import Timer, { TimerState, TimerType } from './Timer'

interface Storage {
  get: <T>(key: string, defaultValue: T, storageArea: 'sync' | 'local' | 'managed') => Promise<T>
  set: <T>(key: string, value: T, storageArea: 'sync' | 'local' | 'managed') => Promise<void>
}

export type ElapsedEntry = {
  elapsed: number
  state: TimerState
}

export type ElapsedState = {
  countup: ElapsedEntry
  focus: ElapsedEntry
  today: ElapsedEntry
}

export const storage: Storage = {
  get: <T>(key: string, defaultValue: T, storageArea: 'sync' | 'local' | 'managed') => {
    return new Promise<T>((resolve, reject) => {
      chrome.storage[storageArea].get({ [key]: defaultValue }, (items: Record<string, unknown>) => {
        const error = chrome.runtime.lastError
        if (error) {
          reject(error)
        } else {
          const value = items[key]
          resolve((value === undefined ? defaultValue : value) as T)
        }
      })
    })
  },
  set: <T>(key: string, value: T, storageArea: 'sync' | 'local' | 'managed') => {
    return new Promise((resolve, reject) => {
      chrome.storage[storageArea].set({ [key]: value }, () => {
        const error = chrome.runtime.lastError
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  },
}

const KEY = 'focusTimer_elapsed_today'

export default class Model {
  private countupTimer: Timer
  private focusTimer: Timer
  private started: boolean = false
  private resetTimersAtTime: Date
  private previousStorageUpdateElapsedValue: number = 0
  private previousStorageUpdateTime: Date = new Date(0, 0, 0, 0, 0, 0)
  private baseKey: string
  private resetTimeoutId: number | null = null
  constructor() {
    this.countupTimer = new Timer(TimerType.COUNTUP, 1000, () => ({}))
    this.focusTimer = new Timer(TimerType.FOCUS, 1000, this.updateStorageValues.bind(this))
    const hostname = window.location.hostname
    // remove subdomains
    const parts = hostname.split('.')
    while (parts.length > 2) {
      parts.shift()
    }
    this.baseKey = `${KEY}_${parts.join('.')}`

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
    const today = new Date()
    // ISO date format and handle 0 padding
    const key = `${this.baseKey}_${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate()
    ).padStart(2, '0')}`
    return key
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

  updateStorageValues = (elapsed: number) => {
    // If we crossed the reset boundary, reset() has already zeroed today's
    // key and the timers; the `elapsed` argument is now stale, so bail.
    if (this.maybeRollover()) {
      return
    }
    const key = this.getTodayKey()
    const diff = elapsed - this.previousStorageUpdateElapsedValue
    if (diff < 0) {
      return
    }
    if (new Date().getTime() - this.previousStorageUpdateTime.getTime() < 10000) {
      return
    }

    this.readStorageElapsedToday().then((storedVal) => {
      const val = storedVal + diff
      storage.set(key, val, 'local').then(() => {
        this.previousStorageUpdateElapsedValue = elapsed
        this.previousStorageUpdateTime = new Date()
      })
    })
  }

  public readStorageElapsedToday(): Promise<number> {
    return storage.get(this.getTodayKey(), 0, 'local')
  }

  private resetStorageValues(): Promise<void> {
    return storage.set(this.getTodayKey(), 0, 'local')
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
    this.resetStorageValues()
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
