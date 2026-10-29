// The message contract between the extension's pages/content script and the
// service worker, the only writer of chrome.storage.local. Pure: no chrome,
// no DOM.
//
// Requests are untrusted input: the service worker accepts only what
// parseRequest returns. A content script never names the site it reports
// for; the service worker derives it from the sender's URL.
import type { LimitEdit, Limits } from './limits'
import { MAX_SCALE, MIN_SCALE, type Prefs } from './schema'
import type { Site } from './site'

// A stretch of active time, [start, end) in epoch ms.
export type Span = [start: number, end: number]

type Empty = Record<never, never>

export type Contract = {
  // content: which site this page counts under.
  hello: { req: Empty; res: { site: Site } }
  // content: credit active time to the sender's site. The service worker
  // assigns it to local days and hours. Replies with the site's total today.
  addElapsed: { req: { spans: Span[] }; res: { total: number } }
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

export type MessageType = keyof Contract

export type RequestOf<K extends MessageType> = { type: K } & Contract[K]['req']

export type Request = { [K in MessageType]: RequestOf<K> }[MessageType]

export type ErrorCode = 'bad_request' | 'forbidden' | 'internal' | 'unreachable'

export type Response<K extends MessageType> = { ok: true; value: Contract[K]['res'] } | { ok: false; error: ErrorCode }

// Who may send each request: a content script in a tracked page, an
// extension page (popup, options), or both.
export type Origin = 'content' | 'extension'

export const SENDERS: { [K in MessageType]: readonly Origin[] } = {
  hello: ['content'],
  addElapsed: ['content'],
  resetToday: ['extension'],
  setLimit: ['extension'],
  snooze: ['content', 'extension'],
  setPrefs: ['content', 'extension'],
  openOptions: ['content', 'extension'],
}

// Bounds on one addElapsed request. A content script reports about every
// 10 s; these leave room for retries after the worker was unreachable.
export const MAX_SPANS = 64
export const MAX_REPORT_MS = 10 * 60_000
// How far back a span may start (older time is dropped), and how far ahead
// of the worker's clock it may end.
export const MAX_SPAN_AGE_MS = 24 * 3600_000
export const MAX_CLOCK_SKEW_MS = 5_000

export const MAX_LIMIT_MS = 1440 * 60_000

type Raw = Record<string, unknown>

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// A plausible lowercase hostname. The service worker additionally checks it
// is a site in canonical form (that needs the public suffix list).
function isSiteString(v: unknown): v is Site {
  return typeof v === 'string' && v.length > 0 && v.length <= 253 && /^[a-z0-9.\-[\]:]+$/.test(v)
}

function parseSpans(v: unknown, now: number): Span[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_SPANS) {
    return null
  }
  let total = 0
  const spans: Span[] = []
  for (const span of v) {
    if (!Array.isArray(span) || span.length !== 2) {
      return null
    }
    const [start, end] = span as unknown[]
    if (!isFiniteNumber(start) || !isFiniteNumber(end) || end <= start) {
      return null
    }
    if (start < now - MAX_SPAN_AGE_MS || end > now + MAX_CLOCK_SKEW_MS) {
      return null
    }
    total += end - start
    spans.push([start, end])
  }
  return total <= MAX_REPORT_MS ? spans : null
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
// a content request, say) is dropped. `now` bounds addElapsed spans.
// null = reject.
export function parseRequest(raw: unknown, now: number): Request | null {
  if (!isObject(raw)) {
    return null
  }
  switch (raw.type) {
    case 'hello':
      return { type: 'hello' }
    case 'snooze':
      return { type: 'snooze' }
    case 'openOptions':
      return { type: 'openOptions' }
    case 'addElapsed': {
      const spans = parseSpans(raw.spans, now)
      return spans ? { type: 'addElapsed', spans } : null
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

// Add `ms` of active time ending at `end` to a list of spans, extending the
// last span when the new one continues it (the usual tick-after-tick case).
export function appendSpan(spans: Span[], end: number, ms: number): void {
  if (ms <= 0) {
    return
  }
  const last = spans.at(-1)
  if (last && Math.abs(end - ms - last[1]) <= 1) {
    last[1] += ms
  } else {
    spans.push([end - ms, end])
  }
}

// Total time in `spans` that falls at or after `from`.
export function spanTimeSince(spans: Iterable<Span>, from: number): number {
  let total = 0
  for (const [start, end] of spans) {
    total += Math.max(0, end - Math.max(start, from))
  }
  return total
}

// Group spans into addElapsed requests within the bounds parseRequest
// enforces at `now`: time too old to be accepted is dropped, and spans too
// long for one request are cut.
export function batchSpans(spans: Span[], now: number): Span[][] {
  const batches: Span[][] = []
  let batch: Span[] = []
  let batchMs = 0
  const oldest = now - MAX_SPAN_AGE_MS
  for (const [rawStart, end] of spans) {
    let start = Math.max(rawStart, oldest)
    while (start < end) {
      if (batch.length === MAX_SPANS || batchMs === MAX_REPORT_MS) {
        batches.push(batch)
        batch = []
        batchMs = 0
      }
      const cut = Math.min(end, start + (MAX_REPORT_MS - batchMs))
      batch.push([start, cut])
      batchMs += cut - start
      start = cut
    }
  }
  if (batch.length > 0) {
    batches.push(batch)
  }
  return batches
}
