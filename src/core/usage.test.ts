import { describe, it, expect } from 'vitest'
import { addDays, daysBetween, type DayStamp } from './day'
import { emptyBuckets, oldestKept, LIMITS_KEY, RETENTION_DAYS, type DayUsage } from './schema'
import {
  barTotal,
  change,
  countedDays,
  dailyAverage,
  dayBars,
  dayLabel,
  daysFrom,
  hasAnyUsage,
  historyOf,
  hourBars,
  hourLabel,
  maxOffset,
  niceScale,
  patchHistory,
  periodOf,
  periodTotal,
  rangeLabel,
  siteTotals,
  stack,
  summarize,
  topSites,
  weekdayOf,
  weekStartOf,
  withUncredited,
  splitAtLimit,
  type Bar,
  type History,
} from './usage'
import type { TodayTotals } from './messages'

const MIN = 60_000
const d = (s: string) => s as DayStamp

// A day's usage: each site's minutes per hour ({ hour: minutes }).
function day(sites: Record<string, Record<number, number>>) {
  const usage: Record<string, number[]> = {}
  for (const [site, hours] of Object.entries(sites)) {
    usage[site] = emptyBuckets()
    for (const [hour, minutes] of Object.entries(hours)) {
      usage[site][Number(hour)] = minutes * MIN
    }
  }
  return usage
}

const history = (days: Record<string, ReturnType<typeof day>>): History =>
  historyOf(Object.fromEntries(Object.entries(days).map(([k, v]) => [`day:${k}`, v])))

describe('historyOf', () => {
  it('keeps only day:* keys, normalized', () => {
    const h = historyOf({
      [LIMITS_KEY]: { global: null },
      'day:2026-10-28': { 'a.com': [MIN] },
      'day:nope': {},
    })
    expect([...h.keys()]).toEqual(['2026-10-28'])
    expect(h.get(d('2026-10-28'))?.['a.com']).toHaveLength(24)
  })
})

describe('patchHistory', () => {
  it('applies day:* changes, a removed key as a pruned day, and names the days', () => {
    const h = history({ '2026-10-01': day({ 'a.com': { 9: 1 } }) })
    const days = patchHistory(h, {
      [LIMITS_KEY]: { newValue: { global: null } },
      'day:2026-10-01': {},
      'day:2026-10-28': { newValue: { 'a.com': [MIN] } },
    })
    expect(days).toEqual(['2026-10-01', '2026-10-28'])
    expect([...h.keys()]).toEqual(['2026-10-28'])
    expect(h.get(d('2026-10-28'))?.['a.com']).toHaveLength(24)
  })
})

describe('weeks', () => {
  it('finds weekdays and week starts', () => {
    expect(weekdayOf(d('2026-10-28'))).toBe(3) // a Wednesday
    expect(weekStartOf(d('2026-10-28'), 0)).toBe('2026-10-25')
    expect(weekStartOf(d('2026-10-28'), 1)).toBe('2026-10-26')
    expect(weekStartOf(d('2026-10-25'), 0)).toBe('2026-10-25')
    expect(weekStartOf(d('2026-10-25'), 1)).toBe('2026-10-19')
  })

  it('lists consecutive days and the oldest kept', () => {
    expect(daysFrom(d('2026-10-30'), 3)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01'])
    expect(daysBetween(oldestKept(d('2026-10-28')), d('2026-10-28'))).toBe(RETENTION_DAYS - 1)
  })
})

describe('bars', () => {
  const h = history({
    '2026-10-27': day({ 'a.com': { 9: 10, 10: 5 }, 'b.com': { 9: 20 } }),
    '2026-10-28': day({ 'a.com': { 14: 30 } }),
  })

  it('gives a day 24 hourly bars, empty hours empty', () => {
    const bars = hourBars(h, d('2026-10-27'))
    expect(bars).toHaveLength(24)
    expect(bars[9]).toEqual({ 'a.com': 10 * MIN, 'b.com': 20 * MIN })
    expect(bars[10]).toEqual({ 'a.com': 5 * MIN })
    expect(bars[0]).toEqual({})
  })

  it('leaves out a site with no time that day', () => {
    expect(dayBars(history({ '2026-10-28': day({ 'a.com': {} }) }), [d('2026-10-28')])).toEqual([{}])
  })

  it('treats a day with no key as zero', () => {
    expect(hourBars(h, d('2026-10-01')).every((bar) => barTotal(bar) === 0)).toBe(true)
    expect(dayBars(h, [d('2026-10-01')])).toEqual([{}])
  })

  it('gives each day its sites’ totals', () => {
    expect(dayBars(h, [d('2026-10-27'), d('2026-10-28')])).toEqual([
      { 'a.com': 15 * MIN, 'b.com': 20 * MIN },
      { 'a.com': 30 * MIN },
    ])
  })

  it('totals a bar and a period, for all sites or one', () => {
    const bars = dayBars(h, [d('2026-10-27'), d('2026-10-28')])
    expect(barTotal(bars[0]!)).toBe(35 * MIN)
    expect(barTotal(bars[0]!, 'b.com')).toBe(20 * MIN)
    expect(barTotal(bars[1]!, 'b.com')).toBe(0)
    expect(periodTotal(bars)).toBe(65 * MIN)
    expect(periodTotal(bars, 'a.com')).toBe(45 * MIN)
    expect(periodTotal([])).toBe(0)
  })
})

describe('top sites', () => {
  it('orders by time, ties by name, and drops zero', () => {
    const bars: Bar[] = [{ 'c.com': 5, 'b.com': 5, 'a.com': 1, 'z.com': 0 }, { 'a.com': 4 }]
    expect(siteTotals(bars)).toEqual([
      { site: 'a.com', ms: 5 },
      { site: 'b.com', ms: 5 },
      { site: 'c.com', ms: 5 },
    ])
    expect(topSites(siteTotals(bars), 2)).toEqual(['a.com', 'b.com'])
  })

  it('defaults to three', () => {
    expect(topSites(siteTotals([{ a: 4, b: 3, c: 2, d: 1 }]))).toEqual(['a', 'b', 'c'])
  })

  it('stacks the top sites, then everyone else as Other', () => {
    const bar = { a: 4, b: 3, c: 2, d: 1, e: 1 }
    expect(stack(bar, ['a', 'b', 'c'])).toEqual([4, 3, 2, 2])
    expect(stack({ b: 3 }, ['a', 'b'])).toEqual([0, 3, 0])
    expect(stack({}, [])).toEqual([0])
  })
})

describe('change and averages', () => {
  it('is the fraction changed, or null with nothing before', () => {
    expect(change(122, 100)).toBeCloseTo(0.22)
    expect(change(50, 100)).toBe(-0.5)
    expect(change(50, 0)).toBeNull()
  })

  it('counts begun, kept days only', () => {
    const today = d('2026-10-28')
    expect(countedDays(daysFrom(d('2026-10-25'), 7), today)).toBe(4)
    expect(countedDays(daysFrom(addDays(oldestKept(today), -3), 7), today)).toBe(4)
    expect(countedDays([d('2026-11-01')], today)).toBe(0)
  })

  it('averages per counted day', () => {
    expect(dailyAverage(70, 7)).toBe(10)
    expect(dailyAverage(70, 0)).toBe(0)
  })

  it('knows whether there is any usage on a kept day', () => {
    const today = d('2026-10-28')
    expect(hasAnyUsage(new Map(), today)).toBe(false)
    expect(hasAnyUsage(history({ '2026-10-28': day({ 'a.com': {} }) }), today)).toBe(false)
    expect(hasAnyUsage(history({ '2026-10-28': day({ 'a.com': { 3: 1 } }) }), today)).toBe(true)
    expect(hasAnyUsage(history({ [addDays(oldestKept(today), -1)]: day({ 'a.com': { 3: 1 } }) }), today)).toBe(false)
    expect(hasAnyUsage(history({ '2026-10-29': day({ 'a.com': { 3: 1 } }) }), today)).toBe(false)
  })
})

describe('niceScale', () => {
  it('covers the max in at most three steps', () => {
    expect(niceScale(38 * MIN)).toEqual({ step: 15 * MIN, top: 45 * MIN })
    expect(niceScale(60 * MIN)).toEqual({ step: 30 * MIN, top: 60 * MIN })
    expect(niceScale(5 * 60 * MIN)).toEqual({ step: 120 * MIN, top: 360 * MIN })
  })

  it('gives an empty chart a scale', () => {
    expect(niceScale(0)).toEqual({ step: MIN, top: MIN })
    expect(niceScale(-5)).toEqual({ step: MIN, top: MIN })
  })

  it('keeps going past the largest step', () => {
    expect(niceScale(48 * 60 * MIN)).toEqual({ step: 960 * MIN, top: 2880 * MIN })
  })
})

describe('labels', () => {
  it('names hours by their slot', () => {
    expect(hourLabel(0, 'en-US')).toBe('12 AM')
    expect(hourLabel(14, 'en-US')).toBe('2 PM')
    expect(hourLabel(14, 'en-GB')).toBe('14')
  })

  it('names days in the locale', () => {
    expect(dayLabel(d('2026-10-28'), 'en-US', { weekday: 'short' })).toBe('Wed')
    expect(dayLabel(d('2026-10-28'), 'en-US', { month: 'short', day: 'numeric' })).toBe('Oct 28')
  })

  it('names a range of days compactly', () => {
    // Intl spaces the dash with thin spaces.
    const range = (from: string, to: string) => rangeLabel(d(from), d(to), 'en-US').replace(/\s/g, ' ')
    expect(range('2026-10-11', '2026-10-17')).toBe('Oct 11 – 17')
    expect(range('2026-09-27', '2026-10-03')).toBe('Sep 27 – Oct 3')
  })
})

describe('periods', () => {
  const today = d('2026-10-28') // a Wednesday

  it('steps back by days, within the kept days', () => {
    expect(periodOf('day', 0, today, 0)).toEqual({
      mode: 'day',
      offset: 0,
      days: ['2026-10-28'],
      previous: ['2026-10-27'],
    })
    expect(periodOf('day', 3, today, 0).days).toEqual(['2026-10-25'])
    expect(maxOffset('day', today, 0)).toBe(RETENTION_DAYS - 1)
    expect(periodOf('day', 99, today, 0).days).toEqual([oldestKept(today)])
    expect(periodOf('day', -2, today, 0).offset).toBe(0)
  })

  it('steps back by calendar weeks overlapping the kept days', () => {
    const week = periodOf('week', 0, today, 0)
    expect(week.days[0]).toBe('2026-10-25')
    expect(week.days).toHaveLength(7)
    expect(week.previous[0]).toBe('2026-10-18')
    expect(periodOf('week', 1, today, 1).days[0]).toBe('2026-10-19')
    // Oldest kept: 2026-09-29, a Tuesday, in the week of Sunday 2026-09-27.
    expect(maxOffset('week', today, 0)).toBe(4)
    expect(periodOf('week', 10, today, 0).days[0]).toBe('2026-09-27')
  })
})

describe('summarize', () => {
  const today = d('2026-10-28')
  const h = history({
    '2026-10-21': day({ 'a.com': { 9: 50 } }),
    '2026-10-26': day({ 'a.com': { 9: 30 }, 'b.com': { 10: 20 } }),
    '2026-10-28': day({ 'a.com': { 14: 10 }, 'b.com': { 9: 30 }, 'c.com': { 9: 5 }, 'd.com': { 9: 1 } }),
  })

  it('summarizes a day', () => {
    const s = summarize(h, periodOf('day', 0, today, 0), today, null)
    expect(s.bars).toHaveLength(24)
    expect(s.top).toEqual(['b.com', 'a.com', 'c.com'])
    expect(s.sites.map((x) => x.site)).toEqual(['b.com', 'a.com', 'c.com', 'd.com'])
    expect(s.total).toBe(46 * MIN)
    expect(s.change).toBeNull() // nothing on the 27th
    expect(s.average).toBe(46 * MIN)
  })

  it('summarizes a week against the one before', () => {
    const s = summarize(h, periodOf('week', 0, today, 0), today, null)
    expect(s.bars).toHaveLength(7)
    expect(s.total).toBe(96 * MIN)
    expect(s.change).toBeCloseTo(96 / 50 - 1)
    expect(s.average).toBe(24 * MIN) // Sunday to Wednesday
  })

  it('leaves out a stored day outside the kept days, as the average does', () => {
    const expired = addDays(oldestKept(today), -1)
    const stale = history({ [expired]: day({ 'a.com': { 9: 60 } }), [oldestKept(today)]: day({ 'a.com': { 9: 30 } }) })
    const period = periodOf('week', maxOffset('week', today, 0), today, 0)
    expect(period.days).toContain(expired)
    const s = summarize(stale, period, today, null)
    expect(s.total).toBe(30 * MIN)
    expect(s.average).toBe((30 * MIN) / s.days)
    expect(s.sites).toEqual([{ site: 'a.com', ms: 30 * MIN }])
  })

  // U3: an unfinished period was compared with all of the one before, so
  // every Monday morning read as a 90% drop.
  it('U3: compares an unfinished period with the same part of the one before', () => {
    const early = history({
      '2026-10-20': day({ 'a.com': { 9: 60, 20: 60 } }),
      '2026-10-21': day({ 'a.com': { 9: 40, 10: 60, 20: 300 } }),
      '2026-10-27': day({ 'a.com': { 9: 60, 20: 60 } }),
      '2026-10-28': day({ 'a.com': { 9: 40 } }),
    })
    // 10:30 on Wednesday: yesterday so far is its 9 AM hour.
    expect(summarize(early, periodOf('day', 0, today, 0), today, null, 10.5).change).toBeCloseTo(40 / 60 - 1)
    // This week so far: Tuesday's 120, Wednesday's 40. Last week to the same
    // point: Tuesday's 120, then Wednesday's 40 and half of its 10 AM hour.
    expect(summarize(early, periodOf('week', 0, today, 0), today, null, 10.5).change).toBeCloseTo(160 / 190 - 1)
    // A period that is over is compared with all of the one before.
    expect(summarize(early, periodOf('day', 7, today, 0), today, null, 10.5).change).toBeCloseTo(400 / 120 - 1)
  })

  it('filters to one site', () => {
    const s = summarize(h, periodOf('week', 0, today, 0), today, 'a.com')
    expect(s.top).toEqual([])
    expect(s.total).toBe(40 * MIN)
    expect(s.change).toBeCloseTo(-0.2)
  })
})

describe('withUncredited', () => {
  const NOW = new Date(2026, 9, 28, 14, 30).getTime()
  const DAY: DayStamp = '2026-10-28'
  const at = (hours: Record<number, number>) => {
    const buckets = emptyBuckets()
    for (const [hour, ms] of Object.entries(hours)) {
      buckets[Number(hour)] = ms
    }
    return buckets
  }
  const stored: History = new Map<DayStamp, DayUsage>([
    ['2026-10-27', { 'a.com': at({ 9: 5000 }) }],
    [DAY, { 'a.com': at({ 9: 1000, 14: 2000 }), 'b.com': at({ 10: 4000 }) }],
  ])
  const totals: TodayTotals = {
    day: DAY,
    asOf: NOW - 10_000,
    seq: 3,
    running: 'a.com',
    sites: { 'a.com': 3000 + 20_000, 'b.com': 4000, 'c.com': 7000 },
  }

  it('adds what storage lacks to the current hour, in a copy', () => {
    const shown = withUncredited(stored, totals, NOW)
    expect(shown.get(DAY)).toEqual({
      'a.com': at({ 9: 1000, 14: 2000 + 20_000 + 10_000 }),
      'b.com': at({ 10: 4000 }),
      'c.com': at({ 14: 7000 }),
    })
    expect(shown.get('2026-10-27')).toBe(stored.get('2026-10-27'))
    expect(stored.get(DAY)!['a.com']).toEqual(at({ 9: 1000, 14: 2000 }))
    expect(stored.get(DAY)!['c.com']).toBeUndefined()
  })

  it('leaves history as it is when storage has it all, or more', () => {
    const behind: TodayTotals = { ...totals, running: null, sites: { 'a.com': 1000, 'b.com': 4000 } }
    expect(withUncredited(stored, behind, NOW)).toBe(stored)
  })

  it('past midnight, adds only the running time since', () => {
    const midnight = new Date(2026, 9, 29).getTime()
    const late: TodayTotals = { ...totals, asOf: midnight - 5000 }
    const shown = withUncredited(stored, late, midnight + 3000)
    expect(shown.get('2026-10-29')).toEqual({ 'a.com': at({ 0: 3000 }) })
    expect(shown.get(DAY)).toBe(stored.get(DAY))
  })
})

describe('splitAtLimit', () => {
  it('splits a day’s hours where their running total reaches the limit', () => {
    expect(splitAtLimit([30, 0, 25, 15], 60, true)).toEqual([
      { within: 30, over: 0 },
      { within: 0, over: 0 },
      { within: 25, over: 0 },
      { within: 5, over: 10 },
    ])
  })

  it('marks the first hour over even when the limit fell at its start', () => {
    expect(splitAtLimit([60, 10, 5], 60, true)).toEqual([
      { within: 60, over: 0 },
      { within: 0, over: 10 },
      { within: 0, over: 5 },
    ])
  })

  it('compares each day with the limit on its own', () => {
    expect(splitAtLimit([70, 50], 60, false)).toEqual([
      { within: 60, over: 10 },
      { within: 50, over: 0 },
    ])
  })

  it('keeps everything within when there is no limit', () => {
    expect(splitAtLimit([5, 7], null, true)).toEqual([
      { within: 5, over: 0 },
      { within: 7, over: 0 },
    ])
  })
})
