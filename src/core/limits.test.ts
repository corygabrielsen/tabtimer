import { describe, it, expect } from 'vitest'
import {
  applyLimit,
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
