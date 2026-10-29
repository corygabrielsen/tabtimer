import { describe, it, expect, beforeEach } from 'vitest'
import { watchGrants } from './grants'
import { fakeChrome, type FakeChrome } from '../test/chrome'

let browser: FakeChrome

beforeEach(() => {
  browser = fakeChrome()
})

describe('watchGrants', () => {
  it('reads the tracked grants once, and again after a change', async () => {
    browser.granted = new Set(['*://x.com/*', 'file:///*'])
    const granted = watchGrants()
    await expect(granted()).resolves.toEqual(['*://x.com/*'])
    await granted()
    expect(browser.permissions.getAll).toHaveBeenCalledOnce()
    browser.grant(['*://y.com/*'])
    await expect(granted()).resolves.toEqual(['*://x.com/*', '*://y.com/*'])
  })

  it('reads none when Chrome lists no origins', async () => {
    browser.permissions.getAll.mockResolvedValueOnce({ permissions: [] } as never)
    await expect(watchGrants()()).resolves.toEqual([])
  })

  it('keeps a read made after a change when an older one fails', async () => {
    const granted = watchGrants()
    let fail: (e: Error) => void = () => undefined
    browser.permissions.getAll.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
    const old = granted()
    browser.grant(['*://x.com/*'])
    const fresh = granted()
    fail(new Error('gone'))
    await expect(old).rejects.toThrow('gone')
    await expect(fresh).resolves.toEqual(['*://x.com/*'])
    await granted()
    expect(browser.permissions.getAll).toHaveBeenCalledTimes(2)
  })
})
