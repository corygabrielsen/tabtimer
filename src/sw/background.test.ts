import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fakeChrome, type FakeChrome } from '../test/chrome'
import { flush } from '../test/dom'
import { dayKeyOf } from '../test/content'
import { bus } from '../chrome/bus'
import { originsForSite } from '../core/site'
import { emptyBuckets, SCHEMA } from '../core/schema'

let browser: FakeChrome

const PRESENT = { visible: true, focused: true, media: false, blocked: false }

beforeEach(async () => {
  browser = fakeChrome()
  vi.resetModules()
  await import('./background')
})

describe('storage on install and startup', () => {
  it('clears data from an older storage format, keeping only the schema mark', async () => {
    browser.storage.local.seed({
      focusTimer_elapsed_today_reddit_com_2026_06_10: 5000,
      tabtimer_limits: { global: 60_000, perSite: {} },
    })
    browser.runtime.onInstalled.dispatch({ reason: 'update' })
    await flush()
    expect(browser.storage.local.data).toEqual({ schema: SCHEMA })
  })

  it('keeps data in the current format and prunes expired days on startup', async () => {
    const today = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = (days: number) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days, 12)
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }
    browser.storage.local.seed({
      schema: SCHEMA,
      limits: { global: 60, perSite: {} },
      clock: { day: stamp(-1), pending: null },
      [`day:${stamp(-45)}`]: {},
    })
    browser.runtime.onStartup.dispatch()
    await flush()
    expect(browser.storage.local.data).toEqual({
      schema: SCHEMA,
      limits: { global: 60, perSite: {} },
      clock: { day: stamp(0), pending: null },
    })
  })
})

describe('idle', () => {
  it('watches chrome.idle over five minutes and records the state at every start', async () => {
    await flush()
    browser.idleState = 'locked'
    vi.resetModules()
    await import('./background')
    await flush()
    expect(browser.idle.setDetectionInterval).toHaveBeenCalledWith(300)
    const away = () => (browser.storage.session.data.worker as { away: { state: string } }).away.state
    expect(away()).toBe('locked')
    browser.setIdleState('active')
    await flush()
    expect(away()).toBe('active')
  })
})

describe('messages', () => {
  beforeEach(() => {
    browser.granted = new Set(originsForSite('reddit.com'))
  })

  it('serves the contract to this extension', async () => {
    browser.sender = {
      id: browser.runtime.id,
      url: 'https://www.reddit.com/',
      tab: { id: 1 },
      frameId: 0,
      documentLifecycle: 'active',
    }
    await expect(bus.send('presence', PRESENT)).resolves.toMatchObject({
      ok: true,
      value: { site: 'reddit.com', running: true },
    })
    await expect(bus.send('open', { page: 'options' })).resolves.toEqual({ ok: true, value: null })
    expect(browser.runtime.openOptionsPage).toHaveBeenCalledOnce()
  })

  // W5: the page opened in a window that stayed behind, so the button
  // seemed to do nothing while the block stayed up.
  it('W5: brings the window of the page it opens to the front', async () => {
    browser.sender = {
      id: browser.runtime.id,
      url: 'https://www.reddit.com/',
      tab: { id: 1, windowId: 1 },
      frameId: 0,
      documentLifecycle: 'active',
    }
    // The options page already open in another window: that window.
    browser.runtime.getContexts.mockResolvedValueOnce([{ windowId: 2, tabId: 8 }])
    await bus.send('open', { page: 'options' })
    expect(browser.runtime.getContexts).toHaveBeenLastCalledWith({
      contextTypes: ['TAB'],
      documentUrls: ['chrome-extension://tabtimer-test/options.html'],
    })
    expect(browser.windows.update).toHaveBeenLastCalledWith(2, { focused: true })
    // Not found, or the lookup fails: nothing more to do.
    browser.windows.update.mockClear()
    browser.runtime.getContexts.mockRejectedValueOnce(new Error('nope'))
    await bus.send('open', { page: 'options' })
    expect(browser.windows.update).not.toHaveBeenCalled()
  })

  it('refuses other senders', async () => {
    browser.sender = {
      id: 'someone-else',
      url: 'https://www.reddit.com/',
      tab: { id: 1 },
      frameId: 0,
      documentLifecycle: 'active',
    }
    await expect(bus.send('presence', PRESENT)).resolves.toEqual({ ok: false, error: 'forbidden' })
  })
})

describe('content-script registration', () => {
  const registered = () => browser.registered.get('tabtimer-content')

  it('opens options on first install, but not on update', async () => {
    browser.runtime.onInstalled.dispatch({ reason: 'update' })
    await flush()
    expect(browser.runtime.openOptionsPage).not.toHaveBeenCalled()
    browser.runtime.onInstalled.dispatch({ reason: 'install' })
    await flush()
    expect(browser.runtime.openOptionsPage).toHaveBeenCalledOnce()
  })

  it('registers nothing when no site is granted', async () => {
    browser.runtime.onInstalled.dispatch({ reason: 'install' })
    await flush()
    expect(registered()).toBeUndefined()
  })

  it('registers the content script for granted origins on startup', async () => {
    browser.granted = new Set(originsForSite('reddit.com'))
    browser.runtime.onStartup.dispatch()
    await flush()
    expect(registered()).toMatchObject({
      js: ['content.js'],
      matches: originsForSite('reddit.com'),
      persistAcrossSessions: true,
    })
  })

  it('keeps every grant when grants come in quick succession', async () => {
    browser.grant(originsForSite('reddit.com'))
    browser.grant(originsForSite('x.com'))
    await flush()
    expect(registered()?.matches).toEqual([...originsForSite('reddit.com'), ...originsForSite('x.com')])
  })

  it("X3: registers Chrome's own grant shapes, but not a bare public suffix", async () => {
    browser.granted = new Set(['https://www.reddit.com/*', '*://*/*', ...originsForSite('s3.amazonaws.com')])
    browser.runtime.onStartup.dispatch()
    await flush()
    expect(registered()?.matches).toEqual(['https://www.reddit.com/*', '*://*/*'])
  })

  it('U2: registers nothing for a grant on a bare public suffix alone', async () => {
    browser.granted = new Set(originsForSite('s3.amazonaws.com'))
    browser.runtime.onStartup.dispatch()
    await flush()
    expect(registered()).toBeUndefined()
  })

  it('tracks grants as they are added and removed', async () => {
    browser.grant(originsForSite('reddit.com'))
    await flush()
    expect(registered()?.matches).toEqual(originsForSite('reddit.com'))

    browser.grant(originsForSite('x.com'))
    await flush()
    expect(registered()?.matches).toEqual([...originsForSite('reddit.com'), ...originsForSite('x.com')])

    await browser.permissions.remove({ origins: originsForSite('reddit.com') })
    await flush()
    expect(registered()?.matches).toEqual(originsForSite('x.com'))

    await browser.permissions.remove({ origins: originsForSite('x.com') })
    await flush()
    expect(registered()).toBeUndefined()
  })
})

describe('open tabs follow the grants', () => {
  const registered = () => browser.registered.get('tabtimer-content')
  const injected = () => browser.scripting.executeScript.mock.calls.map(([injection]) => injection.target.tabId)
  const stopped = () =>
    browser.tabs.sendMessage.mock.calls.filter(([, message]) => (message as { type?: string }).type === 'stop')

  beforeEach(() => {
    browser.openTabs = [
      { id: 1, url: 'https://www.reddit.com/r/all' },
      { id: 2, url: 'https://old.reddit.com/' },
      { id: 3, url: 'https://x.com/home' },
      { id: 4 },
    ]
  })

  it('X2: a grant starts every open tab on the site, without a reload', async () => {
    browser.grant(originsForSite('reddit.com'))
    await flush()
    expect(injected()).toEqual([1, 2])
    expect(browser.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 1 }, files: ['content.js'] })
  })

  it('X2: leaves alone the tabs an earlier grant already covers', async () => {
    browser.grant(['*://*/*'])
    await flush()
    browser.scripting.executeScript.mockClear()
    browser.grant(originsForSite('reddit.com'))
    await flush()
    expect(injected()).toEqual([])
  })

  it('X2: starts no tab for a grant on a bare public suffix', async () => {
    browser.grant(originsForSite('s3.amazonaws.com'))
    await flush()
    expect(injected()).toEqual([])
  })

  it('KNOWN-1: a revoke stops every page no longer covered, whoever revoked it', async () => {
    browser.granted = new Set([...originsForSite('reddit.com'), ...originsForSite('x.com')])
    // Revoked: the reddit tabs' URLs can't be seen any more.
    browser.openTabs = [{ id: 1 }, { id: 2 }, { id: 3, url: 'https://x.com/home' }]
    await browser.permissions.remove({ origins: originsForSite('reddit.com') })
    await flush()
    expect(stopped().map(([tabId]) => tabId)).toEqual([1, 2])
    expect(registered()?.matches).toEqual(originsForSite('x.com'))
  })

  it('X2: starts a page shown on a granted site that runs no script, as after a bfcache restore', async () => {
    browser.granted = new Set(originsForSite('reddit.com'))
    let running = false
    browser.scripting.executeScript.mockImplementation((injection: { files?: string[] }) =>
      Promise.resolve(injection.files ? [] : [{ result: running }])
    )
    const shown = async (tabId: number, url: string, status = 'complete') => {
      browser.tabs.onUpdated.dispatch(tabId, { status }, { url })
      await flush()
    }
    await shown(1, 'https://www.reddit.com.:443/r/all')
    await shown(3, 'https://x.com/home')
    await shown(1, 'https://www.reddit.com/r/all', 'loading')
    running = true
    await shown(2, 'https://old.reddit.com/')
    expect(browser.scripting.executeScript.mock.calls.map(([injection]) => injection)).toEqual([
      { target: { tabId: 1 }, func: expect.any(Function) },
      { target: { tabId: 1 }, files: ['content.js'] },
      { target: { tabId: 2 }, func: expect.any(Function) },
    ])
  })

  it('X4: tells every page its new all-sites total when the grants change', async () => {
    browser.granted = new Set(originsForSite('reddit.com'))
    browser.storage.local.seed({ [dayKeyOf()]: { 'x.com': emptyBuckets().fill(1000) } })
    browser.sender = {
      id: browser.runtime.id,
      url: 'https://www.reddit.com/',
      tab: { id: 1, windowId: 1 },
      frameId: 0,
      documentLifecycle: 'active',
    }
    await expect(bus.send('presence', PRESENT)).resolves.toMatchObject({ ok: true, value: { globalToday: 0 } })
    const told = () =>
      browser.tabs.sendMessage.mock.calls
        .map(([, message]) => message as { type?: string; state?: { globalToday: number } })
        .filter((m) => m.type === 'state')
        .map((m) => m.state!.globalToday)
    browser.grant(originsForSite('x.com'))
    await flush()
    // The page's own running time aside.
    expect(told().at(-1)).toBeGreaterThanOrEqual(24_000)
    await browser.permissions.remove({ origins: originsForSite('x.com') })
    await flush()
    expect(told().at(-1)).toBeLessThan(24_000)
  })

  it('survives the browser failing every call', async () => {
    browser.tabs.query.mockImplementation(() => Promise.reject(new Error('gone')))
    browser.scripting.executeScript.mockImplementation(() => Promise.reject(new Error('no access')))
    browser.grant(originsForSite('reddit.com'))
    await browser.permissions.remove({ origins: originsForSite('reddit.com') })
    browser.permissions.getAll.mockImplementation(() => Promise.reject(new Error('gone')))
    browser.grant(originsForSite('x.com'))
    browser.storage.session.data = {}
    vi.resetModules()
    await import('./background')
    await flush()
    // Not marked done: the next worker start tries again.
    expect(browser.storage.session.data.injected).toBeUndefined()
  })

  it('W1/X1: a new extension context starts every tracked open tab, once', async () => {
    browser.granted = new Set(originsForSite('reddit.com'))
    // Updated, reloaded or enabled: storage.session is empty.
    browser.storage.session.data = {}
    vi.resetModules()
    await import('./background')
    await flush()
    expect(injected()).toEqual([1, 2])
    // The same context's worker starting again (after going idle).
    vi.resetModules()
    await import('./background')
    await flush()
    expect(injected()).toEqual([1, 2])
  })
})
