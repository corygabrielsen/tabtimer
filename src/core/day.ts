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

// --- The logical day ----------------------------------------------------------
// A day runs from `dayStart` (a local wall-clock hour, 0-23; 0 = midnight) to
// that hour on the next date, and is named by the date it starts on. Built
// from local y/m/d/h, never by subtracting milliseconds, so DST moves no
// boundary: a start hour that is skipped (clocks go forward) begins the day
// at the next hour that exists, a repeated one at its first pass.

const HOURS = 24

// The logical day containing `epochMs`: its local date, or the date before
// while its hour is earlier than `dayStart`.
export function logicalDay(epochMs: number, dayStart: number): DayStamp {
  const day = dayOf(epochMs)
  return hourOf(epochMs) < dayStart ? addDays(day, -1) : day
}

// The moment the logical day containing `epochMs` began.
export function startOfLogicalDay(epochMs: number, dayStart: number): number {
  const date = new Date(epochMs)
  const back = date.getHours() < dayStart ? 1 : 0
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - back, dayStart).getTime()
}

// Where wall-clock `hour` falls in a logical day: 0 for `dayStart`, 23 for
// the hour before it.
export function slotOfHour(hour: number, dayStart: number): number {
  return (((hour - dayStart) % HOURS) + HOURS) % HOURS
}

// The wall-clock hour at `slot` of a logical day.
export function hourOfSlot(slot: number, dayStart: number): number {
  return (slot + dayStart) % HOURS
}

// 24 per-hour values indexed by wall-clock hour, in the logical day's order:
// `dayStart` first, the hour before it last.
export function inDayOrder<T>(byHour: readonly T[], dayStart: number): T[] {
  return Array.from({ length: HOURS }, (_, slot) => byHour[hourOfSlot(slot, dayStart)]!)
}

// How far into its logical day `epochMs` is, in wall-clock hours
// (fractional).
export function hoursIntoDay(epochMs: number, dayStart: number): number {
  const date = new Date(epochMs)
  return slotOfHour(date.getHours(), dayStart) + date.getMinutes() / 60
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

// One piece of an interval that lies within a single local hour: its
// logical day and wall-clock hour.
export type HourSlice = { day: DayStamp; hour: number; ms: number }

// Split [start, end) at every local hour boundary (a day's start is one of
// them). An empty or backwards interval yields nothing.
export function splitByHour(start: number, end: number, dayStart: number): HourSlice[] {
  const slices: HourSlice[] = []
  let cursor = start
  while (cursor < end) {
    const boundary = Math.min(nextHour(cursor), end)
    slices.push({ day: logicalDay(cursor, dayStart), hour: hourOf(cursor), ms: boundary - cursor })
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
