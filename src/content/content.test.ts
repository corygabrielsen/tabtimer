// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://www.x.com/home"}
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { LIMITS_KEY } from '../core/schema'
import { fakeChrome } from '../test/chrome'
import { flush, setPageState, trackShadowRoots } from '../test/dom'
import { dayKeyOf, minutes, pageTimers, seconds, startBackground, storedToday, useClock } from '../test/content'

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

function pageTransition(type: 'pagehide' | 'pageshow', persisted: boolean): void {
  const event = new Event(type)
  Object.defineProperty(event, 'persisted', { value: persisted })
  window.dispatchEvent(event)
}

const blocked = () => document.getElementById('tabtimer-block')?.style.getPropertyValue('display') === 'block'

afterEach(() => {
  // Tear down whatever instance a test left running.
  window.dispatchEvent(new Event('pagehide'))
})

describe('content script', () => {
  it('mounts the overlay and tracks focus time on load', async () => {
    await inject()
    await vi.advanceTimersByTimeAsync(seconds(12))
    expect(shadowOf('tabtimer-root').querySelector('.pill')?.textContent).toBe('00:00:12')
    // The service worker credits the open interval when it closes (or at
    // its checkpoint, every minute).
    expect(storedToday()).toBe(0)
    window.dispatchEvent(new Event('pagehide'))
    await flush()
    expect(storedToday()).toBe(seconds(12))
  })

  it('is credited every minute while it stays open', async () => {
    await inject()
    await vi.advanceTimersByTimeAsync(minutes(1))
    expect(storedToday()).toBe(minutes(1))
    await vi.advanceTimersByTimeAsync(minutes(2))
    expect(storedToday()).toBe(minutes(3))
    expect(shadowOf('tabtimer-root').querySelector('.pill')?.textContent).toBe('00:03:00')
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
    expect(storedToday()).toBe(0)
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
    window.dispatchEvent(new Event('pagehide'))
    await flush()
    expect(storedToday()).toBe(seconds(30))
  })

  it('B5: the replaced instance flushes its time and stops ticking', async () => {
    await inject()
    await vi.advanceTimersByTimeAsync(seconds(5))
    await inject()
    // The first instance's 5s were credited when it was disposed...
    expect(storedToday()).toBe(seconds(5))
    // ...and only the new instance's tick remains.
    expect(pageTimers()).toBe(1)
    await vi.advanceTimersByTimeAsync(seconds(3))
    window.dispatchEvent(new Event('pagehide'))
    await flush()
    expect(storedToday()).toBe(seconds(8))
    expect(pageTimers()).toBe(0)
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

  it('B9: survives the back/forward cache and resumes on restore', async () => {
    fakeChrome().storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: { 'x.com': minutes(1) } } })
    await inject()
    await vi.advanceTimersByTimeAsync(seconds(7))
    setPageState({ hidden: true })
    pageTransition('pagehide', true)
    await flush()
    // The time so far is credited, but the instance stays alive.
    expect(storedToday()).toBe(seconds(7))
    expect(document.getElementById('tabtimer-root')).not.toBeNull()
    expect(document.getElementById('tabtimer-block')).not.toBeNull()

    // Back: restored from the cache. Tracking and blocking still work.
    setPageState({ hidden: false })
    pageTransition('pageshow', true)
    await vi.advanceTimersByTimeAsync(seconds(30))
    expect(shadowOf('tabtimer-root').querySelector('.pill')?.textContent).toBe('00:00:37')
    await vi.advanceTimersByTimeAsync(seconds(23))
    expect(blocked()).toBe(true)
  })

  it('B9: catches up on storage changes missed while in the back/forward cache', async () => {
    await inject()
    await vi.advanceTimersByTimeAsync(seconds(3))
    setPageState({ hidden: true })
    pageTransition('pagehide', true)
    await flush()
    // While frozen, another tab logs time and a limit is set; a frozen page
    // gets no storage.onChanged for either.
    const data = fakeChrome().storage.local.data
    data[dayKeyOf()] = { 'x.com': [minutes(10)] }
    data[LIMITS_KEY] = { global: null, perSite: { 'x.com': minutes(5) } }

    setPageState({ hidden: false })
    pageTransition('pageshow', true)
    await flush()
    expect(blocked()).toBe(true)
  })

  it('B9: a non-persisted pageshow changes nothing', async () => {
    await inject()
    pageTransition('pageshow', false)
    await vi.advanceTimersByTimeAsync(seconds(2))
    expect(pageTimers()).toBe(1)
  })
})
