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

// The next local midnight after `epochMs`. Day overflow normalizes across
// months, and rebuilding from y/m/d (rather than adding 24h) stays correct on
// DST-transition days where a local day is 23h or 25h long.
export function nextMidnight(epochMs: number): number {
  const date = new Date(epochMs)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0).getTime()
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

// The local calendar day `days` days before the day containing `epochMs`
// (calendar arithmetic, so DST days of 23h or 25h don't shift it).
export function dayBefore(epochMs: number, days: number): DayStamp {
  const date = new Date(epochMs)
  return dayOf(new Date(date.getFullYear(), date.getMonth(), date.getDate() - days, 12).getTime())
}
