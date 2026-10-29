import { describe, it, expect, vi } from 'vitest'
import {
  baseHost,
  baseKeyForHost,
  isElapsedKeyForDay,
  todayKeyForHost,
  readGlobalElapsedToday,
  readLimits,
  readSnoozeUntil,
  setGlobalLimit,
  setPerSiteLimit,
  snoozeBlocking,
  ELAPSED_KEY_PREFIX,
} from './storage'
import { BLOCK_SNOOZE_KEY, DEFAULT_LIMITS, LIMITS_KEY, SNOOZE_MS } from './core/limits'
import { fakeChrome } from './test/chrome'

describe('baseHost', () => {
  it('strips subdomains down to the last two labels', () => {
    expect(baseHost('www.reddit.com')).toBe('reddit.com')
    expect(baseHost('old.reddit.com')).toBe('reddit.com')
    expect(baseHost('reddit.com')).toBe('reddit.com')
    expect(baseHost('x.com')).toBe('x.com')
  })
})

describe('baseKeyForHost', () => {
  it('builds a stable base key from the registrable host', () => {
    expect(baseKeyForHost('www.youtube.com')).toBe(`${ELAPSED_KEY_PREFIX}_youtube.com`)
  })
})

describe('todayKeyForHost', () => {
  it('appends a zero-padded ISO date for the given day', () => {
    const day = new Date(2026, 0, 5) // 2026-01-05, local
    expect(todayKeyForHost('m.youtube.com', day)).toBe(`${ELAPSED_KEY_PREFIX}_youtube.com_2026-01-05`)
  })

  it('maps two subdomains of one site to the same key', () => {
    const day = new Date(2026, 5, 28)
    expect(todayKeyForHost('old.reddit.com', day)).toBe(todayKeyForHost('www.reddit.com', day))
  })
})

describe('isElapsedKeyForDay', () => {
  it('matches every site’s key for that day only', () => {
    const day = new Date(2026, 5, 28)
    expect(isElapsedKeyForDay(todayKeyForHost('x.com', day), day)).toBe(true)
    expect(isElapsedKeyForDay(todayKeyForHost('x.com', new Date(2026, 5, 27)), day)).toBe(false)
    expect(isElapsedKeyForDay('tabtimer_limits', day)).toBe(false)
  })
})

describe('readGlobalElapsedToday', () => {
  it('sums every site for the day, and is 0 when storage fails', async () => {
    const day = new Date(2026, 5, 28)
    fakeChrome().storage.local.seed({
      [todayKeyForHost('x.com', day)]: 5,
      [todayKeyForHost('reddit.com', day)]: 7,
      [todayKeyForHost('x.com', new Date(2026, 5, 27))]: 100,
    })
    await expect(readGlobalElapsedToday(day)).resolves.toBe(12)
    fakeChrome().storage.local.error = 'storage unavailable'
    await expect(readGlobalElapsedToday(day)).resolves.toBe(0)
  })
})

describe('limits storage', () => {
  it('reads defaults, then what was written', async () => {
    await expect(readLimits()).resolves.toEqual(DEFAULT_LIMITS)
    await setGlobalLimit(60_000)
    await setPerSiteLimit('x.com', 30_000)
    await expect(readLimits()).resolves.toEqual({ global: 60_000, perSite: { 'x.com': 30_000 } })
    await setPerSiteLimit('x.com', null)
    expect(fakeChrome().storage.local.data[LIMITS_KEY]).toEqual({ global: 60_000, perSite: {} })
  })

  it('swallows storage failures', async () => {
    fakeChrome().storage.local.error = 'storage unavailable'
    await expect(readLimits()).resolves.toEqual(DEFAULT_LIMITS)
    await expect(setGlobalLimit(60_000)).resolves.toBeUndefined()
    await expect(readSnoozeUntil()).resolves.toBe(0)
    await expect(snoozeBlocking()).resolves.toBeUndefined()
  })

  it('snoozes for SNOOZE_MS of wall-clock time', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    await expect(readSnoozeUntil()).resolves.toBe(0)
    await snoozeBlocking()
    expect(fakeChrome().storage.local.data[BLOCK_SNOOZE_KEY]).toBe(1_000_000 + SNOOZE_MS)
    await expect(readSnoozeUntil()).resolves.toBe(1_000_000 + SNOOZE_MS)
  })
})
