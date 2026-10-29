import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fakeChrome, type FakeChrome } from '../test/chrome'
import { flush } from '../test/dom'
import { sendMessage, type MessageResponse } from '../messages'
import { originsForHost } from '../sites'

// Send an arbitrary (possibly malformed) payload, resolving with the response
// or the lastError message.
function rawSend(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    fakeChrome().runtime.sendMessage(message, (response) => {
      resolve(fakeChrome().runtime.lastError?.message ?? response)
    })
  })
}

let browser: FakeChrome

beforeEach(async () => {
  browser = fakeChrome()
  vi.resetModules()
  await import('./background')
})

describe('background single writer', () => {
  it('adds focus time to a key and returns the new total', async () => {
    await expect(sendMessage({ type: 'addElapsed', key: 'k', delta: 1500 })).resolves.toEqual({ ok: true, total: 1500 })
    await expect(sendMessage({ type: 'addElapsed', key: 'k', delta: 500 })).resolves.toEqual({ ok: true, total: 2000 })
    expect(browser.storage.local.data.k).toBe(2000)
  })

  it('never loses an update when many tabs report at once', async () => {
    // Slow storage widens the read-modify-write window an unserialized
    // writer would lose updates in.
    browser.latency = 3
    const reports = Array.from({ length: 10 }, () => sendMessage({ type: 'addElapsed', key: 'k', delta: 1000 }))
    const responses = await Promise.all(reports)
    expect(browser.storage.local.data.k).toBe(10_000)
    expect(responses.map((r) => (r.ok ? r.total : -1)).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 10 }, (_, i) => (i + 1) * 1000)
    )
  })

  it.each([
    { type: 'addElapsed', key: 'k', delta: 0 },
    { type: 'addElapsed', key: 'k', delta: -5 },
    { type: 'addElapsed', key: 'k', delta: '5' },
    { type: 'addElapsed', delta: 5 },
    { type: 'resetKey' },
  ])('rejects malformed %j without writing', async (message) => {
    const response = (await rawSend(message)) as MessageResponse
    expect(response.ok).toBe(false)
    expect(browser.storage.local.data).toEqual({})
  })

  it('resets a key to zero', async () => {
    browser.storage.local.seed({ k: 9000 })
    await expect(sendMessage({ type: 'resetKey', key: 'k' })).resolves.toEqual({ ok: true, total: 0 })
    expect(browser.storage.local.data.k).toBe(0)
  })

  it('orders a reset after earlier queued additions', async () => {
    browser.latency = 2
    const add = sendMessage({ type: 'addElapsed', key: 'k', delta: 1000 })
    const reset = sendMessage({ type: 'resetKey', key: 'k' })
    await Promise.all([add, reset])
    expect(browser.storage.local.data.k).toBe(0)
  })

  it('reports a storage failure and keeps serving later writes', async () => {
    browser.storage.local.error = 'QUOTA_BYTES quota exceeded'
    const failed = await sendMessage({ type: 'addElapsed', key: 'k', delta: 1000 })
    expect(failed.ok).toBe(false)
    browser.storage.local.error = null
    await expect(sendMessage({ type: 'addElapsed', key: 'k', delta: 1000 })).resolves.toEqual({ ok: true, total: 1000 })
  })

  it('opens the options page on request', async () => {
    await expect(sendMessage({ type: 'openOptions' })).resolves.toEqual({ ok: true, total: 0 })
    expect(browser.runtime.openOptionsPage).toHaveBeenCalledOnce()
  })

  it('does not answer unknown messages', async () => {
    expect(await rawSend({ type: 'mystery' })).toMatch(/port closed/)
    expect(await rawSend(null)).toMatch(/port closed/)
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
    browser.granted = new Set(originsForHost('reddit.com'))
    browser.runtime.onStartup.dispatch()
    await flush()
    expect(registered()).toMatchObject({
      js: ['content.js'],
      matches: originsForHost('reddit.com'),
      persistAcrossSessions: true,
    })
  })

  it('tracks grants as they are added and removed', async () => {
    browser.grant(originsForHost('reddit.com'))
    await flush()
    expect(registered()?.matches).toEqual(originsForHost('reddit.com'))

    browser.grant(originsForHost('x.com'))
    await flush()
    expect(registered()?.matches).toEqual([...originsForHost('reddit.com'), ...originsForHost('x.com')])

    await browser.permissions.remove({ origins: originsForHost('reddit.com') })
    await flush()
    expect(registered()?.matches).toEqual(originsForHost('x.com'))

    await browser.permissions.remove({ origins: originsForHost('x.com') })
    await flush()
    expect(registered()).toBeUndefined()
  })
})
