// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://www.reddit.com/r/all"}
//
// The page's presence reporter against the real service worker behind the
// fake chrome.*: the worker decides which tab accrues, and the tracker shows
// what the worker says.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import FocusTracker from './FocusTracker'
import { bus } from '../chrome/bus'
import type { TabState } from '../core/messages'
import type { Bus, Pushes } from '../ports'
import { fakeChrome, type FakeChrome } from '../test/chrome'
import { flush, setPageState } from '../test/dom'
import {
  dayKeyOf,
  disposeTrackers,
  minutes,
  seconds,
  seedLimits,
  seedToday,
  startBackground,
  EVERY_HOST,
  storedToday,
  trackTracker,
  useClock,
} from '../test/content'

const NOON = new Date(2026, 5, 10, 12, 0, 0)

// A state as the worker pushes it.
const STATE: TabState = {
  site: 'reddit.com',
  day: '2026-06-10',
  asOf: NOON.getTime(),
  seq: 1,
  today: 0,
  globalToday: 0,
  running: false,
  blockAt: null,
  limit: null,
  snoozes: [],
  prefs: { hidden: false, scale: 1 },
}

let browser: FakeChrome

function started(): FocusTracker {
  const model = trackTracker(new FocusTracker())
  model.start()
  return model
}

// A fake bus's extension, still there; a fake push channel that never stops.
const alive = () => true
const onStop = () => () => {}

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
  await startBackground(EVERY_HOST)
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
    setPageState({ focused: false })
    await run(seconds(10))
    expect(today(model)).toBe(seconds(4))
    // Hidden, then shown in a window that has focus by then.
    setPageState({ hidden: true })
    setPageState({ focused: true }, false)
    setPageState({ hidden: false })
    await run(seconds(3))
    expect(today(model)).toBe(seconds(7))
  })

  it('P2: keeps counting while focus is in one of the page’s frames', async () => {
    const model = started()
    await run(seconds(4))
    // Focus moves into an iframe: the window blurs, the document keeps focus.
    window.dispatchEvent(new Event('blur'))
    await run(seconds(10))
    expect(today(model)).toBe(seconds(14))
    // Then leaves the browser from there: no event reaches the page.
    setPageState({ focused: false }, false)
    await run(seconds(10))
    expect(today(model)).toBeLessThanOrEqual(seconds(15))
    await close(model)
    expect(storedToday()).toBeLessThanOrEqual(seconds(15))
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
    const model = trackTracker(new FocusTracker(undefined, { send, alive }))
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

  it('P4: reports a change at once after a failed report, without waiting out the retry', async () => {
    const send = vi.fn<Bus['send']>(() => Promise.resolve({ ok: false, error: 'internal' }) as never)
    setPageState({ hidden: true, focused: false }, false)
    const model = trackTracker(new FocusTracker(undefined, { send, alive }))
    model.start()
    await run(seconds(1))
    send.mockImplementation(bus.send)
    setPageState({ focused: true }, false)
    setPageState({ hidden: false })
    await flush()
    expect(send).toHaveBeenCalledTimes(2)
    await run(seconds(5))
    expect(today(model)).toBe(seconds(5))
  })

  it('W2: a prerendered page reports once shown, and counts from then', async () => {
    let prerendering = true
    Object.defineProperty(document, 'prerendering', { configurable: true, get: () => prerendering })
    // The worker refuses a prerendered page, as the router does.
    const send = vi.fn<Bus['send']>((type, req) =>
      prerendering ? (Promise.resolve({ ok: false, error: 'forbidden' }) as never) : bus.send(type, req)
    )
    setPageState({ hidden: true, focused: false }, false)
    const model = trackTracker(new FocusTracker(undefined, { send, alive }))
    model.start()
    await run(seconds(2))
    expect(send).not.toHaveBeenCalled()
    prerendering = false
    setPageState({ hidden: false, focused: true }, false)
    document.dispatchEvent(new Event('prerenderingchange'))
    await run(seconds(5))
    expect(send).toHaveBeenCalledTimes(1)
    expect(today(model)).toBe(seconds(5))
    delete (document as { prerendering?: boolean }).prerendering
  })

  it('P7: a push that isn’t a probe leaves a failed report to be retried', async () => {
    let handler: ((state: TabState, probe: boolean) => unknown) | null = null
    const pushes: Pushes = { onState: (fn) => ((handler = fn), () => (handler = null)), onStop }
    const send = vi.fn<Bus['send']>(() => Promise.resolve({ ok: false, error: 'unreachable' }) as never)
    const model = trackTracker(new FocusTracker(undefined, { send, alive }, pushes))
    model.start()
    await run(seconds(2))
    // A checkpoint's push: its reply goes unread.
    handler!({ ...STATE, seq: 1 }, false)
    send.mockImplementation(bus.send)
    await run(seconds(10))
    expect(send).toHaveBeenCalledTimes(2)
    await run(seconds(5))
    expect(model.site).toBe('reddit.com')
    expect(today(model)).toBeGreaterThanOrEqual(seconds(5))
  })

  it('P7: a probe’s reply is the report: not sent again', async () => {
    let handler: ((state: TabState, probe: boolean) => unknown) | null = null
    const pushes: Pushes = { onState: (fn) => ((handler = fn), () => (handler = null)), onStop }
    const send = vi.fn<Bus['send']>(() => Promise.resolve({ ok: false, error: 'unreachable' }) as never)
    trackTracker(new FocusTracker(undefined, { send, alive }, pushes)).start()
    await run(seconds(2))
    handler!({ ...STATE, seq: 1 }, true)
    await run(seconds(30))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('leaves a hidden page unpolled, and reports what changed once shown', async () => {
    const reports = presenceReports()
    const video = document.createElement('video')
    const state = { paused: false }
    Object.defineProperty(video, 'paused', { get: () => state.paused })
    Object.defineProperty(video, 'readyState', { get: () => 4 })
    document.body.append(video)
    started()
    await run(seconds(1))
    setPageState({ hidden: true })
    await run(seconds(1))
    const sent = reports.length
    state.paused = true // stalls, with no event
    await run(seconds(30))
    expect(reports).toHaveLength(sent)
    setPageState({ hidden: false })
    await run(seconds(1))
    expect(reports.at(-1)).toMatchObject({ visible: true, media: false })
    video.remove()
  })

  it('X1: stops at once when a report finds the extension gone', async () => {
    let gone = false
    const send = vi.fn<Bus['send']>(() => Promise.resolve({ ok: false, error: 'unreachable' }) as never)
    const model = trackTracker(new FocusTracker(undefined, { send, alive: () => !gone }))
    const stopped = vi.fn()
    model.onStop(stopped)
    model.start()
    gone = true
    await flush()
    expect(stopped).toHaveBeenCalledOnce()
    // Gone: the page isn't reported hidden to a worker that can't hear it.
    expect(send).toHaveBeenCalledOnce()
    await run(seconds(30))
    expect(send).toHaveBeenCalledOnce()
  })

  it('X1/W1: stops when the worker says its site is not tracked', async () => {
    const send = vi.fn<Bus['send']>(() => Promise.resolve({ ok: false, error: 'untracked' }) as never)
    const model = trackTracker(new FocusTracker(undefined, { send, alive: () => true }))
    const stopped = vi.fn()
    model.onStop(stopped)
    model.start()
    await flush()
    expect(stopped).toHaveBeenCalledOnce()
    // Its hiding, once: nothing retries.
    expect(send).toHaveBeenCalledTimes(2)
    await run(seconds(30))
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('retries a failed report while hidden', async () => {
    const send = vi.fn<Bus['send']>(() => Promise.resolve({ ok: false, error: 'unreachable' }) as never)
    setPageState({ hidden: true, focused: false }, false)
    const model = trackTracker(new FocusTracker(undefined, { send, alive }))
    model.start()
    await run(seconds(10))
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('shows nothing ticking while the worker is unreachable', async () => {
    browser.runtime.onMessage.listeners.clear()
    const model = started()
    await run(seconds(30))
    expect(model.readTotals()).toEqual({ site: null, siteToday: 0, globalToday: 0 })
  })

  it('takes pushed states, ignores one built before the current one, and answers with its presence', async () => {
    let handler: ((state: TabState, probe: boolean) => unknown) | null = null
    const pushes: Pushes = {
      onState: (fn) => {
        handler = fn
        return () => (handler = null)
      },
      onStop,
    }
    const model = trackTracker(new FocusTracker(undefined, bus, pushes))
    model.start()
    await flush()
    const base: TabState = {
      site: 'reddit.com',
      day: '2026-06-10',
      asOf: NOON.getTime() + 5000,
      seq: 100,
      today: minutes(9),
      globalToday: minutes(9),
      running: false,
      blockAt: null,
      limit: null,
      snoozes: [],
      prefs: { hidden: false, scale: 1 },
    }
    expect(handler!(base, false)).toEqual({ visible: true, focused: true, media: false, blocked: false })
    expect(today(model)).toBe(minutes(9))
    handler!({ ...base, seq: 99, today: minutes(1) }, false)
    expect(today(model)).toBe(minutes(9))
    model.destroy()
    expect(handler).toBeNull()
  })

  it('P8: orders states by the worker’s sequence, not its clock', async () => {
    let handler: ((state: TabState, probe: boolean) => unknown) | null = null
    const pushes: Pushes = { onState: (fn) => ((handler = fn), () => (handler = null)), onStop }
    const model = trackTracker(new FocusTracker(undefined, bus, pushes))
    model.start()
    await flush()
    const at = NOON.getTime() + 5000
    // Two transactions in the same millisecond, their pushes delivered in
    // reverse: the later one stands.
    handler!({ ...STATE, asOf: at, seq: 1001, today: minutes(2) }, false)
    handler!({ ...STATE, asOf: at, seq: 1000, today: minutes(1) }, false)
    expect(today(model)).toBe(minutes(2))
    // The clock went back an hour: the worker's next state still applies.
    handler!({ ...STATE, asOf: at - minutes(60), seq: 1002, today: minutes(3) }, false)
    expect(today(model)).toBe(minutes(3))
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
  it('blocks at the moment the worker said, naming the limit', async () => {
    seedLimits({ perSite: { 'reddit.com': 1 } })
    seedToday({ 'reddit.com': seconds(50) })
    const model = started()
    await run(seconds(9))
    expect(model.blockReason()).toBeNull()
    await run(seconds(1))
    expect(model.blockReason()).toEqual({ scope: 'site', limit: minutes(1), elapsed: minutes(1) })
  })

  it('takes the all-sites cap from every site’s time', async () => {
    seedLimits({ global: 5 })
    seedToday({ 'x.com': minutes(5) })
    const model = started()
    await run(0)
    expect(model.blockReason()).toEqual({ scope: 'global', limit: minutes(5), elapsed: minutes(5) })
  })

  it('does not block while a snooze is being asked for, then until it ends', async () => {
    seedLimits({ perSite: { 'reddit.com': 1 } })
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
  // A media element in the page (or in `parent`), playing (or not) as far
  // as the tracker can tell.
  function media(tag: 'audio' | 'video', playing: boolean, parent: ParentNode = document.body) {
    const el = document.createElement(tag)
    const state = { paused: !playing }
    Object.defineProperty(el, 'paused', { get: () => state.paused })
    Object.defineProperty(el, 'readyState', { get: () => 4 })
    parent.append(el)
    return {
      stop: () => {
        state.paused = true
        el.dispatchEvent(new Event('pause'))
      },
    }
  }

  // A player element whose media goes in an open shadow root, one level
  // down from another.
  function shadowPlayer(): { player: HTMLElement; root: ShadowRoot } {
    const player = document.createElement('div')
    document.body.append(player)
    const inner = document.createElement('div')
    player.attachShadow({ mode: 'open' }).append(inner)
    return { player, root: inner.attachShadow({ mode: 'open' }) }
  }

  it('P6: keeps counting idle time while media in an open shadow root plays', async () => {
    const video = media('video', true, shadowPlayer().root)
    const model = started()
    await run(minutes(1))
    browser.setIdleState('idle')
    await run(minutes(2))
    expect(today(model)).toBe(minutes(3))
    // Its pause is heard at once, though the event stays in the shadow root.
    const reports = presenceReports()
    video.stop()
    await flush()
    expect(reports.at(-1)).toMatchObject({ media: false })
    await run(minutes(2))
    expect(today(model)).toBe(minutes(3))
  })

  it('P6: finds a player added later, and lets go of one removed', async () => {
    const reports = presenceReports()
    const model = started()
    await run(seconds(1))
    const { player, root } = shadowPlayer()
    media('audio', true, root)
    await run(seconds(5))
    expect(reports.at(-1)).toMatchObject({ media: true })
    player.remove()
    await run(seconds(5))
    expect(reports.at(-1)).toMatchObject({ media: false })
    expect(today(model)).toBe(seconds(11))
  })

  it('P2: keeps counting idle time while media in a closed shadow root plays', async () => {
    const player = document.createElement('div')
    document.body.append(player)
    const closed = player.attachShadow({ mode: 'closed' })
    browser.dom.openOrClosedShadowRoot.mockImplementation((el) => (el === player ? closed : el.shadowRoot))
    const video = media('video', true, closed)
    const model = started()
    await run(minutes(1))
    browser.setIdleState('idle')
    await run(minutes(2))
    expect(today(model)).toBe(minutes(3))
    const reports = presenceReports()
    video.stop()
    await flush()
    expect(reports.at(-1)).toMatchObject({ media: false })
  })

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

describe('P1: after a gap the page can see (sleep, the back/forward cache)', () => {
  const RUNNING: TabState = {
    ...STATE,
    running: true,
    blockAt: NOON.getTime() + minutes(10),
    limit: { scope: 'site', ms: minutes(10) },
  }

  // The worker answers the first report with RUNNING, then never again (its
  // replies and pushes can't reach a sleeping or frozen page).
  function silenced() {
    let handler: ((state: TabState, probe: boolean) => unknown) | null = null
    const pushes: Pushes = { onState: (fn) => ((handler = fn), () => (handler = null)), onStop }
    const send = vi.fn<Bus['send']>(() => new Promise(() => {}))
    send.mockImplementationOnce(() => Promise.resolve({ ok: true, value: RUNNING }) as never)
    const model = trackTracker(new FocusTracker(undefined, { send, alive }, pushes))
    model.start()
    return { model, send, push: (state: TabState) => handler!(state, false) }
  }

  it('never blocks or grows past the gap, and the focus stopwatch stops at the last tick', async () => {
    const { model, send, push } = silenced()
    await run(seconds(60))
    expect(model.readElapsed()).toMatchObject({ today: seconds(60), focus: seconds(60) })
    // An hour asleep: no timers ran.
    vi.setSystemTime(NOON.getTime() + seconds(60) + minutes(60))
    expect(model.blockReason()).toBeNull()
    expect(model.readElapsed().today).toBeLessThanOrEqual(seconds(90))
    expect(model.readElapsed().focus).toBe(seconds(60))
    const sent = send.mock.calls.length
    await run(seconds(1))
    // The tick sees the gap: the page asks again, and holds what it had.
    expect(send.mock.calls.length).toBeGreaterThan(sent)
    expect(model.blockReason()).toBeNull()
    expect(model.readElapsed()).toMatchObject({ today: seconds(60), focus: seconds(60) })
    // The worker's state on waking: not running since it woke.
    const wake = Date.now()
    push({ ...STATE, seq: 2, asOf: wake, today: seconds(60), globalToday: seconds(60) })
    expect(model.readElapsed()).toMatchObject({ today: seconds(60), focus: seconds(60) })
  })

  it('closes the stopwatch at the last tick when the worker’s state arrives first', async () => {
    const { model, push } = silenced()
    await run(seconds(60))
    vi.setSystemTime(NOON.getTime() + seconds(60) + minutes(60))
    push({ ...STATE, seq: 2, asOf: Date.now(), today: seconds(60), globalToday: seconds(60) })
    expect(model.readElapsed().focus).toBe(seconds(60))
  })

  it('holds the state while in the back/forward cache, and counts focus only from the worker’s next word', async () => {
    const { model, push } = silenced()
    await run(seconds(30))
    model.suspend()
    // Restored a minute later, after the block was due: the hidden report's
    // answer was lost.
    vi.setSystemTime(NOON.getTime() + seconds(30) + minutes(1))
    const due = { ...RUNNING, blockAt: NOON.getTime() + seconds(45) }
    expect(model.blockReason()).toBeNull()
    expect(model.readElapsed()).toMatchObject({ today: seconds(30), focus: seconds(30) })
    // The state from before the freeze, delivered late, counts nothing twice.
    push({ ...due, seq: 1 })
    await run(seconds(5))
    expect(model.readElapsed().focus).toBe(seconds(30))
    push({ ...RUNNING, seq: 3, asOf: Date.now(), today: seconds(30), globalToday: seconds(30) })
    await run(seconds(10))
    expect(model.readElapsed()).toMatchObject({ today: seconds(40), focus: seconds(40) })
  })

  it('keeps a block already due before the gap', async () => {
    const { model } = silenced()
    await run(seconds(1))
    model.suspend()
    expect(model.blockReason()).toBeNull()
    const { model: due } = (() => {
      const pushes: Pushes = { onState: () => () => {}, onStop }
      const send = vi.fn<Bus['send']>(() => new Promise(() => {}))
      send.mockImplementationOnce(
        () => Promise.resolve({ ok: true, value: { ...RUNNING, blockAt: NOON.getTime() } }) as never
      )
      const m = trackTracker(new FocusTracker(undefined, { send, alive }, pushes))
      m.start()
      return { model: m }
    })()
    await run(seconds(1))
    due.suspend()
    vi.setSystemTime(Date.now() + minutes(5))
    expect(due.blockReason()).toMatchObject({ scope: 'site' })
  })
})
