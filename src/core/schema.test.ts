import { describe, it, expect } from 'vitest'
import {
  dayKey,
  dayOfKey,
  dayTotal,
  emptyBuckets,
  expiredDayKeys,
  normalizeDay,
  normalizePrefs,
  siteTotal,
  sumBuckets,
  RETENTION_DAYS,
} from './schema'

const buckets = (byHour: Record<number, number>) => {
  const b = emptyBuckets()
  for (const [h, ms] of Object.entries(byHour)) {
    b[Number(h)] = ms
  }
  return b
}

describe('day keys', () => {
  it('round-trip a day stamp', () => {
    expect(dayKey('2026-06-10')).toBe('day:2026-06-10')
    expect(dayOfKey('day:2026-06-10')).toBe('2026-06-10')
  })

  it('recognize only well-formed day keys', () => {
    expect(dayOfKey('day:2026-6-10')).toBeNull()
    expect(dayOfKey('limits')).toBeNull()
    expect(dayOfKey('day:2026-06-10x')).toBeNull()
  })
})

describe('retention', () => {
  const now = new Date(2026, 5, 30, 9).getTime()

  it(`keeps ${RETENTION_DAYS} days, today included, and expires the rest`, () => {
    const keys = ['day:2026-06-30', 'day:2026-06-01', 'day:2026-05-31', 'day:2025-12-25']
    // 1 June is 29 days before 30 June: the oldest day kept.
    expect(expiredDayKeys(keys, now)).toEqual(['day:2026-05-31', 'day:2025-12-25'])
  })

  it('drops malformed day keys and leaves every other key alone', () => {
    expect(expiredDayKeys(['day:garbage', 'limits', 'prefs', 'schema', 'snoozeUntil'], now)).toEqual(['day:garbage'])
  })

  it('keeps days after today (a clock set back)', () => {
    expect(expiredDayKeys(['day:2026-07-04'], now)).toEqual([])
  })
})

describe('normalizeDay', () => {
  it('reads garbage as an empty day', () => {
    for (const value of [undefined, null, 5, 'x', [1, 2]]) {
      expect(normalizeDay(value)).toEqual({})
    }
  })

  it('keeps 24 numeric buckets per site, zeroing bad entries', () => {
    expect(normalizeDay({ 'a.com': [1, -2, 'x', null, Infinity, 6], 'b.com': 'nope' })).toEqual({
      'a.com': buckets({ 0: 1, 5: 6 }),
    })
    expect(normalizeDay({ 'a.com': new Array(30).fill(1) })['a.com']).toHaveLength(24)
  })
})

describe('totals', () => {
  const day = { 'a.com': buckets({ 9: 1000, 10: 500 }), 'b.com': buckets({ 23: 250 }) }

  it('sum a site’s hours, and every site’s', () => {
    expect(siteTotal(day, 'a.com')).toBe(1500)
    expect(siteTotal(day, 'c.com')).toBe(0)
    expect(dayTotal(day)).toBe(1750)
    expect(dayTotal({})).toBe(0)
    expect(sumBuckets(undefined)).toBe(0)
  })
})

describe('normalizePrefs', () => {
  it('defaults to shown at full size', () => {
    expect(normalizePrefs(undefined)).toEqual({ hidden: false, scale: 1 })
    expect(normalizePrefs({ hidden: 'yes', scale: 'big' })).toEqual({ hidden: false, scale: 1 })
  })

  it('keeps valid values and clamps the scale into range', () => {
    expect(normalizePrefs({ hidden: true, scale: 0.75 })).toEqual({ hidden: true, scale: 0.75 })
    expect(normalizePrefs({ scale: 0.1 }).scale).toBe(0.5)
    expect(normalizePrefs({ scale: 7 }).scale).toBe(1)
    expect(normalizePrefs({ scale: NaN }).scale).toBe(1)
  })
})
