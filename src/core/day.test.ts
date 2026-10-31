import { describe, it, expect } from 'vitest'
import {
  addDays,
  dayOf,
  daysBetween,
  hourOf,
  hourOfSlot,
  hoursIntoDay,
  inDayOrder,
  isDayStamp,
  logicalDay,
  nextHour,
  slotOfHour,
  splitByHour,
  startOfLogicalDay,
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

describe('startOfLogicalDay with days starting at midnight', () => {
  it('is the local midnight starting the day', () => {
    expect(startOfLogicalDay(at(2026, 5, 10, 12, 34, 56), 0)).toBe(at(2026, 5, 10))
    expect(startOfLogicalDay(at(2026, 5, 10), 0)).toBe(at(2026, 5, 10))
  })
})

describe('splitByHour', () => {
  const MIN = 60_000

  it('keeps an interval inside one hour whole', () => {
    expect(splitByHour(at(2026, 5, 10, 12, 10), at(2026, 5, 10, 12, 20), 0)).toEqual([
      { day: '2026-06-10', hour: 12, ms: 10 * MIN },
    ])
  })

  it('cuts at every hour boundary', () => {
    expect(splitByHour(at(2026, 5, 10, 12, 50), at(2026, 5, 10, 14, 5), 0)).toEqual([
      { day: '2026-06-10', hour: 12, ms: 10 * MIN },
      { day: '2026-06-10', hour: 13, ms: 60 * MIN },
      { day: '2026-06-10', hour: 14, ms: 5 * MIN },
    ])
  })

  it('treats midnight as just another boundary', () => {
    expect(splitByHour(at(2026, 11, 31, 23, 59), at(2027, 0, 1, 0, 1), 0)).toEqual([
      { day: '2026-12-31', hour: 23, ms: MIN },
      { day: '2027-01-01', hour: 0, ms: MIN },
    ])
  })

  it('yields nothing for an empty or backwards interval', () => {
    expect(splitByHour(at(2026, 5, 10, 12), at(2026, 5, 10, 12), 0)).toEqual([])
    expect(splitByHour(at(2026, 5, 10, 13), at(2026, 5, 10, 12), 0)).toEqual([])
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

describe('the logical day', () => {
  it('starts at midnight with dayStart 0: the calendar date', () => {
    expect(logicalDay(at(2026, 5, 10, 0, 0), 0)).toBe('2026-06-10')
    expect(logicalDay(at(2026, 5, 9, 23, 59, 59), 0)).toBe('2026-06-09')
    expect(startOfLogicalDay(at(2026, 5, 10, 0, 0), 0)).toBe(at(2026, 5, 10))
  })

  it('turns at dayStart: the minute before is the date before, dayStart:00 the date', () => {
    for (const dayStart of [1, 6, 12]) {
      expect(logicalDay(at(2026, 5, 10, dayStart - 1, 59, 59), dayStart)).toBe('2026-06-09')
      expect(logicalDay(at(2026, 5, 10, dayStart, 0), dayStart)).toBe('2026-06-10')
      expect(startOfLogicalDay(at(2026, 5, 10, dayStart - 1, 59), dayStart)).toBe(at(2026, 5, 9, dayStart))
      expect(startOfLogicalDay(at(2026, 5, 10, dayStart, 0), dayStart)).toBe(at(2026, 5, 10, dayStart))
    }
  })

  it('with dayStart 6, counts 01:00 toward the evening before', () => {
    expect(logicalDay(at(2026, 5, 11, 1, 0), 6)).toBe('2026-06-10')
    expect(startOfLogicalDay(at(2026, 5, 11, 1, 0), 6)).toBe(at(2026, 5, 10, 6))
  })

  it('with dayStart 23, only the last hour of a date begins its day', () => {
    expect(logicalDay(at(2026, 5, 10, 22, 59, 59), 23)).toBe('2026-06-09')
    expect(logicalDay(at(2026, 5, 10, 23, 0), 23)).toBe('2026-06-10')
    expect(logicalDay(at(2026, 5, 11, 22, 0), 23)).toBe('2026-06-10')
    expect(startOfLogicalDay(at(2026, 5, 11, 12), 23)).toBe(at(2026, 5, 10, 23))
  })

  it('crosses months and years', () => {
    expect(logicalDay(at(2027, 0, 1, 5, 59), 6)).toBe('2026-12-31')
    expect(startOfLogicalDay(at(2026, 2, 1, 3), 6)).toBe(at(2026, 1, 28, 6))
  })
})

describe('slots of a logical day', () => {
  it('number hours from the day start', () => {
    expect(slotOfHour(6, 6)).toBe(0)
    expect(slotOfHour(5, 6)).toBe(23)
    expect(slotOfHour(0, 6)).toBe(18)
    expect(slotOfHour(13, 0)).toBe(13)
    expect(slotOfHour(0, 23)).toBe(1)
    expect([0, 6, 12, 18].map((slot) => hourOfSlot(slot, 6))).toEqual([6, 12, 18, 0])
    expect([0, 6, 12, 18].map((slot) => hourOfSlot(slot, 0))).toEqual([0, 6, 12, 18])
    expect(hourOfSlot(23, 23)).toBe(22)
  })

  it('put per-hour values in the day’s order, as they are from midnight', () => {
    const byHour = Array.from({ length: 24 }, (_, hour) => hour)
    expect(inDayOrder(byHour, 0)).toEqual(byHour)
    expect(inDayOrder(byHour, 6)).toEqual([...byHour.slice(6), ...byHour.slice(0, 6)])
    expect(inDayOrder(byHour, 23)[0]).toBe(23)
  })

  it('say how far into the day it is', () => {
    expect(hoursIntoDay(at(2026, 5, 10, 10, 30), 0)).toBe(10.5)
    expect(hoursIntoDay(at(2026, 5, 10, 10, 30), 6)).toBe(4.5)
    expect(hoursIntoDay(at(2026, 5, 11, 1, 15), 6)).toBe(19.25)
  })
})

describe('splitByHour with a day start', () => {
  const MIN = 60_000

  it('names each piece by its logical day, cutting at the day start', () => {
    expect(splitByHour(at(2026, 5, 11, 5, 50), at(2026, 5, 11, 6, 10), 6)).toEqual([
      { day: '2026-06-10', hour: 5, ms: 10 * MIN },
      { day: '2026-06-11', hour: 6, ms: 10 * MIN },
    ])
  })

  it('keeps midnight inside the day', () => {
    expect(splitByHour(at(2026, 5, 10, 23, 59), at(2026, 5, 11, 0, 1), 6)).toEqual([
      { day: '2026-06-10', hour: 23, ms: MIN },
      { day: '2026-06-10', hour: 0, ms: MIN },
    ])
  })
})
