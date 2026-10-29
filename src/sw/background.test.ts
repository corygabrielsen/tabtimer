import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fakeChrome, type FakeChrome } from '../test/chrome'
import { flush } from '../test/dom'
import { bus } from '../chrome/bus'
import { originsForSite } from '../core/site'
import { SCHEMA } from '../core/schema'

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
    const old = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 45, 12)
    const pad = (n: number) => String(n).padStart(2, '0')
    const oldKey = `day:${old.getFullYear()}-${pad(old.getMonth() + 1)}-${pad(old.getDate())}`
    browser.storage.local.seed({ schema: SCHEMA, limits: { global: 60, perSite: {} }, [oldKey]: {} })
    browser.runtime.onStartup.dispatch()
    await flush()
    expect(browser.storage.local.data).toEqual({
      schema: SCHEMA,
      limits: { global: 60, perSite: {} },
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
    await expect(bus.send('open', { page: 'activity' })).resolves.toEqual({ ok: true, value: null })
    expect(browser.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://tabtimer-test/usage.html' })
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
