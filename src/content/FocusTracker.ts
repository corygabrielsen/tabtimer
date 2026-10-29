import Timer, { TimerState, TimerType } from './Timer'
import { chromeStore } from '../chrome/store'
import { bus as chromeBus } from '../chrome/bus'
import { systemClock } from '../chrome/clock'
import { isIdleState, type IdleState } from '../core/away'
import { dayOf, nextMidnight, startOfDay, type DayStamp } from '../core/day'
import { appendSpan, batchSpans, spanTimeSince, type ErrorCode, type Span } from '../core/messages'
import { dayKey, dayTotal, normalizeDay, siteTotal, IDLE_STATE_KEY, type DayUsage } from '../core/schema'
import type { Bus, Clock, Store, StoreChanges } from '../ports'

export type ElapsedEntry = {
  elapsed: number
  state: TimerState
}

export type ElapsedState = {
  countup: ElapsedEntry
  focus: ElapsedEntry
  today: ElapsedEntry
}

// What the limits are checked against.
// `site` is null while the service worker can't be reached to name it; the
// stored totals are then unknown, so only time not yet stored is counted.
export type Totals = { site: string | null; siteToday: number; globalToday: number }

// The tab's single tick source: timers, reporting, rendering and limit checks
// all run off this one interval.
export const TICK_MS = 1000
// Minimum spacing between routine reports to the service worker.
const REPORT_INTERVAL_MS = 10_000

// A report that failed for one of these reasons is retried; any other
// failure (a malformed or refused report) would fail the same way again.
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['unreachable', 'internal'])

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
  private unsubscribeStore: (() => void) | null = null
  // The local day this tab displays totals for, and the next midnight (when
  // it rolls over).
  private day: DayStamp
  private resetTimersAtTime: Date
  // Focus time not yet acknowledged by the service worker, as spans of wall
  // time: accrued but not sent yet, and sent but not yet answered. The
  // worker assigns each span to its day and hour. A report that fails to
  // arrive is merged back into `unsent` and retried, so no time is dropped;
  // reports carry disjoint spans, so several may be in flight.
  private unsent: Span[] = []
  private inFlight = new Set<Span[]>()
  // When we last attempted a routine report (throttle baseline); epoch so
  // the very first report fires immediately.
  private previousStorageUpdateTime: number = 0
  // Focus time accrues only while the window has focus, the tab is visible,
  // the block screen is not up, and the user is at the computer: not
  // locked, and not idle unless media is playing (core/away.ts). The idle
  // state is the service worker's, mirrored in storage. The worker trims
  // reported time by the same rule, so this only keeps the display honest.
  private windowFocused = false
  private blocked = false
  private idle: IdleState = 'active'

  // The site this page counts under, as the service worker resolves it
  // (content.js doesn't bundle the public suffix list).
  private site: string | null = null
  private siteLoad: Promise<string> | null = null
  // Cached usage of every site today (the stored day:* object), loaded once
  // per day and then kept current from storage changes (rather than read
  // every second).
  private usage: DayUsage = {}
  private usageLoad: Promise<void> | null = null

  constructor(
    private clock: Clock = systemClock,
    private bus: Bus = chromeBus,
    private store: Store = chromeStore('local')
  ) {
    this.day = dayOf(this.clock.now())
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
    // Keeps the cached usage current, and reacts when this site's time is
    // reset from the popup.
    this.unsubscribeStore = this.store.onChanged(this.handleStorageChange)

    void this.load().catch(() => undefined)

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
    this.unsubscribeStore?.()
    this.unsubscribeStore = null
  }

  // Catch up after the page was frozen in the back/forward cache: storage
  // events aren't delivered while frozen, so reload the cached usage, and
  // re-sample focus (no focus event may fire on restore).
  resync(): void {
    this.maybeRollover()
    this.usageLoad = null
    void this.load().catch(() => undefined)
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
    if (this.idle === 'idle') {
      // Media starting or stopping decides whether idle time counts.
      this.updateFocusTimer()
    }
    this.countupTimer.tick(now)
    this.creditFocus(() => this.focusTimer.tick(now))
    if (!this.maybeRollover()) {
      this.maybeReport(now)
    }
    for (const listener of this.tickListeners) {
      listener()
    }
  }

  // The storage key of the day this tab displays.
  getTodayKey(): string {
    return dayKey(this.day)
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

  // Start a new day: the timers and the cached usage restart. Reported time
  // is dated by its spans, so time accrued before midnight still lands in
  // the old day, whenever it arrives.
  private rollover(): void {
    this.countupTimer.tick()
    this.creditFocus(() => this.focusTimer.tick())
    this.sendUnsent()
    this.day = dayOf(this.clock.now())
    this.resetTimersAtTime = this.getResetTime()
    this.resetTimers()
    this.usage = {}
    this.usageLoad = null
  }

  // Measure the focus timer and record what it credits, dated from where its
  // previous measurement ended: after a gap (sleep, a throttled tab) the
  // capped credit is the time right after the last tick, not the time just
  // before waking.
  private creditFocus(measure: () => number): void {
    const from = this.focusTimer.measuredUpTo
    const ms = measure()
    if (from !== null) {
      appendSpan(this.unsent, from + ms, ms)
    }
  }

  // Throttled to ~10s: report accrued focus time to the service worker.
  private maybeReport(now: number): void {
    if (this.unsent.length === 0 || now - this.previousStorageUpdateTime < REPORT_INTERVAL_MS) {
      return
    }
    // Advance the throttle baseline at attempt time so a failing report
    // (e.g. extension context invalidated) is retried at most every 10s
    // rather than every tick.
    this.previousStorageUpdateTime = now
    this.sendUnsent()
  }

  // Send every unsent span to the service worker, which adds it to the
  // sender's site. The single writer makes cross-tab accumulation race-free.
  private sendUnsent(): void {
    // Whether media played while this time accrued: while idle, the focus
    // timer runs only with media playing; otherwise it is sampled now.
    const media = this.idle === 'idle' || mediaPlaying()
    const batches = batchSpans(this.unsent, this.clock.now())
    this.unsent = []
    for (const spans of batches) {
      this.inFlight.add(spans)
      void this.bus.send('addElapsed', { spans, media }).then((response) => {
        // A report dropped by a reset is no longer ours to retry.
        if (this.inFlight.delete(spans) && !response.ok && RETRYABLE.has(response.error)) {
          this.unsent = [...spans, ...this.unsent].sort((a, b) => a[0] - b[0])
        }
      })
    }
  }

  // Report everything accrued so far right away, regardless of the throttle
  // or of reports still in flight (page hidden or unloading).
  flush(): void {
    this.creditFocus(() => this.focusTimer.tick())
    this.sendUnsent()
  }

  // Focus time today not yet reflected in storage.
  private unacknowledged(): number {
    const from = startOfDay(this.clock.now())
    return spanTimeSince(this.unsent, from) + spanTimeSince([...this.inFlight].flat(), from)
  }

  // The site this page counts under (asked once; retried after a failure).
  getSite(): Promise<string> {
    if (!this.siteLoad) {
      const load = this.bus.send('hello', {}).then((response) => {
        if (!response.ok) {
          throw new Error(response.error)
        }
        this.site = response.value.site
        return response.value.site
      })
      load.catch(() => {
        if (this.siteLoad === load) {
          this.siteLoad = null
        }
      })
      this.siteLoad = load
    }
    return this.siteLoad
  }

  // Load today's usage into the cache (once per day; retried after a failure).
  private loadUsage(): Promise<void> {
    if (!this.usageLoad) {
      const load: Promise<void> = this.store.get(this.getTodayKey()).then(
        (value) => {
          // Ignore a stale result if the day rolled over or a storage change
          // already delivered a newer value meanwhile.
          if (this.usageLoad === load) {
            this.usage = normalizeDay(value)
          }
        },
        (error: unknown) => {
          if (this.usageLoad === load) {
            this.usageLoad = null
          }
          throw error
        }
      )
      this.usageLoad = load
    }
    return this.usageLoad
  }

  // Everything a read needs: the site and today's usage; and the idle state.
  private load(): Promise<unknown> {
    return Promise.all([this.getSite(), this.loadUsage(), this.loadIdle()])
  }

  private async loadIdle(): Promise<void> {
    this.setIdle(await this.store.get(IDLE_STATE_KEY))
  }

  // Follow the service worker's idle state. What has accrued is reported
  // first, flagged as it accrued (so going idle, the worker trims it back
  // to the last input at once and the stored total settles).
  private setIdle(value: unknown): void {
    const next = isIdleState(value) ? value : 'active'
    if (next === this.idle) {
      return
    }
    this.flush()
    this.idle = next
    this.updateFocusTimer()
  }

  // Today's totals: this site's (including time not yet stored) and every
  // tracked site's combined (the global daily total). The global total is
  // stored time only, so it can lag a live counter by up to ~10s; fine for
  // a minute-scale limit.
  async readTotals(): Promise<Totals> {
    this.maybeRollover()
    const [site] = await Promise.all([this.getSite().catch(() => null), this.loadUsage()])
    return {
      site,
      siteToday: (site === null ? 0 : siteTotal(this.usage, site)) + this.unacknowledged(),
      globalToday: dayTotal(this.usage),
    }
  }

  readGlobalToday(): Promise<number> {
    return this.readTotals().then((totals) => totals.globalToday)
  }

  async readElapsed(): Promise<ElapsedState> {
    const { siteToday } = await this.readTotals()
    return {
      countup: {
        elapsed: this.elapsedCountupTime(),
        state: this.countupTimer.state,
      },
      focus: {
        elapsed: this.elapsedFocusTime(),
        state: this.focusTimer.state,
      },
      today: {
        elapsed: siteToday,
        state: this.focusTimer.state, // same as focus timer
      },
    }
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
    const away = this.idle === 'locked' || (this.idle === 'idle' && !mediaPlaying())
    if (!this.blocked && !document.hidden && this.windowFocused && !away) {
      this.focusTimer.unpause()
    } else {
      this.creditFocus(() => this.focusTimer.pause())
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

  handleStorageChange = (changes: StoreChanges) => {
    if (IDLE_STATE_KEY in changes) {
      this.setIdle(changes[IDLE_STATE_KEY]?.newValue)
    }
    const change = changes[this.getTodayKey()]
    if (!change) {
      return
    }
    const next = normalizeDay(change.newValue)
    // Authoritative and newer than any load in flight.
    this.usage = next
    this.usageLoad = Promise.resolve()
    // Stored time only ever grows, except when this site's time today is
    // reset (from the popup). Then drop our in-memory accumulation, so the
    // on-screen total reflects the reset and the stale time isn't reported
    // straight back onto the zeroed counter.
    if (this.site !== null && siteTotal(next, this.site) < siteTotal(normalizeDay(change.oldValue), this.site)) {
      this.resetTimers()
      this.unsent = []
      this.inFlight.clear()
    }
  }
}

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
