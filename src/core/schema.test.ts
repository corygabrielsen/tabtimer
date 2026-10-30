import { describe, it, expect } from 'vitest'
import {
  dayKey,
  dayOfKey,
  dayTotal,
  emptyBuckets,
  expiredDayKeys,
  snoozeKey,
  normalizeClock,
  normalizeDay,
  normalizePrefs,
  settleClock,
  siteTotal,
  snapScale,
  sumBuckets,
  HOLD_MS,
  RETENTION_DAYS,
  type ClockMark,
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

  it('expires a day’s snoozes with its usage', () => {
    expect(snoozeKey('2026-06-30')).toBe('snoozes:2026-06-30')
    const keys = ['snoozes:2026-06-30', 'snoozes:2026-05-31', 'snoozes:junk', 'day:2026-05-31']
    expect(expiredDayKeys(keys, now)).toEqual(['snoozes:2026-05-31', 'snoozes:junk', 'day:2026-05-31'])
  })

  it('drops malformed day keys and leaves every other key alone', () => {
    expect(expiredDayKeys(['day:garbage', 'limits', 'prefs', 'schema', 'snoozeUntil'], now)).toEqual(['day:garbage'])
  })

  it('keeps days after today (a clock set back)', () => {
    expect(expiredDayKeys(['day:2026-07-04'], now)).toEqual([])
  })

  it('expires days after tomorrow up to the last day shown before the clock went back', () => {
    const keys = ['day:2026-06-30', 'day:2026-07-01', 'day:2026-07-02', 'day:2026-07-03']
    expect(expiredDayKeys(keys, now, '2026-07-03')).toEqual(['day:2026-07-02', 'day:2026-07-03'])
    // Tomorrow is kept: a time zone change moves the date by at most a day.
    expect(expiredDayKeys(keys, now, '2026-07-01')).toEqual([])
    expect(expiredDayKeys(keys, now, '2026-06-29')).toEqual([])
  })

  it('expires days written ahead no further than a window ahead', () => {
    const keys = ['day:2026-07-30', 'day:2026-07-31', 'day:2027-06-30']
    expect(expiredDayKeys(keys, now, '2027-06-30')).toEqual(['day:2026-07-30'])
  })
})

describe('the clock mark', () => {
  const now = new Date(2026, 5, 30, 9).getTime()
  const DAY = 24 * 60 * 60_000
  const trusted = (mark: ClockMark) => settleClock(mark, now).day === '2026-06-30'
  const mark = (day: string | null, pending: ClockMark['pending'] = null) => normalizeClock({ day, pending })

  it('reads garbage as no mark', () => {
    for (const value of [undefined, 5, { day: 'x', pending: { day: '2026-06-30' } }]) {
      expect(normalizeClock(value)).toEqual({ day: null, pending: null })
    }
    expect(normalizeClock({ day: '2026-06-30', pending: { day: '2026-07-01', since: 5 } })).toEqual({
      day: '2026-06-30',
      pending: { day: '2026-07-01', since: 5 },
    })
  })

  it('trusts the same date, a day back, or up to two days on, and is unchanged on the same date', () => {
    const same = mark('2026-06-30')
    expect(settleClock(same, now)).toBe(same)
    for (const day of ['2026-06-28', '2026-07-01']) {
      expect(trusted(mark(day))).toBe(true)
    }
    for (const day of ['2026-06-27', '2026-07-02']) {
      expect(trusted(mark(day))).toBe(false)
    }
  })

  it('holds any other date pending, trusting it once the clock has run on from it for an hour', () => {
    const pending = settleClock(mark('2025-06-30'), now)
    expect(pending).toEqual({ day: '2025-06-30', pending: { day: '2026-06-30', since: now } })
    expect(settleClock(pending, now + HOLD_MS - 1)).toBe(pending)
    expect(settleClock(pending, now + HOLD_MS)).toEqual({ day: '2026-06-30', pending: null })
    expect(settleClock(pending, now + 3 * DAY).day).toBe('2026-07-03')
    // A clock gone back since restarts the wait.
    expect(settleClock(pending, now - 2 * DAY)).toEqual({
      day: '2025-06-30',
      pending: { day: '2026-06-28', since: now - 2 * DAY },
    })
    expect(settleClock(pending, now - 1).pending).toEqual({ day: '2026-06-30', since: now - 1 })
    // With no mark at all, every date waits.
    expect(settleClock(mark(null), now)).toEqual({ day: null, pending: { day: '2026-06-30', since: now } })
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

describe('snapScale', () => {
  it('snaps to the nearest overlay size in range, and garbage to the default', () => {
    expect(snapScale(0.7)).toBe(0.75)
    expect(snapScale(0.1)).toBe(0.5)
    expect(snapScale(3)).toBe(1)
    expect(snapScale(NaN)).toBe(1)
  })
})
