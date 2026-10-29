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
