// The message contract between the extension's pages/content script and the
// service worker, the only writer of chrome.storage.local. Pure: no chrome,
// no DOM.
//
// Requests are untrusted input: the service worker accepts only what
// parseRequest (core/requests.ts) returns. A content script never names the
// site it reports for; the service worker derives it from the sender's URL.
import { dayOf, isDayStamp, startOfDay, type DayStamp } from './day'
import { isBool, isFiniteNumber, isObject } from './guards'
import type { BlockReason, BlockScope, LimitEdit } from './limits'
import { withTimeAt, HOURS_PER_DAY, type Prefs } from './schema'
import type { Site } from './site'
import type { Presence } from './tracker'

type Empty = Record<never, never>

// The extension pages a content script may open.
export type Page = 'options' | 'activity'

// What a tracked page shows and enforces, as the service worker sees it at
// `asOf`. The page keeps the display ticking from there: while `running`
// (this tab's interval is open) both totals grow with the clock.
export type TabState = {
  site: Site
  // The local day the totals are for.
  day: DayStamp
  asOf: number
  // The worker transaction that built it: a later one has a higher seq
  // (asOf can tie, or go back with the clock).
  seq: number
  // This site's time today, and every tracked site's combined.
  today: number
  globalToday: number
  running: boolean
  // When the page must block (epoch ms; null: not before something
  // changes), and the limit that then applies.
  blockAt: number | null
  limit: { scope: BlockScope; ms: number } | null
  // The snoozes today that count against that limit (this site's own, when
  // none applies): the time each began at, in the limit's measure, oldest
  // first (core/snooze.ts snoozeMarks).
  snoozes: number[]
  // This site's time today per local hour (index 0 = 00:00), the open
  // interval's uncredited part in the hour of `asOf`: `today`, by hour.
  hours: number[]
  // The overlay preferences (the worker is their only writer).
  prefs: Prefs
}

// How far past `asOf` a running state holds. The worker tells the open tab
// its state every checkpoint, and credits nothing past a longer silence
// (SUSPEND_GAP_MS, core/tracker.ts): a running state older than this has
// missed what the worker said since (the device slept, the page was in the
// back/forward cache), and projects no further.
export const PROJECT_MS = 90_000

// Whether `s` is running and too old to project at `now`.
function stale(s: { asOf: number; running: boolean }, now: number): boolean {
  return s.running && now - s.asOf > PROJECT_MS
}

// `ms` as of `asOf` on `day`, read at `now`: plus the time since while
// running, up to PROJECT_MS. Past midnight, only the running time since
// midnight.
function grownAt(ms: number, s: { day: DayStamp; asOf: number; running: boolean }, now: number): number {
  const end = Math.min(now, s.asOf + PROJECT_MS)
  if (dayOf(now) !== s.day) {
    return s.running ? Math.max(0, end - Math.max(s.asOf, startOfDay(now))) : 0
  }
  return ms + (s.running ? Math.max(0, end - s.asOf) : 0)
}

// A state's totals at `now`.
export function totalsAt(s: TabState, now: number): { siteToday: number; globalToday: number } {
  return { siteToday: grownAt(s.today, s, now), globalToday: grownAt(s.globalToday, s, now) }
}

// A state's site's time today by hour at `now`: what the state grew by
// since `asOf` goes into the current hour. Past midnight, only that.
export function hoursAt(s: TabState, now: number): number[] {
  const { siteToday } = totalsAt(s, now)
  const sameDay = dayOf(now) === s.day
  return withTimeAt(sameDay ? s.hours : undefined, now, siteToday - (sameDay ? s.today : 0))
}

// Every site's time today as the service worker sees it at `asOf`: what
// storage holds plus the open interval's uncredited part, which is the
// `running` site's (null: none open).
export type TodayTotals = {
  day: DayStamp
  asOf: number
  seq: number
  running: Site | null
  sites: Record<Site, number>
  // How many snoozes each site's block screen took today.
  snoozes: Record<Site, number>
}

// One site's time today at `now`.
export function siteTodayAt(t: TodayTotals, site: Site, now: number): number {
  return grownAt(t.sites[site] ?? 0, { ...t, running: t.running === site }, now)
}

// Whether `site`'s time today has reached its own `limit` (ms; null: none)
// at `now`, by the worker's totals: overAt's rule with the snooze ignored
// (the popup's), for a page that shows every site.
export function siteOverAt(t: TodayTotals, site: Site, limit: number | null, now: number): boolean {
  const s = { ...t, running: t.running === site }
  return limit !== null && dayOf(now) === t.day && !stale(s, now) && siteTodayAt(t, site, now) >= limit
}

// The totals to keep after asking the worker: its answer, unless an earlier
// transaction's (a lower seq) than `kept`; null when it doesn't answer.
export function latestTotals(kept: TodayTotals | null, res: Response<'todayTotals'>): TodayTotals | null {
  if (!res.ok) {
    return null
  }
  return kept === null || res.value.seq >= kept.seq ? res.value : kept
}

// The limit a state is over at `now`, or null: the one rule for the block
// screen, the worker's backstop and the popup. The worker moves blockAt
// past `now` for a snooze; while the snooze 'holds' the state is over
// nothing until blockAt, and 'ignored' it is over from the moment it
// reaches its limit. A state from before midnight, or running and stale,
// is over nothing: a projection the worker hasn't confirmed never blocks.
export function overAt(s: TabState, now: number, snooze: 'holds' | 'ignored'): BlockReason | null {
  if (s.limit === null || s.blockAt === null || dayOf(now) !== s.day || stale(s, now)) {
    return null
  }
  const totals = totalsAt(s, now)
  const elapsed = s.limit.scope === 'site' ? totals.siteToday : totals.globalToday
  const over = now >= s.blockAt || (snooze === 'ignored' && elapsed >= s.limit.ms)
  return over ? { scope: s.limit.scope, limit: s.limit.ms, elapsed } : null
}

export type Contract = {
  // content: the page's visibility, focus, media and block screen changed
  // (or it was asked). The service worker decides which one tab accrues
  // time and replies with this tab's state.
  presence: { req: Presence; res: TabState }
  // extension pages: the state a tab on `site` is told (the popup's face).
  tabState: { req: { tabId: number; site: Site }; res: TabState }
  // extension pages: every site's time today (the settings page's figures).
  todayTotals: { req: Empty; res: TodayTotals }
  // extension pages: change one limit (read-modify-write in the worker).
  setLimit: { req: LimitEdit; res: null }
  // content: suppress blocking for SNOOZE_MS.
  snooze: { req: Empty; res: null }
  // content, extension pages: change overlay preferences.
  setPrefs: { req: Partial<Prefs>; res: null }
  // content: close the sending page's tab (the block screen's way out).
  closeTab: { req: Empty; res: null }
  // content: open the options page, or the activity page in a new tab (the
  // block stays up).
  open: { req: { page: Page }; res: null }
}

// The service worker's message to a tracked page (chrome.tabs.sendMessage):
// its new state. The page replies with its Presence; with `probe`, the
// worker takes that reply as a fresh report (how it asks a page to report
// again), and otherwise ignores it.
export type StatePush = { type: 'state'; state: TabState; probe: boolean }

// The service worker's message to a page whose site is no longer tracked
// (its grant was revoked): stop counting and remove the page's UI.
export type StopPush = { type: 'stop' }

export type MessageType = keyof Contract

export type RequestOf<K extends MessageType> = { type: K } & Contract[K]['req']

export type Request = { [K in MessageType]: RequestOf<K> }[MessageType]

// 'untracked': the sending page is on no granted site; it stops.
export type ErrorCode = 'bad_request' | 'forbidden' | 'untracked' | 'internal' | 'unreachable'

export type Response<K extends MessageType> = { ok: true; value: Contract[K]['res'] } | { ok: false; error: ErrorCode }

// Who may send each request: a content script in a tracked page, an
// extension page (popup, options), or both.
export type Origin = 'content' | 'extension'

export const SENDERS: { [K in MessageType]: readonly Origin[] } = {
  presence: ['content'],
  tabState: ['extension'],
  todayTotals: ['extension'],
  setLimit: ['extension'],
  snooze: ['content'],
  closeTab: ['content'],
  setPrefs: ['content', 'extension'],
  open: ['content'],
}

// A Presence: four booleans, nothing else kept. null = reject.
export function parsePresence(raw: unknown): Presence | null {
  if (!isObject(raw)) {
    return null
  }
  const { visible, focused, media, blocked } = raw
  if (!isBool(visible) || !isBool(focused) || !isBool(media) || !isBool(blocked)) {
    return null
  }
  return { visible, focused, media, blocked }
}

export function isStopPush(raw: unknown): raw is StopPush {
  return isObject(raw) && raw.type === 'stop'
}

// A StatePush, its state checked field by field (content scripts trust
// only this extension, but a malformed state must not break the page).
export function parseStatePush(raw: unknown): StatePush | null {
  if (!isObject(raw) || raw.type !== 'state' || !isObject(raw.state) || !isBool(raw.probe)) {
    return null
  }
  const s = raw.state
  if (typeof s.site !== 'string' || !isDayStamp(s.day)) {
    return null
  }
  if (!isFiniteNumber(s.asOf) || !isFiniteNumber(s.seq) || !isFiniteNumber(s.today) || !isFiniteNumber(s.globalToday)) {
    return null
  }
  if (!isBool(s.running) || (s.blockAt !== null && !isFiniteNumber(s.blockAt))) {
    return null
  }
  let limit: TabState['limit'] = null
  if (s.limit !== null) {
    const l = s.limit
    if (!isObject(l) || (l.scope !== 'site' && l.scope !== 'global') || !isFiniteNumber(l.ms)) {
      return null
    }
    limit = { scope: l.scope, ms: l.ms }
  }
  if (!Array.isArray(s.snoozes) || !(s.snoozes as unknown[]).every(isFiniteNumber)) {
    return null
  }
  const hours = s.hours
  if (!Array.isArray(hours) || hours.length !== HOURS_PER_DAY || !(hours as unknown[]).every(isFiniteNumber)) {
    return null
  }
  const p = s.prefs
  if (!isObject(p) || !isBool(p.hidden) || !isFiniteNumber(p.scale)) {
    return null
  }
  const state: TabState = {
    site: s.site,
    day: s.day,
    asOf: s.asOf,
    seq: s.seq,
    today: s.today,
    globalToday: s.globalToday,
    running: s.running,
    blockAt: s.blockAt,
    limit,
    snoozes: [...(s.snoozes as number[])],
    hours: [...(hours as number[])],
    prefs: { hidden: p.hidden, scale: p.scale },
  }
  return { type: 'state', state, probe: raw.probe }
}
