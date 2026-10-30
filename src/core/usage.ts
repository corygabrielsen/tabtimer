// Usage across the kept days, shaped for the activity views. Pure: no chrome,
// no DOM.
//
// A Bar is one slot of a chart (an hour of a day, or a day of a week): each
// site's time in it. A day with no stored key is a day of zero usage.
import { addDays, dayOf, daysBetween, hourOf, utcOf, type DayStamp } from './day'
import { siteTodayAt, type TodayTotals } from './messages'
import {
  dayOfKey,
  emptyBuckets,
  isKept,
  normalizeDay,
  oldestKept,
  siteTotal,
  sumBuckets,
  RETENTION_DAYS,
  HOURS_PER_DAY,
  type DayUsage,
} from './schema'

// Stored days by date. Days absent from the map had no usage.
export type History = Map<DayStamp, DayUsage>

// One chart slot: ms per site.
export type Bar = Record<string, number>

export type SiteTotal = { site: string; ms: number }

export const DAYS_PER_WEEK = 7

// The top sites a stacked chart names; the rest share one "Other" segment.
export const TOP_SITES = 3

// Every day:* entry among stored `items`, normalized.
export function historyOf(items: Record<string, unknown>): History {
  const history: History = new Map()
  for (const [key, value] of Object.entries(items)) {
    const day = dayOfKey(key)
    if (day !== null) {
      history.set(day, normalizeDay(value))
    }
  }
  return history
}

// Applies storage `changes` to `history` (a removed key is a pruned day) and
// returns the days that changed.
export function patchHistory(history: History, changes: Record<string, { newValue?: unknown }>): DayStamp[] {
  const days: DayStamp[] = []
  for (const [key, { newValue }] of Object.entries(changes)) {
    const day = dayOfKey(key)
    if (day !== null) {
      if (newValue === undefined) {
        history.delete(day)
      } else {
        history.set(day, normalizeDay(newValue))
      }
      days.push(day)
    }
  }
  return days
}

// `history` as the worker's `totals` see today at `now`: each site's time
// not yet stored goes into the current hour. For display; `history` is left
// as it is.
export function withUncredited(history: History, totals: TodayTotals, now: number): History {
  const day = dayOf(now)
  const stored = history.get(day) ?? {}
  const usage: DayUsage = { ...stored }
  let added = false
  for (const site of Object.keys(totals.sites)) {
    const ms = siteTodayAt(totals, site, now) - siteTotal(stored, site)
    if (ms > 0) {
      const buckets = [...(stored[site] ?? emptyBuckets())]
      buckets[hourOf(now)]! += ms
      usage[site] = buckets
      added = true
    }
  }
  return added ? new Map(history).set(day, usage) : history
}

// --- Weeks -------------------------------------------------------------------

// 0 = Sunday … 6 = Saturday.
export function weekdayOf(day: DayStamp): number {
  return new Date(utcOf(day)).getUTCDay()
}

// The first day of the week containing `day`, for weeks starting on
// `firstDay` (0 = Sunday … 6 = Saturday).
export function weekStartOf(day: DayStamp, firstDay: number): DayStamp {
  return addDays(day, -((weekdayOf(day) - firstDay + DAYS_PER_WEEK) % DAYS_PER_WEEK))
}

// `count` consecutive days starting at `start`.
export function daysFrom(start: DayStamp, count: number): DayStamp[] {
  return Array.from({ length: count }, (_, i) => addDays(start, i))
}

// --- Bars --------------------------------------------------------------------

// One day's 24 hourly bars. Buckets are local wall-clock hours as stored: on a
// 23-hour day the skipped hour is an empty bar, on a 25-hour day the repeated
// hour is already folded into one, so there are always 24.
export function hourBars(history: History, day: DayStamp): Bar[] {
  const usage = history.get(day) ?? {}
  return Array.from({ length: HOURS_PER_DAY }, (_, hour) => {
    const bar: Bar = {}
    for (const [site, buckets] of Object.entries(usage)) {
      const ms = buckets[hour]!
      if (ms > 0) {
        bar[site] = ms
      }
    }
    return bar
  })
}

// One bar per day of `days`: each site's total that day.
export function dayBars(history: History, days: DayStamp[]): Bar[] {
  return days.map((day) => {
    const bar: Bar = {}
    for (const [site, buckets] of Object.entries(history.get(day) ?? {})) {
      const ms = sumBuckets(buckets)
      if (ms > 0) {
        bar[site] = ms
      }
    }
    return bar
  })
}

// A bar's total: every site's, or one site's.
export function barTotal(bar: Bar, site: string | null = null): number {
  if (site !== null) {
    return bar[site] ?? 0
  }
  return Object.values(bar).reduce((total, ms) => total + ms, 0)
}

// The total over `bars`: every site's, or one site's.
export function periodTotal(bars: Bar[], site: string | null = null): number {
  return bars.reduce((total, bar) => total + barTotal(bar, site), 0)
}

// Each site's total over `bars`, most time first; equal times by site name,
// so the order is stable. Sites with no time are left out.
export function siteTotals(bars: Bar[]): SiteTotal[] {
  const totals = new Map<string, number>()
  for (const bar of bars) {
    for (const [site, ms] of Object.entries(bar)) {
      totals.set(site, (totals.get(site) ?? 0) + ms)
    }
  }
  return [...totals]
    .filter(([, ms]) => ms > 0)
    .map(([site, ms]) => ({ site, ms }))
    .sort((a, b) => b.ms - a.ms || a.site.localeCompare(b.site))
}

// The `n` sites with the most time, of `totals` (siteTotals).
export function topSites(totals: SiteTotal[], n = TOP_SITES): string[] {
  return totals.slice(0, n).map((s) => s.site)
}

// A bar split into the `top` sites' times, in order, then everyone else's.
export function stack(bar: Bar, top: string[]): number[] {
  const named = top.map((site) => bar[site] ?? 0)
  const namedTotal = named.reduce((total, ms) => total + ms, 0)
  return [...named, barTotal(bar) - namedTotal]
}

// The change from `previous` to `current` as a fraction (0.22 = 22% more), or
// null when there is nothing to compare against.
// A slot's time against a daily limit: the part within it, the part over
// it, and whether this is the slot the limit fell in (the first over it).
export type LimitSplit = { within: number; over: number; crosses: boolean }

// Each slot's time split at `limit` (ms; null: none). `cumulative`: the
// slots are one day's hours, and the limit is reached by their running
// total; otherwise each slot is a day of its own against it.
export function splitAtLimit(values: readonly number[], limit: number | null, cumulative: boolean): LimitSplit[] {
  let before = 0
  let fell = false
  return values.map((ms) => {
    const room = limit === null ? ms : Math.max(0, limit - (cumulative ? before : 0))
    const within = Math.min(ms, room)
    const crosses = cumulative && !fell && ms > within
    fell ||= crosses
    before += ms
    return { within, over: ms - within, crosses }
  })
}

export function change(current: number, previous: number): number | null {
  return previous > 0 ? (current - previous) / previous : null
}

// The days of `days` that count toward a daily average on `today`: those
// already begun and still kept. A day in the future, or older than the
// retention window, was never recorded.
export function countedDays(days: DayStamp[], today: DayStamp): number {
  return days.filter((day) => isKept(day, today)).length
}

// The days of `history` kept on `today`. A stored day outside the window
// (not yet pruned) counts as never recorded, as countedDays has it.
export function keptOf(history: History, today: DayStamp): History {
  return new Map([...history].filter(([day]) => isKept(day, today)))
}

// The average per counted day (0 when no day counts).
export function dailyAverage(total: number, days: number): number {
  return days > 0 ? total / days : 0
}

// Whether any day kept on `today` has usage.
export function hasAnyUsage(history: History, today: DayStamp): boolean {
  for (const usage of keptOf(history, today).values()) {
    for (const buckets of Object.values(usage)) {
      if (buckets.some((ms) => ms > 0)) {
        return true
      }
    }
  }
  return false
}

// --- Scale -------------------------------------------------------------------

const MINUTE = 60_000
// Gridline steps, in minutes.
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720]

// A chart scale for values up to `max` ms: the smallest step that covers it
// in at most three gridlines, and the top of the scale (a whole number of
// steps). An empty chart still gets a scale, so its gridlines show.
export function niceScale(max: number): { step: number; top: number } {
  const minutes = Math.max(max, 0) / MINUTE
  const step = STEPS.find((s) => s * 3 >= minutes) ?? Math.ceil(minutes / 3 / 60) * 60
  const top = Math.max(1, Math.ceil(minutes / step)) * step
  return { step: step * MINUTE, top: top * MINUTE }
}

// --- Labels ------------------------------------------------------------------
// Formatted in UTC from the slot's own number, so an hour is named by its
// wall-clock position even on a DST day, where that hour may not exist.

// Building a formatter is the costly part, so each is built once.
const formats = new Map<string, Intl.DateTimeFormat>()

function utcFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale} ${JSON.stringify(options)}`
  let format = formats.get(key)
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' })
    formats.set(key, format)
  }
  return format
}

// "2 PM" for hour 14.
export function hourLabel(hour: number, locale: string): string {
  return utcFormat(locale, { hour: 'numeric' }).format(Date.UTC(2000, 0, 1, hour))
}

export function dayLabel(day: DayStamp, locale: string, options: Intl.DateTimeFormatOptions): string {
  return utcFormat(locale, options).format(utcOf(day))
}

// "Oct 11 – 17", "Sep 27 – Oct 3".
export function rangeLabel(from: DayStamp, to: DayStamp, locale: string): string {
  return utcFormat(locale, { month: 'short', day: 'numeric' }).formatRange(utcOf(from), utcOf(to))
}

// --- Periods -----------------------------------------------------------------

// What a chart covers: one day by hour, or one week by day.
export type Mode = 'day' | 'week'

// A period `offset` periods before the current one (0 = today, or this
// week). `previous` is the period before it, for the change.
export type Period = { mode: Mode; offset: number; days: DayStamp[]; previous: DayStamp[] }

// The furthest back a period can go and still overlap the kept days.
export function maxOffset(mode: Mode, today: DayStamp, firstDay: number): number {
  if (mode === 'day') {
    return RETENTION_DAYS - 1
  }
  return daysBetween(weekStartOf(oldestKept(today), firstDay), weekStartOf(today, firstDay)) / DAYS_PER_WEEK
}

export function periodOf(mode: Mode, offset: number, today: DayStamp, firstDay: number): Period {
  const back = Math.min(Math.max(0, Math.round(offset)), maxOffset(mode, today, firstDay))
  if (mode === 'day') {
    const day = addDays(today, -back)
    return { mode, offset: back, days: [day], previous: [addDays(day, -1)] }
  }
  const start = addDays(weekStartOf(today, firstDay), -DAYS_PER_WEEK * back)
  return {
    mode,
    offset: back,
    days: daysFrom(start, DAYS_PER_WEEK),
    previous: daysFrom(addDays(start, -DAYS_PER_WEEK), DAYS_PER_WEEK),
  }
}

// Everything a chart of `period` shows, for every site or one (`site`).
export type Summary = {
  bars: Bar[]
  // The sites named in the stacks (empty when filtered to one site).
  top: string[]
  // Every site with time in the period, most first.
  sites: SiteTotal[]
  total: number
  // The fraction changed from the previous period, up to the point this
  // one has reached; null when it had none.
  change: number | null
  // The days that count toward the average (countedDays), and the average.
  days: number
  average: number
}

// The previous period's time up to the point the current one has reached:
// all of it for a period that is over, else its days before today's
// counterpart and that day up to `hour` (wall-clock hours into today,
// fractional). An unfinished period is compared with the same part of the
// one before, not with all of it.
function previousSoFar(history: History, period: Period, today: DayStamp, hour: number, site: string | null): number {
  const at = period.days.indexOf(today)
  if (at === -1) {
    return periodTotal(dayBars(history, period.previous), site)
  }
  const whole = Math.floor(hour)
  const hours = hourBars(history, period.previous[at]!)
  return (
    periodTotal(dayBars(history, period.previous.slice(0, at)), site) +
    periodTotal(hours.slice(0, whole), site) +
    barTotal(hours[whole] ?? {}, site) * (hour - whole)
  )
}

// `hour`: how far into today it is, in wall-clock hours (fractional).
export function summarize(
  stored: History,
  period: Period,
  today: DayStamp,
  site: string | null,
  hour = HOURS_PER_DAY
): Summary {
  const history = keptOf(stored, today)
  const bars = period.mode === 'day' ? hourBars(history, period.days[0]!) : dayBars(history, period.days)
  const total = periodTotal(bars, site)
  const previous = previousSoFar(history, period, today, hour, site)
  const days = countedDays(period.days, today)
  const sites = siteTotals(bars)
  return {
    bars,
    top: site === null ? topSites(sites) : [],
    sites,
    total,
    change: change(total, previous),
    days,
    average: dailyAverage(total, days),
  }
}
