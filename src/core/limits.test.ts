import { describe, it, expect } from 'vitest'
import {
  applyLimit,
  blockAt,
  evaluateLimits,
  normalizeLimits,
  parseLimitMinutes,
  minutesToMs,
  msToMinutes,
  DEFAULT_LIMITS,
} from './limits'

const limits = { global: minutesToMs(60), perSite: { 'reddit.com': minutesToMs(30) } }

describe('evaluateLimits', () => {
  it('returns null when under all limits', () => {
    expect(evaluateLimits(limits, 'reddit.com', minutesToMs(10), minutesToMs(20))).toBeNull()
  })

  it('blocks on the per-site limit', () => {
    const r = evaluateLimits(limits, 'reddit.com', minutesToMs(30), minutesToMs(40))
    expect(r?.scope).toBe('site')
    expect(r?.limit).toBe(minutesToMs(30))
  })

  it('blocks on the global limit when no per-site limit applies', () => {
    const r = evaluateLimits(limits, 'youtube.com', minutesToMs(5), minutesToMs(60))
    expect(r?.scope).toBe('global')
  })

  it('reports per-site over global when both are exceeded', () => {
    const r = evaluateLimits(limits, 'reddit.com', minutesToMs(45), minutesToMs(90))
    expect(r?.scope).toBe('site')
  })

  it('ignores absent/zero limits', () => {
    expect(evaluateLimits(DEFAULT_LIMITS, 'reddit.com', minutesToMs(999), minutesToMs(999))).toBeNull()
  })
})

describe('parseLimitMinutes', () => {
  it('parses positive minutes to ms', () => {
    expect(parseLimitMinutes('30')).toBe(minutesToMs(30))
  })

  it('returns null for blank, zero, negative, or non-numeric input', () => {
    expect(parseLimitMinutes('')).toBeNull()
    expect(parseLimitMinutes('0')).toBeNull()
    expect(parseLimitMinutes('-5')).toBeNull()
    expect(parseLimitMinutes('abc')).toBeNull()
  })

  it('floors fractional minutes', () => {
    expect(parseLimitMinutes('2.9')).toBe(minutesToMs(2))
  })
})

describe('minute/ms conversion', () => {
  it('round-trips whole minutes', () => {
    expect(msToMinutes(minutesToMs(45))).toBe(45)
  })
})

describe('normalizeLimits', () => {
  it('coerces missing/garbage values to safe defaults', () => {
    expect(normalizeLimits(null)).toEqual({ global: null, perSite: {} })
    expect(normalizeLimits({ global: 0 })).toEqual({ global: null, perSite: {} })
  })

  it('keeps valid values', () => {
    expect(normalizeLimits({ global: 1000, perSite: { 'x.com': 60000 } })).toEqual({
      global: 1000,
      perSite: { 'x.com': 60000 },
    })
  })
})

describe('normalizeLimits per-site entries', () => {
  it('drops entries that are not positive numbers', () => {
    expect(
      normalizeLimits({ global: -1, perSite: { 'a.com': 60000, 'b.com': 0, 'c.com': '5', 'd.com': NaN } })
    ).toEqual({
      global: null,
      perSite: { 'a.com': 60000 },
    })
  })
})

describe('applyLimit', () => {
  const base = { global: minutesToMs(60), perSite: { 'a.com': minutesToMs(10) } }

  it('sets or clears the all-sites cap, keeping per-site limits', () => {
    expect(applyLimit(base, { scope: 'global', ms: minutesToMs(90) })).toEqual({ ...base, global: minutesToMs(90) })
    expect(applyLimit(base, { scope: 'global', ms: null })).toEqual({ ...base, global: null })
  })

  it('sets or clears one site, keeping the rest', () => {
    expect(applyLimit(base, { scope: 'site', site: 'b.com', ms: minutesToMs(5) })).toEqual({
      global: minutesToMs(60),
      perSite: { 'a.com': minutesToMs(10), 'b.com': minutesToMs(5) },
    })
    expect(applyLimit(base, { scope: 'site', site: 'a.com', ms: null })).toEqual({
      global: minutesToMs(60),
      perSite: {},
    })
  })

  it('does not modify its input', () => {
    applyLimit(base, { scope: 'site', site: 'a.com', ms: null })
    expect(base.perSite).toEqual({ 'a.com': minutesToMs(10) })
  })
})

describe('blockAt', () => {
  const MIN = 60_000
  const T = 1_000_000

  it('is when the tighter limit is reached, if the page keeps accruing', () => {
    expect(blockAt(limits, 'reddit.com', 20 * MIN, 25 * MIN, T, true, 0)).toEqual({
      at: T + 10 * MIN,
      scope: 'site',
      limit: 30 * MIN,
    })
    expect(blockAt(limits, 'reddit.com', 20 * MIN, 55 * MIN, T, true, 0)).toEqual({
      at: T + 5 * MIN,
      scope: 'global',
      limit: 60 * MIN,
    })
  })

  it('names the site when both limits are reached at once', () => {
    expect(blockAt(limits, 'reddit.com', 30 * MIN, 60 * MIN, T, false, 0)).toMatchObject({ at: T, scope: 'site' })
  })

  it('is now when already over, running or not; never while under and not accruing', () => {
    expect(blockAt(limits, 'reddit.com', 31 * MIN, 31 * MIN, T, false, 0)?.at).toBe(T)
    expect(blockAt(limits, 'reddit.com', 10 * MIN, 10 * MIN, T, false, 0)).toBeNull()
    expect(blockAt(DEFAULT_LIMITS, 'reddit.com', 600 * MIN, 600 * MIN, T, true, 0)).toBeNull()
  })

  it('waits for a snooze to end', () => {
    expect(blockAt(limits, 'reddit.com', 40 * MIN, 40 * MIN, T, false, T + 5 * MIN)?.at).toBe(T + 5 * MIN)
    expect(blockAt(limits, 'reddit.com', 20 * MIN, 20 * MIN, T, true, T + MIN)?.at).toBe(T + 10 * MIN)
  })
})
