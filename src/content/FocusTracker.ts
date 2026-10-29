import Timer, { TimerState, TimerType } from './Timer'
import { local, baseKeyForHost, isElapsedKeyForDay, todayKeyForHost } from '../storage'
import { sendMessage } from '../messages'
import { systemClock } from '../chrome/clock'
import { nextMidnight, startOfDay } from '../core/day'
import type { Clock } from '../ports'

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

export default class FocusTracker {
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
  // Focus time not yet acknowledged by the background writer, by the day key
  // it belongs to: accrued but not sent yet, and sent but not yet answered.
  // A failed send is merged back into `unsent` and retried, so no time is
  // dropped; sends carry disjoint deltas, so several may be in flight.
  private unsent = new Map<string, number>()
  private inFlight = new Set<{ key: string; delta: number }>()
  // When we last attempted a routine report (throttle baseline); epoch so
  // the very first report fires immediately.
  private previousStorageUpdateTime: number = 0
  private host: string
  // Focus time accrues only while the window has focus, the tab is visible
  // and the block screen is not up.
  private windowFocused = false
  private blocked = false

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

  constructor(private clock: Clock = systemClock) {
    this.host = window.location.hostname
    this.day = new Date(startOfDay(this.clock.now()))
    this.resetTimersAtTime = this.getResetTime()
  }

  // Next local calendar midnight.
  getResetTime(): Date {
    return new Date(nextMidnight(this.clock.now()))
  }

  isResetTime(): boolean {
    return this.clock.now() >= this.resetTimersAtTime.getTime()
  }

  start() {
    if (this.started) {
      throw new Error('FocusTracker timers already started')
    }
    this.started = true
    this.countupTimer.start()
    this.focusTimer.start()

    // A tab can load already hidden (opened in the background, or restored
    // on browser start) or visible-but-unfocused. No visibilitychange/blur
    // event fires for that initial state, so sample it up front and let
    // handleFocus/handleVisibilityChange resume the timer. Without this, a
    // never-focused tab accrues focus time.
    this.windowFocused = document.hasFocus()
    this.updateFocusTimer()

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

  // Stop ticking and detach every listener. The tracker can't be restarted.
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

  // Catch up after the page was frozen in the back/forward cache: storage
  // events aren't delivered while frozen, so reload the cached totals, and
  // re-sample focus (no focus event may fire on restore).
  resync(): void {
    this.maybeRollover()
    this.storedTodayLoad = null
    this.globalToday.clear()
    this.globalTouched.clear()
    this.globalTodayLoad = null
    void this.loadStoredToday().catch(() => undefined)
    this.windowFocused = document.hasFocus()
    this.updateFocusTimer()
  }

  // Run `listener` after every tick (once the timers have advanced).
  onTick(listener: () => void): () => void {
    this.tickListeners.add(listener)
    return () => this.tickListeners.delete(listener)
  }

  private tick = () => {
    const now = this.clock.now()
    this.countupTimer.tick(now)
    this.credit(this.focusTimer.tick(now))
    // This tick's time is credited to the day the tab was accounting to; a
    // tick that crosses midnight is the old day's final one.
    if (!this.maybeRollover()) {
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
    // Credit the time since the last tick to the old day, and send it.
    this.countupTimer.tick()
    this.credit(this.focusTimer.tick())
    this.sendUnsent()
    this.day = new Date(startOfDay(this.clock.now()))
    this.resetTimersAtTime = this.getResetTime()
    this.resetTimers()
    this.storedToday = 0
    this.storedTodayLoad = null
    this.globalToday.clear()
    this.globalTouched.clear()
    this.globalTodayLoad = null
  }

  // Attribute focus time to the day being accounted.
  private credit(ms: number): void {
    if (ms > 0) {
      const key = this.getTodayKey()
      this.unsent.set(key, (this.unsent.get(key) ?? 0) + ms)
    }
  }

  // Throttled to ~10s: report accrued focus time to the background writer.
  private maybeReport(now: number): void {
    if (this.unsent.size === 0 || now - this.previousStorageUpdateTime < REPORT_INTERVAL_MS) {
      return
    }
    // Advance the throttle baseline at attempt time so a failing report
    // (e.g. extension context invalidated) is retried at most every 10s
    // rather than every tick.
    this.previousStorageUpdateTime = now
    this.sendUnsent()
  }

  // Send every unsent delta to the background writer, which atomically adds
  // it to its day's key. The single writer makes the cross-tab accumulation
  // race-free.
  private sendUnsent(): void {
    for (const [key, delta] of this.unsent) {
      const report = { key, delta }
      this.inFlight.add(report)
      sendMessage({ type: 'addElapsed', key, delta })
        .then((response) => response.ok)
        .catch(() => false) // service worker asleep or extension reloaded
        .then((ok) => {
          // A report dropped by a reset is no longer ours to retry.
          if (this.inFlight.delete(report) && !ok) {
            this.unsent.set(key, (this.unsent.get(key) ?? 0) + delta)
          }
        })
    }
    this.unsent.clear()
  }

  // Report everything accrued so far right away, regardless of the throttle
  // or of reports still in flight (page hidden or unloading).
  flush(): void {
    this.credit(this.focusTimer.tick())
    this.sendUnsent()
  }

  // Focus time on `key` not yet reflected in storage.
  private unacknowledged(key: string): number {
    let total = this.unsent.get(key) ?? 0
    for (const report of this.inFlight) {
      if (report.key === key) {
        total += report.delta
      }
    }
    return total
  }

  // Remove this host's daily keys for every day except today. Safe to run
  // from the content script: it never touches today's key, so it can't race
  // the background writer's accumulation.
  private pruneOldKeys(): void {
    const prefix = `${baseKeyForHost(this.host)}_`
    const todayKey = this.getTodayKey()
    local
      .getAll()
      .then((items) => {
        const stale = Object.keys(items).filter((key) => key.startsWith(prefix) && key !== todayKey)
        return stale.length > 0 ? local.remove(stale) : undefined
      })
      .catch(() => {
        // Pruning is best-effort; ignore storage errors.
      })
  }

  // Load today's stored total into the cache (once; retried after a failure).
  private loadStoredToday(): Promise<void> {
    if (!this.storedTodayLoad) {
      const key = this.getTodayKey()
      const load = local
        .get<number>(key)
        .then((v) => v ?? 0)
        .then(
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
      const load: Promise<void> = local.getAll().then(
        (items) => {
          if (this.globalTodayLoad !== load) {
            return // superseded by a rollover
          }
          for (const [key, value] of Object.entries(items)) {
            if (isElapsedKeyForDay(key, day) && typeof value === 'number' && !this.globalTouched.has(key)) {
              this.globalToday.set(key, value)
            }
          }
        },
        (error: unknown) => {
          if (this.globalTodayLoad !== load) {
            return // superseded by a rollover
          }
          this.globalTodayLoad = null
          throw error
        }
      )
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
          elapsed: this.storedToday + this.unacknowledged(this.getTodayKey()),
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
    // Drop the throttle baseline so the first post-reset write isn't
    // suppressed for up to 10s.
    this.previousStorageUpdateTime = 0
  }

  // Zero today's total: this tab's timers and the stored counter.
  reset(): void {
    // Roll over first if due, so the reset applies to the current day.
    this.maybeRollover()
    this.resetTimers()
    this.dropUnacknowledged(this.getTodayKey())
    this.storedToday = 0
    void sendMessage({ type: 'resetKey', key: this.getTodayKey() }).catch(() => undefined)
  }

  // Forget focus time owed to `key` (its stored total was reset).
  private dropUnacknowledged(key: string): void {
    this.unsent.delete(key)
    for (const report of this.inFlight) {
      if (report.key === key) {
        this.inFlight.delete(report)
      }
    }
  }

  // The block screen is up (or down). Blocked time is not focus time: the
  // page can't be used, and counting it would keep consuming the global
  // allowance on behalf of a site that is already over its limit.
  setBlocked(blocked: boolean): void {
    this.blocked = blocked
    this.updateFocusTimer()
  }

  // Run the focus timer iff unblocked AND visible AND focused.
  private updateFocusTimer(): void {
    if (this.focusTimer.state === TimerState.NOT_STARTED) {
      return
    }
    if (!this.blocked && !document.hidden && this.windowFocused) {
      this.focusTimer.unpause()
    } else {
      this.credit(this.focusTimer.pause())
    }
  }

  handleBlur = () => {
    this.windowFocused = false
    this.updateFocusTimer()
  }

  handleFocus = () => {
    this.windowFocused = true
    this.updateFocusTimer()
  }

  handleVisibilityChange = () => {
    if (document.hidden) {
      this.updateFocusTimer()
      // Hidden fires before pagehide and is the last event reliably delivered
      // on mobile and when a tab is discarded, so persist pending time now.
      this.flush()
    } else {
      // Focus may have moved while the tab was hidden.
      this.windowFocused = document.hasFocus()
      this.updateFocusTimer()
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
      this.dropUnacknowledged(this.getTodayKey())
    }
  }
}
