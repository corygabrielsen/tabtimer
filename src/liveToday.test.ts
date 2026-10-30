// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { bus } from './chrome/bus'
import { siteTodayAt } from './core/messages'
import { originsForSite } from './core/site'
import { liveToday, type LiveToday } from './liveToday'
import { fakeChrome, type FakeChrome } from './test/chrome'
import { flush } from './test/dom'
import { dayEntry, seedToday, startBackground } from './test/content'

let browser: FakeChrome
const NOW = new Date(2026, 9, 28, 16, 40)
const page = { url: 'https://www.reddit.com/', frameId: 0, documentLifecycle: 'active' }

// Tab 1 on reddit.com reports itself in use, or not. The tab is the sender
// only until the worker takes the message: the page asks while it handles it.
async function report(visible: boolean): Promise<void> {
  const own = browser.sender
  browser.sender = { ...page, id: browser.runtime.id, tab: { id: 1, windowId: 1 } }
  const sent = bus.send('presence', { visible, focused: true, media: false, blocked: false })
  await Promise.resolve()
  browser.sender = own
  await sent
}

let changes = 0
let live: LiveToday
const reddit = () => siteTodayAt(live.totals(), 'reddit.com', Date.now())

async function start(stored = {}): Promise<void> {
  live = liveToday(
    () => stored,
    () => changes++
  )
  await live.ready
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'Date'], now: NOW })
  browser = fakeChrome()
  browser.sender = { id: browser.runtime.id, url: browser.runtime.getURL('usage.html') }
  browser.granted = new Set(originsForSite('reddit.com'))
  await startBackground()
  changes = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('liveToday', () => {
  it('counts the open interval, and runs on each second while it is open', async () => {
    await report(true)
    vi.setSystemTime(Date.now() + 40_000)
    await start()
    expect(reddit()).toBe(40_000)
    expect(live.totals().running).toBe('reddit.com')
    vi.advanceTimersByTime(3000)
    expect(changes).toBe(3)
    expect(reddit()).toBe(43_000)
  })

  it('stops running once the tab stops', async () => {
    await report(true)
    vi.setSystemTime(Date.now() + 40_000)
    await start()
    await report(false)
    await flush()
    expect(live.totals().running).toBeNull()
    const seen = changes
    vi.advanceTimersByTime(5000)
    expect(changes).toBe(seen)
    expect(reddit()).toBe(40_000)
  })

  it('asks again when today’s storage changes, not another day’s', async () => {
    await start()
    expect(reddit()).toBe(0)
    seedToday({ 'reddit.com': 5000 })
    await flush()
    expect(changes).toBe(1)
    expect(reddit()).toBe(5000)
    browser.storage.local.seed(dayEntry({ 'reddit.com': 9000 }, new Date(2026, 9, 27)))
    await flush()
    expect(changes).toBe(1)
    // A snooze taken today.
    browser.storage.local.seed({ 'snoozes:2026-10-28': [] })
    await flush()
    expect(changes).toBe(2)
  })

  it('asks again at midnight, telling the page at once', async () => {
    await report(true)
    vi.setSystemTime(new Date(2026, 9, 28, 23, 59, 59))
    await start()
    vi.advanceTimersByTime(1000)
    // The new day at once, then the worker's answer.
    expect(changes).toBe(1)
    await flush()
    expect(changes).toBe(2)
    expect(live.totals().day).toBe('2026-10-29')
  })

  it('shows storage’s time when the worker doesn’t answer', async () => {
    // Not an extension page: the worker refuses it.
    browser.sender = { id: browser.runtime.id, url: 'https://reddit.com/' }
    await start({ 'reddit.com': [0, 0, 7000] })
    expect(live.totals()).toEqual({
      day: '2026-10-28',
      asOf: NOW.getTime(),
      seq: 0,
      running: null,
      sites: { 'reddit.com': 7000 },
      snoozes: {},
    })
    vi.advanceTimersByTime(5000)
    expect(changes).toBe(0)
  })
})
