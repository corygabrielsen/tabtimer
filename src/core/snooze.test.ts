import { describe, it, expect } from 'vitest'
import { normalizeSnoozes, overSegments, snoozeCounts, snoozeMarks, type Snooze } from './snooze'

const MIN = 60_000

const taken = (site: string, at: number, siteMs: number, globalMs: number): Snooze => ({
  site,
  at,
  ms: 5 * MIN,
  siteMs,
  globalMs,
})

describe('normalizeSnoozes', () => {
  it('keeps well-formed snoozes, oldest first, and drops the rest', () => {
    const a = taken('a.com', 2, MIN, 2 * MIN)
    const b = taken('b.com', 1, 0, 0)
    expect(normalizeSnoozes([a, null, { ...a, site: '' }, { ...a, at: 'x' }, [1], b])).toEqual([b, a])
  })

  it('reads anything but an array as none, and clamps negative times to zero', () => {
    expect(normalizeSnoozes({})).toEqual([])
    expect(normalizeSnoozes(undefined)).toEqual([])
    expect(normalizeSnoozes([{ site: 'a.com', at: 1, ms: -1, siteMs: -1, globalMs: -1 }])).toEqual([
      { site: 'a.com', at: 1, ms: 0, siteMs: 0, globalMs: 0 },
    ])
  })
})

describe('snoozeMarks', () => {
  const snoozes = [taken('a.com', 1, 60 * MIN, 80 * MIN), taken('b.com', 2, 10 * MIN, 85 * MIN)]

  it('counts a site’s own snoozes against its own limit, by its own time', () => {
    expect(snoozeMarks(snoozes, 'a.com', 'site')).toEqual([60 * MIN])
    expect(snoozeMarks(snoozes, 'c.com', 'site')).toEqual([])
  })

  it('counts every snooze against the all-sites limit, by the combined time', () => {
    expect(snoozeMarks(snoozes, 'a.com', 'global')).toEqual([80 * MIN, 85 * MIN])
  })
})

describe('snoozeCounts', () => {
  it('counts each site’s snoozes', () => {
    expect(snoozeCounts([taken('a.com', 1, 0, 0), taken('b.com', 2, 0, 0), taken('a.com', 3, 0, 0)])).toEqual({
      'a.com': 2,
      'b.com': 1,
    })
    expect(snoozeCounts([])).toEqual({})
  })
})

describe('overSegments', () => {
  it('is empty within the limit', () => {
    expect(overSegments(60 * MIN, 60 * MIN, [60 * MIN])).toEqual([])
  })

  it('gives one stretch per snooze when each began at the limit or the last one’s end', () => {
    expect(overSegments(60 * MIN, 70 * MIN, [60 * MIN, 65 * MIN])).toEqual([5 * MIN, 5 * MIN])
  })

  it('gives time over before any snooze a stretch of its own (a limit lowered)', () => {
    expect(overSegments(30 * MIN, 70 * MIN, [60 * MIN])).toEqual([30 * MIN, 10 * MIN])
    expect(overSegments(30 * MIN, 40 * MIN, [])).toEqual([10 * MIN])
  })

  it('clamps marks into the time over, and leaves out empty stretches', () => {
    // A snooze before the limit was raised, and one after time away was taken back.
    expect(overSegments(60 * MIN, 70 * MIN, [20 * MIN, 90 * MIN])).toEqual([10 * MIN])
    // A snooze with no time spent in it.
    expect(overSegments(60 * MIN, 64 * MIN, [60 * MIN, 64 * MIN])).toEqual([4 * MIN])
  })

  it('always adds up to the time over', () => {
    const segments = overSegments(45 * MIN, 81 * MIN, [50 * MIN, 47 * MIN, 70 * MIN])
    expect(segments.reduce((a, b) => a + b, 0)).toBe(36 * MIN)
    expect(segments).toEqual([2 * MIN, 3 * MIN, 20 * MIN, 11 * MIN])
  })
})
