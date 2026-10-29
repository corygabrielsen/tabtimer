import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createLedger, PRUNED_DAY_KEY, type Ledger } from './ledger'
import { chromeStore } from '../chrome/store'
import { normalizeDay, siteTotal, LIMITS_KEY, PREFS_KEY, SCHEMA } from '../core/schema'
import { normalizeAway, AWAY_KEY, type IdleState, type Span } from '../core/away'
import { SNOOZE_MS } from '../core/limits'
import { at, bucketsOf } from '../test/data'
import { fakeChrome, type FakeChrome } from '../test/chrome'

const MIN = 60_000
const NOON = at(2026, 5, 10, 12)

let browser: FakeChrome
let now: number
let ledger: Ledger

const data = () => browser.storage.local.data
// The transaction operations, each in a transaction of its own.
const addElapsed = (site: string, spans: Span[], media = false, on: Ledger = ledger): Promise<number> =>
  on.transaction(async (tx) => {
    await tx.credit(spans.map(([start, end]) => ({ site, start, end, media })))
    return siteTotal(await tx.today(), site)
  })
const setIdleState = (state: IdleState, on: Ledger = ledger) => on.transaction((tx) => tx.observeIdle(state))
const resetToday = (site: string) => ledger.transaction((tx) => tx.resetToday(site))

beforeEach(() => {
  browser = fakeChrome()
  now = NOON
  ledger = createLedger(chromeStore('local'), chromeStore('session'), { now: () => now })
})

describe('credit', () => {
  it('adds time to the site’s hour and returns its total today', async () => {
    await expect(addElapsed('reddit.com', [[NOON - 5000, NOON - 2000]])).resolves.toBe(3000)
    await expect(addElapsed('reddit.com', [[NOON - 2000, NOON]])).resolves.toBe(5000)
    expect(data()['day:2026-06-10']).toEqual({ 'reddit.com': bucketsOf({ 11: 5000 }) })
  })

  it('splits spans at hour boundaries and midnight into each day’s own key', async () => {
    now = at(2026, 5, 11, 0, 5)
    const total = await addElapsed('x.com', [
      [at(2026, 5, 10, 22, 50), at(2026, 5, 10, 23, 0)],
      [at(2026, 5, 10, 23, 58), at(2026, 5, 11, 0, 2)],
    ])
    expect(total).toBe(2 * MIN)
    expect(data()['day:2026-06-10']).toEqual({ 'x.com': bucketsOf({ 22: 10 * MIN, 23: 2 * MIN }) })
    expect(data()['day:2026-06-11']).toEqual({ 'x.com': bucketsOf({ 0: 2 * MIN }) })
  })

  it('keeps every other site’s time', async () => {
    await addElapsed('a.com', [[NOON - 1000, NOON]])
    await addElapsed('b.com', [[NOON - 2000, NOON]])
    expect(data()['day:2026-06-10']).toEqual({ 'a.com': bucketsOf({ 11: 1000 }), 'b.com': bucketsOf({ 11: 2000 }) })
  })

  it('never loses an update when many tabs report at once', async () => {
    // Slow storage widens the read-modify-write window an unserialized
    // writer would lose updates in.
    browser.latency = 3
    const totals = await Promise.all(Array.from({ length: 10 }, () => addElapsed('a.com', [[NOON - 1000, NOON]])))
    expect(data()['day:2026-06-10']).toEqual({ 'a.com': bucketsOf({ 11: 10_000 }) })
    expect(totals.sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => (i + 1) * 1000))
  })

  it('writes nothing for nothing to credit', async () => {
    const set = vi.spyOn(browser.storage.local, 'set')
    await ledger.transaction((tx) => tx.credit([]))
    expect(set).not.toHaveBeenCalled()
  })

  it('reads limits and the snooze for the tracker, tolerating garbage', async () => {
    browser.storage.local.seed({ [LIMITS_KEY]: { global: 1, perSite: {}, snoozeUntil: 'soon' } })
    await expect(ledger.transaction((tx) => tx.limits())).resolves.toEqual({ global: 1, perSite: {}, snoozeUntil: 0 })
  })

  it('reports a storage failure and keeps serving later writes', async () => {
    browser.storage.local.error = 'QUOTA_BYTES quota exceeded'
    await expect(addElapsed('a.com', [[NOON - 1000, NOON]])).rejects.toThrow('QUOTA_BYTES')
    browser.storage.local.error = null
    await expect(addElapsed('a.com', [[NOON - 1000, NOON]])).resolves.toBe(1000)
  })
})

describe('retention', () => {
  const seedDays = (...days: string[]) =>
    browser.storage.local.seed(Object.fromEntries(days.map((d) => [`day:${d}`, { 'a.com': bucketsOf({ 1: 1 }) }])))

  it('the first write of a new day prunes days older than 30, and only once that day', async () => {
    seedDays('2026-05-11', '2026-05-12', '2026-06-09')
    await addElapsed('a.com', [[NOON - 1000, NOON]])
    // 11 May is 30 days before 10 June: gone; 12 May is the oldest day kept.
    expect(Object.keys(data()).sort()).toEqual(['day:2026-05-12', 'day:2026-06-09', 'day:2026-06-10'])
    expect(browser.storage.session.data[PRUNED_DAY_KEY]).toBe('2026-06-10')

    const getAll = vi.spyOn(browser.storage.local, 'get')
    seedDays('2026-01-01')
    await addElapsed('a.com', [[NOON, NOON + 1000]])
    expect(getAll.mock.calls.filter(([keys]) => keys === null)).toHaveLength(0)
    expect(data()['day:2026-01-01']).toBeDefined()

    now = at(2026, 5, 11, 9)
    await addElapsed('a.com', [[now - 1000, now]])
    // A day later, 12 May has expired too (as has the stray January day).
    expect(Object.keys(data()).sort()).toEqual(['day:2026-06-09', 'day:2026-06-10', 'day:2026-06-11'])
  })

  it('prunes on demand (install and startup)', async () => {
    seedDays('2026-04-01', '2026-06-01')
    browser.storage.local.seed({ [LIMITS_KEY]: { global: 1, perSite: {} } })
    await ledger.prune()
    expect(Object.keys(data()).sort()).toEqual(['day:2026-06-01', LIMITS_KEY])
  })
})

describe('ensureSchema', () => {
  it('clears storage written in any other layout, keeping only the schema mark', async () => {
    browser.storage.local.seed({
      focusTimer_elapsed_today_reddit_com_2026_06_10: 5000,
      tabtimer_limits: { global: MIN, perSite: {} },
      tabtimer_hidden: true,
    })
    await ledger.ensureSchema()
    expect(data()).toEqual({ schema: SCHEMA })
  })

  it('clears a different schema number too', async () => {
    browser.storage.local.seed({ schema: SCHEMA - 1, [LIMITS_KEY]: { global: MIN, perSite: {} } })
    await ledger.ensureSchema()
    expect(data()).toEqual({ schema: SCHEMA })
  })

  it('leaves storage in this schema alone', async () => {
    const stored = { schema: SCHEMA, [LIMITS_KEY]: { global: 1, perSite: {} }, 'day:2026-06-10': {} }
    browser.storage.local.seed(stored)
    await ledger.ensureSchema()
    expect(data()).toEqual(stored)
  })
})

describe('resetToday', () => {
  it('zeroes one site today, keeping other sites and other days', async () => {
    browser.storage.local.seed({
      'day:2026-06-09': { 'a.com': bucketsOf({ 3: 100 }) },
      'day:2026-06-10': { 'a.com': bucketsOf({ 3: 100 }), 'b.com': bucketsOf({ 4: 200 }) },
    })
    await resetToday('a.com')
    expect(data()['day:2026-06-10']).toEqual({ 'b.com': bucketsOf({ 4: 200 }) })
    expect(data()['day:2026-06-09']).toEqual({ 'a.com': bucketsOf({ 3: 100 }) })
  })

  it('writes nothing for a site with no time today', async () => {
    const set = vi.spyOn(browser.storage.local, 'set')
    await resetToday('a.com')
    expect(set).not.toHaveBeenCalled()
  })

  it('applies after additions queued before it', async () => {
    browser.latency = 2
    await Promise.all([addElapsed('a.com', [[NOON - 1000, NOON]]), resetToday('a.com')])
    expect(data()['day:2026-06-10']).toEqual({})
  })
})

describe('setLimit', () => {
  it('Copilot 4408399271: concurrent edits from the popup and the options page both survive', async () => {
    browser.latency = 3
    browser.storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: { 'x.com': 5 }, snoozeUntil: 0 } })
    // The popup sets this site's limit while the options page sets the cap.
    const [fromPopup, fromOptions] = await Promise.all([
      ledger.setLimit({ scope: 'site', site: 'reddit.com', minutes: 30 }),
      ledger.setLimit({ scope: 'global', minutes: 120 }),
    ])
    const both = { global: 120, perSite: { 'x.com': 5, 'reddit.com': 30 }, snoozeUntil: 0 }
    expect(data()[LIMITS_KEY]).toEqual(both)
    expect(fromPopup).toEqual({ ...both, global: null })
    expect(fromOptions).toEqual(both)
  })

  it('clears a limit, and tolerates garbage in storage', async () => {
    browser.storage.local.seed({ [LIMITS_KEY]: 'garbage' })
    await ledger.setLimit({ scope: 'site', site: 'a.com', minutes: 1 })
    await ledger.setLimit({ scope: 'site', site: 'a.com', minutes: null })
    expect(data()[LIMITS_KEY]).toEqual({ global: null, perSite: {}, snoozeUntil: 0 })
  })
})

describe('snooze and prefs', () => {
  it('snoozes for SNOOZE_MS from now, keeping the limits; a limit edit keeps the snooze', async () => {
    browser.storage.local.seed({ [LIMITS_KEY]: { global: 60, perSite: {} } })
    await expect(ledger.snooze()).resolves.toBe(NOON + SNOOZE_MS)
    expect(data()[LIMITS_KEY]).toEqual({ global: 60, perSite: {}, snoozeUntil: NOON + SNOOZE_MS })
    await ledger.setLimit({ scope: 'global', minutes: 90 })
    expect(data()[LIMITS_KEY]).toEqual({ global: 90, perSite: {}, snoozeUntil: NOON + SNOOZE_MS })
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

  it('records the idle state for the worker, in session storage only', async () => {
    await setIdleState('locked')
    expect(data()).toEqual({})
    await expect(ledger.transaction((tx) => tx.idleState())).resolves.toBe('locked')
    expect(away()).toMatchObject({ state: 'locked', periods: [{ kind: 'locked', start: NOON, end: null }] })
  })

  it('credits nothing while locked, media or not, and counts again on return', async () => {
    await setIdleState('locked')
    now = NOON + 2 * MIN
    await expect(addElapsed('a.com', [[NOON - MIN, now]], true)).resolves.toBe(MIN)
    await setIdleState('active')
    now = NOON + 3 * MIN
    await expect(addElapsed('a.com', [[NOON + 2 * MIN, now]])).resolves.toBe(2 * MIN)
  })

  it('takes back time credited since the last input when idle is reported', async () => {
    // Reports every 10 s, the last input 5 minutes before idle fires.
    for (let t = NOON - 10 * MIN; t < NOON; t += 10_000) {
      now = t + 10_000
      await addElapsed('a.com', [[t, now]])
    }
    expect(siteTotal(normalizeDay(day()), 'a.com')).toBe(10 * MIN)
    await setIdleState('idle')
    expect(day()).toEqual({ 'a.com': bucketsOf({ 11: 5 * MIN }) })
    // Late reports from inside the idle period are trimmed too.
    now = NOON + 10_000
    await expect(addElapsed('a.com', [[NOON - 20_000, now]])).resolves.toBe(5 * MIN)
  })

  it('keeps idle time a page reports with media playing, but not other pages’ time', async () => {
    now = NOON - MIN
    await addElapsed('video.com', [[NOON - 2 * MIN, now]], true)
    await addElapsed('news.com', [[NOON - 2 * MIN, now]], false)
    now = NOON
    await setIdleState('idle')
    now = NOON + MIN
    await addElapsed('video.com', [[NOON, now]], true)
    await addElapsed('news.com', [[NOON, now]], false)
    expect(day()).toEqual({ 'video.com': bucketsOf({ 11: MIN, 12: MIN }), 'news.com': bucketsOf({}) })
    // A lock pauses even media.
    await setIdleState('locked')
    now = NOON + 2 * MIN
    await addElapsed('video.com', [[NOON + MIN, now]], true)
    expect(siteTotal(normalizeDay(day()), 'video.com')).toBe(2 * MIN)
  })

  it('takes back time across an hour boundary and midnight, from each day’s own key', async () => {
    const midnight = at(2026, 5, 11)
    now = midnight + 3 * MIN
    await addElapsed('a.com', [[midnight - 4 * MIN, now]])
    await setIdleState('idle')
    // Idle since 23:58 on the 10th: two minutes back before midnight, three after.
    expect(day('2026-06-10')).toEqual({ 'a.com': bucketsOf({ 23: 2 * MIN }) })
    expect(day('2026-06-11')).toEqual({ 'a.com': bucketsOf({}) })
  })

  it('never takes back below zero, nor time reset since it was credited', async () => {
    now = NOON
    await addElapsed('a.com', [[NOON - MIN, NOON]])
    await addElapsed('b.com', [[NOON - MIN, NOON]])
    await resetToday('a.com')
    await addElapsed('a.com', [[NOON - 1000, NOON]])
    browser.storage.local.seed({ 'day:2026-06-10': { 'a.com': bucketsOf({ 11: 500 }) } })
    await setIdleState('idle')
    expect(day()).toEqual({ 'a.com': bucketsOf({ 11: 0 }) })
    expect(away().recent).toEqual([])
  })

  it('survives a service worker restart: a new ledger reads the periods back', async () => {
    await setIdleState('locked')
    const restarted = createLedger(chromeStore('local'), chromeStore('session'), { now: () => now })
    now = NOON + MIN
    await expect(addElapsed('a.com', [[NOON - MIN, now]], false, restarted)).resolves.toBe(MIN)
    await setIdleState('active', restarted)
    expect(away().periods).toEqual([{ kind: 'locked', start: NOON, end: NOON + MIN }])
  })
})
