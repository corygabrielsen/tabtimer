import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest'
import { createTracker, type TrackerDeps } from './tracker'
import { checkpointAlarm, CHECKPOINT_ALARM } from './checkpoint'
import { createLedger, WORKER_KEY } from './ledger'
import { chromeStore } from '../chrome/store'
import { bus } from '../chrome/bus'
import { emptyBuckets, normalizeDay, siteTotal, LIMITS_KEY } from '../core/schema'
import { CHECKPOINT_MS, type Presence } from '../core/tracker'
import type { StatePush } from '../core/messages'
import { fakeChrome, type FakeChrome } from '../test/chrome'
import { flush } from '../test/dom'

const NOON = new Date(2026, 5, 10, 12).getTime()
const S = 1000
const MIN = 60_000

const SHOWN: Presence = { visible: true, focused: true, media: false, blocked: false }
const HIDDEN: Presence = { ...SHOWN, visible: false }
const PAGE = { site: 'a.com', windowId: 1, doc: 'doc-a', departing: false }

let browser: FakeChrome
let now: number
let sent: Array<[number, string, StatePush]>
let replies: Map<number, unknown>
let alarm: ReturnType<typeof vi.fn<TrackerDeps['alarm']>>

// A fresh worker on the same storage: what the browser starts after it
// stopped the previous one.
function worker(alarmDep: TrackerDeps['alarm'] = alarm) {
  const ledger = createLedger(chromeStore('local'), chromeStore('session'), { now: () => now })
  return createTracker({
    ledger,
    send: (tabId, doc, push) => {
      sent.push([tabId, doc, push])
      return replies.has(tabId) ? Promise.resolve(replies.get(tabId)) : Promise.reject(new Error('no page'))
    },
    alarm: alarmDep,
  })
}

const stored = (site = 'a.com') => siteTotal(normalizeDay(browser.storage.local.data['day:2026-06-10']), site)
const open = () =>
  (browser.storage.session.data[WORKER_KEY] as { tracker: { open: unknown } } | undefined)?.tracker.open ?? null

beforeEach(() => {
  browser = fakeChrome()
  now = NOON
  sent = []
  replies = new Map()
  alarm = vi.fn(() => Promise.resolve())
})

describe('presence', () => {
  it('opens on a page in use, replies with its running state, and credits on close', async () => {
    const tracker = worker()
    await expect(tracker.presence(1, { ...PAGE, ...SHOWN })).resolves.toEqual({
      site: 'a.com',
      day: '2026-06-10',
      asOf: NOON,
      seq: 1,
      today: 0,
      globalToday: 0,
      running: true,
      blockAt: null,
      limit: null,
      prefs: { hidden: false, scale: 1 },
    })
    expect(alarm).toHaveBeenLastCalledWith(true)
    now += 30 * S
    await expect(tracker.presence(1, { ...PAGE, ...HIDDEN })).resolves.toMatchObject({ today: 30 * S, running: false })
    expect(alarm).toHaveBeenLastCalledWith(false)
    expect(stored()).toBe(30 * S)
  })

  it('touches the alarm only when the interval opens or closes', async () => {
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    now += 5 * S
    await tracker.presence(1, { ...PAGE, ...SHOWN, media: true })
    await tracker.dispatch({ kind: 'checkpoint' })
    expect(alarm.mock.calls).toEqual([[true]])
  })

  it('counts the open interval’s uncredited time in the state it gives', async () => {
    browser.storage.local.seed({ 'day:2026-06-10': { 'b.com': emptyBuckets().fill(1000) } })
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    now += 20 * S
    await expect(tracker.presence(1, { ...PAGE, ...SHOWN })).resolves.toMatchObject({
      today: 20 * S,
      globalToday: 24 * S + 20 * S,
      running: true,
    })
  })

  it('tells the page that lost the interval, and not the one that took it', async () => {
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    now += 5 * S
    await tracker.presence(2, { site: 'b.com', windowId: 2, doc: 'doc-b', departing: false, ...SHOWN })
    expect(sent.map(([tabId, doc, push]) => [tabId, doc, push.state.running])).toEqual([[1, 'doc-a', false]])
  })

  it('P8: numbers its states in the order it built them, across restarts and within a millisecond', async () => {
    const seqs: number[] = []
    let tracker = worker()
    seqs.push((await tracker.presence(1, { ...PAGE, ...SHOWN })).seq)
    seqs.push((await tracker.presence(1, { ...PAGE, ...SHOWN, media: true })).seq)
    tracker = worker()
    now -= 60 * MIN // the clock went back
    seqs.push((await tracker.presence(1, { ...PAGE, ...SHOWN })).seq)
    expect(seqs).toEqual([1, 2, 3])
  })
})

describe('failures', () => {
  it('a failing alarm doesn’t fail the report', async () => {
    alarm.mockRejectedValue(new Error('alarms'))
    await expect(worker().presence(1, { ...PAGE, ...SHOWN })).resolves.toMatchObject({ running: true })
    await expect(worker().resume()).resolves.toBeUndefined()
  })
})

describe('restart', () => {
  it('a worker stopped mid-interval resumes from storage.session, losing nothing', async () => {
    await worker().presence(1, { ...PAGE, ...SHOWN })
    // Stopped. The next event (here, the checkpoint alarm) starts a new one.
    now += 50 * S
    const second = worker()
    await second.dispatch({ kind: 'checkpoint' })
    expect(stored()).toBe(50 * S)
    expect(open()).toMatchObject({ tabId: 1, since: now })
    now += 10 * S
    await worker().presence(1, { ...PAGE, ...HIDDEN })
    expect(stored()).toBe(MIN)
  })

  it('puts the checkpoint alarm in line with the stored state on start', async () => {
    await worker().resume()
    expect(alarm).toHaveBeenLastCalledWith(false)
    await worker().presence(1, { ...PAGE, ...SHOWN })
    alarm.mockClear()
    await worker().resume()
    expect(alarm).toHaveBeenCalledWith(true)
  })
})

describe('the checkpoint alarm under events in quick succession', () => {
  // chrome.alarms, a moment per call: overlapping events interleave.
  function slowAlarms() {
    const slow = <A extends unknown[], R>(method: Mock<(...args: A) => Promise<R>>) => {
      const real = method.getMockImplementation()!
      method.mockImplementation(async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        return real(...args)
      })
    }
    slow(browser.alarms.get)
    slow(browser.alarms.create)
    slow(browser.alarms.clear)
  }

  const running = () => browser.alarmTimers.has(CHECKPOINT_ALARM)
  const B = { site: 'b.com', windowId: 2, doc: 'doc-b', departing: false }

  async function settled<T>(work: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(50)
    return work
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: NOON })
  })

  afterEach(() => {
    browser.alarmTimers.forEach(({ timer }) => clearInterval(timer))
    vi.useRealTimers()
  })

  it('keeps the alarm when the open interval moves to another window', async () => {
    const tracker = worker(checkpointAlarm(browser.alarms))
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    slowAlarms()
    await settled(
      Promise.all([tracker.dispatch({ kind: 'windowFocus', windowId: 2 }), tracker.presence(2, { ...B, ...SHOWN })])
    )
    expect(open()).toMatchObject({ tabId: 2 })
    expect(running()).toBe(true)
  })

  it('doesn’t leave it running when an interval opens and closes at once', async () => {
    const tracker = worker(checkpointAlarm(browser.alarms))
    slowAlarms()
    await settled(
      Promise.all([
        tracker.presence(1, { ...PAGE, ...SHOWN }),
        tracker.dispatch({ kind: 'windowFocus', windowId: null }),
      ])
    )
    expect(open()).toBeNull()
    expect(running()).toBe(false)
  })

  it('keeps the alarm a restarted browser kept when a page opens as the worker starts', async () => {
    // Chrome keeps the alarm across a restart; storage.session starts empty.
    await browser.alarms.create(CHECKPOINT_ALARM, { periodInMinutes: 1 })
    slowAlarms()
    const tracker = worker(checkpointAlarm(browser.alarms))
    await settled(Promise.all([tracker.resume(), tracker.presence(1, { ...PAGE, ...SHOWN })]))
    expect(open()).toMatchObject({ tabId: 1 })
    expect(running()).toBe(true)
  })
})

describe('the bound on time lost to a crash', () => {
  it('is under one checkpoint: storage.session goes, storage.local keeps the rest', async () => {
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    for (let m = 1; m <= 10; m++) {
      now = NOON + m * CHECKPOINT_MS
      await tracker.dispatch({ kind: 'checkpoint' })
    }
    // The browser crashes 59 s after the last checkpoint.
    now += 59 * S
    const used = now - NOON
    await browser.storage.session.clear()
    // The browser starts again: an empty tracker, nothing open.
    now += MIN
    await worker().dispatch({ kind: 'checkpoint' })
    expect(used - stored()).toBe(59 * S)
    expect(used - stored()).toBeLessThan(CHECKPOINT_MS)
  })

  it('counts none of a sleep without a lock, and resumes on the page’s answer', async () => {
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    now += 3 * 3600 * S
    await tracker.dispatch({ kind: 'checkpoint' })
    expect(stored()).toBe(0)
    expect(open()).toBeNull()
    // Awake and in use: the page answers the probe and counting resumes.
    replies.set(1, SHOWN)
    now += CHECKPOINT_MS
    await tracker.dispatch({ kind: 'activated', tabId: 1, windowId: 1 })
    expect(open()).toMatchObject({ tabId: 1, since: now })
    now += 10 * S
    await tracker.presence(1, { ...PAGE, ...HIDDEN })
    expect(stored()).toBe(10 * S)
  })
})

describe('probes', () => {
  it('asks the pages of a newly focused window, and opens for the one in use', async () => {
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    await tracker.presence(3, { site: 'c.com', windowId: 2, doc: 'doc-c', departing: false, ...SHOWN, focused: false })
    replies.set(3, SHOWN)
    sent = []
    now += 5 * S
    await tracker.dispatch({ kind: 'windowFocus', windowId: 2 })
    expect(open()).toMatchObject({ tabId: 3, site: 'c.com', since: now })
    expect(stored()).toBe(5 * S)
    // Tab 1 was told it stopped; tab 3 was asked, then told it runs.
    expect(sent.map(([tabId, , push]) => [tabId, push.state.running])).toEqual([
      [1, false],
      [3, false],
      [3, true],
    ])
  })

  it('P7: marks the pushes it reads the reply to as probes, and only those', async () => {
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    await tracker.presence(2, { site: 'b.com', windowId: 1, doc: 'doc-b', departing: false, ...HIDDEN })
    replies.set(2, SHOWN)
    sent = []
    await tracker.dispatch({ kind: 'activated', tabId: 2, windowId: 1 })
    expect(sent.map(([tabId, , push]) => [tabId, push.probe, push.state.running])).toEqual([
      [1, false, false],
      [2, true, false],
      [2, false, true],
    ])
  })

  it('W3: follows a tab moved to another window, which then counts there', async () => {
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN, focused: false })
    replies.set(1, SHOWN)
    // Dragged into window 2, which takes focus.
    await tracker.dispatch({ kind: 'attached', tabId: 1, windowId: 2 })
    await tracker.dispatch({ kind: 'activated', tabId: 1, windowId: 2 })
    await tracker.dispatch({ kind: 'windowFocus', windowId: 2 })
    expect(open()).toMatchObject({ tabId: 1, windowId: 2, since: NOON })
    // The open tab moved back: it keeps counting once its window has focus.
    now += 5 * S
    await tracker.dispatch({ kind: 'attached', tabId: 1, windowId: 1 })
    await tracker.dispatch({ kind: 'windowFocus', windowId: 1 })
    expect(open()).toMatchObject({ tabId: 1, windowId: 1, since: NOON })
  })

  it('W3: takes a tab’s window from its activation too', async () => {
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    replies.set(1, SHOWN)
    await tracker.dispatch({ kind: 'activated', tabId: 1, windowId: 3 })
    await tracker.dispatch({ kind: 'windowFocus', windowId: 3 })
    expect(open()).toMatchObject({ tabId: 1, windowId: 3, since: NOON })
  })

  it('ignores an answer that is not a presence, and a page that is gone', async () => {
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN, focused: false })
    replies.set(1, { visible: 'yes' })
    await tracker.dispatch({ kind: 'activated', tabId: 1, windowId: 1 })
    expect(open()).toBeNull()
    replies.delete(1)
    await tracker.dispatch({ kind: 'activated', tabId: 1, windowId: 1 })
    expect(open()).toBeNull()
  })

  it('back from a lock, reopens the page last in use if it says it still is', async () => {
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    now += 4 * S
    await tracker.dispatch({ kind: 'idle', state: 'locked' })
    expect(open()).toBeNull()
    expect(stored()).toBe(4 * S)
    replies.set(1, SHOWN)
    now += MIN
    await tracker.dispatch({ kind: 'idle', state: 'active' })
    expect(open()).toMatchObject({ tabId: 1, since: now })
  })
})

describe('limits', () => {
  it('gives the moment to block, and closes an interval already over (the backstop)', async () => {
    browser.storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: { 'a.com': 1 } } })
    const tracker = worker()
    await expect(tracker.presence(1, { ...PAGE, ...SHOWN })).resolves.toMatchObject({
      running: true,
      blockAt: NOON + MIN,
      limit: { scope: 'site', ms: MIN },
    })
    // The page didn't block (it was frozen): the checkpoint does.
    now += MIN + 30 * S
    await tracker.dispatch({ kind: 'checkpoint' })
    expect(open()).toBeNull()
    expect(stored()).toBe(MIN + 30 * S)
    expect(sent.at(-1)?.[2].state).toMatchObject({ running: false, blockAt: now })
  })

  it('refresh tells every page that reported its new state', async () => {
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    await tracker.presence(2, { site: 'b.com', windowId: 1, doc: 'doc-b', departing: false, ...HIDDEN })
    sent = []
    browser.storage.local.seed({ [LIMITS_KEY]: { global: 1, perSite: {}, snoozeUntil: NOON + 5 * MIN } })
    await tracker.refresh()
    expect(sent.map(([tabId, , push]) => [tabId, push.state.blockAt])).toEqual([
      [1, NOON + 5 * MIN],
      [2, null],
    ])
  })

  it('resetToday drops the open interval’s time so far too', async () => {
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    now += 30 * S
    await tracker.resetToday('a.com')
    now += 5 * S
    await tracker.presence(1, { ...PAGE, ...HIDDEN })
    expect(stored()).toBe(5 * S)
    // A reset of another site leaves this one alone.
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    now += 5 * S
    await tracker.resetToday('b.com')
    await tracker.presence(1, { ...PAGE, ...HIDDEN })
    expect(stored()).toBe(10 * S)
  })
})

describe('background wiring', () => {
  async function boot() {
    vi.resetModules()
    await import('./background')
    await flush()
  }

  async function report(presence: Presence, tab = { id: 1, windowId: 1 }, url = 'https://www.reddit.com/') {
    browser.sender = { id: browser.runtime.id, url, tab, frameId: 0, documentLifecycle: 'active' }
    const response = await bus.send('presence', presence)
    await flush()
    return response
  }

  const tracked = () =>
    (browser.storage.session.data[WORKER_KEY] as { tracker: { open: { tabId: number } | null } }).tracker.open

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOON })
    await boot()
  })

  it('runs the checkpoint alarm only while an interval is open', async () => {
    await report(SHOWN)
    expect(browser.alarmTimers.has('checkpoint')).toBe(true)
    await vi.advanceTimersByTimeAsync(MIN)
    await flush()
    expect(siteTotal(normalizeDay(browser.storage.local.data['day:2026-06-10']), 'reddit.com')).toBe(MIN)
    browser.alarms.onAlarm.dispatch({ name: 'other', scheduledTime: 0, persistAcrossSessions: true })
    await report(HIDDEN)
    expect(browser.alarmTimers.has('checkpoint')).toBe(false)
  })

  it('closes on tab switch, tab removal and leaving Chrome', async () => {
    await report(SHOWN)
    browser.tabs.onActivated.dispatch({ tabId: 2, windowId: 1 })
    await flush()
    expect(tracked()).toBeNull()
    await report(SHOWN)
    browser.tabs.onRemoved.dispatch(1)
    await flush()
    expect(tracked()).toBeNull()
    await report(SHOWN, { id: 3, windowId: 1 })
    browser.windows.onFocusChanged.dispatch(browser.windows.WINDOW_ID_NONE)
    await flush()
    expect(tracked()).toBeNull()
  })

  it('W3: follows a tab moved to another window', async () => {
    await report(SHOWN)
    browser.tabs.onAttached.dispatch(1, { newWindowId: 2, newPosition: 0 })
    await flush()
    browser.windows.onFocusChanged.dispatch(2)
    await flush()
    expect(tracked()).toMatchObject({ tabId: 1, windowId: 2 })
  })

  it('closes on navigation to another site, a page it can’t see, or a discard', async () => {
    const navigate = async (change: { url?: string; status?: string; discarded?: boolean }, url?: string) => {
      await report(SHOWN)
      browser.tabs.onUpdated.dispatch(1, change, { url })
      await flush()
      return tracked()
    }
    expect(await navigate({ url: 'https://www.reddit.com/r/x' })).not.toBeNull()
    expect(await navigate({ status: 'loading' }, 'https://reddit.com/')).not.toBeNull()
    expect(await navigate({ status: 'complete' })).not.toBeNull()
    expect(await navigate({ url: 'https://x.com/' })).toBeNull()
    expect(await navigate({ status: 'loading' })).toBeNull()
    expect(await navigate({ discarded: true }, 'https://www.reddit.com/')).toBeNull()
  })

  it('tells pages when limits, the snooze or the prefs change, whoever changed them', async () => {
    await report(SHOWN)
    browser.tabs.sendMessage.mockClear()
    browser.storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 1 } } })
    await flush()
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: 'state', state: expect.objectContaining({ blockAt: NOON + MIN }) }),
      { frameId: 0 }
    )
    browser.tabs.sendMessage.mockClear()
    browser.storage.local.seed({ prefs: { hidden: true, scale: 1 } })
    await flush()
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ state: expect.objectContaining({ prefs: { hidden: true, scale: 1 } }) }),
      { frameId: 0 }
    )
    browser.tabs.sendMessage.mockClear()
    browser.storage.local.seed({ other: 1 })
    browser.storage.session.seed({ [LIMITS_KEY]: { global: 1, perSite: {} } })
    await flush()
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled()
  })

  it('keeps serving when storage fails under any event', async () => {
    await report(SHOWN)
    browser.storage.session.error = 'unavailable'
    browser.tabs.onActivated.dispatch({ tabId: 2, windowId: 1 })
    browser.storage.local.seed({ [LIMITS_KEY]: { global: 1, perSite: {} } })
    browser.setIdleState('locked')
    vi.resetModules()
    await import('./background')
    await flush()
    browser.storage.session.error = null
    await expect(report(HIDDEN)).resolves.toMatchObject({ ok: true })
  })

  it('creates the checkpoint alarm once, and clears it once', async () => {
    await report(SHOWN)
    await report({ ...SHOWN, media: true })
    expect(browser.alarms.create).toHaveBeenCalledTimes(1)
    await report(HIDDEN)
    await report(HIDDEN)
    expect(browser.alarms.clear).toHaveBeenCalledTimes(1)
  })
})
