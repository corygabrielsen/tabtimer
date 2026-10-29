import { describe, it, expect } from 'vitest'
import { sendMessage } from './messages'
import { fakeChrome } from './test/chrome'

describe('sendMessage', () => {
  it('resolves with the receiver’s response', async () => {
    fakeChrome().runtime.onMessage.addListener((message, _sender, sendResponse) => {
      expect(message).toEqual({ type: 'resetKey', key: 'k' })
      sendResponse({ ok: true, total: 0 })
    })
    await expect(sendMessage({ type: 'resetKey', key: 'k' })).resolves.toEqual({ ok: true, total: 0 })
  })

  it('resolves with an asynchronous response when the receiver keeps the channel open', async () => {
    fakeChrome().runtime.onMessage.addListener((_message, _sender, sendResponse) => {
      setTimeout(() => sendResponse({ ok: true, total: 7 }), 0)
      return true
    })
    await expect(sendMessage({ type: 'addElapsed', key: 'k', delta: 7 })).resolves.toEqual({ ok: true, total: 7 })
  })

  it('rejects when nothing is listening (service worker gone)', async () => {
    await expect(sendMessage({ type: 'openOptions' })).rejects.toMatchObject({
      message: expect.stringContaining('Receiving end does not exist'),
    })
  })
})
