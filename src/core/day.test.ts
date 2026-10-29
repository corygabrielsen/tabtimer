import { describe, it, expect } from 'vitest'
import { dayOf, nextMidnight, startOfDay } from './day'

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
