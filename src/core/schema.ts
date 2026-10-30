// The chrome.storage.local layout (schema 3). Pure: no chrome, no DOM.
//
// The service worker is the only writer. Every reader goes through the
// normalize* functions below, so a malformed value reads as its default.
//
//   schema       3
//   limits       Limits (core/limits.ts), the snooze included
//   prefs        Prefs
//   day:<date>   DayUsage for one local calendar day (yyyy-mm-dd)
//   clock        ClockMark: the date pruning last trusted
//
// A stored `schema` other than SCHEMA means the data is in some other layout:
// the service worker clears storage and starts over (no migration).
import { addDays, dayOf, hourOf, isDayStamp, type DayStamp } from './day'
import { isBool, isFiniteNumber, isObject } from './guards'

export const SCHEMA = 3

export const SCHEMA_KEY = 'schema'
export const LIMITS_KEY = 'limits'
export const PREFS_KEY = 'prefs'
export const CLOCK_KEY = 'clock'
export const DAY_KEY_PREFIX = 'day:'

// Days of usage kept, today included: older day:* keys are pruned.
export const RETENTION_DAYS = 30

export const HOURS_PER_DAY = 24

// Active milliseconds per local wall-clock hour, index 0 = 00:00-01:00. On a
// day with a repeated hour (clocks go back) both passes add to the same
// bucket; on a day with a skipped hour (clocks go forward) it stays 0.
export type HourBuckets = number[]

// One day's usage, by site.
export type DayUsage = Record<string, HourBuckets>

// Global preferences for the on-page overlay.
export type Prefs = { hidden: boolean; scale: number }

export const MIN_SCALE = 0.5
export const MAX_SCALE = 1
// The overlay's sizes are MIN_SCALE to MAX_SCALE in steps of this.
export const SCALE_STEP = 0.25
export const DEFAULT_PREFS: Prefs = { hidden: false, scale: 1 }

// The overlay size nearest `scale`; not a number at all reads as the default.
export function snapScale(scale: number): number {
  if (!Number.isFinite(scale)) {
    return DEFAULT_PREFS.scale
  }
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(scale / SCALE_STEP) * SCALE_STEP))
}

export type DayKey = `${typeof DAY_KEY_PREFIX}${DayStamp}`

export function dayKey(day: DayStamp): DayKey {
  return `${DAY_KEY_PREFIX}${day}`
}

// The day a day:* key is for, or null if `key` isn't one.
export function dayOfKey(key: string): DayStamp | null {
  const day = key.startsWith(DAY_KEY_PREFIX) ? key.slice(DAY_KEY_PREFIX.length) : null
  return isDayStamp(day) ? day : null
}

// The oldest day still kept on `today`.
export function oldestKept(today: DayStamp): DayStamp {
  return addDays(today, -(RETENTION_DAYS - 1))
}

// Whether `day` is in the retention window ending on `today` (a later day
// hasn't begun).
export function isKept(day: DayStamp, today: DayStamp): boolean {
  return day >= oldestKept(today) && day <= today
}

// The day:* keys among `keys` that fall outside the retention window ending
// on the day containing `now` (malformed day:* keys go too). `last`: a later
// day the clock showed before it went back; the days after tomorrow up to it
// were written while the clock was ahead, and go too, as far as a window
// ahead. Tomorrow is kept: a time zone change moves the date by at most a
// day, and that usage is real. Any other later day is kept (the clock may be
// the one that is wrong).
export function expiredDayKeys(keys: string[], now: number, last: DayStamp | null = null): string[] {
  const today = dayOf(now)
  const oldest = oldestKept(today)
  const tomorrow = addDays(today, 1)
  const ahead = addDays(today, RETENTION_DAYS)
  return keys.filter((key) => {
    if (!key.startsWith(DAY_KEY_PREFIX)) {
      return false
    }
    const day = dayOfKey(key)
    return day === null || day < oldest || (last !== null && day > tomorrow && day <= last && day <= ahead)
  })
}

// Pruning deletes for good, so it trusts the clock's date only when the date
// moved plausibly from the last trusted one (`day`): back at most a day (a
// time zone change) or on at most PLAUSIBLE_DAYS. Any other date is
// `pending` from `since`, and trusted once the clock has run on from it for
// HOLD_MS. A clock briefly wrong (an unset clock at boot, a resumed machine)
// is put right before then.
export type ClockMark = { day: DayStamp | null; pending: { day: DayStamp; since: number } | null }

export const PLAUSIBLE_DAYS = 2
export const HOLD_MS = 60 * 60_000

export function normalizeClock(value: unknown): ClockMark {
  const v = isObject(value) ? value : {}
  const p = isObject(v.pending) ? v.pending : {}
  return {
    day: isDayStamp(v.day) ? v.day : null,
    pending: isDayStamp(p.day) && isFiniteNumber(p.since) ? { day: p.day, since: p.since } : null,
  }
}

// The mark after the clock shows `now`. The date is trusted when the result's
// day is the day containing `now`.
export function settleClock(mark: ClockMark, now: number): ClockMark {
  const today = dayOf(now)
  const { day, pending } = mark
  if (day !== null && today >= addDays(day, -1) && today <= addDays(day, PLAUSIBLE_DAYS)) {
    return day === today && pending === null ? mark : { day: today, pending: null }
  }
  // The clock ran on from the pending date (a time zone change aside).
  const runOn = pending !== null && today >= addDays(pending.day, -1) && now >= pending.since
  if (runOn && now - pending.since >= HOLD_MS) {
    return { day: today, pending: null }
  }
  return runOn ? mark : { day, pending: { day: today, since: now } }
}

export function emptyBuckets(): HourBuckets {
  return new Array<number>(HOURS_PER_DAY).fill(0)
}

// `buckets` (none: empty) with `ms` more in the hour of `at`: where time not
// yet stored is shown, the one rule for every surface.
export function withTimeAt(buckets: readonly number[] | undefined, at: number, ms: number): HourBuckets {
  const out = buckets ? [...buckets] : emptyBuckets()
  if (ms > 0) {
    out[hourOf(at)]! += ms
  }
  return out
}

function normalizeBuckets(value: unknown): HourBuckets | null {
  if (!Array.isArray(value)) {
    return null
  }
  const buckets = emptyBuckets()
  for (let h = 0; h < HOURS_PER_DAY; h++) {
    const ms: unknown = value[h]
    buckets[h] = isFiniteNumber(ms) && ms > 0 ? ms : 0
  }
  return buckets
}

export function normalizeDay(value: unknown): DayUsage {
  const day: DayUsage = {}
  if (isObject(value)) {
    for (const [site, buckets] of Object.entries(value)) {
      const normalized = normalizeBuckets(buckets)
      if (normalized) {
        day[site] = normalized
      }
    }
  }
  return day
}

export function sumBuckets(buckets: HourBuckets | undefined): number {
  return (buckets ?? []).reduce((total, ms) => total + ms, 0)
}

// One site's total for the day.
export function siteTotal(day: DayUsage, site: string): number {
  return sumBuckets(day[site])
}

// The total for the day of every site `counts` (what the all-sites limit
// compares, over the tracked sites).
export function dayTotal(day: DayUsage, counts: (site: string) => boolean = () => true): number {
  return Object.entries(day).reduce((total, [site, buckets]) => total + (counts(site) ? sumBuckets(buckets) : 0), 0)
}

export function normalizePrefs(value: unknown): Prefs {
  const p = (value ?? {}) as Partial<Prefs>
  return {
    hidden: isBool(p.hidden) ? p.hidden : DEFAULT_PREFS.hidden,
    // Out of range is clamped; not a number at all reads as the default.
    scale: isFiniteNumber(p.scale) ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, p.scale)) : DEFAULT_PREFS.scale,
  }
}
