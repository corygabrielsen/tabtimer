import { describe, it, expect } from 'vitest'
import { evaluateLimits, normalizeLimits, parseLimitMinutes, minutesToMs, msToMinutes, DEFAULT_LIMITS } from './limits'

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
