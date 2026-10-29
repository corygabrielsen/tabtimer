// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://www.reddit.com/r/all"}
//
// End-to-end at the unit level: the real content script (FocusTracker,
// Overlay and BlockScreen wired together) in a page, with the real background
// writer behind the fake chrome.* — only the clock advances; the tracker's
// single 1s tick drives everything.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SNOOZE_MS, type Limits } from '../core/limits'
import { LIMITS_KEY } from '../core/schema'
import { dayOf } from '../core/day'
import { PRUNED_DAY_KEY } from '../sw/ledger'
import { fakeChrome, type FakeChrome } from '../test/chrome'
import { click, flush, setPageState, trackShadowRoots } from '../test/dom'
import { minutes, seconds, seedToday, startBackground, storedToday, useClock } from '../test/content'

let browser: FakeChrome
let shadowOf: (id: string) => ShadowRoot

function limits(l: Partial<Limits>): void {
  browser.storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: {}, ...l } })
}

// Run the content script entry point, as Chrome does on injection.
async function openTab(): Promise<void> {
  vi.resetModules()
  await import('./content')
  await flush()
}

const closeTab = () => window.dispatchEvent(new Event('pagehide'))
const blocked = () => document.getElementById('tabtimer-block')?.style.getPropertyValue('display') === 'block'
const blockScreen = () => shadowOf('tabtimer-block')
const pillText = () => shadowOf('tabtimer-root').querySelector('.pill')?.textContent
const run = (ms: number) => vi.advanceTimersByTimeAsync(ms)

beforeEach(async () => {
  browser = fakeChrome()
  await startBackground()
  useClock(new Date(2026, 5, 10, 12, 0, 0))
  shadowOf = trackShadowRoots()
})

afterEach(() => {
  // Tear down whatever instance a test left running.
  closeTab()
})

describe('time limits end to end', () => {
  it('blocks the moment focus time reaches the per-site limit', async () => {
    limits({ perSite: { 'reddit.com': minutes(1) } })
    await openTab()
    await run(seconds(59))
    expect(blocked()).toBe(false)
    await run(seconds(1))
    expect(blocked()).toBe(true)
    expect(blockScreen().querySelector('.detail')?.textContent).toBe('00:01:00 today · 00:01:00 limit')
  })

  it('includes time other tabs already spent on the site today', async () => {
    limits({ perSite: { 'reddit.com': minutes(20) } })
    seedToday({ 'reddit.com': minutes(19) + seconds(50) })
    await openTab()
    await run(seconds(9))
    expect(blocked()).toBe(false)
    await run(seconds(1))
    expect(blocked()).toBe(true)
  })

  it('does not accrue or block in a hidden tab', async () => {
    limits({ perSite: { 'reddit.com': minutes(1) } })
    setPageState({ hidden: true, focused: false }, false)
    await openTab()
    await run(minutes(10))
    expect(blocked()).toBe(false)
    expect(storedToday()).toBe(0)

    setPageState({ hidden: false, focused: true })
    await run(seconds(30))
    expect(blocked()).toBe(false)
    expect(pillText()).toMatch(/^00:00:(29|30)$/)
  })

  it('does not accrue while the window is unfocused', async () => {
    limits({ perSite: { 'reddit.com': minutes(1) } })
    await openTab()
    await run(seconds(30))
    setPageState({ focused: false })
    await run(minutes(10))
    expect(blocked()).toBe(false)
    setPageState({ focused: true })
    await run(seconds(30))
    expect(blocked()).toBe(true)
  })

  it('B10: stops counting while blocked, so the global allowance is not consumed', async () => {
    limits({ global: minutes(30), perSite: { 'reddit.com': minutes(1) } })
    await openTab()
    await run(minutes(1))
    expect(blocked()).toBe(true)
    await run(minutes(10))
    expect(blockScreen().querySelector('.detail')?.textContent).toBe('00:01:00 today · 00:01:00 limit')
    expect(storedToday()).toBe(minutes(1))
  })

  it('enforces the global cap across every tracked site', async () => {
    limits({ global: minutes(31) })
    seedToday({ 'x.com': minutes(20), 'youtube.com': minutes(10) })
    await openTab()
    await run(seconds(55))
    expect(blocked()).toBe(false)
    // The global total reads persisted time, reported every ~10s.
    await run(seconds(15))
    expect(blocked()).toBe(true)
    expect(blockScreen().querySelector('.host')?.textContent).toBe('all tracked sites')
  })

  it('applies a limit set from the options page within a second', async () => {
    await openTab()
    await run(minutes(5))
    expect(blocked()).toBe(false)
    limits({ perSite: { 'reddit.com': minutes(3) } })
    await flush()
    expect(blocked()).toBe(true)
  })

  it('gives a five-minute reprieve on snooze, then blocks again', async () => {
    limits({ perSite: { 'reddit.com': minutes(1) } })
    await openTab()
    await run(minutes(1))
    expect(blocked()).toBe(true)

    click(blockScreen().querySelector('.snooze'))
    await flush()
    expect(blocked()).toBe(false)
    await run(SNOOZE_MS - seconds(2))
    expect(blocked()).toBe(false)
    // Time still accrued during the snooze.
    expect(pillText()).toMatch(/^00:05:5\d$/)
    await run(seconds(3))
    expect(blocked()).toBe(true)
  })

  it('lifts the block at midnight when the daily total resets', async () => {
    vi.setSystemTime(new Date(2026, 5, 10, 23, 58, 0))
    limits({ perSite: { 'reddit.com': minutes(1) } })
    await openTab()
    await run(minutes(1)) // 23:59:00
    expect(blocked()).toBe(true)
    await run(seconds(60)) // 00:00:00
    await run(seconds(2))
    expect(blocked()).toBe(false)
    expect(pillText()).toMatch(/^00:00:0[12]$/)
  })
})

describe('per-tab cost', () => {
  it('runs a single interval per tab', async () => {
    await openTab()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('reads totals from storage once, then follows storage.onChanged', async () => {
    limits({ global: minutes(30), perSite: { 'reddit.com': minutes(30) } })
    // The service worker already pruned today (its once-a-day get(null)).
    browser.storage.session.seed({ [PRUNED_DAY_KEY]: dayOf(Date.now()) })
    await openTab()
    const get = vi.spyOn(browser.storage.local, 'get')
    await run(minutes(1))
    // No per-second storage.get (site total) or get(null) (global total):
    // the only reads are the background writer's, one per report (~10s).
    expect(get.mock.calls.filter(([keys]) => keys === null)).toHaveLength(0)
    expect(get).toHaveBeenCalledTimes(6)
    // Another tab's writes still count: x.com logs 29 minutes, which with
    // this tab's reported minute crosses the cap (the report sent on this
    // very tick may still be in flight, so it isn't counted on).
    seedToday({ 'x.com': minutes(29) + seconds(10) })
    await run(seconds(1))
    expect(blocked()).toBe(true)
    expect(blockScreen().querySelector('.host')?.textContent).toBe('all tracked sites')
    // ...as does another reddit tab's.
    limits({ global: null, perSite: { 'reddit.com': minutes(5) } })
    seedToday({ 'reddit.com': minutes(5) })
    await run(seconds(1))
    expect(blocked()).toBe(true)
    expect(blockScreen().querySelector('.host')?.textContent).toBe('reddit.com')
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
    limits({ perSite: { 'reddit.com': minutes(1) } })
    await openTab()
    await run(minutes(1))
    closeTab()
    expect(document.getElementById('tabtimer-root')).toBeNull()
    expect(document.getElementById('tabtimer-block')).toBeNull()
    expect(document.documentElement.style.getPropertyValue('overflow')).toBe('')
    expect(vi.getTimerCount()).toBe(0)
    await run(seconds(5))
    expect(document.getElementById('tabtimer-root')).toBeNull()
  })
})
