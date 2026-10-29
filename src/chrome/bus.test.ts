import { describe, it, expect, vi } from 'vitest'
import { bus, pushes, sendState, serveRouter } from './bus'
import type { TabState } from '../core/messages'
import { fakeChrome } from '../test/chrome'

describe('bus.send', () => {
  it('sends the request with its type and resolves with the response', async () => {
    fakeChrome().runtime.onMessage.addListener((message, _sender, sendResponse) => {
      expect(message).toEqual({ type: 'setPrefs', hidden: true })
      sendResponse({ ok: true, value: null })
    })
    await expect(bus.send('setPrefs', { hidden: true })).resolves.toEqual({ ok: true, value: null })
  })

  it('is unreachable when nothing is listening (service worker gone)', async () => {
    await expect(bus.send('snooze', {})).resolves.toEqual({ ok: false, error: 'unreachable' })
  })

  it('is unreachable when the extension context is gone', async () => {
    vi.spyOn(fakeChrome().runtime, 'sendMessage').mockImplementation(() => {
      throw new Error('Extension context invalidated.')
    })
    await expect(bus.send('snooze', {})).resolves.toEqual({ ok: false, error: 'unreachable' })
  })

  it('is internal when the reply is not a response', async () => {
    fakeChrome().runtime.onMessage.addListener((_message, _sender, sendResponse) => {
      sendResponse({ total: 5 })
    })
    await expect(bus.send('open', { page: 'options' })).resolves.toEqual({ ok: false, error: 'internal' })
  })
})

describe('serveRouter', () => {
  it('answers every message asynchronously through the handler', async () => {
    const handle = vi.fn(() => Promise.resolve({ ok: true as const, value: null }))
    serveRouter(handle)
    await expect(bus.send('open', { page: 'options' })).resolves.toEqual({ ok: true, value: null })
    expect(handle).toHaveBeenCalledWith(
      { type: 'open', page: 'options' },
      expect.objectContaining({ id: 'tabtimer-test' })
    )
  })

  it('answers internal if the handler itself rejects', async () => {
    serveRouter(() => Promise.reject(new Error('boom')))
    await expect(bus.send('open', { page: 'options' })).resolves.toEqual({ ok: false, error: 'internal' })
  })
})

describe('state pushes', () => {
  const state: TabState = {
    site: 'reddit.com',
    day: '2026-06-10',
    asOf: 1,
    seq: 1,
    today: 2,
    globalToday: 3,
    running: false,
    blockAt: null,
    limit: null,
    prefs: { hidden: false, scale: 1 },
  }
  const PRESENT = { visible: true, focused: true, media: false, blocked: false }

  it('hands the page each state from the worker and replies with its presence', async () => {
    const handle = vi.fn(() => PRESENT)
    const stop = pushes.onState(handle)
    const push = { type: 'state', state, probe: true } as const
    await expect(sendState(4, '', push)).resolves.toEqual(PRESENT)
    expect(handle).toHaveBeenCalledWith(state, true)
    expect(fakeChrome().tabs.sendMessage).toHaveBeenCalledWith(4, push, { frameId: 0 })
    await sendState(4, 'doc-1', { ...push, probe: false })
    expect(handle).toHaveBeenLastCalledWith(state, false)
    expect(fakeChrome().tabs.sendMessage).toHaveBeenLastCalledWith(
      4,
      { ...push, probe: false },
      { documentId: 'doc-1' }
    )
    stop()
    await expect(sendState(4, '', push)).rejects.toThrow()
  })

  it('ignores other messages, other extensions and other tabs', () => {
    const handle = vi.fn(() => PRESENT)
    pushes.onState(handle)
    const browser = fakeChrome()
    const respond = vi.fn()
    const deliver = (message: unknown, sender: object) => {
      for (const listener of browser.runtime.onMessage.listeners) {
        listener(message, sender, respond)
      }
    }
    deliver({ type: 'state', state, probe: false }, { id: 'someone-else' })
    deliver({ type: 'state', state, probe: false }, { id: browser.runtime.id, tab: { id: 2 } })
    deliver({ type: 'state', state: { ...state, asOf: 'x' }, probe: false }, { id: browser.runtime.id })
    expect(handle).not.toHaveBeenCalled()
    expect(respond).not.toHaveBeenCalled()
  })

  it('fails to reach a tab whose page is gone', async () => {
    fakeChrome().closedTabs.add(4)
    await expect(sendState(4, '', { type: 'state', state, probe: false })).rejects.toThrow(
      'Receiving end does not exist'
    )
  })
})
