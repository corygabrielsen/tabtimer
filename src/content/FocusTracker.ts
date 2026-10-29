import { bus as chromeBus, pushes as chromePushes } from '../chrome/bus'
import { systemClock } from '../chrome/clock'
import { dayOf, startOfDay, type DayStamp } from '../core/day'
import type { BlockReason } from '../core/limits'
import type { TabState } from '../core/messages'
import type { Presence } from '../core/tracker'
import type { Bus, Clock, Pushes } from '../ports'

// What the overlay shows: this site's time today, this page's focus time,
// and how long the page has been open (both since midnight at most).
export type ElapsedState = { today: number; focus: number; session: number }

// What the limits are checked against. `site` is null until the service
// worker has answered.
export type Totals = { site: string | null; siteToday: number; globalToday: number }

// The tab's single tick source: rendering and limit checks run off it.
export const TICK_MS = 1000
// After a report fails, wait this long before trying again.
const RETRY_MS = 10_000

// The page's side of active time. The service worker decides which one tab
// accrues (core/tracker.ts); this reports the page's presence (visible,
// focused, playing media, blocked) whenever it changes, and keeps the
// display ticking from the TabState the worker replies with or pushes.
// Nothing here is counted: closing the page loses no time.
export default class FocusTracker {
  private started = false
  private intervalId: ReturnType<typeof setInterval> | null = null
  private tickListeners = new Set<() => void>()
  private stateListeners = new Set<() => void>()
  private unsubscribePush: (() => void) | null = null
  private state: TabState | null = null
  private blocked = false
  // Window focus, as the focus and blur events tell it (sampled with
  // document.hasFocus() on start, on being shown and on restore, when no
  // event may fire).
  private windowFocused = false
  // A snooze asked for and not yet reflected in a state from the worker.
  private snoozing = false
  // The presence last reported (as JSON), and when a failed report may be
  // retried.
  private lastReport: string | null = null
  private retryAt = 0
  // Display-only stopwatches: when the page opened, this page's focus time
  // so far, and since when it has been running (null: not running).
  private sessionStart: number
  private focusDone = 0
  private focusFrom: number | null = null
  private day: DayStamp

  constructor(
    private clock: Clock = systemClock,
    private bus: Bus = chromeBus,
    private pushes: Pushes = chromePushes
  ) {
    this.sessionStart = this.clock.now()
    this.day = dayOf(this.sessionStart)
  }

  start(): void {
    if (this.started) {
      throw new Error('FocusTracker already started')
    }
    this.started = true
    this.windowFocused = document.hasFocus()
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    window.addEventListener('blur', this.handleBlur)
    window.addEventListener('focus', this.handleFocus)
    // Media starting or stopping decides whether idle time counts.
    for (const type of MEDIA_EVENTS) {
      document.addEventListener(type, this.handleChange, true)
    }
    this.unsubscribePush = this.pushes.onState((state) => {
      this.apply(state)
      const presence = this.presence()
      this.lastReport = JSON.stringify(presence)
      return presence
    })
    // A tab can load hidden or unfocused, with no event for that initial
    // state: the first report samples it.
    void this.report(true)
    this.intervalId = setInterval(this.tick, TICK_MS)
  }

  // Stop ticking and detach every listener, reporting the page as gone. The
  // tracker can't be restarted.
  destroy(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.tickListeners.clear()
    this.stateListeners.clear()
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    window.removeEventListener('blur', this.handleBlur)
    window.removeEventListener('focus', this.handleFocus)
    for (const type of MEDIA_EVENTS) {
      document.removeEventListener(type, this.handleChange, true)
    }
    this.unsubscribePush?.()
    this.unsubscribePush = null
    if (this.started) {
      this.started = false
      void this.bus.send('presence', { visible: false, focused: false, media: false, blocked: this.blocked })
    }
  }

  // Restored from the back/forward cache: report again (no event may fire
  // for the restored focus), and catch up on the worker's state.
  resync(): void {
    this.windowFocused = document.hasFocus()
    void this.report(true)
  }

  // Run `listener` after every tick.
  onTick(listener: () => void): () => void {
    this.tickListeners.add(listener)
    return () => this.tickListeners.delete(listener)
  }

  // Run `listener` whenever a new state from the worker applies.
  onState(listener: () => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  private tick = () => {
    const now = this.clock.now()
    const day = dayOf(now)
    if (day !== this.day) {
      // A new day: the stopwatches restart, and the worker's totals are
      // yesterday's until it answers.
      this.day = day
      this.focusDone = 0
      if (this.focusFrom !== null) {
        this.focusFrom = startOfDay(now)
      }
      void this.report(true)
    } else {
      // Catches what no event announces (media that stalled or ran out).
      void this.report()
    }
    for (const listener of this.tickListeners) {
      listener()
    }
  }

  private presence(): Presence {
    return { visible: !document.hidden, focused: this.windowFocused, media: mediaPlaying(), blocked: this.blocked }
  }

  // Tell the worker the page's presence, if it changed (or `force`), and
  // apply the state it replies with.
  async report(force = false): Promise<void> {
    if (!this.started) {
      return
    }
    const presence = this.presence()
    const key = JSON.stringify(presence)
    const now = this.clock.now()
    if (!force && (key === this.lastReport || now < this.retryAt)) {
      return
    }
    this.lastReport = key
    const response = await this.bus.send('presence', presence)
    if (response.ok) {
      this.retryAt = 0
      this.apply(response.value)
    } else if (this.lastReport === key) {
      // Not heard: report again once the worker may be back.
      this.lastReport = null
      this.retryAt = now + RETRY_MS
    }
  }

  // Take a state from the worker, unless one computed later already came.
  private apply(state: TabState): void {
    if (this.state && state.asOf < this.state.asOf) {
      return
    }
    if (state.running && this.focusFrom === null) {
      this.focusFrom = Math.max(state.asOf, startOfDay(this.clock.now()))
    } else if (!state.running && this.focusFrom !== null) {
      this.focusDone += Math.max(0, state.asOf - this.focusFrom)
      this.focusFrom = null
    }
    this.state = state
    if (this.started) {
      for (const listener of this.stateListeners) {
        listener()
      }
    }
  }

  // The site this page counts under, once the worker has said.
  get site(): string | null {
    return this.state?.site ?? null
  }

  // Today's totals now: as of the worker's last state, plus the time since
  // while this tab is the one accruing. Past midnight, until the worker
  // answers, only the time since midnight.
  readTotals(): Totals {
    const s = this.state
    if (!s) {
      return { site: null, siteToday: 0, globalToday: 0 }
    }
    const now = this.clock.now()
    if (dayOf(now) !== s.day) {
      const since = s.running ? Math.max(0, now - Math.max(s.asOf, startOfDay(now))) : 0
      return { site: s.site, siteToday: since, globalToday: since }
    }
    const running = s.running ? Math.max(0, now - s.asOf) : 0
    return { site: s.site, siteToday: s.today + running, globalToday: s.globalToday + running }
  }

  readElapsed(): ElapsedState {
    const now = this.clock.now()
    const focus = this.focusDone + (this.focusFrom === null ? 0 : Math.max(0, now - this.focusFrom))
    return {
      today: this.readTotals().siteToday,
      focus,
      session: Math.max(0, now - Math.max(this.sessionStart, startOfDay(now))),
    }
  }

  // Why the page must block now, or null. The worker said when (blockAt);
  // a snooze being asked for, or a state from before midnight, never blocks.
  blockReason(): BlockReason | null {
    const s = this.state
    const now = this.clock.now()
    if (!s || this.snoozing || s.blockAt === null || s.limit === null || now < s.blockAt || dayOf(now) !== s.day) {
      return null
    }
    const totals = this.readTotals()
    return {
      scope: s.limit.scope,
      limit: s.limit.ms,
      elapsed: s.limit.scope === 'site' ? totals.siteToday : totals.globalToday,
    }
  }

  // The block screen is up (or down): blocked time is not counted.
  setBlocked(blocked: boolean): void {
    if (blocked !== this.blocked) {
      this.blocked = blocked
      void this.report()
    }
  }

  // Suppress blocking for SNOOZE_MS: until the worker's state reflects it,
  // the page doesn't block again.
  async snooze(): Promise<void> {
    this.snoozing = true
    try {
      await this.bus.send('snooze', {})
      await this.report(true)
    } finally {
      this.snoozing = false
    }
  }

  private handleChange = () => {
    void this.report()
  }

  private handleBlur = () => {
    this.windowFocused = false
    void this.report()
  }

  private handleFocus = () => {
    this.windowFocused = true
    void this.report()
  }

  private handleVisibilityChange = () => {
    if (!document.hidden) {
      // Focus may have moved while the tab was hidden.
      this.windowFocused = document.hasFocus()
    }
    void this.report()
  }
}

const MEDIA_EVENTS = ['play', 'playing', 'pause', 'ended'] as const

// Whether the page is playing audio or video (muted or not): watching or
// listening keeps idle time counting. Media in closed shadow roots or
// cross-origin frames isn't seen. readyState 2 is HAVE_CURRENT_DATA.
export function mediaPlaying(): boolean {
  for (const media of document.querySelectorAll<HTMLMediaElement>('video, audio')) {
    if (!media.paused && !media.ended && media.readyState >= 2) {
      return true
    }
  }
  return false
}
