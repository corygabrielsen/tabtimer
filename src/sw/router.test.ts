import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRouter } from './router'
import { createLedger } from './ledger'
import { createTracker } from './tracker'
import { chromeStore } from '../chrome/store'
import type { Handler, Sender } from '../chrome/bus'
import { LIMITS_KEY, PREFS_KEY, SNOOZE_KEY, emptyBuckets } from '../core/schema'
import { SNOOZE_MS } from '../core/limits'
import { fakeChrome, type FakeChrome } from '../test/chrome'

const ID = 'tabtimer-test'
const EXT = `chrome-extension://${ID}/`
const NOON = new Date(2026, 5, 10, 12).getTime()
const MIN = 60_000

let browser: FakeChrome
let NOW = NOON
let handle: Handler
let openOptions: ReturnType<typeof vi.fn<() => Promise<void>>>

const content = (url = 'https://old.reddit.com/r/all', extra: Partial<Sender> = {}): Sender => ({
  id: ID,
  url,
  tab: { id: 7, windowId: 1 },
  frameId: 0,
  ...extra,
})
const page = (path = 'popup.html'): Sender => ({ id: ID, url: `${EXT}${path}` })
const today = () => browser.storage.local.data['day:2026-06-10'] as Record<string, number[]> | undefined
const PRESENT = { visible: true, focused: true, media: false, blocked: false }
const presence = { type: 'presence', ...PRESENT }
const hidden = { type: 'presence', ...PRESENT, visible: false }

// The page reports in, three seconds pass, and it reports itself hidden:
// three seconds are credited to the sender's site.
async function visit(sender = content(), extra: Record<string, unknown> = {}) {
  const shown = await handle({ ...presence, ...extra }, sender)
  NOW += 3000
  await handle(hidden, sender)
  return shown
}

beforeEach(() => {
  browser = fakeChrome()
  openOptions = vi.fn(() => Promise.resolve())
  NOW = NOON
  const clock = { now: () => NOW }
  const ledger = createLedger(chromeStore('local'), chromeStore('session'), clock)
  const tracker = createTracker({
    ledger,
    session: chromeStore('session'),
    send: () => Promise.resolve(undefined),
    alarm: () => Promise.resolve(),
  })
  handle = createRouter({ ledger, tracker, extensionId: ID, extensionUrl: EXT, openOptions })
})

describe('sender policy', () => {
  it('refuses anything not sent by this extension', async () => {
    for (const sender of [
      { ...content(), id: 'some-other-extension' },
      { ...page(), id: undefined },
    ]) {
      await expect(handle(presence, sender)).resolves.toEqual({ ok: false, error: 'forbidden' })
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
    const response = await visit(content(), { site: 'x.com' })
    expect(response).toMatchObject({ ok: true, value: { site: 'reddit.com', running: true, today: 0 } })
    expect(Object.keys(today() ?? {})).toEqual(['reddit.com'])
    expect(today()?.['reddit.com']?.[12]).toBe(3000)
    await expect(handle({ ...presence, site: 'x.com' }, content('https://news.bbc.co.uk/'))).resolves.toMatchObject({
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
      await expect(handle(presence, sender)).resolves.toEqual({ ok: false, error: 'forbidden' })
    }
    expect(today()).toBeUndefined()
  })

  it('still accepts a page’s last report as it leaves, and hears it as hidden', async () => {
    // Chrome numbers a departing top frame like any other frame.
    for (const documentLifecycle of ['cached', 'pending_deletion']) {
      await handle(presence, content())
      NOW += 3000
      // Whatever it says, a page in the back/forward cache or unloading
      // isn't being used.
      await expect(handle(presence, content(undefined, { frameId: 4, documentLifecycle }))).resolves.toMatchObject({
        ok: true,
        value: { running: false },
      })
    }
    expect(today()?.['reddit.com']?.[12]).toBe(6000)
  })

  it('identifies the tab, its window and its document', async () => {
    await handle(presence, content(undefined, { tab: { id: 3, windowId: 9 }, documentId: 'doc-a' }))
    expect(browser.storage.session.data.tracker).toMatchObject({
      open: { tabId: 3, windowId: 9, doc: 'doc-a', site: 'reddit.com' },
    })
    // A tab without a window id still reports (as window -1).
    await handle(presence, content(undefined, { tab: { id: 4 } }))
    expect(browser.storage.session.data.tracker).toMatchObject({ open: { tabId: 4, windowId: -1, doc: '' } })
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

  it('does not take presence from extension pages', async () => {
    await expect(handle(presence, page())).resolves.toEqual({ ok: false, error: 'forbidden' })
    await expect(handle(presence, page('options.html'))).resolves.toEqual({ ok: false, error: 'forbidden' })
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
  it('reset today for one site, from the popup, including time not yet credited', async () => {
    browser.storage.local.seed({ 'day:2026-06-10': { 'reddit.com': emptyBuckets(), 'a.com': emptyBuckets() } })
    await handle(presence, content())
    NOW += 3000
    await expect(handle({ type: 'resetToday', site: 'reddit.com' }, page())).resolves.toEqual({
      ok: true,
      value: null,
    })
    expect(Object.keys(today() ?? {})).toEqual(['a.com'])
    NOW += 2000
    await handle(hidden, content())
    expect(today()?.['reddit.com']?.[12]).toBe(2000)
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

  it('take the page’s media flag: while idle, only a page playing media accrues', async () => {
    browser.storage.session.seed({
      away: { state: 'idle', since: NOW - MIN, periods: [{ kind: 'idle', start: NOW - MIN, end: null }], recent: [] },
    })
    await expect(handle(presence, content())).resolves.toMatchObject({ ok: true, value: { running: false } })
    await expect(handle({ ...presence, media: true }, content())).resolves.toMatchObject({
      ok: true,
      value: { running: true },
    })
    NOW += 3000
    await handle({ ...hidden, media: true }, content())
    expect(today()?.['reddit.com']?.[12]).toBe(3000)
    await expect(handle({ ...presence, media: 'yes' }, content())).resolves.toEqual({ ok: false, error: 'bad_request' })
  })

  it('open the options page', async () => {
    await expect(handle({ type: 'openOptions' }, content())).resolves.toEqual({ ok: true, value: null })
    expect(openOptions).toHaveBeenCalledOnce()
  })

  it('answer internal when a handler fails', async () => {
    browser.storage.local.error = 'QUOTA_BYTES quota exceeded'
    await expect(handle(presence, content())).resolves.toEqual({ ok: false, error: 'internal' })
  })
})
