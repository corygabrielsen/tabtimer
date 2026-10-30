// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://www.reddit.com/r/all"}
//
// End-to-end at the unit level: the real content script (FocusTracker,
// Overlay and BlockScreen wired together) in a page, with the real background
// writer behind the fake chrome.* — only the clock advances; the tracker's
// single 1s tick drives everything.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SNOOZE_MS } from '../core/limits'
import { DONE_MS, HOLD_MS } from './hold'
import { fakeChrome, type FakeChrome } from '../test/chrome'
import { flush, setPageState, trackShadowRoots } from '../test/dom'
import {
  isBlocked,
  minutes,
  pageTimers,
  seconds,
  seedLimits,
  seedToday,
  startBackground,
  EVERY_HOST,
  storedToday,
  useClock,
} from '../test/content'

let browser: FakeChrome
let shadowOf: (id: string) => ShadowRoot

// Run the content script entry point, as Chrome does on injection.
async function openTab(): Promise<void> {
  vi.resetModules()
  await import('./content')
  await flush()
}

const closeTab = () => window.dispatchEvent(new Event('pagehide'))
const blockScreen = () => shadowOf('tabtimer-block')
const pillText = () => shadowOf('tabtimer-root').querySelector('.pill')?.textContent
const run = (ms: number) => vi.advanceTimersByTimeAsync(ms)

beforeEach(async () => {
  browser = fakeChrome()
  await startBackground(EVERY_HOST)
  useClock(new Date(2026, 5, 10, 12, 0, 0))
  shadowOf = trackShadowRoots()
})

afterEach(() => {
  // Tear down whatever instance a test left running.
  closeTab()
})

describe('time limits end to end', () => {
  it('blocks the moment focus time reaches the per-site limit', async () => {
    seedLimits({ perSite: { 'reddit.com': 1 } })
    await openTab()
    await run(seconds(59))
    expect(isBlocked()).toBe(false)
    await run(seconds(1))
    expect(isBlocked()).toBe(true)
    expect(blockScreen().querySelector('.used')?.textContent).toBe('1 min today')
  })

  it('includes time other tabs already spent on the site today', async () => {
    seedLimits({ perSite: { 'reddit.com': 20 } })
    seedToday({ 'reddit.com': minutes(19) + seconds(50) })
    await openTab()
    await run(seconds(9))
    expect(isBlocked()).toBe(false)
    await run(seconds(1))
    expect(isBlocked()).toBe(true)
  })

  it('does not accrue or block in a hidden tab', async () => {
    seedLimits({ perSite: { 'reddit.com': 1 } })
    setPageState({ hidden: true, focused: false }, false)
    await openTab()
    await run(minutes(10))
    expect(isBlocked()).toBe(false)
    expect(storedToday()).toBe(0)

    setPageState({ hidden: false, focused: true })
    await run(seconds(30))
    expect(isBlocked()).toBe(false)
    expect(pillText()).toMatch(/^00:00:(29|30)$/)
  })

  it('does not accrue while the window is unfocused', async () => {
    seedLimits({ perSite: { 'reddit.com': 1 } })
    await openTab()
    await run(seconds(30))
    setPageState({ focused: false })
    await run(minutes(10))
    expect(isBlocked()).toBe(false)
    setPageState({ focused: true })
    await run(seconds(30))
    expect(isBlocked()).toBe(true)
  })

  it('B10: stops counting while blocked, so the global allowance is not consumed', async () => {
    seedLimits({ global: 30, perSite: { 'reddit.com': 1 } })
    await openTab()
    await run(minutes(1))
    expect(isBlocked()).toBe(true)
    await run(minutes(10))
    expect(blockScreen().querySelector('.used')?.textContent).toBe('1 min today')
    expect(storedToday()).toBe(minutes(1))
  })

  it('enforces the global cap across every tracked site', async () => {
    seedLimits({ global: 31 })
    seedToday({ 'x.com': minutes(20), 'youtube.com': minutes(10) })
    await openTab()
    await run(seconds(55))
    expect(isBlocked()).toBe(false)
    // The global total reads persisted time, reported every ~10s.
    await run(seconds(15))
    expect(isBlocked()).toBe(true)
    expect(blockScreen().querySelector('.used')?.textContent).toMatch(/ today on all sites$/)
  })

  it('applies a limit set from the options page within a second', async () => {
    await openTab()
    await run(minutes(5))
    expect(isBlocked()).toBe(false)
    seedLimits({ perSite: { 'reddit.com': 3 } })
    await flush()
    expect(isBlocked()).toBe(true)
  })

  it('gives a five-minute reprieve on snooze, then blocks again', async () => {
    seedLimits({ perSite: { 'reddit.com': 1 } })
    await openTab()
    await run(minutes(1))
    expect(isBlocked()).toBe(true)

    // Held for the snooze, not clicked.
    const hold = blockScreen().querySelector('.hold')!
    hold.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    await run(HOLD_MS + DONE_MS + 50)
    await flush()
    expect(isBlocked()).toBe(false)
    await run(SNOOZE_MS - seconds(2))
    expect(isBlocked()).toBe(false)
    // Time still accrued during the snooze.
    expect(pillText()).toMatch(/^00:05:5\d$/)
    await run(seconds(3))
    expect(isBlocked()).toBe(true)
  })

  it('lifts the block at midnight when the daily total resets', async () => {
    vi.setSystemTime(new Date(2026, 5, 10, 23, 58, 0))
    seedLimits({ perSite: { 'reddit.com': 1 } })
    await openTab()
    await run(minutes(1)) // 23:59:00
    expect(isBlocked()).toBe(true)
    await run(seconds(60)) // 00:00:00
    await run(seconds(2))
    expect(isBlocked()).toBe(false)
    expect(pillText()).toMatch(/^00:00:0[12]$/)
  })
})

describe('per-tab cost', () => {
  it('runs a single interval per tab', async () => {
    await openTab()
    expect(pageTimers()).toBe(1)
  })

  it('reads no storage per second: the worker pushes what changes', async () => {
    seedLimits({ global: 30, perSite: { 'reddit.com': 30 } })
    await openTab()
    const get = vi.spyOn(browser.storage.local, 'get')
    await run(minutes(1))
    // No per-second storage.get (site total) or get(null) (global total):
    // the only reads are the worker's, at its one checkpoint.
    expect(get.mock.calls.filter(([keys]) => keys === null)).toHaveLength(0)
    expect(get.mock.calls.length).toBeLessThanOrEqual(6)
    // Time counted elsewhere still counts: x.com has 29 minutes, which with
    // this tab's minute crosses the cap once the worker re-checks (here, on
    // the limits changing).
    seedToday({ 'x.com': minutes(29) + seconds(10) })
    seedLimits({ global: 30, perSite: {} })
    await run(seconds(1))
    expect(isBlocked()).toBe(true)
    expect(blockScreen().querySelector('.used')?.textContent).toMatch(/ today on all sites$/)
    // ...and so does this site's own limit.
    seedToday({ 'reddit.com': minutes(5) })
    seedLimits({ global: null, perSite: { 'reddit.com': 5 } })
    await run(seconds(1))
    expect(isBlocked()).toBe(true)
    expect(blockScreen().querySelector('.used')?.textContent).toMatch(/^\d+ min today$/)
    expect(get.mock.calls.filter(([keys]) => keys === null)).toHaveLength(0)
  })
})

describe('tick wiring', () => {
  it('skips per-second rendering while the tab is hidden', async () => {
    seedToday({ 'reddit.com': minutes(1) })
    await openTab()
    await run(seconds(1))
    setPageState({ hidden: true }, false)
    seedToday({ 'x.com': 1 })
    const before = pillText()
    await run(seconds(5))
    expect(pillText()).toBe(before)
  })

  it('tears down the overlay and block screen and stops ticking on pagehide', async () => {
    seedLimits({ perSite: { 'reddit.com': 1 } })
    await openTab()
    await run(minutes(1))
    closeTab()
    expect(document.getElementById('tabtimer-root')).toBeNull()
    expect(document.getElementById('tabtimer-block')).toBeNull()
    expect(document.documentElement.style.getPropertyValue('overflow')).toBe('')
    expect(pageTimers()).toBe(0)
    await run(seconds(5))
    expect(document.getElementById('tabtimer-root')).toBeNull()
  })
})
