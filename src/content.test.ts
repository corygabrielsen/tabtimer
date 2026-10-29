// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://www.x.com/home"}
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { LIMITS_KEY } from './limits'
import { fakeChrome } from './test/chrome'
import { flush, trackShadowRoots } from './test/dom'
import { minutes, seconds, startBackground, storedToday, useClock } from './test/content'

let shadowOf: (id: string) => ShadowRoot

// Run the content script entry point, as Chrome does on injection.
async function inject(): Promise<void> {
  vi.resetModules()
  await import('./content')
  await flush()
}

beforeEach(async () => {
  await startBackground()
  useClock(new Date(2026, 5, 10, 12, 0, 0))
  shadowOf = trackShadowRoots()
})

describe('content script', () => {
  it('mounts the overlay and tracks focus time on load', async () => {
    await inject()
    await vi.advanceTimersByTimeAsync(seconds(12))
    expect(shadowOf('tabtimer-root').querySelector('.pill')?.textContent).toMatch(/^00:00:1[12]$/)
    expect(storedToday()).toBe(seconds(11))
    window.dispatchEvent(new Event('pagehide'))
  })

  it('enforces limits through the block screen', async () => {
    fakeChrome().storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: { 'x.com': minutes(1) } } })
    await inject()
    await vi.advanceTimersByTimeAsync(minutes(1) + seconds(1))
    expect(document.getElementById('tabtimer-block')?.style.getPropertyValue('display')).toBe('block')
    window.dispatchEvent(new Event('pagehide'))
  })

  it('persists pending time and removes its UI on pagehide', async () => {
    await inject()
    await vi.advanceTimersByTimeAsync(seconds(7))
    expect(storedToday()).toBe(seconds(1))
    window.dispatchEvent(new Event('pagehide'))
    await flush()
    expect(storedToday()).toBe(seconds(7))
    expect(document.getElementById('tabtimer-root')).toBeNull()
    expect(document.getElementById('tabtimer-block')).toBeNull()
  })

  it('never throws into the host page if setup fails', async () => {
    vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(() => {
      throw new Error('blocked by page')
    })
    await expect(inject()).resolves.toBeUndefined()
  })

  it('keeps a single overlay when injected twice (popup enable + registered script)', async () => {
    await inject()
    await inject()
    expect(document.querySelectorAll('#tabtimer-root')).toHaveLength(1)
    expect(document.querySelectorAll('#tabtimer-block')).toHaveLength(1)
    window.dispatchEvent(new Event('pagehide'))
  })

  it.fails('B5: a second injection disposes the first instead of double-counting', async () => {
    await inject()
    await inject()
    await vi.advanceTimersByTimeAsync(seconds(30))
    expect(storedToday()).toBe(seconds(21))
  })
})
