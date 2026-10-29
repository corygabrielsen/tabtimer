import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRouter } from './router'
import { createLedger } from './ledger'
import { chromeStore } from '../chrome/store'
import type { Handler, Sender } from '../chrome/bus'
import { LIMITS_KEY, PREFS_KEY, SNOOZE_KEY, emptyBuckets } from '../core/schema'
import { SNOOZE_MS } from '../core/limits'
import { fakeChrome, type FakeChrome } from '../test/chrome'

const ID = 'tabtimer-test'
const EXT = `chrome-extension://${ID}/`
const NOW = new Date(2026, 5, 10, 12).getTime()
const MIN = 60_000

let browser: FakeChrome
let handle: Handler
let openOptions: ReturnType<typeof vi.fn<() => Promise<void>>>

const content = (url = 'https://old.reddit.com/r/all', extra: Partial<Sender> = {}): Sender => ({
  id: ID,
  url,
  tab: { id: 7 },
  frameId: 0,
  ...extra,
})
const page = (path = 'popup.html'): Sender => ({ id: ID, url: `${EXT}${path}` })
const today = () => browser.storage.local.data['day:2026-06-10'] as Record<string, number[]> | undefined
const report = { type: 'addElapsed', spans: [[NOW - 3000, NOW]] }

beforeEach(() => {
  browser = fakeChrome()
  openOptions = vi.fn(() => Promise.resolve())
  const clock = { now: () => NOW }
  handle = createRouter({
    ledger: createLedger(chromeStore('local'), chromeStore('session'), clock),
    extensionId: ID,
    extensionUrl: EXT,
    now: clock.now,
    openOptions,
  })
})

describe('sender policy', () => {
  it('refuses anything not sent by this extension', async () => {
    for (const sender of [
      { ...content(), id: 'some-other-extension' },
      { ...page(), id: undefined },
    ]) {
      await expect(handle({ type: 'hello' }, sender)).resolves.toEqual({ ok: false, error: 'forbidden' })
    }
    await expect(handle({ type: 'resetToday', site: 'reddit.com' }, { url: `${EXT}popup.html` })).resolves.toEqual({
      ok: false,
      error: 'forbidden',
    })
  })

  it('rejects a malformed request before acting on it', async () => {
    await expect(handle({ type: 'resetKey', key: 'limits' }, page())).resolves.toEqual({
      ok: false,
      error: 'bad_request',
    })
    await expect(handle(null, content())).resolves.toEqual({ ok: false, error: 'bad_request' })
    expect(browser.storage.local.data).toEqual({})
  })

  it('takes a content script’s site from its URL and ignores any site in the payload', async () => {
    const response = await handle({ ...report, site: 'x.com' }, content())
    expect(response).toEqual({ ok: true, value: { total: 3000 } })
    expect(Object.keys(today() ?? {})).toEqual(['reddit.com'])
    await expect(handle({ type: 'hello', site: 'x.com' }, content('https://news.bbc.co.uk/'))).resolves.toEqual({
      ok: true,
      value: { site: 'bbc.co.uk' },
    })
  })

  it('accepts content requests only from a tab’s top frame on an http(s) page', async () => {
    const refused = [
      content(undefined, { frameId: 3 }),
      content(undefined, { frameId: 3, documentLifecycle: 'active' }),
      content(undefined, { frameId: 3, documentLifecycle: 'prerender' }),
      content(undefined, { frameId: undefined }),
      content(undefined, { tab: undefined }),
      content('about:blank'),
      content('file:///etc/passwd'),
      { id: ID, tab: { id: 7 }, frameId: 0 },
    ]
    for (const sender of refused) {
      await expect(handle(report, sender)).resolves.toEqual({ ok: false, error: 'forbidden' })
    }
    expect(today()).toBeUndefined()
  })

  it('still accepts a page’s last report as it leaves (back/forward cache or unload)', async () => {
    // Chrome numbers a departing top frame like any other frame.
    for (const documentLifecycle of ['cached', 'pending_deletion']) {
      await expect(handle(report, content(undefined, { frameId: 4, documentLifecycle }))).resolves.toMatchObject({
        ok: true,
      })
    }
    expect(Object.keys(today() ?? {})).toEqual(['reddit.com'])
  })

  it('reserves resets and limits for extension pages (closes key injection)', async () => {
    browser.storage.local.seed({ 'day:2026-06-10': { 'x.com': emptyBuckets().fill(1000) } })
    for (const raw of [
      { type: 'resetToday', site: 'x.com' },
      { type: 'setLimit', scope: 'global', ms: MIN },
      { type: 'setLimit', scope: 'site', site: 'x.com', ms: MIN },
    ]) {
      await expect(handle(raw, content())).resolves.toEqual({ ok: false, error: 'forbidden' })
    }
    expect(today()?.['x.com']).toEqual(emptyBuckets().fill(1000))
    expect(browser.storage.local.data[LIMITS_KEY]).toBeUndefined()
  })

  it('does not take time reports or hellos from extension pages', async () => {
    await expect(handle(report, page())).resolves.toEqual({ ok: false, error: 'forbidden' })
    await expect(handle({ type: 'hello' }, page('options.html'))).resolves.toEqual({ ok: false, error: 'forbidden' })
  })

  it('wants sites from extension pages in canonical form', async () => {
    for (const site of ['www.reddit.com', 'news.bbc.co.uk']) {
      await expect(handle({ type: 'resetToday', site }, page())).resolves.toEqual({ ok: false, error: 'bad_request' })
      await expect(handle({ type: 'setLimit', scope: 'site', site, ms: MIN }, page())).resolves.toEqual({
        ok: false,
        error: 'bad_request',
      })
    }
  })
})

describe('handlers', () => {
  it('reset today for one site, from the popup', async () => {
    browser.storage.local.seed({ 'day:2026-06-10': { 'x.com': emptyBuckets(), 'a.com': emptyBuckets() } })
    await expect(handle({ type: 'resetToday', site: 'x.com' }, page())).resolves.toEqual({ ok: true, value: null })
    expect(Object.keys(today() ?? {})).toEqual(['a.com'])
  })

  it('set a limit and answer with all limits', async () => {
    await expect(handle({ type: 'setLimit', scope: 'site', site: 'x.com', ms: MIN }, page())).resolves.toEqual({
      ok: true,
      value: { global: null, perSite: { 'x.com': MIN } },
    })
    await expect(handle({ type: 'setLimit', scope: 'global', ms: 2 * MIN }, page('options.html'))).resolves.toEqual({
      ok: true,
      value: { global: 2 * MIN, perSite: { 'x.com': MIN } },
    })
  })

  it('snooze, from a tab or a page', async () => {
    await expect(handle({ type: 'snooze' }, content())).resolves.toEqual({
      ok: true,
      value: { snoozeUntil: NOW + SNOOZE_MS },
    })
    expect(browser.storage.local.data[SNOOZE_KEY]).toBe(NOW + SNOOZE_MS)
  })

  it('set prefs, changing only the fields given', async () => {
    await handle({ type: 'setPrefs', scale: 0.5 }, content())
    await expect(handle({ type: 'setPrefs', hidden: true }, page())).resolves.toEqual({
      ok: true,
      value: { hidden: true, scale: 0.5 },
    })
    expect(browser.storage.local.data[PREFS_KEY]).toEqual({ hidden: true, scale: 0.5 })
  })

  it('open the options page', async () => {
    await expect(handle({ type: 'openOptions' }, content())).resolves.toEqual({ ok: true, value: null })
    expect(openOptions).toHaveBeenCalledOnce()
  })

  it('answer internal when a handler fails', async () => {
    browser.storage.local.error = 'QUOTA_BYTES quota exceeded'
    await expect(handle(report, content())).resolves.toEqual({ ok: false, error: 'internal' })
  })
})
