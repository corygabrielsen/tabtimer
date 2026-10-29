// Time away from the computer: idle (no keyboard or mouse input) and locked
// (screen lock or screensaver). Pure: no chrome, no DOM.
//
// The service worker records every away period it learns of from
// chrome.idle, and credits a site only the part of each closed interval
// (core/tracker.ts) that falls outside them:
//   - locked always pauses;
//   - idle pauses unless the page was playing media (watching a video or
//     listening is using the site without touching the input).
//
// Idle is detected late by construction: Chrome reports it only once there
// has been no input for IDLE_DETECTION_S. The period is therefore dated
// back to the last input (now - IDLE_DETECTION_MS), and time already
// credited since then is taken back (the debit returned by observe()).
import { isBool, isFiniteNumber } from './guards'

// A stretch of time, [start, end) in epoch ms.
export type Span = [start: number, end: number]

// How far back a credited span can reach: older periods can't matter.
export const MAX_SPAN_AGE_MS = 24 * 3600_000

export type IdleState = 'active' | 'idle' | 'locked'

export const IDLE_STATES: readonly IdleState[] = ['active', 'idle', 'locked']

// The longest stretch without keyboard or mouse input that still counts as
// using the site: reading a page without scrolling keeps counting for up to
// this long. Walking away is never over-counted, because an idle period
// starts at the last input, not when Chrome reports it. (Chrome's minimum
// is 15 s, its default 60 s.)
export const IDLE_DETECTION_S = 300
export const IDLE_DETECTION_MS = IDLE_DETECTION_S * 1000

export type AwayKind = Exclude<IdleState, 'active'>

// [start, end) in epoch ms; end null while it lasts.
export type AwayPeriod = { kind: AwayKind; start: number; end: number | null }

// Time credited to a site recently enough that a back-dated idle period may
// still take it back. `media`: the page reported media playing.
export type Credit = { site: string; start: number; end: number; media: boolean }

// What the service worker keeps in storage.session (key AWAY_KEY).
export type AwayState = {
  state: IdleState
  // When `state` began (0 = unknown, e.g. the first observation).
  since: number
  periods: AwayPeriod[]
  recent: Credit[]
}

export const AWAY_KEY = 'away'

// Bounds on what storage.session holds. Periods ended more than
// MAX_SPAN_AGE_MS ago can't matter; credits older than one detection
// interval can't be reached by a back-dated period.
export const MAX_PERIODS = 512
export const MAX_RECENT = 256

export function initialAway(): AwayState {
  return { state: 'active', since: 0, periods: [], recent: [] }
}

export function isIdleState(v: unknown): v is IdleState {
  return typeof v === 'string' && (IDLE_STATES as readonly string[]).includes(v)
}

function normalizePeriod(v: unknown): AwayPeriod | null {
  const p = v as Partial<AwayPeriod> | null
  if (!p || typeof p !== 'object' || (p.kind !== 'idle' && p.kind !== 'locked') || !isFiniteNumber(p.start)) {
    return null
  }
  if (p.end !== null && !(isFiniteNumber(p.end) && p.end >= p.start)) {
    return null
  }
  return { kind: p.kind, start: p.start, end: p.end }
}

function normalizeCredit(v: unknown): Credit | null {
  const c = v as Partial<Credit> | null
  if (!c || typeof c !== 'object' || typeof c.site !== 'string' || !isFiniteNumber(c.start)) {
    return null
  }
  if (!isFiniteNumber(c.end) || c.end <= c.start || !isBool(c.media)) {
    return null
  }
  return { site: c.site, start: c.start, end: c.end, media: c.media }
}

// A stored AwayState, or the initial one where it is missing or malformed.
export function normalizeAway(value: unknown): AwayState {
  const v = value as Partial<AwayState> | null
  if (!v || typeof v !== 'object' || !isIdleState(v.state)) {
    return initialAway()
  }
  const keep = <T>(list: unknown, normalize: (x: unknown) => T | null): T[] =>
    Array.isArray(list) ? list.map(normalize).filter((x): x is T => x !== null) : []
  return {
    state: v.state,
    since: isFiniteNumber(v.since) ? v.since : 0,
    periods: keep(v.periods, normalizePeriod),
    recent: keep(v.recent, normalizeCredit),
  }
}

// Whether a period pauses time reported with media playing (or not).
function pauses(kind: AwayKind, media: boolean): boolean {
  return kind === 'locked' || !media
}

// `span` minus [start, end).
function subtract([s, e]: Span, start: number, end: number): Span[] {
  if (end <= s || start >= e) {
    return [[s, e]]
  }
  const out: Span[] = []
  if (start > s) {
    out.push([s, start])
  }
  if (end < e) {
    out.push([end, e])
  }
  return out
}

// The parts of `spans` outside every period that pauses them.
export function creditable(spans: Span[], periods: AwayPeriod[], media: boolean): Span[] {
  let out = spans.filter(([s, e]) => e > s)
  for (const p of periods) {
    if (pauses(p.kind, media)) {
      out = out.flatMap((span) => subtract(span, p.start, p.end ?? Infinity))
    }
  }
  return out
}

// Drop what no future observation or credit can reach.
function prune(s: AwayState, now: number): AwayState {
  const periods = s.periods.filter((p) => p.end === null || p.end > now - MAX_SPAN_AGE_MS).slice(-MAX_PERIODS)
  const recent = s.recent.filter((c) => c.end > now - IDLE_DETECTION_MS).slice(-MAX_RECENT)
  return { ...s, periods, recent }
}

// Remember time just credited to `site`, so a back-dated idle period can
// take it back.
export function remember(s: AwayState, site: string, spans: Span[], media: boolean, now: number): AwayState {
  const credits = spans.map(([start, end]) => ({ site, start, end, media }))
  return prune({ ...s, recent: [...s.recent, ...credits] }, now)
}

// Apply a state change reported at `now`. Returns the new state and the
// credited time it takes back (parts of recent credits inside a new period
// that pauses them). Repeating the current state changes nothing.
export function observe(s: AwayState, next: IdleState, now: number): { state: AwayState; debit: Credit[] } {
  if (next === s.state) {
    return { state: s, debit: [] }
  }
  const periods = s.periods.map((p) => (p.end === null ? { ...p, end: Math.max(p.start, now) } : p))
  const debit: Credit[] = []
  let recent = s.recent
  if (next !== 'active') {
    // Idle is reported a detection interval after the last input; locking
    // is reported as it happens. Never date a period before the state it
    // follows began (it can't have been idle while it was locked).
    const start = next === 'idle' && s.state === 'active' ? Math.max(now - IDLE_DETECTION_MS, s.since) : now
    periods.push({ kind: next, start, end: null })
    recent = []
    for (const c of s.recent) {
      if (c.end > start && pauses(next, c.media)) {
        debit.push({ ...c, start: Math.max(c.start, start) })
        if (c.start < start) {
          recent.push({ ...c, end: start })
        }
      } else {
        recent.push(c)
      }
    }
  }
  return { state: prune({ state: next, since: now, periods, recent }, now), debit }
}
