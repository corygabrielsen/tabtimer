// Which tab is accruing active time: a pure reducer over browser events.
// Pure: no chrome, no DOM. The service worker (sw/tracker.ts) keeps the
// state in storage.session, feeds every event through step(), and applies
// the effects it returns.
//
// Invariants:
//   - at most one interval is open, browser-wide, so two windows (or two
//     tabs) can never count the same moment twice;
//   - an interval opens only on a content script's positive report (a
//     presence that is visible, focused and not blocked) while the user is
//     at the computer (core/away.ts: not locked; not idle unless that page
//     is playing media);
//   - browser events (tab switch, window focus, removal, navigation, idle,
//     lock, blocking) only close the interval, or ask a page to report
//     again (`probe`); a reset of the open site's time only moves the
//     interval's start up to `now`, crediting nothing;
//   - an interval is credited up to `now` while its checkpoints keep
//     coming; after a silence longer than SUSPEND_GAP_MS (the device slept
//     without locking, so no alarm fired) it is credited only up to its
//     last checkpoint: sleep never counts;
//   - each checkpoint credits what has accrued and moves `since` up, so
//     at most one checkpoint period is uncredited at any moment (the bound
//     on time lost if the browser crashes).
import type { IdleState } from './away'
import type { Site } from './site'
import { isBool, isFiniteNumber } from './guards'
import { parsePresence } from './messages'

// The checkpoint alarm's period.
export const CHECKPOINT_MS = 60_000

// The longest silence since the last checkpoint (the alarm, or a report
// from the open page) still taken as the page in use. Longer means the
// device was suspended: the time since the last checkpoint is not credited.
// While the device is awake the 60 s alarm runs late by a few seconds at
// most (timer coalescing, the worker starting up), so 1.5 periods leaves
// room for that jitter and never mistakes normal use for a suspension
// (which would drop up to a period of real use). Alarms don't fire during
// sleep and a missed one fires on wake, so any sleep that ends more than
// 90 s after the last checkpoint is caught and counts none of it; only a
// nap of under 90 s in all can slip through, counted as use.
export const SUSPEND_GAP_MS = 90_000

// What a content script reports about its page.
export type Presence = { visible: boolean; focused: boolean; media: boolean; blocked: boolean }

// The latest report from one tab. `doc` identifies the document that sent
// it ('' if unknown). `departing`: that document is no longer the tab's
// shown page (it is in the back/forward cache, or unloading), so its report
// never accrues and never replaces another document's. `at`: when the
// worker heard it (step() sets it).
export type Attest = Presence & { site: Site; windowId: number; doc: string; departing: boolean; at: number }

// The interval accruing time: [since, now) is not yet credited, and
// `checkpoint` is the last time the worker saw it alive.
export type Open = {
  tabId: number
  windowId: number
  doc: string
  site: Site
  media: boolean
  since: number
  checkpoint: number
}

// Kept in storage.session by the service worker. `tabs` is keyed by tab id.
export type TrackerState = { tabs: Record<string, Attest>; open: Open | null }

export type TrackerEvent =
  | { kind: 'presence'; tabId: number; attest: Attest }
  | { kind: 'activated'; tabId: number; windowId: number }
  // windowId null: no Chrome window has focus.
  | { kind: 'windowFocus'; windowId: number | null }
  | { kind: 'removed'; tabId: number }
  // The tab's top frame moved to `site` (null: a page that isn't tracked,
  // or one whose URL the worker can't see).
  | { kind: 'navigated'; tabId: number; site: Site | null }
  | { kind: 'idle'; state: IdleState }
  | { kind: 'checkpoint' }
  // The open tab's site is over its limit (the worker's backstop).
  | { kind: 'overLimit'; tabId: number }
  // The site's time today was zeroed.
  | { kind: 'reset'; site: Site }

// Time to credit to a site: [start, end), with media playing or not.
export type Accrual = { site: Site; start: number; end: number; media: boolean }

export type Step = {
  state: TrackerState
  credits: Accrual[]
  // Tabs whose state changed: tell them.
  push: number[]
  // Tabs to ask for a fresh report (which may open an interval).
  probe: number[]
}

export function initialTracker(): TrackerState {
  return { tabs: {}, open: null }
}

function normalizeAttest(v: unknown): Attest | null {
  const a = v as Partial<Attest> | null
  if (!a || typeof a !== 'object' || typeof a.site !== 'string' || typeof a.doc !== 'string') {
    return null
  }
  const presence = parsePresence(a)
  if (!isFiniteNumber(a.windowId) || !isFiniteNumber(a.at) || !isBool(a.departing) || !presence) {
    return null
  }
  const { site, windowId, doc, departing, at } = a
  return { site, windowId, doc, departing, at, ...presence }
}

function normalizeOpen(v: unknown): Open | null {
  const o = v as Partial<Open> | null
  if (!o || typeof o !== 'object' || typeof o.site !== 'string' || typeof o.doc !== 'string') {
    return null
  }
  if (!isFiniteNumber(o.tabId) || !isFiniteNumber(o.windowId) || !isBool(o.media)) {
    return null
  }
  if (!isFiniteNumber(o.since) || !isFiniteNumber(o.checkpoint)) {
    return null
  }
  const { tabId, windowId, doc, site, media, since, checkpoint } = o
  return { tabId, windowId, doc, site, media, since, checkpoint }
}

// A stored TrackerState, or the initial one where it is missing or
// malformed (a malformed attestation is dropped on its own).
export function normalizeTracker(value: unknown): TrackerState {
  const v = value as Partial<TrackerState> | null
  if (!v || typeof v !== 'object') {
    return initialTracker()
  }
  const tabs: Record<string, Attest> = {}
  if (v.tabs && typeof v.tabs === 'object') {
    for (const [id, raw] of Object.entries(v.tabs)) {
      const attest = normalizeAttest(raw)
      if (attest) {
        tabs[id] = attest
      }
    }
  }
  return { tabs, open: normalizeOpen(v.open) }
}

// Whether a page in this state may accrue time.
export function canAccrue(p: Presence, idle: IdleState): boolean {
  if (!p.visible || !p.focused || p.blocked || idle === 'locked') {
    return false
  }
  return idle === 'active' || p.media
}

// Whether the open interval went silent for longer than an awake device
// allows (see SUSPEND_GAP_MS).
export function suspended(open: Open, now: number): boolean {
  return now - open.checkpoint > SUSPEND_GAP_MS
}

// The open interval's end when closed at `now`: now, or after a suspension
// its last checkpoint; never before it started (a clock that jumps back
// credits nothing).
export function creditEnd(open: Open, now: number): number {
  return Math.max(open.since, suspended(open, now) ? open.checkpoint : now)
}

// Whether a tab's report lets it accrue time.
function live(a: Attest, idle: IdleState): boolean {
  return !a.departing && canAccrue(a, idle)
}

function accrual(open: Open, end: number): Accrual[] {
  return end > open.since ? [{ site: open.site, start: open.since, end, media: open.media }] : []
}

// Most recent first, then the lowest tab id (a stable order).
function freshest(tabs: Record<string, Attest>, idle: IdleState): number | null {
  let best: [number, Attest] | null = null
  for (const [id, attest] of Object.entries(tabs)) {
    if (live(attest, idle) && (!best || attest.at > best[1].at)) {
      best = [Number(id), attest]
    }
  }
  return best ? best[0] : null
}

class Builder {
  readonly credits: Accrual[] = []
  readonly push = new Set<number>()
  readonly probe = new Set<number>()
  tabs: Record<string, Attest>
  open: Open | null

  constructor(
    s: TrackerState,
    readonly now: number
  ) {
    this.tabs = { ...s.tabs }
    this.open = s.open
  }

  close(): void {
    const open = this.open
    if (open) {
      this.credits.push(...accrual(open, creditEnd(open, this.now)))
      this.push.add(open.tabId)
      this.open = null
    }
  }

  start(tabId: number, a: Attest): void {
    this.close()
    this.open = {
      tabId,
      windowId: a.windowId,
      doc: a.doc,
      site: a.site,
      media: a.media,
      since: this.now,
      checkpoint: this.now,
    }
  }

  // Credit what has accrued and keep going (from `now`).
  advance(changes: Partial<Open> = {}): void {
    const open = this.open!
    this.credits.push(...accrual(open, this.now))
    this.open = { ...open, ...changes, since: Math.max(open.since, this.now), checkpoint: this.now }
  }

  done(): Step {
    return {
      state: { tabs: this.tabs, open: this.open },
      credits: this.credits,
      push: [...this.push],
      probe: [...this.probe].filter((id) => String(id) in this.tabs),
    }
  }
}

function presence(b: Builder, tabId: number, a: Attest, idle: IdleState): void {
  const key = String(tabId)
  const previous = b.tabs[key]
  // A late report from a document this tab has already replaced (the page
  // navigated away, and its hiding arrived after the new page's report)
  // changes nothing.
  if (a.departing && previous && previous.doc !== a.doc) {
    return
  }
  const accrues = live(a, idle)
  b.tabs[key] = { ...a, at: b.now }
  const open = b.open
  const same = open !== null && open.tabId === tabId && open.doc === a.doc && open.site === a.site
  // A report after a gap (the device slept with the page open) starts over:
  // the gap is credited only up to the cap.
  const fresh = same && !suspended(open, b.now) && b.now >= open.since
  if (accrues) {
    if (fresh) {
      // Alive. A change in media playing starts a new piece, credited as
      // the time accrued (core/away.ts treats the two differently).
      if (open.media !== a.media) {
        b.advance({ media: a.media })
      } else {
        b.open = { ...open, checkpoint: b.now }
      }
    } else {
      b.start(tabId, a)
    }
  } else if (open?.tabId === tabId) {
    b.close()
  }
}

// Apply one event at `now`, with the user's current idle state (after the
// event, for an idle event).
export function step(s: TrackerState, e: TrackerEvent, now: number, idle: IdleState): Step {
  const b = new Builder(s, now)
  const open = b.open
  switch (e.kind) {
    case 'presence':
      presence(b, e.tabId, e.attest, idle)
      break
    case 'activated':
      // Another tab came to the front of the open tab's window.
      if (open && open.windowId === e.windowId && open.tabId !== e.tabId) {
        b.close()
      }
      b.probe.add(e.tabId)
      break
    case 'windowFocus':
      if (open && open.windowId !== e.windowId) {
        b.close()
      }
      if (e.windowId !== null) {
        for (const [id, attest] of Object.entries(b.tabs)) {
          if (attest.windowId === e.windowId) {
            b.probe.add(Number(id))
          }
        }
      }
      break
    case 'removed':
      if (open?.tabId === e.tabId) {
        b.close()
      }
      b.push.delete(e.tabId)
      delete b.tabs[String(e.tabId)]
      break
    case 'navigated': {
      if (open?.tabId === e.tabId && open.site !== e.site) {
        b.close()
      }
      const key = String(e.tabId)
      if (b.tabs[key] && b.tabs[key].site !== e.site) {
        delete b.tabs[key]
        b.push.delete(e.tabId)
      }
      break
    }
    case 'idle':
      if (open && !canAccrue({ visible: true, focused: true, blocked: false, media: open.media }, idle)) {
        b.close()
      }
      if (!b.open) {
        // Back at the computer: the page last seen in use reports again.
        const candidate = freshest(b.tabs, 'active')
        if (candidate !== null && idle !== 'locked') {
          b.probe.add(candidate)
        }
      }
      break
    case 'checkpoint':
      if (open) {
        if (suspended(open, now) || now < open.since) {
          // A gap (the device slept) or a clock jump: credit up to the last
          // checkpoint, then reopen only if the page still reports being
          // in use.
          b.close()
          b.probe.add(open.tabId)
        } else {
          b.advance()
          b.push.add(open.tabId)
        }
      }
      break
    case 'overLimit':
      if (open?.tabId === e.tabId) {
        b.close()
      }
      break
    case 'reset':
      // The open interval's time so far goes too: it starts again from now.
      if (open?.site === e.site) {
        b.open = { ...open, since: now }
      }
      for (const [id, attest] of Object.entries(b.tabs)) {
        if (attest.site === e.site) {
          b.push.add(Number(id))
        }
      }
      break
  }
  return b.done()
}
