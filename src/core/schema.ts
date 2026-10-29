// The chrome.storage.local layout (schema 3). Pure: no chrome, no DOM.
//
// The service worker is the only writer. Every reader goes through the
// normalize* functions below, so a malformed value reads as its default.
//
//   schema       3
//   limits       Limits (core/limits.ts), the snooze included
//   prefs        Prefs
//   day:<date>   DayUsage for one local calendar day (yyyy-mm-dd)
//
// A stored `schema` other than SCHEMA means the data is in some other layout:
// the service worker clears storage and starts over (no migration).
import { addDays, dayOf, isDayStamp, type DayStamp } from './day'
import { isBool, isFiniteNumber, isObject } from './guards'

export const SCHEMA = 3

export const SCHEMA_KEY = 'schema'
export const LIMITS_KEY = 'limits'
export const PREFS_KEY = 'prefs'
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
export const DEFAULT_PREFS: Prefs = { hidden: false, scale: 1 }

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

// The day:* keys among `keys` that fall outside the retention window ending
// on the day containing `now` (malformed day:* keys go too).
export function expiredDayKeys(keys: string[], now: number): string[] {
  const oldest = oldestKept(dayOf(now))
  return keys.filter((key) => {
    if (!key.startsWith(DAY_KEY_PREFIX)) {
      return false
    }
    const day = dayOfKey(key)
    return day === null || day < oldest
  })
}

export function emptyBuckets(): HourBuckets {
  return new Array<number>(HOURS_PER_DAY).fill(0)
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

// Every site's total for the day (what the all-sites limit compares).
export function dayTotal(day: DayUsage): number {
  return Object.values(day).reduce((total, buckets) => total + sumBuckets(buckets), 0)
}

export function normalizePrefs(value: unknown): Prefs {
  const p = (value ?? {}) as Partial<Prefs>
  return {
    hidden: isBool(p.hidden) ? p.hidden : DEFAULT_PREFS.hidden,
    // Out of range is clamped; not a number at all reads as the default.
    scale: isFiniteNumber(p.scale) ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, p.scale)) : DEFAULT_PREFS.scale,
  }
}
