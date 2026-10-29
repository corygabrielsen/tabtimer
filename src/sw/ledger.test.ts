import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createLedger, PRUNED_DAY_KEY, type Ledger } from './ledger'
import { chromeStore } from '../chrome/store'
import {
  emptyBuckets,
  normalizeDay,
  siteTotal,
  IDLE_STATE_KEY,
  LIMITS_KEY,
  PREFS_KEY,
  SCHEMA,
  SNOOZE_KEY,
} from '../core/schema'
import { normalizeAway, AWAY_KEY } from '../core/away'
import { SNOOZE_MS } from '../core/limits'
import { fakeChrome, type FakeChrome } from '../test/chrome'

const MIN = 60_000
const HOUR = 60 * MIN
const at = (...args: [number, number, number, number?, number?, number?]) => new Date(...args).getTime()
const NOON = at(2026, 5, 10, 12)

let browser: FakeChrome
let now: number
let ledger: Ledger

const data = () => browser.storage.local.data
const buckets = (byHour: Record<number, number>) => {
  const b = emptyBuckets()
  for (const [h, ms] of Object.entries(byHour)) {
    b[Number(h)] = ms
  }
  return b
}

beforeEach(() => {
  browser = fakeChrome()
  now = NOON
  ledger = createLedger(chromeStore('local'), chromeStore('session'), { now: () => now })
})

describe('addElapsed', () => {
  it('adds time to the site’s hour and returns its total today', async () => {
    await expect(ledger.addElapsed('reddit.com', [[NOON - 5000, NOON - 2000]])).resolves.toBe(3000)
    await expect(ledger.addElapsed('reddit.com', [[NOON - 2000, NOON]])).resolves.toBe(5000)
    expect(data()['day:2026-06-10']).toEqual({ 'reddit.com': buckets({ 11: 5000 }) })
  })

  it('splits spans at hour boundaries and midnight into each day’s own key', async () => {
    now = at(2026, 5, 11, 0, 5)
    const total = await ledger.addElapsed('x.com', [
      [at(2026, 5, 10, 22, 50), at(2026, 5, 10, 23, 0)],
      [at(2026, 5, 10, 23, 58), at(2026, 5, 11, 0, 2)],
    ])
    expect(total).toBe(2 * MIN)
    expect(data()['day:2026-06-10']).toEqual({ 'x.com': buckets({ 22: 10 * MIN, 23: 2 * MIN }) })
    expect(data()['day:2026-06-11']).toEqual({ 'x.com': buckets({ 0: 2 * MIN }) })
  })

  it('keeps every other site’s time', async () => {
    await ledger.addElapsed('a.com', [[NOON - 1000, NOON]])
    await ledger.addElapsed('b.com', [[NOON - 2000, NOON]])
    expect(data()['day:2026-06-10']).toEqual({ 'a.com': buckets({ 11: 1000 }), 'b.com': buckets({ 11: 2000 }) })
  })

  it('never loses an update when many tabs report at once', async () => {
    // Slow storage widens the read-modify-write window an unserialized
    // writer would lose updates in.
    browser.latency = 3
    const totals = await Promise.all(
      Array.from({ length: 10 }, () => ledger.addElapsed('a.com', [[NOON - 1000, NOON]]))
    )
    expect(data()['day:2026-06-10']).toEqual({ 'a.com': buckets({ 11: 10_000 }) })
    expect(totals.sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => (i + 1) * 1000))
  })

  it('reports a storage failure and keeps serving later writes', async () => {
    browser.storage.local.error = 'QUOTA_BYTES quota exceeded'
    await expect(ledger.addElapsed('a.com', [[NOON - 1000, NOON]])).rejects.toThrow('QUOTA_BYTES')
    browser.storage.local.error = null
    await expect(ledger.addElapsed('a.com', [[NOON - 1000, NOON]])).resolves.toBe(1000)
  })
})

describe('retention', () => {
  const seedDays = (...days: string[]) =>
    browser.storage.local.seed(Object.fromEntries(days.map((d) => [`day:${d}`, { 'a.com': buckets({ 1: 1 }) }])))

  it('the first write of a new day prunes days older than 30, and only once that day', async () => {
    seedDays('2026-05-11', '2026-05-12', '2026-06-09')
    await ledger.addElapsed('a.com', [[NOON - 1000, NOON]])
    // 11 May is 30 days before 10 June: gone; 12 May is the oldest day kept.
    expect(Object.keys(data()).sort()).toEqual(['day:2026-05-12', 'day:2026-06-09', 'day:2026-06-10'])
    expect(browser.storage.session.data[PRUNED_DAY_KEY]).toBe('2026-06-10')

    const getAll = vi.spyOn(browser.storage.local, 'get')
    seedDays('2026-01-01')
    await ledger.addElapsed('a.com', [[NOON, NOON + 1000]])
    expect(getAll.mock.calls.filter(([keys]) => keys === null)).toHaveLength(0)
    expect(data()['day:2026-01-01']).toBeDefined()

    now = at(2026, 5, 11, 9)
    await ledger.addElapsed('a.com', [[now - 1000, now]])
    // A day later, 12 May has expired too (as has the stray January day).
    expect(Object.keys(data()).sort()).toEqual(['day:2026-06-09', 'day:2026-06-10', 'day:2026-06-11'])
  })

  it('prunes on demand (install and startup)', async () => {
    seedDays('2026-04-01', '2026-06-01')
    browser.storage.local.seed({ [LIMITS_KEY]: { global: MIN, perSite: {} } })
    await ledger.prune()
    expect(Object.keys(data()).sort()).toEqual(['day:2026-06-01', LIMITS_KEY])
  })
})

describe('ensureSchema', () => {
  it('clears storage written in any other layout, then writes the defaults', async () => {
    browser.storage.local.seed({
      focusTimer_elapsed_today_reddit_com_2026_06_10: 5000,
      tabtimer_limits: { global: MIN, perSite: {} },
      tabtimer_hidden: true,
    })
    await expect(ledger.ensureSchema()).resolves.toBe(true)
    expect(data()).toEqual({
      schema: SCHEMA,
      limits: { global: null, perSite: {} },
      prefs: { hidden: false, scale: 1 },
      snoozeUntil: 0,
    })
  })

  it('clears a different schema number too', async () => {
    browser.storage.local.seed({ schema: 3, [LIMITS_KEY]: { global: MIN, perSite: {} } })
    await ledger.ensureSchema()
    expect(data()[LIMITS_KEY]).toEqual({ global: null, perSite: {} })
  })

  it('leaves storage in this schema alone', async () => {
    const stored = { schema: SCHEMA, [LIMITS_KEY]: { global: MIN, perSite: {} }, 'day:2026-06-10': {} }
    browser.storage.local.seed(stored)
    await expect(ledger.ensureSchema()).resolves.toBe(false)
    expect(data()).toEqual(stored)
  })
})

describe('resetToday', () => {
  it('zeroes one site today, keeping other sites and other days', async () => {
    browser.storage.local.seed({
      'day:2026-06-09': { 'a.com': buckets({ 3: 100 }) },
      'day:2026-06-10': { 'a.com': buckets({ 3: 100 }), 'b.com': buckets({ 4: 200 }) },
    })
    await ledger.resetToday('a.com')
    expect(data()['day:2026-06-10']).toEqual({ 'b.com': buckets({ 4: 200 }) })
    expect(data()['day:2026-06-09']).toEqual({ 'a.com': buckets({ 3: 100 }) })
  })

  it('writes nothing for a site with no time today', async () => {
    const set = vi.spyOn(browser.storage.local, 'set')
    await ledger.resetToday('a.com')
    expect(set).not.toHaveBeenCalled()
  })

  it('applies after additions queued before it', async () => {
    browser.latency = 2
    await Promise.all([ledger.addElapsed('a.com', [[NOON - 1000, NOON]]), ledger.resetToday('a.com')])
    expect(data()['day:2026-06-10']).toEqual({})
  })
})

describe('setLimit', () => {
  it('Copilot 4408399271: concurrent edits from the popup and the options page both survive', async () => {
    browser.latency = 3
    browser.storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: { 'x.com': 5 * MIN } } })
    // The popup sets this site's limit while the options page sets the cap.
    const [fromPopup, fromOptions] = await Promise.all([
      ledger.setLimit({ scope: 'site', site: 'reddit.com', ms: 30 * MIN }),
      ledger.setLimit({ scope: 'global', ms: 2 * HOUR }),
    ])
    const both = { global: 2 * HOUR, perSite: { 'x.com': 5 * MIN, 'reddit.com': 30 * MIN } }
    expect(data()[LIMITS_KEY]).toEqual(both)
    expect(fromPopup).toEqual({ global: null, perSite: both.perSite })
    expect(fromOptions).toEqual(both)
  })

  it('clears a limit, and tolerates garbage in storage', async () => {
    browser.storage.local.seed({ [LIMITS_KEY]: 'garbage' })
    await ledger.setLimit({ scope: 'site', site: 'a.com', ms: MIN })
    await ledger.setLimit({ scope: 'site', site: 'a.com', ms: null })
    expect(data()[LIMITS_KEY]).toEqual({ global: null, perSite: {} })
  })
})

describe('snooze and prefs', () => {
  it('snoozes for SNOOZE_MS from now', async () => {
    await expect(ledger.snooze()).resolves.toBe(NOON + SNOOZE_MS)
    expect(data()[SNOOZE_KEY]).toBe(NOON + SNOOZE_MS)
  })

  it('merges a prefs change into the stored prefs', async () => {
    await expect(ledger.setPrefs({ scale: 0.75 })).resolves.toEqual({ hidden: false, scale: 0.75 })
    await expect(ledger.setPrefs({ hidden: true })).resolves.toEqual({ hidden: true, scale: 0.75 })
    expect(data()[PREFS_KEY]).toEqual({ hidden: true, scale: 0.75 })
  })
})

describe('time away from the computer', () => {
  const away = () => normalizeAway(browser.storage.session.data[AWAY_KEY])
  const day = (stamp = '2026-06-10') => data()[`day:${stamp}`]

  it('mirrors the idle state for content scripts and records it for the worker', async () => {
    await ledger.setIdleState('locked')
    expect(data()[IDLE_STATE_KEY]).toBe('locked')
    expect(away()).toMatchObject({ state: 'locked', periods: [{ kind: 'locked', start: NOON, end: null }] })
  })

  it('credits nothing while locked, media or not, and counts again on return', async () => {
    await ledger.setIdleState('locked')
    now = NOON + 2 * MIN
    await expect(ledger.addElapsed('a.com', [[NOON - MIN, now]], true)).resolves.toBe(MIN)
    await ledger.setIdleState('active')
    now = NOON + 3 * MIN
    await expect(ledger.addElapsed('a.com', [[NOON + 2 * MIN, now]])).resolves.toBe(2 * MIN)
  })

  it('takes back time credited since the last input when idle is reported', async () => {
    // Reports every 10 s, the last input 5 minutes before idle fires.
    for (let t = NOON - 10 * MIN; t < NOON; t += 10_000) {
      now = t + 10_000
      await ledger.addElapsed('a.com', [[t, now]])
    }
    expect(siteTotal(normalizeDay(day()), 'a.com')).toBe(10 * MIN)
    await ledger.setIdleState('idle')
    expect(day()).toEqual({ 'a.com': buckets({ 11: 5 * MIN }) })
    // Late reports from inside the idle period are trimmed too.
    now = NOON + 10_000
    await expect(ledger.addElapsed('a.com', [[NOON - 20_000, now]])).resolves.toBe(5 * MIN)
  })

  it('keeps idle time a page reports with media playing, but not other pages’ time', async () => {
    now = NOON - MIN
    await ledger.addElapsed('video.com', [[NOON - 2 * MIN, now]], true)
    await ledger.addElapsed('news.com', [[NOON - 2 * MIN, now]], false)
    now = NOON
    await ledger.setIdleState('idle')
    now = NOON + MIN
    await ledger.addElapsed('video.com', [[NOON, now]], true)
    await ledger.addElapsed('news.com', [[NOON, now]], false)
    expect(day()).toEqual({ 'video.com': buckets({ 11: MIN, 12: MIN }), 'news.com': buckets({}) })
    // A lock pauses even media.
    await ledger.setIdleState('locked')
    now = NOON + 2 * MIN
    await ledger.addElapsed('video.com', [[NOON + MIN, now]], true)
    expect(siteTotal(normalizeDay(day()), 'video.com')).toBe(2 * MIN)
  })

  it('takes back time across an hour boundary and midnight, from each day’s own key', async () => {
    const midnight = at(2026, 5, 11)
    now = midnight + 3 * MIN
    await ledger.addElapsed('a.com', [[midnight - 4 * MIN, now]])
    await ledger.setIdleState('idle')
    // Idle since 23:58 on the 10th: two minutes back before midnight, three after.
    expect(day('2026-06-10')).toEqual({ 'a.com': buckets({ 23: 2 * MIN }) })
    expect(day('2026-06-11')).toEqual({ 'a.com': buckets({}) })
  })

  it('never takes back below zero, nor time reset since it was credited', async () => {
    now = NOON
    await ledger.addElapsed('a.com', [[NOON - MIN, NOON]])
    await ledger.addElapsed('b.com', [[NOON - MIN, NOON]])
    await ledger.resetToday('a.com')
    await ledger.addElapsed('a.com', [[NOON - 1000, NOON]])
    browser.storage.local.seed({ 'day:2026-06-10': { 'a.com': buckets({ 11: 500 }) } })
    await ledger.setIdleState('idle')
    expect(day()).toEqual({ 'a.com': buckets({ 11: 0 }) })
    expect(away().recent).toEqual([])
  })

  it('survives a service worker restart: a new ledger reads the periods back', async () => {
    await ledger.setIdleState('locked')
    const restarted = createLedger(chromeStore('local'), chromeStore('session'), { now: () => now })
    now = NOON + MIN
    await expect(restarted.addElapsed('a.com', [[NOON - MIN, now]])).resolves.toBe(MIN)
    await restarted.setIdleState('active')
    expect(away().periods).toEqual([{ kind: 'locked', start: NOON, end: NOON + MIN }])
  })
})
