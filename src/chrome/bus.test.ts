import { describe, it, expect, vi } from 'vitest'
import { bus, serveRouter } from './bus'
import { fakeChrome } from '../test/chrome'

describe('bus.send', () => {
  it('sends the request with its type and resolves with the response', async () => {
    fakeChrome().runtime.onMessage.addListener((message, _sender, sendResponse) => {
      expect(message).toEqual({ type: 'setPrefs', hidden: true })
      sendResponse({ ok: true, value: { hidden: true, scale: 1 } })
    })
    await expect(bus.send('setPrefs', { hidden: true })).resolves.toEqual({
      ok: true,
      value: { hidden: true, scale: 1 },
    })
  })

  it('is unreachable when nothing is listening (service worker gone)', async () => {
    await expect(bus.send('hello', {})).resolves.toEqual({ ok: false, error: 'unreachable' })
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
    await expect(bus.send('openOptions', {})).resolves.toEqual({ ok: false, error: 'internal' })
  })
})

describe('serveRouter', () => {
  it('answers every message asynchronously through the handler', async () => {
    const handle = vi.fn(() => Promise.resolve({ ok: true as const, value: null }))
    serveRouter(handle)
    await expect(bus.send('openOptions', {})).resolves.toEqual({ ok: true, value: null })
    expect(handle).toHaveBeenCalledWith({ type: 'openOptions' }, expect.objectContaining({ id: 'tabtimer-test' }))
  })

  it('answers internal if the handler itself rejects', async () => {
    serveRouter(() => Promise.reject(new Error('boom')))
    await expect(bus.send('openOptions', {})).resolves.toEqual({ ok: false, error: 'internal' })
  })
})
