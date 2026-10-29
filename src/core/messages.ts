// The message contract between the extension's pages/content script and the
// service worker, the only writer of chrome.storage.local. Pure: no chrome,
// no DOM.
//
// Requests are untrusted input: the service worker accepts only what
// parseRequest returns. A content script never names the site it reports
// for; the service worker derives it from the sender's URL.
import type { DayStamp } from './day'
import type { BlockScope, LimitEdit, Limits } from './limits'
import { MAX_SCALE, MIN_SCALE, type Prefs } from './schema'
import type { Site } from './site'
import type { Presence } from './tracker'

type Empty = Record<never, never>

// What a tracked page shows and enforces, as the service worker sees it at
// `asOf`. The page keeps the display ticking from there: while `running`
// (this tab's interval is open) both totals grow with the clock.
export type TabState = {
  site: Site
  // The local day the totals are for.
  day: DayStamp
  asOf: number
  // This site's time today, and every tracked site's combined.
  today: number
  globalToday: number
  running: boolean
  // When the page must block (epoch ms; null: not before something
  // changes), and the limit that then applies.
  blockAt: number | null
  limit: { scope: BlockScope; ms: number } | null
}

export type Contract = {
  // content: the page's visibility, focus, media and block screen changed
  // (or it was asked). The service worker decides which one tab accrues
  // time and replies with this tab's state.
  presence: { req: Presence; res: TabState }
  // extension pages: zero one site's time today.
  resetToday: { req: { site: Site }; res: null }
  // extension pages: change one limit (read-modify-write in the worker).
  setLimit: { req: LimitEdit; res: Limits }
  // content, extension pages: suppress blocking for SNOOZE_MS.
  snooze: { req: Empty; res: { snoozeUntil: number } }
  // content, extension pages: change overlay preferences.
  setPrefs: { req: Partial<Prefs>; res: Prefs }
  // content: open the options page.
  openOptions: { req: Empty; res: null }
}

// The service worker's message to a tracked page (chrome.tabs.sendMessage):
// its new state. The page replies with its Presence, which is how the worker
// asks a page to report again.
export type StatePush = { type: 'state'; state: TabState }

export type MessageType = keyof Contract

export type RequestOf<K extends MessageType> = { type: K } & Contract[K]['req']

export type Request = { [K in MessageType]: RequestOf<K> }[MessageType]

export type ErrorCode = 'bad_request' | 'forbidden' | 'internal' | 'unreachable'

export type Response<K extends MessageType> = { ok: true; value: Contract[K]['res'] } | { ok: false; error: ErrorCode }

// Who may send each request: a content script in a tracked page, an
// extension page (popup, options), or both.
export type Origin = 'content' | 'extension'

export const SENDERS: { [K in MessageType]: readonly Origin[] } = {
  presence: ['content'],
  resetToday: ['extension'],
  setLimit: ['extension'],
  snooze: ['content', 'extension'],
  setPrefs: ['content', 'extension'],
  openOptions: ['content', 'extension'],
}

export const MAX_LIMIT_MS = 1440 * 60_000

type Raw = Record<string, unknown>

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// A plausible lowercase hostname. The service worker additionally checks it
// is a site in canonical form (that needs the public suffix list).
function isSiteString(v: unknown): v is Site {
  return typeof v === 'string' && v.length > 0 && v.length <= 253 && /^[a-z0-9.\-[\]:]+$/.test(v)
}

// A Presence: four booleans, nothing else kept. null = reject.
export function parsePresence(raw: unknown): Presence | null {
  if (!isObject(raw)) {
    return null
  }
  const { visible, focused, media, blocked } = raw
  if (
    typeof visible !== 'boolean' ||
    typeof focused !== 'boolean' ||
    typeof media !== 'boolean' ||
    typeof blocked !== 'boolean'
  ) {
    return null
  }
  return { visible, focused, media, blocked }
}

// A pushed TabState, checked field by field (content scripts trust only
// this extension, but a malformed state must not break the page).
export function parseStatePush(raw: unknown): TabState | null {
  if (!isObject(raw) || raw.type !== 'state' || !isObject(raw.state)) {
    return null
  }
  const s = raw.state
  if (typeof s.site !== 'string' || typeof s.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.day)) {
    return null
  }
  if (!isFiniteNumber(s.asOf) || !isFiniteNumber(s.today) || !isFiniteNumber(s.globalToday)) {
    return null
  }
  if (typeof s.running !== 'boolean' || (s.blockAt !== null && !isFiniteNumber(s.blockAt))) {
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
  return {
    site: s.site,
    day: s.day as DayStamp,
    asOf: s.asOf,
    today: s.today,
    globalToday: s.globalToday,
    running: s.running,
    blockAt: s.blockAt,
    limit,
  }
}

function parseLimitMs(v: unknown): number | null | undefined {
  if (v === null) {
    return null
  }
  return isFiniteNumber(v) && v >= 60_000 && v <= MAX_LIMIT_MS ? v : undefined
}

function parsePrefs(raw: Raw): Partial<Prefs> | null {
  const prefs: Partial<Prefs> = {}
  if ('hidden' in raw) {
    if (typeof raw.hidden !== 'boolean') {
      return null
    }
    prefs.hidden = raw.hidden
  }
  if ('scale' in raw) {
    if (!isFiniteNumber(raw.scale) || raw.scale < MIN_SCALE || raw.scale > MAX_SCALE) {
      return null
    }
    prefs.scale = raw.scale
  }
  return Object.keys(prefs).length > 0 ? prefs : null
}

// Validate an incoming message against the contract. The result is rebuilt
// from the checked fields only, so anything else in the payload (a `site` on
// a content request, say) is dropped. null = reject.
export function parseRequest(raw: unknown): Request | null {
  if (!isObject(raw)) {
    return null
  }
  switch (raw.type) {
    case 'snooze':
      return { type: 'snooze' }
    case 'openOptions':
      return { type: 'openOptions' }
    case 'presence': {
      const presence = parsePresence(raw)
      return presence ? { type: 'presence', ...presence } : null
    }
    case 'resetToday':
      return isSiteString(raw.site) ? { type: 'resetToday', site: raw.site } : null
    case 'setLimit': {
      const ms = parseLimitMs(raw.ms)
      if (ms === undefined) {
        return null
      }
      if (raw.scope === 'global') {
        return { type: 'setLimit', scope: 'global', ms }
      }
      if (raw.scope === 'site' && isSiteString(raw.site)) {
        return { type: 'setLimit', scope: 'site', site: raw.site, ms }
      }
      return null
    }
    case 'setPrefs': {
      const prefs = parsePrefs(raw)
      return prefs ? { type: 'setPrefs', ...prefs } : null
    }
    default:
      return null
  }
}
