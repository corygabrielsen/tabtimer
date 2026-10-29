// Local calendar days. Pure: no chrome, no DOM.

// A local yyyy-mm-dd date, zero padded.
export type DayStamp = `${number}-${number}-${number}`

// The local calendar day containing `epochMs`.
export function dayOf(epochMs: number): DayStamp {
  const date = new Date(epochMs)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${mm}-${dd}` as DayStamp
}

// Local midnight that starts the day containing `epochMs`.
export function startOfDay(epochMs: number): number {
  const date = new Date(epochMs)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

// The local wall-clock hour (0-23) containing `epochMs`.
export function hourOf(epochMs: number): number {
  return new Date(epochMs).getHours()
}

// The start of the next local wall-clock hour after `epochMs`, rebuilt from
// y/m/d/h so DST is handled by the platform: in a repeated hour (clocks go
// back) the next boundary is the end of the second pass, so both passes fold
// into one hour; a skipped hour (clocks go forward) is never entered.
export function nextHour(epochMs: number): number {
  const date = new Date(epochMs)
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours() + 1).getTime()
  // Always make progress, even on a platform with an odd zone rule.
  return Math.max(next, epochMs + 1)
}

// One piece of an interval that lies within a single local hour.
export type HourSlice = { day: DayStamp; hour: number; ms: number }

// Split [start, end) at every local hour boundary (midnight is one of them).
// An empty or backwards interval yields nothing.
export function splitByHour(start: number, end: number): HourSlice[] {
  const slices: HourSlice[] = []
  let cursor = start
  while (cursor < end) {
    const boundary = Math.min(nextHour(cursor), end)
    slices.push({ day: dayOf(cursor), hour: hourOf(cursor), ms: boundary - cursor })
    cursor = boundary
  }
  return slices
}

// --- Calendar arithmetic on stamps ------------------------------------------
// Done in UTC, where every day is 24 h, so a DST change never shifts a date.

// Whether `v` is a yyyy-mm-dd stamp.
export function isDayStamp(v: unknown): v is DayStamp {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}

// `day`'s midnight in UTC.
export function utcOf(day: DayStamp): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d)
}

// The day `n` days after `day` (negative: before).
export function addDays(day: DayStamp, n: number): DayStamp {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10) as DayStamp
}

// Whole days from `from` to `to` (negative if `to` is earlier).
export function daysBetween(from: DayStamp, to: DayStamp): number {
  return Math.round((utcOf(to) - utcOf(from)) / 86_400_000)
}
