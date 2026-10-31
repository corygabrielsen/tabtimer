// Local wall-clock hours across DST transitions, in a fixed zone. Set before
// any Date is built; each test file runs in its own worker.
;(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = 'America/New_York'

import { describe, it, expect } from 'vitest'
import { addDays, dayOf, logicalDay, nextHour, splitByHour, startOfLogicalDay } from './day'

const HOUR = 3600_000
const MIN = 60_000
const at = (...args: [number, number, number, number?, number?]) => new Date(...args).getTime()

// 2026 in New York: clocks go forward at 02:00 on 8 March (02:00-03:00 does
// not exist) and back at 02:00 on 1 November (01:00-02:00 happens twice).
const SPRING = { y: 2026, m: 2, d: 8 }
const FALL = { y: 2026, m: 10, d: 1 }

const hours = (start: number, end: number) => {
  const byHour: Record<number, number> = {}
  for (const s of splitByHour(start, end, 0)) {
    byHour[s.hour] = (byHour[s.hour] ?? 0) + s.ms
  }
  return byHour
}

describe('the test zone', () => {
  it('really observes DST', () => {
    expect(at(FALL.y, FALL.m, FALL.d + 1) - at(FALL.y, FALL.m, FALL.d)).toBe(25 * HOUR)
    expect(at(SPRING.y, SPRING.m, SPRING.d + 1) - at(SPRING.y, SPRING.m, SPRING.d)).toBe(23 * HOUR)
  })
})

describe('splitByHour across DST', () => {
  it('leaves the skipped hour empty when clocks go forward', () => {
    const start = at(SPRING.y, SPRING.m, SPRING.d, 1, 30)
    // One real hour: 01:30 EST to 03:30 EDT.
    const end = start + HOUR
    expect(hours(start, end)).toEqual({ 1: 30 * MIN, 3: 30 * MIN })
  })

  it('folds the repeated hour into one bucket when clocks go back', () => {
    // 00:30 EDT, then three real hours: to 02:30 EST.
    const start = at(FALL.y, FALL.m, FALL.d, 0, 30)
    const end = start + 3 * HOUR
    expect(hours(start, end)).toEqual({ 0: 30 * MIN, 1: 2 * HOUR, 2: 30 * MIN })
  })

  it('fills 23 buckets on the short day and 25 hours of time on the long day', () => {
    const spring = hours(at(SPRING.y, SPRING.m, SPRING.d), at(SPRING.y, SPRING.m, SPRING.d + 1))
    expect(Object.keys(spring)).toHaveLength(23)
    expect(spring[2]).toBeUndefined()
    expect(Object.values(spring).reduce((a, b) => a + b, 0)).toBe(23 * HOUR)

    const fall = hours(at(FALL.y, FALL.m, FALL.d), at(FALL.y, FALL.m, FALL.d + 1))
    expect(Object.keys(fall)).toHaveLength(24)
    expect(fall[1]).toBe(2 * HOUR)
    expect(Object.values(fall).reduce((a, b) => a + b, 0)).toBe(25 * HOUR)
  })

  it('always moves forward from inside the repeated hour', () => {
    // 01:15 EST, the second pass.
    const secondPass = at(FALL.y, FALL.m, FALL.d, 0, 15) + 2 * HOUR
    expect(new Date(secondPass).getHours()).toBe(1)
    expect(nextHour(secondPass)).toBe(at(FALL.y, FALL.m, FALL.d, 2))
  })
})

describe('day arithmetic across DST', () => {
  it('counts calendar days, not 24h steps', () => {
    expect(addDays(dayOf(at(FALL.y, FALL.m, FALL.d + 1, 0, 30)), -1)).toBe('2026-11-01')
    expect(addDays(dayOf(at(SPRING.y, SPRING.m, SPRING.d + 1, 23, 30)), -1)).toBe('2026-03-08')
    expect(dayOf(at(FALL.y, FALL.m, FALL.d, 23, 59))).toBe('2026-11-01')
  })
})

describe('the logical day across DST', () => {
  const length = (day: { y: number; m: number; d: number }, dayStart: number) =>
    startOfLogicalDay(at(day.y, day.m, day.d + 1, 12), dayStart) -
    startOfLogicalDay(at(day.y, day.m, day.d, 12), dayStart)

  it('is 23 or 25 hours when the change falls inside it, wherever it starts', () => {
    // dayStart 6: the change at 02:00 falls in the day before's night.
    expect(length({ ...SPRING, d: SPRING.d - 1 }, 6)).toBe(23 * HOUR)
    expect(length(SPRING, 6)).toBe(24 * HOUR)
    expect(length({ ...FALL, d: FALL.d - 1 }, 6)).toBe(25 * HOUR)
    expect(length(FALL, 6)).toBe(24 * HOUR)
  })

  it('splits a short night into 23 buckets on one logical day', () => {
    const start = at(SPRING.y, SPRING.m, SPRING.d - 1, 6)
    const end = at(SPRING.y, SPRING.m, SPRING.d, 6)
    const slices = splitByHour(start, end, 6)
    expect(new Set(slices.map((s) => s.day))).toEqual(new Set(['2026-03-07']))
    expect(slices).toHaveLength(23)
    expect(slices.some((s) => s.hour === 2)).toBe(false)
    expect(slices.reduce((total, s) => total + s.ms, 0)).toBe(23 * HOUR)
  })

  it('starts at the next hour that exists when the start hour is skipped', () => {
    // 02:00 doesn't exist on 8 March: that day starts at 03:00 EDT.
    expect(startOfLogicalDay(at(SPRING.y, SPRING.m, SPRING.d, 12), 2)).toBe(at(SPRING.y, SPRING.m, SPRING.d, 3))
    expect(logicalDay(at(SPRING.y, SPRING.m, SPRING.d, 1, 59), 2)).toBe('2026-03-07')
    expect(logicalDay(at(SPRING.y, SPRING.m, SPRING.d, 3), 2)).toBe('2026-03-08')
    // 03:00 EDT is the moment 02:00 EST would have been: still 24 hours.
    expect(length({ ...SPRING, d: SPRING.d - 1 }, 2)).toBe(24 * HOUR)
  })

  it('starts at the first pass when the start hour repeats', () => {
    // 01:00 happens twice on 1 November: the day starts at the first.
    const firstPass = at(FALL.y, FALL.m, FALL.d, 1)
    const secondPass = firstPass + HOUR + 15 * MIN
    expect(new Date(secondPass).getHours()).toBe(1)
    expect(startOfLogicalDay(secondPass, 1)).toBe(firstPass)
    expect(logicalDay(firstPass - 1, 1)).toBe('2026-10-31')
    expect(logicalDay(firstPass, 1)).toBe('2026-11-01')
    expect(logicalDay(secondPass, 1)).toBe('2026-11-01')
    expect(length(FALL, 1)).toBe(25 * HOUR)
  })
})
