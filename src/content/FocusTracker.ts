import { bus as chromeBus, pushes as chromePushes } from '../chrome/bus'
import { systemClock } from '../chrome/clock'
import { logicalDay, startOfLogicalDay, type DayStamp } from '../core/day'
import type { BlockReason } from '../core/limits'
import { overAt, PROJECT_MS, totalsAt, type TabState } from '../core/messages'
import type { Prefs } from '../core/schema'
import type { Presence } from '../core/tracker'
import type { Bus, Clock, Pushes } from '../ports'
import { shadowRootOf } from './shadowHost'

// What the overlay shows: this site's time today, this page's focus time,
// and how long the page has been open (both since the day started at most).
export type ElapsedState = { today: number; focus: number; session: number }

// What the limits are checked against. `site` is null until the service
// worker has answered.
export type Totals = { site: string | null; siteToday: number; globalToday: number }

// The tab's single tick source: rendering and limit checks run off it.
export const TICK_MS = 1000
// After a report fails, wait this long before sending it again.
const RETRY_MS = 10_000
// Look for open shadow roots (and the media in them) every this many ticks
// while the page is shown.
const SCAN_TICKS = 5

// The page's side of active time. The service worker decides which one tab
// accrues (core/tracker.ts); this reports the page's presence (visible,
// focused, playing media, blocked) whenever it changes, and keeps the
// display ticking from the TabState the worker replies with or pushes.
// Presence is read from the document each time; events and ticks only say
// when to look. Nothing here is counted: closing the page loses no time.
export default class FocusTracker {
  private started = false
  private intervalId: ReturnType<typeof setInterval> | null = null
  private tickListeners = new Set<() => void>()
  private stateListeners = new Set<() => void>()
  private stopListeners = new Set<() => void>()
  private unsubscribePush: (() => void) | null = null
  private unsubscribeStop: (() => void) | null = null
  private state: TabState | null = null
  private blocked = false
  // A snooze asked for and not yet reflected in a state from the worker.
  private snoozing = false
  // The presence last reported (null: none, or it failed). A failed one
  // isn't sent again before `retry.at`; any other presence is.
  private lastReport: Presence | null = null
  private retry: { presence: Presence; at: number } | null = null
  // A blur's look at focus, once focus has settled (see handleBlur).
  private blurTimer: ReturnType<typeof setTimeout> | null = null
  // The page's video and audio elements (live: the DOM keeps them current),
  // and the shadow roots last found, whose media they don't include.
  private media: HTMLCollectionOf<HTMLMediaElement>[] = []
  private roots = new Set<ShadowRoot>()
  private ticks = 0
  // Display-only stopwatches: when the page opened, this page's focus time
  // so far, since when it has been running (null: not running), and where
  // the last running piece ended (no moment counts twice).
  private sessionStart: number
  private focusDone = 0
  private focusFrom: number | null = null
  private focusEnd = 0
  // The day the stopwatches are for, and the hour days start at (the
  // worker's word; midnight until it has said).
  private day: DayStamp
  private dayStart = 0
  // The page's last tick (or state): a longer silence than PROJECT_MS since
  // is a gap (the device slept, the page was frozen).
  private lastSeen: number

  constructor(
    private clock: Clock = systemClock,
    private bus: Bus = chromeBus,
    private pushes: Pushes = chromePushes
  ) {
    this.sessionStart = this.clock.now()
    this.lastSeen = this.sessionStart
    this.day = logicalDay(this.sessionStart, this.dayStart)
  }

  start(): void {
    if (this.started) {
      throw new Error('FocusTracker already started')
    }
    this.started = true
    this.media = [document.getElementsByTagName('video'), document.getElementsByTagName('audio')]
    document.addEventListener('visibilitychange', this.handleChange)
    // A prerendered page can't report (the worker refuses it) until shown.
    document.addEventListener('prerenderingchange', this.handleChange)
    window.addEventListener('blur', this.handleBlur)
    window.addEventListener('focus', this.handleChange)
    // Media starting or stopping decides whether idle time counts.
    for (const type of MEDIA_EVENTS) {
      document.addEventListener(type, this.handleChange, true)
    }
    this.scan()
    this.unsubscribePush = this.pushes.onState((state, probe) => {
      this.apply(state)
      const presence = this.presence()
      // Only a probe's reply is taken as a report.
      if (probe) {
        this.lastReport = presence
        this.retry = null
      }
      return presence
    })
    this.unsubscribeStop = this.pushes.onStop(this.stop)
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
    if (this.blurTimer !== null) {
      clearTimeout(this.blurTimer)
      this.blurTimer = null
    }
    this.tickListeners.clear()
    this.stateListeners.clear()
    this.stopListeners.clear()
    document.removeEventListener('visibilitychange', this.handleChange)
    document.removeEventListener('prerenderingchange', this.handleChange)
    window.removeEventListener('blur', this.handleBlur)
    window.removeEventListener('focus', this.handleChange)
    for (const type of MEDIA_EVENTS) {
      document.removeEventListener(type, this.handleChange, true)
    }
    this.watch(new Set())
    this.unsubscribePush?.()
    this.unsubscribePush = null
    this.unsubscribeStop?.()
    this.unsubscribeStop = null
    if (this.started) {
      this.started = false
      if (!this.bus.alive()) {
        return
      }
      void this.bus.send('presence', { visible: false, focused: false, media: false, blocked: this.blocked })
    }
  }

  // Entering the back/forward cache: hold the state here (the worker's
  // replies and pushes can't reach a frozen page), and report it hidden.
  suspend(): void {
    this.hold(this.clock.now())
    void this.report()
  }

  // Restored from the back/forward cache: report again, and catch up on
  // the worker's state.
  resync(): void {
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

  // Run `listener` when the page must stop: its site is no longer tracked,
  // or the extension that ran it is gone. The tracker is destroyed after.
  onStop(listener: () => void): () => void {
    this.stopListeners.add(listener)
    return () => this.stopListeners.delete(listener)
  }

  // Nothing here may outlive its extension: an orphan's last state would
  // keep ticking and blocking with no worker to answer.
  private stop = () => {
    for (const listener of [...this.stopListeners]) {
      listener()
    }
    this.destroy()
  }

  private tick = () => {
    if (!this.bus.alive()) {
      this.stop()
      return
    }
    const now = this.clock.now()
    this.wake(now)
    const day = logicalDay(now, this.dayStart)
    if (day !== this.day) {
      // A new day: the stopwatches restart, and the worker's totals are
      // yesterday's until it answers.
      this.day = day
      this.focusDone = 0
      if (this.focusFrom !== null) {
        this.focusFrom = startOfLogicalDay(now, this.dayStart)
      }
      void this.report(true)
    } else if (!document.hidden || this.lastReport === null) {
      // Catches what no event announces (media that stalled or ran out,
      // focus leaving the browser from inside a frame). A hidden page never
      // accrues, so only a failed report is retried there.
      if (!document.hidden && ++this.ticks % SCAN_TICKS === 0) {
        this.scan()
      }
      void this.report()
    }
    for (const listener of this.tickListeners) {
      listener()
    }
  }

  // After a gap, what the page last knew holds from its last tick until the
  // worker answers again.
  private wake(now: number): void {
    if (now - this.lastSeen > PROJECT_MS) {
      this.hold(this.lastSeen)
      void this.report(true)
    }
    this.lastSeen = now
  }

  // Stop projecting the state at `at`: a running state becomes what it
  // showed then, with any block it hadn't reached by then dropped (only
  // the worker can confirm one), and the focus stopwatch stops there.
  private hold(at: number): void {
    const s = this.state
    if (s?.running) {
      const totals = totalsAt(s, at)
      const reached = s.blockAt !== null && s.blockAt <= at
      this.state = {
        ...s,
        day: logicalDay(at, this.dayStart),
        asOf: at,
        today: totals.siteToday,
        globalToday: totals.globalToday,
        running: false,
        blockAt: reached ? s.blockAt : null,
        limit: reached ? s.limit : null,
      }
    }
    this.closeFocus(at)
  }

  private closeFocus(at: number): void {
    if (this.focusFrom !== null) {
      this.focusDone += Math.max(0, at - this.focusFrom)
      this.focusEnd = Math.max(this.focusFrom, at)
      this.focusFrom = null
    }
  }

  // Focus is the document's: kept while it is in one of the page's frames,
  // gone while the window is in the background.
  private presence(): Presence {
    return {
      visible: !document.hidden,
      focused: document.hasFocus(),
      media: this.media.some(anyPlaying) || [...this.roots].some((root) => anyPlaying(mediaIn(root))),
      blocked: this.blocked,
    }
  }

  // Find the page's shadow roots (closed ones too): media events in one
  // don't reach the document, so each is listened to on its own.
  private scan(): void {
    this.watch(new Set(shadowRoots(document)))
  }

  private watch(roots: Set<ShadowRoot>): void {
    for (const root of this.roots) {
      if (!roots.has(root)) {
        for (const type of MEDIA_EVENTS) {
          root.removeEventListener(type, this.handleChange, true)
        }
      }
    }
    for (const root of roots) {
      if (!this.roots.has(root)) {
        for (const type of MEDIA_EVENTS) {
          root.addEventListener(type, this.handleChange, true)
        }
      }
    }
    this.roots = roots
  }

  // Tell the worker the page's presence, if it changed (or `force`), and
  // apply the state it replies with. A prerendered page waits to be shown.
  async report(force = false): Promise<void> {
    if (!this.started || prerendering()) {
      return
    }
    const presence = this.presence()
    const now = this.clock.now()
    const retry = this.retry
    const waiting = retry !== null && now < retry.at && samePresence(presence, retry.presence)
    if (!force && (samePresence(presence, this.lastReport) || waiting)) {
      return
    }
    this.lastReport = presence
    this.retry = null
    const response = await this.bus.send('presence', presence)
    if (response.ok) {
      this.apply(response.value)
    } else if (response.error === 'untracked' || !this.bus.alive()) {
      this.stop()
    } else if (this.lastReport === presence) {
      // Not heard: send it again once the worker may be back.
      this.lastReport = null
      this.retry = { presence, at: now + RETRY_MS }
    }
  }

  // Take a state from the worker, unless this one or one it built later
  // already came (a state held since stays held).
  private apply(state: TabState): void {
    const now = this.clock.now()
    this.wake(now)
    if (this.state && state.seq <= this.state.seq) {
      return
    }
    if (state.prefs.dayStart !== this.dayStart) {
      // Days start at another hour: the stopwatches are for the day it now
      // is, and keep what they have.
      this.dayStart = state.prefs.dayStart
      this.day = logicalDay(now, this.dayStart)
    }
    if (state.running && this.focusFrom === null) {
      this.focusFrom = Math.max(state.asOf, startOfLogicalDay(now, this.dayStart), this.focusEnd)
    } else if (!state.running) {
      this.closeFocus(state.asOf)
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

  // The worker's last state for this tab (null: none yet).
  get tabState(): TabState | null {
    return this.state
  }

  // The overlay preferences, once the worker has said.
  get prefs(): Prefs | null {
    return this.state?.prefs ?? null
  }

  // Today's totals now: as of the worker's last state, plus the time since
  // while this tab is the one accruing. Once the next day has started, until
  // the worker answers, only the time since it did.
  readTotals(): Totals {
    const s = this.state
    if (!s) {
      return { site: null, siteToday: 0, globalToday: 0 }
    }
    return { site: s.site, ...totalsAt(s, this.clock.now()) }
  }

  // The focus stopwatch runs to now, or after a gap not yet ticked over,
  // to the last tick.
  readElapsed(): ElapsedState {
    const now = this.clock.now()
    const end = now - this.lastSeen > PROJECT_MS ? this.lastSeen : now
    const focus = this.focusDone + (this.focusFrom === null ? 0 : Math.max(0, end - this.focusFrom))
    return {
      today: this.readTotals().siteToday,
      focus,
      session: Math.max(0, now - Math.max(this.sessionStart, startOfLogicalDay(now, this.dayStart))),
    }
  }

  // Why the page must block now, or null (core/messages.ts overAt). A
  // snooze being asked for never blocks.
  blockReason(): BlockReason | null {
    return this.state && !this.snoozing ? overAt(this.state, this.clock.now(), 'holds') : null
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

  // The window blurs when focus leaves it, and also when focus moves into
  // one of the page's frames: look now, and again once focus has settled.
  private handleBlur = () => {
    void this.report()
    if (this.blurTimer === null) {
      this.blurTimer = setTimeout(() => {
        this.blurTimer = null
        void this.report()
      }, 0)
    }
  }
}

const MEDIA_EVENTS = ['play', 'playing', 'pause', 'ended'] as const

// Whether the page is being prerendered, not yet shown (Chrome 108; not in
// TypeScript's DOM types).
const prerendering = () => (document as Document & { prerendering?: boolean }).prerendering === true

// Every shadow root under `root`, closed and nested ones included.
function shadowRoots(root: Document | ShadowRoot): ShadowRoot[] {
  const found: ShadowRoot[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const shadow = shadowRootOf(node as Element)
    if (shadow) {
      found.push(shadow, ...shadowRoots(shadow))
    }
  }
  return found
}

const mediaIn = (root: ShadowRoot) => root.querySelectorAll<HTMLMediaElement>('video, audio')

// Whether any of `media` is playing (muted or not): watching or listening
// keeps idle time counting. Media in cross-origin frames or detached
// elements isn't seen here; the worker hears it (tab.audible). readyState 2
// is HAVE_CURRENT_DATA.
function anyPlaying(media: Iterable<HTMLMediaElement>): boolean {
  for (const el of media) {
    if (!el.paused && !el.ended && el.readyState >= 2) {
      return true
    }
  }
  return false
}

function samePresence(a: Presence, b: Presence | null): boolean {
  return (
    b !== null && a.visible === b.visible && a.focused === b.focused && a.media === b.media && a.blocked === b.blocked
  )
}
