// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://www.reddit.com/r/all"}
//
// The page's presence reporter against the real service worker behind the
// fake chrome.*: the worker decides which tab accrues, and the tracker shows
// what the worker says.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import FocusTracker from './FocusTracker'
import { bus } from '../chrome/bus'
import { LIMITS_KEY } from '../core/schema'
import type { TabState } from '../core/messages'
import type { Bus, Pushes } from '../ports'
import { fakeChrome, type FakeChrome } from '../test/chrome'
import { flush, setPageState } from '../test/dom'
import {
  dayKeyOf,
  disposeTrackers,
  minutes,
  seconds,
  seedToday,
  startBackground,
  storedToday,
  trackTracker,
  useClock,
} from '../test/content'

const NOON = new Date(2026, 5, 10, 12, 0, 0)

let browser: FakeChrome

function started(): FocusTracker {
  const model = trackTracker(new FocusTracker())
  model.start()
  return model
}

const today = (model: FocusTracker) => model.readElapsed().today
const run = (ms: number) => vi.advanceTimersByTimeAsync(ms)

// Every presence report the page sends.
function presenceReports(): Array<Record<string, unknown>> {
  const reports: Array<Record<string, unknown>> = []
  browser.runtime.onMessage.addListener((message) => {
    const m = message as Record<string, unknown>
    if (m.type === 'presence') {
      reports.push(m)
    }
  })
  return reports
}

// The tab closing: the tracker reports it gone, and the worker credits it.
async function close(model: FocusTracker): Promise<void> {
  model.destroy()
  await flush()
}

beforeEach(async () => {
  browser = fakeChrome()
  await startBackground()
  useClock(NOON)
})

afterEach(() => {
  disposeTrackers()
})

describe('presence and active time', () => {
  it('accrues while the tab is visible and focused, credited when it closes', async () => {
    const model = started()
    await run(seconds(30))
    expect(today(model)).toBe(seconds(30))
    expect(storedToday()).toBe(0)
    await close(model)
    expect(storedToday()).toBe(seconds(30))
  })

  it('does not accrue in a tab that loads hidden until it is shown', async () => {
    setPageState({ hidden: true, focused: false }, false)
    const model = started()
    await run(minutes(1))
    expect(today(model)).toBe(0)
    setPageState({ hidden: false, focused: true })
    await run(seconds(10))
    expect(today(model)).toBe(seconds(10))
  })

  it('does not accrue in a visible tab that never had focus', async () => {
    setPageState({ focused: false }, false)
    const model = started()
    await run(minutes(1))
    expect(today(model)).toBe(0)
    expect(storedToday()).toBe(0)
  })

  it('pauses while the window is blurred, across repeated cycles', async () => {
    const model = started()
    for (let i = 0; i < 3; i++) {
      await run(seconds(5))
      setPageState({ focused: false })
      await run(seconds(20))
      setPageState({ focused: true })
    }
    await run(seconds(1))
    expect(today(model)).toBe(seconds(16))
    await close(model)
    expect(storedToday()).toBe(seconds(16))
  })

  it('pauses while the tab is hidden', async () => {
    const model = started()
    await run(seconds(4))
    setPageState({ hidden: true })
    await run(minutes(2))
    expect(today(model)).toBe(seconds(4))
    expect(storedToday()).toBe(seconds(4))
    setPageState({ hidden: false })
    await run(seconds(3))
    expect(today(model)).toBe(seconds(7))
  })

  it('follows focus events, and samples focus again when shown', async () => {
    const model = started()
    await run(seconds(4))
    window.dispatchEvent(new Event('blur'))
    await run(seconds(10))
    expect(today(model)).toBe(seconds(4))
    // Hidden, then shown in a window that has focus by then.
    setPageState({ hidden: true })
    setPageState({ hidden: false })
    await run(seconds(3))
    expect(today(model)).toBe(seconds(7))
  })

  it('adds this tab’s time to what is already logged today', async () => {
    seedToday({ 'reddit.com': minutes(3), 'x.com': minutes(1) })
    const model = started()
    await run(seconds(5))
    expect(model.readTotals()).toEqual({
      site: 'reddit.com',
      siteToday: minutes(3) + seconds(5),
      globalToday: minutes(4) + seconds(5),
    })
  })

  it('knows nothing until the worker has answered', () => {
    const model = trackTracker(new FocusTracker())
    expect(model.site).toBeNull()
    expect(model.readTotals()).toEqual({ site: null, siteToday: 0, globalToday: 0 })
    expect(model.blockReason()).toBeNull()
  })

  it('refuses to start twice', () => {
    const model = started()
    expect(() => model.start()).toThrow('already started')
  })

  it('keeps the focus and session stopwatches for the overlay', async () => {
    const model = started()
    await run(seconds(10))
    setPageState({ focused: false })
    await run(seconds(20))
    setPageState({ focused: true })
    await run(seconds(5))
    expect(model.readElapsed()).toEqual({ today: seconds(15), focus: seconds(15), session: seconds(35) })
  })
})

describe('reporting to the service worker', () => {
  it('reports on load and on change only, not every tick', async () => {
    const reports = presenceReports()
    const model = started()
    await run(seconds(30))
    expect(reports).toHaveLength(1)
    setPageState({ focused: false })
    await run(seconds(30))
    expect(reports).toHaveLength(2)
    expect(reports[1]).toEqual({ type: 'presence', visible: true, focused: false, media: false, blocked: false })
    model.destroy()
    await flush()
    expect(reports.at(-1)).toEqual({ type: 'presence', visible: false, focused: false, media: false, blocked: false })
  })

  it('reports itself gone once, on destroy', async () => {
    const reports = presenceReports()
    const model = started()
    await run(seconds(1))
    model.destroy()
    model.destroy()
    await flush()
    expect(reports).toHaveLength(2)
  })

  it('retries a report the worker could not take, ten seconds later', async () => {
    const send = vi.fn<Bus['send']>(() => Promise.resolve({ ok: false, error: 'unreachable' }) as never)
    const model = trackTracker(new FocusTracker(undefined, { send }))
    model.start()
    await run(seconds(5))
    expect(send).toHaveBeenCalledTimes(1)
    send.mockImplementation(bus.send)
    await run(seconds(5))
    expect(send).toHaveBeenCalledTimes(2)
    await run(seconds(5))
    expect(model.site).toBe('reddit.com')
    expect(today(model)).toBe(seconds(5))
  })

  it('shows nothing ticking while the worker is unreachable', async () => {
    browser.runtime.onMessage.listeners.clear()
    const model = started()
    await run(seconds(30))
    expect(model.readTotals()).toEqual({ site: null, siteToday: 0, globalToday: 0 })
  })

  it('takes pushed states, ignores one computed before the current one, and answers with its presence', async () => {
    let handler: ((state: TabState) => unknown) | null = null
    const pushes: Pushes = {
      onState: (fn) => {
        handler = fn
        return () => (handler = null)
      },
    }
    const model = trackTracker(new FocusTracker(undefined, bus, pushes))
    model.start()
    await flush()
    const base: TabState = {
      site: 'reddit.com',
      day: '2026-06-10',
      asOf: NOON.getTime() + 5000,
      today: minutes(9),
      globalToday: minutes(9),
      running: false,
      blockAt: null,
      limit: null,
    }
    expect(handler!(base)).toEqual({ visible: true, focused: true, media: false, blocked: false })
    expect(today(model)).toBe(minutes(9))
    handler!({ ...base, asOf: base.asOf - 1, today: minutes(1) })
    expect(today(model)).toBe(minutes(9))
    model.destroy()
    expect(handler).toBeNull()
  })
})

describe('B10: while the block screen is up', () => {
  it('does not accrue, and resumes once unblocked', async () => {
    const model = started()
    await run(seconds(5))
    model.setBlocked(true)
    model.setBlocked(true)
    await run(minutes(1))
    expect(today(model)).toBe(seconds(5))
    expect(storedToday()).toBe(seconds(5))
    model.setBlocked(false)
    await run(seconds(5))
    expect(today(model)).toBe(seconds(10))
  })

  it('is remembered when set before the tracker starts', async () => {
    const model = trackTracker(new FocusTracker())
    model.setBlocked(true)
    model.start()
    await run(seconds(30))
    expect(today(model)).toBe(0)
  })
})

describe('limits', () => {
  const limits = (perSite: Record<string, number>, global: number | null = null) =>
    browser.storage.local.seed({ [LIMITS_KEY]: { global, perSite } })

  it('blocks at the moment the worker said, naming the limit', async () => {
    limits({ 'reddit.com': minutes(1) })
    seedToday({ 'reddit.com': seconds(50) })
    const model = started()
    await run(seconds(9))
    expect(model.blockReason()).toBeNull()
    await run(seconds(1))
    expect(model.blockReason()).toEqual({ scope: 'site', limit: minutes(1), elapsed: minutes(1) })
  })

  it('takes the all-sites cap from every site’s time', async () => {
    limits({}, minutes(5))
    seedToday({ 'x.com': minutes(5) })
    const model = started()
    await run(0)
    expect(model.blockReason()).toEqual({ scope: 'global', limit: minutes(5), elapsed: minutes(5) })
  })

  it('does not block while a snooze is being asked for, then until it ends', async () => {
    limits({ 'reddit.com': minutes(1) })
    seedToday({ 'reddit.com': minutes(2) })
    const model = started()
    await run(0)
    expect(model.blockReason()).not.toBeNull()
    const snoozed = model.snooze()
    expect(model.blockReason()).toBeNull()
    await snoozed
    expect(model.blockReason()).toBeNull()
    await run(minutes(5))
    expect(model.blockReason()).toMatchObject({ scope: 'site' })
  })
})

describe('resets and days', () => {
  it('shows a reset from the popup straight away', async () => {
    seedToday({ 'reddit.com': minutes(9) })
    const model = started()
    await run(seconds(5))
    browser.sender = { id: browser.runtime.id, url: browser.runtime.getURL('popup.html') }
    await bus.send('resetToday', { site: 'reddit.com' })
    browser.sender = null
    await flush()
    expect(today(model)).toBe(0)
    await run(seconds(3))
    expect(today(model)).toBe(seconds(3))
    await close(model)
    expect(storedToday()).toBe(seconds(3))
  })

  it('starts a fresh day at local midnight, splitting the time by when it was spent', async () => {
    useClock(new Date(2026, 5, 10, 23, 59, 30))
    seedToday({ 'reddit.com': minutes(9) })
    const model = started()
    await run(seconds(45))
    // Fifteen seconds into the new day, before or after the worker's answer.
    expect(model.readElapsed()).toEqual({ today: seconds(15), focus: seconds(15), session: seconds(15) })
    await close(model)
    const yesterday = new Date(2026, 5, 10, 12)
    expect(storedToday('reddit.com', yesterday)).toBe(minutes(9) + seconds(30))
    expect(storedToday()).toBe(seconds(15))
    expect(Object.keys(browser.storage.local.data)).toContain(dayKeyOf())
  })

  it('B8: a sleep across midnight counts none of the sleep, and only use from waking', async () => {
    useClock(new Date(2026, 5, 10, 23, 50))
    const model = started()
    await run(seconds(10))
    // The machine sleeps (no timers run) and wakes after midnight.
    vi.setSystemTime(new Date(2026, 5, 11, 7, 0))
    await run(seconds(1))
    await flush()
    expect(today(model)).toBeLessThanOrEqual(seconds(2))
    await close(model)
    // At most the time since the last sign of life before sleeping is lost;
    // none of the night is counted.
    expect(storedToday('reddit.com', new Date(2026, 5, 10, 12))).toBeLessThanOrEqual(seconds(10))
    expect(storedToday()).toBeLessThanOrEqual(seconds(2))
  })
})

describe('away from the computer (idle or locked)', () => {
  // A media element in the page, playing (or not) as far as the tracker can
  // tell.
  function media(tag: 'audio' | 'video', playing: boolean) {
    const el = document.createElement(tag)
    const state = { paused: !playing }
    Object.defineProperty(el, 'paused', { get: () => state.paused })
    Object.defineProperty(el, 'readyState', { get: () => 4 })
    document.body.append(el)
    return {
      stop: () => {
        state.paused = true
        el.dispatchEvent(new Event('pause'))
      },
    }
  }

  it('stops counting while the screen is locked, and resumes after', async () => {
    const model = started()
    await run(seconds(5))
    browser.setIdleState('locked')
    await run(minutes(3))
    expect(today(model)).toBe(seconds(5))
    expect(storedToday()).toBe(seconds(5))
    browser.setIdleState('active')
    await run(seconds(5))
    expect(today(model)).toBe(seconds(10))
  })

  it('takes idle time back to the last input, five minutes before idle is reported', async () => {
    const model = started()
    await run(minutes(7))
    browser.setIdleState('idle')
    await run(minutes(10))
    expect(storedToday()).toBe(minutes(2))
    expect(today(model)).toBe(minutes(2))
    browser.setIdleState('active')
    await run(seconds(30))
    expect(today(model)).toBe(minutes(2) + seconds(30))
  })

  it('keeps counting idle time while media plays, and stops when it does', async () => {
    const video = media('video', true)
    media('audio', false)
    const model = started()
    await run(minutes(1))
    browser.setIdleState('idle')
    await run(minutes(2))
    expect(today(model)).toBe(minutes(3))
    expect(storedToday()).toBe(minutes(3))
    video.stop()
    await run(minutes(2))
    expect(today(model)).toBe(minutes(3))
    expect(storedToday()).toBe(minutes(3))
    // A lock pauses media time too.
    browser.setIdleState('locked')
    await flush()
    expect(today(model)).toBe(minutes(3))
  })

  it('does not count in a page loaded while the screen is locked', async () => {
    browser.setIdleState('locked')
    await flush()
    const model = started()
    await run(minutes(1))
    expect(today(model)).toBe(0)
  })
})
