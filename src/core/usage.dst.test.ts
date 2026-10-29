// The activity views across DST transitions, in a fixed zone. Set before any
// Date is built; each test file runs in its own worker.
;(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = 'America/New_York'

import { describe, it, expect } from 'vitest'
import { dayOf, splitByHour, type DayStamp } from './day'
import { emptyBuckets, type DayUsage } from './schema'
import { addDays, dayBars, daysFrom, hourBars, hourLabel, periodOf, weekStartOf, type History } from './usage'

const HOUR = 3600_000
const at = (...args: [number, number, number, number?, number?]) => new Date(...args).getTime()

// Credit [start, end) to one site, the way the service worker stores it.
function credit(history: History, site: string, start: number, end: number): void {
  for (const { day, hour, ms } of splitByHour(start, end)) {
    const usage: DayUsage = history.get(day) ?? {}
    const buckets = (usage[site] ??= emptyBuckets())
    buckets[hour] = (buckets[hour] ?? 0) + ms
    history.set(day, usage)
  }
}

describe('a 23-hour day (clocks go forward)', () => {
  // 8 March 2026: 02:00-03:00 doesn't exist.
  const history: History = new Map()
  credit(history, 'a.com', at(2026, 2, 8, 0), at(2026, 2, 9, 0))
  const day = dayOf(at(2026, 2, 8, 12))

  it('still has 24 slots, the skipped hour empty', () => {
    const bars = hourBars(history, day)
    expect(bars).toHaveLength(24)
    expect(bars[2]).toEqual({})
    expect(bars[1]).toEqual({ 'a.com': HOUR })
    expect(bars[3]).toEqual({ 'a.com': HOUR })
  })

  it('labels each slot by its wall-clock hour', () => {
    expect([1, 2, 3].map((h) => hourLabel(h, 'en-US'))).toEqual(['1 AM', '2 AM', '3 AM'])
  })

  it('totals 23 hours for the day', () => {
    expect(dayBars(history, [day])[0]).toEqual({ 'a.com': 23 * HOUR })
  })
})

describe('a 25-hour day (clocks go back)', () => {
  // 1 November 2026: 01:00-02:00 happens twice.
  const history: History = new Map()
  credit(history, 'a.com', at(2026, 10, 1, 0), at(2026, 10, 2, 0))
  const day = dayOf(at(2026, 10, 1, 12))

  it('still has 24 slots, the repeated hour doubled', () => {
    const bars = hourBars(history, day)
    expect(bars).toHaveLength(24)
    expect(bars[1]).toEqual({ 'a.com': 2 * HOUR })
    expect(bars[2]).toEqual({ 'a.com': HOUR })
  })

  it('totals 25 hours for the day', () => {
    expect(dayBars(history, [day])[0]).toEqual({ 'a.com': 25 * HOUR })
  })
})

describe('weeks across a transition', () => {
  it('keeps calendar days', () => {
    const today = '2026-11-04' as DayStamp
    expect(weekStartOf(today, 0)).toBe('2026-11-01')
    expect(daysFrom(addDays(today, -7), 7).at(-1)).toBe('2026-11-03')
    expect(periodOf('week', 1, today, 0).days).toEqual(daysFrom('2026-10-25' as DayStamp, 7))
    expect(periodOf('day', 3, '2026-03-10' as DayStamp, 0).days).toEqual(['2026-03-07'])
  })
})
