import { describe, it, expect } from 'vitest'
import {
  applyLimit,
  blockAt,
  limitsFor,
  normalizeLimits,
  minutesToMs,
  msToMinutes,
  siteLimitOf,
  DEFAULT_LIMITS,
} from './limits'

const limits = { global: 60, perSite: { 'reddit.com': 30 }, snoozeUntil: 0 }

describe('minute/ms conversion', () => {
  it('round-trips whole minutes', () => {
    expect(msToMinutes(minutesToMs(45))).toBe(45)
  })
})

describe('siteLimitOf and limitsFor', () => {
  it("reads a site's limit in minutes, and the limits that apply in ms", () => {
    expect(siteLimitOf(limits, 'reddit.com')).toBe(30)
    expect(siteLimitOf(limits, 'youtube.com')).toBeNull()
    expect(limitsFor(limits, 'reddit.com')).toEqual({ site: minutesToMs(30), global: minutesToMs(60) })
    expect(limitsFor(DEFAULT_LIMITS, 'reddit.com')).toEqual({ site: null, global: null })
  })
})

describe('normalizeLimits', () => {
  it('coerces missing/garbage values to safe defaults', () => {
    expect(normalizeLimits(null)).toEqual(DEFAULT_LIMITS)
    expect(normalizeLimits({ global: 0, snoozeUntil: 'soon' })).toEqual(DEFAULT_LIMITS)
  })

  it('keeps valid values', () => {
    expect(normalizeLimits({ global: 90, perSite: { 'x.com': 1 }, snoozeUntil: 5 })).toEqual({
      global: 90,
      perSite: { 'x.com': 1 },
      snoozeUntil: 5,
    })
  })
})

describe('normalizeLimits per-site entries', () => {
  it('drops entries that are not positive numbers', () => {
    expect(normalizeLimits({ global: -1, perSite: { 'a.com': 1, 'b.com': 0, 'c.com': '5', 'd.com': NaN } })).toEqual({
      global: null,
      perSite: { 'a.com': 1 },
      snoozeUntil: 0,
    })
  })
})

describe('applyLimit', () => {
  const base = { global: 60, perSite: { 'a.com': 10 }, snoozeUntil: 7 }

  it('sets or clears the all-sites cap, keeping per-site limits and the snooze', () => {
    expect(applyLimit(base, { scope: 'global', minutes: 90 })).toEqual({ ...base, global: 90 })
    expect(applyLimit(base, { scope: 'global', minutes: null })).toEqual({ ...base, global: null })
  })

  it('sets or clears one site, keeping the rest', () => {
    expect(applyLimit(base, { scope: 'site', site: 'b.com', minutes: 5 })).toEqual({
      ...base,
      perSite: { 'a.com': 10, 'b.com': 5 },
    })
    expect(applyLimit(base, { scope: 'site', site: 'a.com', minutes: null })).toEqual({ ...base, perSite: {} })
  })

  it('does not modify its input', () => {
    applyLimit(base, { scope: 'site', site: 'a.com', minutes: null })
    expect(base.perSite).toEqual({ 'a.com': 10 })
  })
})

describe('blockAt', () => {
  const MIN = 60_000
  const T = 1_000_000

  it('is when the tighter limit is reached, if the page keeps accruing', () => {
    expect(blockAt(limits, 'reddit.com', 20 * MIN, 25 * MIN, T, true)).toEqual({
      at: T + 10 * MIN,
      scope: 'site',
      limit: 30 * MIN,
    })
    expect(blockAt(limits, 'reddit.com', 20 * MIN, 55 * MIN, T, true)).toEqual({
      at: T + 5 * MIN,
      scope: 'global',
      limit: 60 * MIN,
    })
  })

  it('names the site when both limits are reached', () => {
    expect(blockAt(limits, 'reddit.com', 30 * MIN, 60 * MIN, T, false)).toMatchObject({ at: T, scope: 'site' })
    expect(blockAt(limits, 'reddit.com', 45 * MIN, 90 * MIN, T, false)).toMatchObject({ scope: 'site' })
  })

  it('is on the all-sites cap where no per-site limit applies', () => {
    expect(blockAt(limits, 'youtube.com', 5 * MIN, 60 * MIN, T, false)).toMatchObject({ at: T, scope: 'global' })
  })

  it('is now when already over, running or not; never while under and not accruing', () => {
    expect(blockAt(limits, 'reddit.com', 31 * MIN, 31 * MIN, T, false)?.at).toBe(T)
    expect(blockAt(limits, 'reddit.com', 10 * MIN, 10 * MIN, T, false)).toBeNull()
    expect(blockAt(DEFAULT_LIMITS, 'reddit.com', 600 * MIN, 600 * MIN, T, true)).toBeNull()
  })

  it('waits for a snooze to end', () => {
    const snoozed = (until: number) => ({ ...limits, snoozeUntil: until })
    expect(blockAt(snoozed(T + 5 * MIN), 'reddit.com', 40 * MIN, 40 * MIN, T, false)?.at).toBe(T + 5 * MIN)
    expect(blockAt(snoozed(T + MIN), 'reddit.com', 20 * MIN, 20 * MIN, T, true)?.at).toBe(T + 10 * MIN)
  })
})
