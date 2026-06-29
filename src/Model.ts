import Timer, { TimerState, TimerType } from './Timer'
import { storage, todayKeyForHost } from './storage'
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
  private resetTimersAtTime: Date
  // Focus elapsed last successfully reported to the background writer.
  private previousStorageUpdateElapsedValue: number = 0
  // When we last attempted a report (throttle baseline); epoch so the very
  // first report fires immediately.
  private previousStorageUpdateTime: Date = new Date(0)
  // True while a report is in flight, to prevent overlapping reports.
  private reporting: boolean = false
  private host: string
  private resetTimeoutId: number | null = null
  constructor() {
    this.countupTimer = new Timer(TimerType.COUNTUP, 1000, () => ({}))
    this.focusTimer = new Timer(TimerType.FOCUS, 1000, this.reportElapsed)
    this.host = window.location.hostname
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
    return new Date() > this.resetTimersAtTime
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

    const millisecondsUntilResetTime = this.resetTimersAtTime.getTime() - new Date().getTime()

    if (this.resetTimeoutId !== null) {
      clearTimeout(this.resetTimeoutId)
    }
    this.resetTimeoutId = setTimeout(() => {
      this.reset()
    }, millisecondsUntilResetTime)
  }

  getTodayKey(): string {
    return todayKeyForHost(this.host)
  }

  // Fallback rollover: the daily reset is normally driven by a setTimeout,
  // but that can fire late or not at all (system sleep across midnight,
  // clock changes, background-tab timer throttling). Re-check the boundary
  // on the hot paths so the day still rolls over. Returns true if it reset.
  private maybeRollover(): boolean {
    if (this.isResetTime()) {
      this.reset()
      return true
    }
    return false
  }

  // Focus-timer tick callback: throttled to ~10s, reports accrued focus time
  // to the background single-writer.
  reportElapsed = (elapsed: number) => {
    // If we crossed the reset boundary, reset() has already zeroed today's
    // key and the timers; the `elapsed` argument is now stale, so bail.
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

  reset(): void {
    this.resetTimers()
    void this.resetStorageValues()
    this.resetTimersAtTime = this.getResetTime()

    if (this.resetTimeoutId !== null) {
      clearTimeout(this.resetTimeoutId)
    }
    const millisecondsUntilResetTime = this.resetTimersAtTime.getTime() - new Date().getTime()
    this.resetTimeoutId = setTimeout(() => {
      this.reset()
    }, millisecondsUntilResetTime)
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
}
