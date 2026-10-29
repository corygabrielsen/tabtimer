import Timer, { TimerState, TimerType } from './Timer'
import { storage, baseKeyForHost, isElapsedKeyForDay, todayKeyForHost } from './storage'
import { sendMessage } from './messages'

export type ElapsedEntry = {
  elapsed: number
  state: TimerState
}

export type ElapsedState = {
  countup: ElapsedEntry
  focus: ElapsedEntry
  today: ElapsedEntry
}

// The tab's single tick source: timers, reporting, rendering and limit checks
// all run off this one interval.
export const TICK_MS = 1000
// Minimum spacing between routine reports to the background writer.
const REPORT_INTERVAL_MS = 10_000

export default class Model {
  // The session timer is wall time on the page, so a long gap between ticks
  // (a throttled background tab wakes about once a minute) still counts in
  // full; only backward clock jumps are ignored.
  private countupTimer = new Timer(TimerType.COUNTUP, Infinity)
  // Focus time credits at most two ticks per tick, so a sleep/suspend gap
  // or a forward clock jump doesn't count as focus.
  private focusTimer = new Timer(TimerType.FOCUS, 2 * TICK_MS)
  private started: boolean = false
  private intervalId: ReturnType<typeof setInterval> | null = null
  private tickListeners = new Set<() => void>()
  // Local midnight that starts the day this tab is accounting to, and the
  // next one (when it rolls over).
  private day: Date
  private resetTimersAtTime: Date
  // Focus elapsed last successfully reported to the background writer.
  private previousStorageUpdateElapsedValue: number = 0
  // When we last attempted a report (throttle baseline); epoch so the very
  // first report fires immediately.
  private previousStorageUpdateTime: number = 0
  // True while a report is in flight, to prevent overlapping reports.
  private reporting: boolean = false
  private host: string

  // Cached stored total for this site today, loaded once per day and then
  // kept current from storage.onChanged (rather than read every second).
  private storedToday = 0
  private storedTodayLoad: Promise<void> | null = null
  // Cached stored totals of every site today (the global total), loaded on
  // first use and likewise kept current from storage.onChanged.
  private globalToday = new Map<string, number>()
  // Keys updated by onChanged since the global load started; the load's
  // (older) snapshot must not overwrite them.
  private globalTouched = new Set<string>()
  private globalTodayLoad: Promise<void> | null = null

  constructor() {
    this.host = window.location.hostname
    this.day = startOfDay(new Date())
    this.resetTimersAtTime = this.getResetTime()
  }

  getResetTime(): Date {
    const now = new Date()
    // Next local calendar midnight. Day overflow normalizes across months,
    // and rebuilding from y/m/d (rather than adding 24h) stays correct on
    // DST-transition days where a local day is 23h or 25h long.
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0)
  }

  isResetTime(): boolean {
    return new Date() >= this.resetTimersAtTime
  }

  start() {
    if (this.started) {
      throw new Error('Model timers already started')
    }
    this.started = true
    this.countupTimer.start()
    this.focusTimer.start()

    // A tab can load already hidden (opened in the background, or restored
    // on browser start) or visible-but-unfocused. No visibilitychange/blur
    // event fires for that initial state, so pause the focus timer up front
    // and let handleFocus/handleVisibilityChange resume it. Without this, a
    // never-focused tab accrues focus time.
    if (document.hidden || !document.hasFocus()) {
      this.focusTimer.pause()
    }

    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    window.addEventListener('blur', this.handleBlur)
    window.addEventListener('focus', this.handleFocus)
    // Keeps the cached totals current, and reacts when today's counter is
    // reset elsewhere (popup or another tab).
    chrome.storage.onChanged.addListener(this.handleStorageChange)

    // Past days' keys are never read again; drop them so chrome.storage.local
    // doesn't grow without bound (one new key per tracked site per day).
    this.pruneOldKeys()
    void this.loadStoredToday().catch(() => undefined)

    this.intervalId = setInterval(this.tick, TICK_MS)
  }

  // Stop ticking and detach every listener. The model can't be restarted.
  destroy(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.tickListeners.clear()
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    window.removeEventListener('blur', this.handleBlur)
    window.removeEventListener('focus', this.handleFocus)
    chrome.storage.onChanged.removeListener(this.handleStorageChange)
  }

  // Run `listener` after every tick (once the timers have advanced).
  onTick(listener: () => void): () => void {
    this.tickListeners.add(listener)
    return () => this.tickListeners.delete(listener)
  }

  private tick = () => {
    const now = Date.now()
    this.countupTimer.tick(now)
    this.focusTimer.tick(now)
    // This tick's time is credited to the day the tab was accounting to; a
    // tick that crosses midnight is the old day's final one.
    if (!this.maybeRollover() && this.focusTimer.state === TimerState.RUNNING) {
      this.maybeReport(now)
    }
    for (const listener of this.tickListeners) {
      listener()
    }
  }

  // The key this tab's focus time is credited to: the day it is accounting
  // for, which only advances when the rollover is noticed.
  getTodayKey(): string {
    return todayKeyForHost(this.host, this.day)
  }

  // Checked every tick and on every read, so the day rolls over even when
  // timers fire late (system sleep across midnight, clock changes,
  // background-tab throttling). Returns true if it rolled over.
  private maybeRollover(): boolean {
    if (this.isResetTime()) {
      this.rollover()
      return true
    }
    return false
  }

  // Start a new day. Stored totals are keyed by date, so the new day's key
  // needs no reset; other tabs may already have logged time to it after
  // 00:00, and zeroing it here would erase that. Only this tab's local
  // baselines restart. Time accrued but not yet reported still belongs to
  // the old day, so it is sent to the old day's key rather than dropped.
  private rollover(): void {
    // Credit the time since the last tick to the old day first.
    this.countupTimer.tick()
    this.focusTimer.tick()
    const oldKey = this.getTodayKey()
    const unreported = this.elapsedFocusTime() - this.previousStorageUpdateElapsedValue
    this.day = startOfDay(new Date())
    this.resetTimersAtTime = this.getResetTime()
    if (unreported > 0) {
      void sendMessage({ type: 'addElapsed', key: oldKey, delta: unreported }).catch(() => undefined)
    }
    this.resetTimers()
    this.storedToday = 0
    this.storedTodayLoad = null
    this.globalToday.clear()
    this.globalTouched.clear()
    this.globalTodayLoad = null
  }

  // Throttled to ~10s: report accrued focus time to the background writer.
  private maybeReport(now: number): void {
    if (this.elapsedFocusTime() - this.previousStorageUpdateElapsedValue <= 0) {
      return
    }
    if (now - this.previousStorageUpdateTime < REPORT_INTERVAL_MS) {
      return
    }
    void this.flushElapsed(this.elapsedFocusTime())
  }

  // Report the focus time accrued since the last successful report to the
  // background writer, which atomically adds it to today's key. The single
  // writer makes the cross-tab accumulation race-free.
  private flushElapsed(elapsed: number): Promise<void> {
    if (this.reporting) {
      return Promise.resolve()
    }
    const diff = elapsed - this.previousStorageUpdateElapsedValue
    if (diff <= 0) {
      return Promise.resolve()
    }
    this.reporting = true
    // Advance the throttle baseline at attempt time so a failing report
    // (e.g. extension context invalidated) is retried at most every 10s
    // rather than every tick.
    this.previousStorageUpdateTime = Date.now()
    const key = this.getTodayKey()
    return sendMessage({ type: 'addElapsed', key, delta: diff })
      .then((response) => {
        // Only advance the reported baseline on success; on failure the same
        // delta is recomputed and retried next time, so no time is lost.
        if (response.ok) {
          this.previousStorageUpdateElapsedValue = elapsed
        }
      })
      .catch(() => {
        // Service worker asleep or extension reloaded; drop this report.
      })
      .finally(() => {
        this.reporting = false
      })
  }

  // Best-effort persist of pending focus time on page unload.
  flush(): void {
    void this.flushElapsed(this.elapsedFocusTime())
  }

  // Remove this host's daily keys for every day except today. Safe to run
  // from the content script: it never touches today's key, so it can't race
  // the background writer's accumulation.
  private pruneOldKeys(): void {
    const prefix = `${baseKeyForHost(this.host)}_`
    const todayKey = this.getTodayKey()
    storage
      .keys('local')
      .then((keys) => {
        const stale = keys.filter((key) => key.startsWith(prefix) && key !== todayKey)
        return stale.length > 0 ? storage.remove(stale, 'local') : undefined
      })
      .catch(() => {
        // Pruning is best-effort; ignore storage errors.
      })
  }

  // Load today's stored total into the cache (once; retried after a failure).
  private loadStoredToday(): Promise<void> {
    if (!this.storedTodayLoad) {
      const key = this.getTodayKey()
      const load = storage.get(key, 0, 'local').then(
        (value) => {
          // Ignore a stale result if the day rolled over or onChanged already
          // delivered a newer value meanwhile.
          if (this.storedTodayLoad === load) {
            this.storedToday = value
          }
        },
        (error: unknown) => {
          if (this.storedTodayLoad === load) {
            this.storedTodayLoad = null
          }
          throw error
        }
      )
      this.storedTodayLoad = load
    }
    return this.storedTodayLoad
  }

  // Load every site's stored total for today into the cache (once; retried
  // after a failure).
  private loadGlobalToday(): Promise<void> {
    if (!this.globalTodayLoad) {
      const day = this.day
      const load = new Promise<void>((resolve, reject) => {
        chrome.storage.local.get(null, (items: Record<string, unknown>) => {
          const error = chrome.runtime.lastError
          if (this.globalTodayLoad !== load) {
            resolve() // superseded by a rollover
            return
          }
          if (error) {
            this.globalTodayLoad = null
            reject(error)
            return
          }
          for (const [key, value] of Object.entries(items)) {
            if (isElapsedKeyForDay(key, day) && typeof value === 'number' && !this.globalTouched.has(key)) {
              this.globalToday.set(key, value)
            }
          }
          resolve()
        })
      })
      this.globalTodayLoad = load
    }
    return this.globalTodayLoad
  }

  // Today's stored focus time summed across every tracked site (the global
  // daily total). Excludes in-flight, not-yet-flushed deltas, so it can lag a
  // live counter by up to ~10s — fine for a minute-scale limit.
  readGlobalToday(): Promise<number> {
    this.maybeRollover()
    return this.loadGlobalToday().then(() => {
      let total = 0
      for (const value of this.globalToday.values()) {
        total += value
      }
      return total
    })
  }

  readElapsed(): Promise<ElapsedState> {
    this.maybeRollover()
    return this.loadStoredToday().then(() => {
      const focusElapsed = this.elapsedFocusTime()
      let diff = focusElapsed - this.previousStorageUpdateElapsedValue
      if (diff < 0) {
        diff = 0
      }
      return {
        countup: {
          elapsed: this.elapsedCountupTime(),
          state: this.countupTimer.state,
        },
        focus: {
          elapsed: focusElapsed,
          state: this.focusTimer.state,
        },
        today: {
          elapsed: this.storedToday + diff,
          state: this.focusTimer.state, // same as focus timer
        },
      }
    })
  }

  elapsedCountupTime(): number {
    return this.countupTimer.elapsed
  }

  elapsedFocusTime(): number {
    return this.focusTimer.elapsed
  }

  private resetTimers(): void {
    this.countupTimer.reset()
    this.focusTimer.reset()
    this.previousStorageUpdateElapsedValue = 0
    // Drop the throttle baseline so the first post-reset write isn't
    // suppressed for up to 10s.
    this.previousStorageUpdateTime = 0
  }

  // Zero today's total: this tab's timers and the stored counter.
  reset(): void {
    // Roll over first if due, so the reset applies to the current day.
    this.maybeRollover()
    this.resetTimers()
    this.storedToday = 0
    void sendMessage({ type: 'resetKey', key: this.getTodayKey() }).catch(() => undefined)
  }

  handleBlur = () => {
    this.focusTimer.pause()
  }

  handleFocus = () => {
    this.focusTimer.unpause()
  }

  handleVisibilityChange = () => {
    if (document.hidden) {
      this.focusTimer.pause()
    } else {
      this.focusTimer.unpause()
    }
  }

  handleStorageChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: chrome.storage.AreaName) => {
    if (areaName !== 'local') {
      return
    }
    for (const [key, change] of Object.entries(changes)) {
      if (isElapsedKeyForDay(key, this.day)) {
        this.globalToday.set(key, typeof change.newValue === 'number' ? change.newValue : 0)
        this.globalTouched.add(key)
      }
    }
    const change = changes[this.getTodayKey()]
    if (!change) {
      return
    }
    const newValue = (change.newValue as number | undefined) ?? 0
    // Authoritative and newer than any load in flight.
    this.storedToday = newValue
    this.storedTodayLoad = Promise.resolve()
    if (newValue === 0) {
      // Today's counter was reset elsewhere. Drop our in-memory accumulation
      // so the on-screen total reflects the reset and we don't immediately
      // re-report the stale delta back onto the freshly-zeroed key.
      this.resetTimers()
    }
  }
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}
