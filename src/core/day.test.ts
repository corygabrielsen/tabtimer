import { describe, it, expect } from 'vitest'
import {
  addDays,
  dayOf,
  daysBetween,
  hourOf,
  isDayStamp,
  nextHour,
  splitByHour,
  startOfDay,
  type DayStamp,
} from './day'

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

describe('calendar arithmetic', () => {
  const d = (s: string) => s as DayStamp

  it('adds days across months and years', () => {
    expect(addDays(d('2026-10-28'), 4)).toBe('2026-11-01')
    expect(addDays(d('2026-01-01'), -1)).toBe('2025-12-31')
    expect(addDays(d('2028-02-28'), 1)).toBe('2028-02-29')
  })

  it('counts days between stamps', () => {
    expect(daysBetween(d('2026-10-01'), d('2026-10-28'))).toBe(27)
    expect(daysBetween(d('2026-10-28'), d('2026-10-01'))).toBe(-27)
  })

  it('recognizes stamps', () => {
    expect(isDayStamp('2026-10-28')).toBe(true)
    expect(isDayStamp('2026-1-28')).toBe(false)
    expect(isDayStamp(20261028)).toBe(false)
  })
})
