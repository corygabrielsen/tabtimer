import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest'
import { createTracker, type TrackerDeps } from './tracker'
import { checkpointAlarm, CHECKPOINT_ALARM } from './checkpoint'
import { createLedger, WORKER_KEY } from './ledger'
import { chromeStore } from '../chrome/store'
import { bus } from '../chrome/bus'
import { emptyBuckets, normalizeDay, siteTotal, LIMITS_KEY } from '../core/schema'
import { CHECKPOINT_MS, type Presence } from '../core/tracker'
import type { StatePush } from '../core/messages'
import { originsForSite } from '../core/site'
import { fakeChrome, type FakeChrome } from '../test/chrome'
import { flush } from '../test/dom'

const NOON = new Date(2026, 5, 10, 12).getTime()
const S = 1000
const MIN = 60_000

const SHOWN: Presence = { visible: true, focused: true, media: false, blocked: false }
const HIDDEN: Presence = { ...SHOWN, visible: false }
const PAGE = { site: 'a.com', windowId: 1, doc: 'doc-a', departing: false, audible: false }

let browser: FakeChrome
let now: number
let sent: Array<[number, string, StatePush]>
let replies: Map<number, unknown>
let alarm: ReturnType<typeof vi.fn<TrackerDeps['alarm']>>
let granted: string[]
let mute: ReturnType<typeof vi.fn<TrackerDeps['mute']>>

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
    granted: () => Promise.resolve(granted),
    mute,
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
  granted = ['*://*/*']
  mute = vi.fn(() => Promise.resolve())
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
      snoozes: [],
      hours: emptyBuckets(),
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
    const stored = emptyBuckets()
    stored[9] = 5 * S
    browser.storage.local.seed({ 'day:2026-06-10': { 'b.com': emptyBuckets().fill(1000), 'a.com': stored } })
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    now += 20 * S
    const hours = [...stored]
    hours[12] = 20 * S
    await expect(tracker.presence(1, { ...PAGE, ...SHOWN })).resolves.toMatchObject({
      today: 25 * S,
      globalToday: 24 * S + 25 * S,
      running: true,
      // By hour too: the uncredited part in the current hour.
      hours,
    })
  })

  it('X4: counts only the tracked sites toward the all-sites total', async () => {
    browser.storage.local.seed({
      [LIMITS_KEY]: { global: 1, perSite: {} },
      'day:2026-06-10': { 'b.com': emptyBuckets().fill(1000), 'c.com': emptyBuckets().fill(10) },
    })
    granted = ['*://a.com/*', '*://*.c.com/*']
    const tracker = worker()
    await expect(tracker.presence(1, { ...PAGE, ...SHOWN })).resolves.toMatchObject({
      globalToday: 240,
      running: true,
      blockAt: NOON + MIN - 240,
    })
    // Grants that can't be read: every site counts.
    const failing = createTracker({
      ledger: createLedger(chromeStore('local'), chromeStore('session'), { now: () => now }),
      send: () => Promise.resolve(undefined),
      alarm,
      granted: () => Promise.reject(new Error('gone')),
      mute,
    })
    await expect(failing.presence(1, { ...PAGE, ...SHOWN })).resolves.toMatchObject({ globalToday: 24_240 })
  })

  it('tells the page that lost the interval, and not the one that took it', async () => {
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    now += 5 * S
    await tracker.presence(2, { site: 'b.com', windowId: 2, doc: 'doc-b', departing: false, audible: false, ...SHOWN })
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

describe('tabState (an extension page asks)', () => {
  // KNOWN-2 / A3: the popup read storage, which lacks the open interval's
  // uncredited time, so it lagged the overlay by up to a checkpoint.
  it('gives the state the tab is told, open interval included, telling no page', async () => {
    browser.storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: { 'a.com': 1 }, snoozeUntil: 0 } })
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    now += 40 * S
    sent = []
    const told = await tracker.presence(1, { ...PAGE, ...SHOWN }).then((state) => state.seq)
    sent = []
    await expect(tracker.tabState(1, 'a.com')).resolves.toMatchObject({
      site: 'a.com',
      seq: told + 1,
      asOf: now,
      today: 40 * S,
      running: true,
      blockAt: NOON + MIN,
      limit: { scope: 'site', ms: MIN },
    })
    expect(sent).toEqual([])
    expect(open()).toMatchObject({ tabId: 1, since: NOON })
  })

  it('counts no open interval for a tab on another site, or one never heard from', async () => {
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    now += 40 * S
    await expect(tracker.tabState(1, 'b.com')).resolves.toMatchObject({ site: 'b.com', today: 0, running: false })
    await expect(tracker.tabState(2, 'a.com')).resolves.toMatchObject({ today: 0, running: false })
  })
})

describe('todayTotals (an extension page asks)', () => {
  it('gives every site’s time today, the open interval’s included, telling no page', async () => {
    browser.storage.local.seed({ 'day:2026-06-10': { 'b.com': emptyBuckets().fill(1000, 0, 20) } })
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    now += 40 * S
    sent = []
    await expect(tracker.todayTotals()).resolves.toMatchObject({
      day: '2026-06-10',
      asOf: now,
      running: 'a.com',
      sites: { 'a.com': 40 * S, 'b.com': 20 * S },
    })
    expect(sent).toEqual([])
    expect(stored()).toBe(0)
    await tracker.presence(1, { ...PAGE, ...HIDDEN })
    await expect(tracker.todayTotals()).resolves.toMatchObject({ running: null, sites: { 'a.com': 40 * S } })
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
  const B = { site: 'b.com', windowId: 2, doc: 'doc-b', departing: false, audible: false }

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
    await tracker.presence(3, {
      site: 'c.com',
      windowId: 2,
      doc: 'doc-c',
      departing: false,
      audible: false,
      ...SHOWN,
      focused: false,
    })
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
    await tracker.presence(2, { site: 'b.com', windowId: 1, doc: 'doc-b', departing: false, audible: false, ...HIDDEN })
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
    await tracker.presence(2, { site: 'b.com', windowId: 1, doc: 'doc-b', departing: false, audible: false, ...HIDDEN })
    sent = []
    browser.storage.local.seed({ [LIMITS_KEY]: { global: 1, perSite: {}, snoozeUntil: NOON + 5 * MIN } })
    await tracker.refresh()
    expect(sent.map(([tabId, , push]) => [tabId, push.state.blockAt])).toEqual([
      [1, NOON + 5 * MIN],
      [2, null],
    ])
  })

  it('snooze records who took it and the times it began at, open interval included', async () => {
    browser.storage.local.seed({ [LIMITS_KEY]: { global: 2, perSite: { 'a.com': 1 } } })
    const tracker = worker()
    await tracker.presence(2, { site: 'b.com', windowId: 1, doc: 'doc-b', departing: false, audible: false, ...SHOWN })
    now += 90 * S
    await tracker.presence(2, { site: 'b.com', windowId: 1, doc: 'doc-b', departing: false, audible: false, ...HIDDEN })
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    now += MIN
    await tracker.snooze('a.com')
    expect(browser.storage.local.data['snoozes:2026-06-10']).toEqual([
      { site: 'a.com', at: now, ms: 5 * MIN, siteMs: MIN, globalMs: MIN + 90 * S },
    ])
    expect(browser.storage.local.data[LIMITS_KEY]).toMatchObject({ snoozeUntil: now + 5 * MIN })
    await tracker.presence(1, { ...PAGE, ...HIDDEN })
    // States carry the snoozes that count against their limit: a.com's own
    // here; b.com's all-sites limit counts every site's.
    await expect(tracker.tabState(1, 'a.com')).resolves.toMatchObject({ limit: { scope: 'site' }, snoozes: [MIN] })
    await expect(tracker.tabState(2, 'b.com')).resolves.toMatchObject({
      limit: { scope: 'global' },
      snoozes: [MIN + 90 * S],
    })
    await expect(tracker.todayTotals()).resolves.toMatchObject({ snoozes: { 'a.com': 1 } })
  })

  it('snooze counts only tracked sites toward the all-sites time', async () => {
    granted = originsForSite('a.com')
    browser.storage.local.seed({
      'day:2026-06-10': { 'a.com': emptyBuckets(), 'x.com': [MIN, ...emptyBuckets().slice(1)] },
    })
    const tracker = worker()
    await tracker.snooze('a.com')
    expect(browser.storage.local.data['snoozes:2026-06-10']).toMatchObject([{ siteMs: 0, globalMs: 0 }])
  })
})

describe('background wiring', () => {
  async function boot() {
    vi.resetModules()
    await import('./background')
    await flush()
  }

  async function report(
    presence: Presence,
    tab: { id: number; windowId: number; audible?: boolean } = { id: 1, windowId: 1 },
    url = 'https://www.reddit.com/'
  ) {
    browser.sender = { id: browser.runtime.id, url, tab, frameId: 0, documentLifecycle: 'active' }
    const response = await bus.send('presence', presence)
    await flush()
    return response
  }

  const tracked = () =>
    (browser.storage.session.data[WORKER_KEY] as { tracker: { open: { tabId: number } | null } }).tracker.open

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOON })
    browser.granted = new Set(originsForSite('reddit.com'))
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

  it('keeps counting in an installed app’s window, and stops in devtools', async () => {
    await report(SHOWN, { id: 1, windowId: 2 })
    browser.windows.onFocusChanged.focus(2, 'app')
    await flush()
    expect(tracked()).toMatchObject({ tabId: 1, windowId: 2 })
    browser.windows.onFocusChanged.focus(3, 'devtools')
    await flush()
    expect(tracked()).toBeNull()
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

  it('P2: mutes a blocked page’s tab, and undoes only its own mute', async () => {
    await report({ ...SHOWN, blocked: true })
    expect(browser.mutedInfo.get(1)).toMatchObject({ muted: true, reason: 'extension' })
    await report(SHOWN)
    expect(browser.mutedInfo.get(1)).toEqual({ muted: false })
    // Muted by the user before the block, or during it: theirs stays.
    browser.mutedInfo.set(1, { muted: true, reason: 'user' })
    await report({ ...SHOWN, blocked: true })
    await report(SHOWN)
    expect(browser.mutedInfo.get(1)).toEqual({ muted: true, reason: 'user' })
    browser.mutedInfo.set(1, { muted: false })
    await report({ ...SHOWN, blocked: true })
    browser.mutedInfo.set(1, { muted: true, reason: 'user' })
    await report(SHOWN)
    expect(browser.mutedInfo.get(1)).toEqual({ muted: true, reason: 'user' })
    // Navigating away from a blocked page unmutes its tab.
    browser.mutedInfo.set(1, { muted: false })
    await report({ ...SHOWN, blocked: true })
    browser.tabs.onUpdated.dispatch(1, { url: 'https://x.com/' }, { url: 'https://x.com/' })
    await flush()
    expect(browser.mutedInfo.get(1)).toEqual({ muted: false })
  })

  it('P2: counts idle time while the browser hears the tab, and asks the page again when that changes', async () => {
    await report(SHOWN, { id: 1, windowId: 1, audible: true })
    browser.setIdleState('idle')
    await flush()
    expect(tracked()).toMatchObject({ tabId: 1, media: true })
    browser.tabs.sendMessage.mockClear()
    browser.tabs.onUpdated.dispatch(1, { audible: false }, {})
    await flush()
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ probe: true }), { frameId: 0 })
    await report(SHOWN, { id: 1, windowId: 1, audible: false })
    expect(tracked()).toBeNull()
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

describe('replies', () => {
  it('W4: answers a report it drops with the page’s own state', async () => {
    const tracker = worker()
    // The tab is unknown (navigated, or removed): a departing report from
    // its cached page still gets a whole state.
    await expect(tracker.presence(7, { ...PAGE, ...HIDDEN, departing: true })).resolves.toMatchObject({
      site: 'a.com',
      running: false,
      seq: 1,
    })
    // The page that replaced it on another site isn't the reporter's.
    await tracker.presence(1, { ...PAGE, doc: 'new', site: 'b.com', ...SHOWN })
    await expect(tracker.presence(1, { ...PAGE, ...HIDDEN, departing: true })).resolves.toMatchObject({
      site: 'a.com',
      running: false,
    })
  })

  it('W5: answers a page without waiting on telling the other tabs', async () => {
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    // Tab 1's renderer hangs: its push is never answered.
    const hung = vi.fn(() => new Promise<unknown>(() => {}))
    const t2 = createTracker({
      ledger: createLedger(chromeStore('local'), chromeStore('session'), { now: () => now }),
      send: hung,
      alarm,
      granted: () => Promise.resolve(granted),
      mute,
    })
    now += 5 * S
    const reply = await Promise.race([
      t2.presence(2, { ...PAGE, site: 'b.com', windowId: 2, doc: 'doc-b', ...SHOWN }),
      new Promise((resolve) => setTimeout(() => resolve('waited'), 50)),
    ])
    expect(reply).toMatchObject({ site: 'b.com', running: true })
    expect(hung).toHaveBeenCalledWith(1, 'doc-a', expect.objectContaining({ type: 'state' }))
  })
})

describe('P2: muting while blocked', () => {
  it('mutes a tab once its page reports blocked, and unmutes once it doesn’t or is gone', async () => {
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    expect(mute).not.toHaveBeenCalled()
    await tracker.presence(1, { ...PAGE, ...SHOWN, blocked: true })
    await tracker.presence(1, { ...PAGE, ...HIDDEN, blocked: true })
    expect(mute.mock.calls).toEqual([[1, true]])
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    expect(mute.mock.calls).toEqual([
      [1, true],
      [1, false],
    ])
    await tracker.presence(1, { ...PAGE, ...SHOWN, blocked: true })
    await tracker.dispatch({ kind: 'removed', tabId: 1 })
    expect(mute.mock.calls.at(-1)).toEqual([1, false])
  })

  it('keeps going when muting fails', async () => {
    mute.mockRejectedValue(new Error('no tab'))
    const tracker = worker()
    await expect(tracker.presence(1, { ...PAGE, ...SHOWN, blocked: true })).resolves.toMatchObject({ running: false })
  })
})

describe('P2: a tab the browser hears', () => {
  it('asks the page again when the tab starts or stops being heard', async () => {
    const tracker = worker()
    await tracker.presence(1, { ...PAGE, ...SHOWN })
    replies.set(1, SHOWN)
    sent = []
    await tracker.dispatch({ kind: 'audible', tabId: 1, audible: true })
    expect(sent.map(([, , push]) => push.probe)).toContain(true)
    expect(open()).toMatchObject({ media: true })
    sent = []
    await tracker.dispatch({ kind: 'audible', tabId: 1, audible: true })
    expect(sent).toEqual([])
  })
})
