import Timer, { TimerState, TimerType } from './Timer'
import { storage, baseKeyForHost, todayKeyForHost } from './storage'
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

export default class Model {
  private countupTimer: Timer
  private focusTimer: Timer
  private started: boolean = false
  // Local midnight that starts the day this tab is accounting to, and the
  // next one (when it rolls over).
  private day: Date
  private resetTimersAtTime: Date
  // Focus elapsed last successfully reported to the background writer.
  private previousStorageUpdateElapsedValue: number = 0
  // When we last attempted a report (throttle baseline); epoch so the very
  // first report fires immediately.
  private previousStorageUpdateTime: Date = new Date(0)
  // True while a report is in flight, to prevent overlapping reports.
  private reporting: boolean = false
  private host: string
  private resetTimeoutId: ReturnType<typeof setTimeout> | null = null
  constructor() {
    // The session timer is wall time on the page, so a long gap between
    // ticks (a throttled background tab wakes about once a minute) still
    // counts in full; only backward clock jumps are ignored.
    this.countupTimer = new Timer(TimerType.COUNTUP, 1000, () => ({}), Infinity)
    this.focusTimer = new Timer(TimerType.FOCUS, 1000, this.reportElapsed)
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

    // Listen for the visibilitychange event and handle it
    document.addEventListener('visibilitychange', this.handleVisibilityChange)

    // Listen for the blur event and handle it
    window.addEventListener('blur', this.handleBlur)

    // Listen for the focus event and handle it
    window.addEventListener('focus', this.handleFocus)

    // React when today's counter is reset elsewhere (popup or another tab).
    chrome.storage.onChanged.addListener(this.handleStorageChange)

    // Past days' keys are never read again; drop them so chrome.storage.local
    // doesn't grow without bound (one new key per tracked site per day).
    this.pruneOldKeys()

    this.scheduleRollover()
  }

  // The key this tab's focus time is credited to: the day it is accounting
  // for, which only advances when the rollover is noticed.
  getTodayKey(): string {
    return todayKeyForHost(this.host, this.day)
  }

  private scheduleRollover(): void {
    if (this.resetTimeoutId !== null) {
      clearTimeout(this.resetTimeoutId)
    }
    this.resetTimeoutId = setTimeout(() => {
      // Credit the focus time since the last tick first (its callback rolls
      // the day over), so the old day keeps its final partial second.
      this.focusTimer.tick()
      this.maybeRollover()
    }, this.resetTimersAtTime.getTime() - Date.now())
  }

  // Fallback rollover: the daily reset is normally driven by a setTimeout,
  // but that can fire late or not at all (system sleep across midnight,
  // clock changes, background-tab timer throttling). Re-check the boundary
  // on the hot paths so the day still rolls over. Returns true if it reset.
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
    const oldKey = this.getTodayKey()
    const unreported = this.elapsedFocusTime() - this.previousStorageUpdateElapsedValue
    // Advance the boundary before resetting the timers: stopping the focus
    // timer runs reportElapsed, which re-checks maybeRollover().
    this.day = startOfDay(new Date())
    this.resetTimersAtTime = this.getResetTime()
    if (unreported > 0) {
      void sendMessage({ type: 'addElapsed', key: oldKey, delta: unreported }).catch(() => undefined)
    }
    this.resetTimers()
    this.scheduleRollover()
  }

  // Focus-timer tick callback: throttled to ~10s, reports accrued focus time
  // to the background single-writer.
  reportElapsed = (elapsed: number) => {
    // If we crossed the reset boundary, rollover() has already restarted the
    // timers; the `elapsed` argument is now stale, so bail.
    if (this.maybeRollover()) {
      return
    }
    if (elapsed - this.previousStorageUpdateElapsedValue <= 0) {
      return
    }
    if (Date.now() - this.previousStorageUpdateTime.getTime() < 10000) {
      return
    }
    void this.flushElapsed(elapsed)
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
    this.previousStorageUpdateTime = new Date()
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

  public readStorageElapsedToday(): Promise<number> {
    return storage.get(this.getTodayKey(), 0, 'local')
  }

  private resetStorageValues(): Promise<void> {
    const key = this.getTodayKey()
    return sendMessage({ type: 'resetKey', key })
      .then(() => undefined)
      .catch(() => undefined)
  }

  readElapsed(): Promise<ElapsedState> {
    this.maybeRollover()
    return this.readStorageElapsedToday().then((storageResult) => {
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
          elapsed: storageResult + diff,
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
    this.previousStorageUpdateTime = new Date(0)
  }

  // Zero today's total: this tab's timers and the stored counter.
  reset(): void {
    // Roll over first if due, so the reset applies to the current day.
    this.maybeRollover()
    this.resetTimers()
    void this.resetStorageValues()
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
    const change = changes[this.getTodayKey()]
    if (!change) {
      return
    }
    const newValue = (change.newValue as number | undefined) ?? 0
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
