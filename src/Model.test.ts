// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://www.reddit.com/r/all"}
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Model from './Model'
import { TimerState } from './Timer'
import { todayKeyForHost } from './storage'
import { sendMessage } from './messages'
import { fakeChrome, type FakeChrome } from './test/chrome'
import { flush, setPageState } from './test/dom'
import { disposeModels, minutes, seconds, startBackground, storedToday, trackModel, useClock } from './test/content'

const NOON = new Date(2026, 5, 10, 12, 0, 0)

let browser: FakeChrome

function started(): Model {
  const model = trackModel(new Model())
  model.start()
  return model
}

async function today(model: Model): Promise<number> {
  return (await model.readElapsed()).today.elapsed
}

function addElapsedReports(): number[] {
  const deltas: number[] = []
  browser.runtime.onMessage.addListener((message) => {
    const m = message as { type: string; delta?: number }
    if (m.type === 'addElapsed') {
      deltas.push(m.delta!)
    }
  })
  return deltas
}

beforeEach(async () => {
  browser = fakeChrome()
  await startBackground()
  useClock(NOON)
})

afterEach(() => {
  disposeModels()
})

describe('focus time accrual', () => {
  it('accrues while the tab is visible and focused, and persists it', async () => {
    const model = started()
    await vi.advanceTimersByTimeAsync(seconds(30))
    expect(await today(model)).toBe(seconds(30))
    // Reported at the 1s, 11s and 21s ticks; the rest is still in memory.
    expect(storedToday()).toBe(seconds(21))
  })

  it('does not accrue in a tab that loads hidden until it is shown', async () => {
    setPageState({ hidden: true, focused: false }, false)
    const model = started()
    await vi.advanceTimersByTimeAsync(minutes(5))
    expect(await today(model)).toBe(0)
    expect(storedToday()).toBe(0)

    setPageState({ hidden: false, focused: true })
    await vi.advanceTimersByTimeAsync(seconds(3))
    expect(await today(model)).toBe(seconds(3))
  })

  it('does not accrue in a visible tab that never had focus', async () => {
    setPageState({ focused: false }, false)
    const model = started()
    await vi.advanceTimersByTimeAsync(minutes(1))
    expect(await today(model)).toBe(0)
  })

  it('pauses while the window is blurred', async () => {
    const model = started()
    await vi.advanceTimersByTimeAsync(seconds(5))
    setPageState({ focused: false })
    await vi.advanceTimersByTimeAsync(minutes(10))
    setPageState({ focused: true })
    await vi.advanceTimersByTimeAsync(seconds(5))
    expect(await today(model)).toBe(seconds(10))
  })

  it('excludes every unfocused gap across repeated blur/focus cycles', async () => {
    const model = started()
    await vi.advanceTimersByTimeAsync(seconds(3))
    setPageState({ focused: false })
    await vi.advanceTimersByTimeAsync(minutes(2))
    setPageState({ focused: true })
    await vi.advanceTimersByTimeAsync(seconds(4))
    setPageState({ focused: false })
    await vi.advanceTimersByTimeAsync(minutes(7))
    setPageState({ focused: true })
    await vi.advanceTimersByTimeAsync(seconds(5))
    const state = await model.readElapsed()
    expect(state.focus.elapsed).toBe(seconds(12))
    expect(state.today.elapsed).toBe(seconds(12))
  })

  it('pauses while the tab is hidden', async () => {
    const model = started()
    await vi.advanceTimersByTimeAsync(seconds(4))
    setPageState({ hidden: true })
    await vi.advanceTimersByTimeAsync(minutes(10))
    setPageState({ hidden: false })
    await vi.advanceTimersByTimeAsync(seconds(2))
    const state = await model.readElapsed()
    expect(state.today.elapsed).toBe(seconds(6))
    // The session timer counts wall time regardless.
    expect(state.countup.elapsed).toBe(minutes(10) + seconds(6))
  })

  it('exposes the timers’ running/paused state', async () => {
    const model = started()
    setPageState({ focused: false })
    const state = await model.readElapsed()
    expect(state.focus.state).toBe(TimerState.PAUSED)
    expect(state.countup.state).toBe(TimerState.RUNNING)
  })

  it('adds this tab’s time to what other tabs already logged today', async () => {
    browser.storage.local.seed({ [todayKeyForHost('reddit.com')]: minutes(7) })
    const model = started()
    await vi.advanceTimersByTimeAsync(seconds(30))
    expect(await today(model)).toBe(minutes(7) + seconds(30))
    expect(storedToday()).toBe(minutes(7) + seconds(21))
  })

  it('refuses to start twice', () => {
    const model = started()
    expect(() => model.start()).toThrow()
  })
})

describe('reporting to the background writer', () => {
  it('reports immediately, then at most every 10 seconds', async () => {
    const deltas = addElapsedReports()
    started()
    await vi.advanceTimersByTimeAsync(seconds(35))
    expect(deltas).toEqual([seconds(1), seconds(10), seconds(10), seconds(10)])
  })

  it('does not report while paused', async () => {
    const deltas = addElapsedReports()
    started()
    await vi.advanceTimersByTimeAsync(seconds(2))
    setPageState({ hidden: true })
    await vi.advanceTimersByTimeAsync(minutes(5))
    expect(deltas).toEqual([seconds(1)])
  })

  it('retries a failed report without losing the time', async () => {
    browser.storage.local.error = 'storage unavailable'
    const model = started()
    await vi.advanceTimersByTimeAsync(seconds(15))
    expect(storedToday()).toBe(0)
    browser.storage.local.error = null
    await vi.advanceTimersByTimeAsync(seconds(10))
    expect(storedToday()).toBe(seconds(21))
    expect(await today(model)).toBe(seconds(25))
  })

  it('keeps counting when the service worker is unreachable', async () => {
    browser.runtime.onMessage.listeners.clear()
    const model = started()
    await vi.advanceTimersByTimeAsync(seconds(12))
    expect(await today(model)).toBe(seconds(12))
  })

  it('flushes unreported time on unload', async () => {
    const model = started()
    await vi.advanceTimersByTimeAsync(seconds(6))
    expect(storedToday()).toBe(seconds(1))
    model.flush()
    await flush()
    expect(storedToday()).toBe(seconds(6))
  })

  it.fails('B7: the unload flush is not skipped while a report is in flight', async () => {
    browser.latency = 500 // a slow-to-wake service worker
    const model = started()
    await vi.advanceTimersByTimeAsync(seconds(12)) // the 11s report is in flight
    model.flush()
    await vi.advanceTimersByTimeAsync(seconds(3))
    expect(storedToday()).toBe(seconds(12))
  })
})

describe('resets', () => {
  it('drops in-memory time when today is reset elsewhere (popup)', async () => {
    const model = started()
    await vi.advanceTimersByTimeAsync(seconds(25))
    await sendMessage({ type: 'resetKey', key: todayKeyForHost('reddit.com') })
    await flush()
    expect(await today(model)).toBe(0)
    // And it doesn't re-report the stale delta onto the zeroed key.
    await vi.advanceTimersByTimeAsync(seconds(5))
    expect(storedToday()).toBeLessThanOrEqual(seconds(5))
    expect(await today(model)).toBe(seconds(5))
  })

  it('ignores other keys and other storage areas', async () => {
    const model = started()
    await vi.advanceTimersByTimeAsync(seconds(5))
    browser.storage.local.seed({ [todayKeyForHost('x.com')]: 0 })
    browser.storage.onChanged.dispatch({ [todayKeyForHost('reddit.com')]: { newValue: 0 } }, 'sync')
    expect(await today(model)).toBe(seconds(5))
  })

  it('starts a fresh day at local midnight', async () => {
    vi.setSystemTime(new Date(2026, 5, 10, 23, 59, 30))
    const model = started()
    await vi.advanceTimersByTimeAsync(seconds(40)) // 00:00:10 next day
    const yesterday = new Date(2026, 5, 10)
    expect(storedToday('reddit.com', yesterday)).toBeGreaterThan(0)
    expect(await today(model)).toBe(seconds(10))
    expect((await model.readElapsed()).focus.elapsed).toBe(seconds(10))
  })

  // B8: reset() used to zero the timers before advancing resetTimersAtTime;
  // stopping the focus timer invoked reportElapsed → maybeRollover → reset()
  // again until the stack overflowed, so any rollover noticed after the
  // boundary (sleep across midnight, or a midnight timeout firing late)
  // crashed and readElapsed() threw on every call.
  it('B8: rolls over even if the midnight timer never fired (sleep across midnight)', async () => {
    vi.setSystemTime(new Date(2026, 5, 10, 23, 0, 0))
    const model = started()
    await vi.advanceTimersByTimeAsync(minutes(1))
    // Jump the wall clock without running timers, as after a suspend.
    vi.setSystemTime(new Date(2026, 5, 11, 7, 0, 0))
    expect(await today(model)).toBe(0)
    expect(model.getTodayKey()).toBe(todayKeyForHost('reddit.com', new Date(2026, 5, 11)))
  })

  it('B8: a midnight timer that fires late still rolls the day over', async () => {
    vi.setSystemTime(new Date(2026, 5, 10, 23, 59, 30))
    const model = started()
    await vi.advanceTimersByTimeAsync(seconds(20))
    vi.setSystemTime(Date.now() + 50) // the timeout will fire 50ms after midnight
    await vi.advanceTimersByTimeAsync(seconds(15))
    expect(await today(model)).toBeLessThanOrEqual(seconds(5))
  })

  // Reaches the rollover through the late path, so it also depends on B8.
  it.fails('B2: midnight rollover keeps time other tabs logged after 00:00', async () => {
    vi.setSystemTime(new Date(2026, 5, 10, 23, 0, 0))
    const model = started()
    await vi.advanceTimersByTimeAsync(minutes(1))
    // Another tab already rolled over and logged 5 minutes into the new day
    // before this (throttled/suspended) tab notices midnight.
    vi.setSystemTime(new Date(2026, 5, 11, 0, 10, 0))
    browser.storage.local.seed({ [todayKeyForHost('reddit.com')]: minutes(5) })
    await model.readElapsed()
    await flush()
    expect(storedToday()).toBe(minutes(5))
  })

  it('prunes this site’s past days but keeps today and other sites', async () => {
    const old = todayKeyForHost('reddit.com', new Date(2026, 5, 1))
    const otherSiteOld = todayKeyForHost('x.com', new Date(2026, 5, 1))
    const todayKey = todayKeyForHost('reddit.com')
    browser.storage.local.seed({ [old]: 1, [otherSiteOld]: 2, [todayKey]: 3, tabtimer_limits: { global: 1 } })
    started()
    await flush()
    expect(Object.keys(browser.storage.local.data).sort()).toEqual([otherSiteOld, todayKey, 'tabtimer_limits'].sort())
  })
})
