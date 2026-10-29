// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://www.x.com/home"}
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

afterEach(() => {
  // Tear down whatever instance a test left running.
  window.dispatchEvent(new Event('pagehide'))
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

  it('B5: a second injection disposes the first instead of double-counting', async () => {
    await inject()
    await inject()
    await vi.advanceTimersByTimeAsync(seconds(30))
    expect(storedToday()).toBe(seconds(21))
  })

  it('B5: the replaced instance flushes its time and stops ticking', async () => {
    await inject()
    await vi.advanceTimersByTimeAsync(seconds(5))
    await inject()
    // The first instance's 5s were persisted when it was disposed...
    expect(storedToday()).toBe(seconds(5))
    // ...and only the new instance's tick remains.
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(seconds(3))
    window.dispatchEvent(new Event('pagehide'))
    await flush()
    expect(storedToday()).toBe(seconds(8))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('B5: survives a previous instance that fails to tear down', async () => {
    const stale = {
      dispose: vi.fn(() => {
        throw new Error('Extension context invalidated.')
      }),
    }
    ;(window as unknown as Record<symbol, unknown>)[Symbol.for('tabtimer.content')] = stale
    await inject()
    expect(stale.dispose).toHaveBeenCalled()
    expect(document.getElementById('tabtimer-root')).not.toBeNull()
  })
})
