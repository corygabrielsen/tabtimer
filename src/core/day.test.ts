import { describe, it, expect } from 'vitest'
import { dayBefore, dayOf, hourOf, nextHour, nextMidnight, splitByHour, startOfDay } from './day'

const at = (...args: [number, number, number, number?, number?, number?]) => new Date(...args).getTime()

describe('dayOf', () => {
  it('is the zero-padded local date', () => {
    expect(dayOf(at(2026, 0, 5, 13, 30))).toBe('2026-01-05')
    expect(dayOf(at(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31')
    expect(dayOf(at(2026, 6, 4, 0, 0, 0))).toBe('2026-07-04')
  })
})

describe('startOfDay', () => {
  it('is the local midnight starting the day', () => {
    expect(startOfDay(at(2026, 5, 10, 12, 34, 56))).toBe(at(2026, 5, 10))
    expect(startOfDay(at(2026, 5, 10))).toBe(at(2026, 5, 10))
  })
})

describe('nextMidnight', () => {
  it('is the next local midnight, across month and year ends', () => {
    expect(nextMidnight(at(2026, 5, 10, 12))).toBe(at(2026, 5, 11))
    expect(nextMidnight(at(2026, 0, 31, 23, 59))).toBe(at(2026, 1, 1))
    expect(nextMidnight(at(2026, 11, 31, 8))).toBe(at(2027, 0, 1))
  })

  it('is strictly after a midnight itself', () => {
    expect(nextMidnight(at(2026, 5, 10))).toBe(at(2026, 5, 11))
  })

  it('lands on a calendar midnight every day of the year (DST-safe)', () => {
    let t = at(2026, 0, 1, 12)
    for (let i = 0; i < 366; i++) {
      const next = nextMidnight(t)
      const d = new Date(next)
      expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([0, 0, 0])
      expect(dayOf(next)).not.toBe(dayOf(t))
      t = next + 12 * 3600_000
    }
  })
})

describe('splitByHour', () => {
  const MIN = 60_000

  it('keeps an interval inside one hour whole', () => {
    expect(splitByHour(at(2026, 5, 10, 12, 10), at(2026, 5, 10, 12, 20))).toEqual([
      { day: '2026-06-10', hour: 12, ms: 10 * MIN },
    ])
  })

  it('cuts at every hour boundary', () => {
    expect(splitByHour(at(2026, 5, 10, 12, 50), at(2026, 5, 10, 14, 5))).toEqual([
      { day: '2026-06-10', hour: 12, ms: 10 * MIN },
      { day: '2026-06-10', hour: 13, ms: 60 * MIN },
      { day: '2026-06-10', hour: 14, ms: 5 * MIN },
    ])
  })

  it('treats midnight as just another boundary', () => {
    expect(splitByHour(at(2026, 11, 31, 23, 59), at(2027, 0, 1, 0, 1))).toEqual([
      { day: '2026-12-31', hour: 23, ms: MIN },
      { day: '2027-01-01', hour: 0, ms: MIN },
    ])
  })

  it('yields nothing for an empty or backwards interval', () => {
    expect(splitByHour(at(2026, 5, 10, 12), at(2026, 5, 10, 12))).toEqual([])
    expect(splitByHour(at(2026, 5, 10, 13), at(2026, 5, 10, 12))).toEqual([])
  })
})

describe('hourOf and nextHour', () => {
  it('name the local hour and where it ends', () => {
    expect(hourOf(at(2026, 5, 10, 0, 0))).toBe(0)
    expect(hourOf(at(2026, 5, 10, 23, 59))).toBe(23)
    expect(nextHour(at(2026, 5, 10, 23, 30))).toBe(at(2026, 5, 11))
    expect(nextHour(at(2026, 5, 10, 9))).toBe(at(2026, 5, 10, 10))
  })
})

describe('dayBefore', () => {
  it('steps back whole calendar days, across months and years', () => {
    expect(dayBefore(at(2026, 5, 10, 8), 0)).toBe('2026-06-10')
    expect(dayBefore(at(2026, 2, 1, 8), 1)).toBe('2026-02-28')
    expect(dayBefore(at(2026, 0, 5, 23, 59), 29)).toBe('2025-12-07')
  })
})
