// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://old.reddit.com/r/all"}
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Blocker from './Blocker'
import Model from './Model'
import { LIMITS_KEY, BLOCK_SNOOZE_KEY, SNOOZE_MS, type Limits } from './limits'
import { todayKeyForHost } from './storage'
import { fakeChrome, type FakeChrome } from './test/chrome'
import { click, flush, text, trackShadowRoots } from './test/dom'
import { disposeModels, minutes, startBackground, trackModel, useClock } from './test/content'

const NOON = new Date(2026, 5, 10, 12, 0, 0)

let browser: FakeChrome
let shadowOf: (id: string) => ShadowRoot
const blockers: Blocker[] = []

function limits(l: Partial<Limits>): void {
  browser.storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: {}, ...l } })
}

function logged(host: string, ms: number): void {
  browser.storage.local.seed({ [todayKeyForHost(host)]: ms })
}

async function mount(): Promise<Blocker> {
  const model = trackModel(new Model())
  model.start()
  const blocker = new Blocker(model)
  blockers.push(blocker)
  await flush()
  return blocker
}

const host = () => document.getElementById('tabtimer-block')!
const isBlocked = () => host().style.getPropertyValue('display') === 'block'
const screen = () => shadowOf('tabtimer-block')
const snoozeButton = () => screen().querySelector<HTMLButtonElement>('.snooze')

beforeEach(async () => {
  browser = fakeChrome()
  await startBackground()
  useClock(NOON)
  shadowOf = trackShadowRoots()
})

afterEach(() => {
  for (const b of blockers.splice(0)) {
    b.destroy()
  }
  disposeModels()
})

describe('deciding to block', () => {
  it('never blocks without any limit', async () => {
    logged('reddit.com', minutes(600))
    await mount()
    expect(isBlocked()).toBe(false)
  })

  it('stays out of the way under the per-site limit', async () => {
    limits({ perSite: { 'reddit.com': minutes(30) } })
    logged('reddit.com', minutes(29))
    await mount()
    expect(isBlocked()).toBe(false)
  })

  it('blocks once today’s time reaches the per-site limit', async () => {
    limits({ perSite: { 'reddit.com': minutes(30) } })
    logged('reddit.com', minutes(30))
    await mount()
    expect(isBlocked()).toBe(true)
    expect(text(screen(), '.title')).toBe("Time's up")
    expect(text(screen(), '.host')).toBe('reddit.com')
    expect(text(screen(), '.detail')).toBe('00:30:00 today · 00:30:00 limit')
  })

  it('counts this tab’s not-yet-reported time toward the limit', async () => {
    limits({ perSite: { 'reddit.com': minutes(30) } })
    logged('reddit.com', minutes(30) - 5000)
    const blocker = await mount()
    expect(isBlocked()).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    await blocker.tick()
    expect(isBlocked()).toBe(true)
  })

  it('ignores another site’s per-site limit', async () => {
    limits({ perSite: { 'x.com': minutes(1) } })
    logged('reddit.com', minutes(60))
    logged('x.com', minutes(60))
    await mount()
    expect(isBlocked()).toBe(false)
  })

  it('blocks on the global cap summed across all tracked sites', async () => {
    limits({ global: minutes(60) })
    logged('reddit.com', minutes(10))
    logged('x.com', minutes(30))
    logged('youtube.com', minutes(20))
    await mount()
    expect(isBlocked()).toBe(true)
    expect(text(screen(), '.host')).toBe('all tracked sites')
    expect(text(screen(), '.detail')).toBe('01:00:00 today · 01:00:00 limit')
  })

  it('does not count earlier days toward the global cap', async () => {
    limits({ global: minutes(60) })
    logged('reddit.com', minutes(10))
    browser.storage.local.seed({ [todayKeyForHost('x.com', new Date(2026, 5, 9))]: minutes(500) })
    await mount()
    expect(isBlocked()).toBe(false)
  })

  it('names the site, not the global cap, when both are exceeded', async () => {
    limits({ global: minutes(20), perSite: { 'reddit.com': minutes(15) } })
    logged('reddit.com', minutes(16))
    logged('x.com', minutes(10))
    await mount()
    expect(text(screen(), '.host')).toBe('reddit.com')
    expect(text(screen(), '.detail')).toBe('00:16:00 today · 00:15:00 limit')
  })

  it('fails open when limits cannot be read', async () => {
    limits({ perSite: { 'reddit.com': minutes(1) } })
    logged('reddit.com', minutes(5))
    browser.storage.local.error = 'storage unavailable'
    await mount()
    expect(isBlocked()).toBe(false)
  })

  it('locks page scrolling only while blocked', async () => {
    limits({ perSite: { 'reddit.com': minutes(1) } })
    logged('reddit.com', minutes(5))
    await mount()
    expect(document.documentElement.style.getPropertyValue('overflow')).toBe('hidden')
    limits({ perSite: {} })
    await flush()
    expect(isBlocked()).toBe(false)
    expect(document.documentElement.style.getPropertyValue('overflow')).toBe('')
  })
})

describe('live re-evaluation', () => {
  it('blocks as soon as a limit is set elsewhere, without a reload', async () => {
    logged('reddit.com', minutes(45))
    await mount()
    expect(isBlocked()).toBe(false)
    limits({ perSite: { 'reddit.com': minutes(30) } })
    await flush()
    expect(isBlocked()).toBe(true)
  })

  it('lifts the block when the limit is raised or removed', async () => {
    limits({ global: minutes(30) })
    logged('reddit.com', minutes(45))
    await mount()
    expect(isBlocked()).toBe(true)
    limits({ global: minutes(60) })
    await flush()
    expect(isBlocked()).toBe(false)
  })

  it('lifts the block when today is reset from the popup', async () => {
    limits({ perSite: { 'reddit.com': minutes(30) } })
    logged('reddit.com', minutes(45))
    const blocker = await mount()
    expect(isBlocked()).toBe(true)
    logged('reddit.com', 0)
    await flush()
    await blocker.tick()
    expect(isBlocked()).toBe(false)
  })

  it('ignores changes to other storage areas', async () => {
    logged('reddit.com', minutes(45))
    await mount()
    browser.storage.onChanged.dispatch({ [LIMITS_KEY]: { newValue: { global: 1, perSite: {} } } }, 'sync')
    await flush()
    expect(isBlocked()).toBe(false)
  })
})

describe('snooze', () => {
  beforeEach(() => {
    limits({ perSite: { 'reddit.com': minutes(30) } })
    logged('reddit.com', minutes(30))
  })

  it('offers five more minutes, then blocks again', async () => {
    const blocker = await mount()
    expect(text(screen(), '.snooze')).toBe('5 more minutes')
    click(snoozeButton())
    expect(isBlocked()).toBe(false)
    await flush()
    expect(browser.storage.local.data[BLOCK_SNOOZE_KEY]).toBe(Date.now() + SNOOZE_MS)

    await vi.advanceTimersByTimeAsync(SNOOZE_MS - 1000)
    await blocker.tick()
    expect(isBlocked()).toBe(false)

    await vi.advanceTimersByTimeAsync(1000)
    await blocker.tick()
    expect(isBlocked()).toBe(true)
  })

  it('applies a snooze taken in another tab', async () => {
    await mount()
    expect(isBlocked()).toBe(true)
    browser.storage.local.seed({ [BLOCK_SNOOZE_KEY]: Date.now() + SNOOZE_MS })
    await flush()
    expect(isBlocked()).toBe(false)
  })

  it('honours a snooze already running when the page loads', async () => {
    browser.storage.local.seed({ [BLOCK_SNOOZE_KEY]: Date.now() + 60_000 })
    await mount()
    expect(isBlocked()).toBe(false)
  })
})

describe('block screen', () => {
  beforeEach(() => {
    limits({ perSite: { 'reddit.com': minutes(1) } })
    logged('reddit.com', minutes(2))
  })

  it('is an alert dialog in a closed shadow root', async () => {
    await mount()
    expect(host().shadowRoot).toBeNull()
    const dialog = screen().querySelector('.screen')!
    expect(dialog.getAttribute('role')).toBe('alertdialog')
    expect(dialog.getAttribute('aria-label')).toBe("Time's up")
  })

  it('opens the options page from the Limits link', async () => {
    await mount()
    const manage = screen().querySelector('.manage')
    expect(manage?.textContent).toBe('Limits…')
    click(manage)
    await flush()
    expect(browser.runtime.openOptionsPage).toHaveBeenCalledOnce()
  })

  it('replaces a stale block screen instead of stacking a second one', async () => {
    await mount()
    await mount()
    expect(document.querySelectorAll('#tabtimer-block')).toHaveLength(1)
  })

  it('removes itself and restores scrolling on destroy', async () => {
    const blocker = await mount()
    blocker.destroy()
    expect(document.getElementById('tabtimer-block')).toBeNull()
    expect(document.documentElement.style.getPropertyValue('overflow')).toBe('')
    // No longer reacts to storage changes.
    limits({ perSite: { 'reddit.com': minutes(1) } })
    await flush()
    expect(document.getElementById('tabtimer-block')).toBeNull()
  })

  it.fails('B6: is modal and moves focus to the snooze button', async () => {
    await mount()
    expect(screen().querySelector('.screen')?.getAttribute('aria-modal')).toBe('true')
    expect(screen().activeElement).toBe(snoozeButton())
  })

  it.fails('B6: keeps keyboard focus inside the block screen', async () => {
    const pageLink = document.createElement('a')
    pageLink.href = '#'
    document.body.prepend(pageLink)
    await mount()
    pageLink.focus()
    // A focus trap pulls focus back into the dialog.
    expect(document.activeElement).toBe(host())
  })

  it.fails('B6: pauses playing media on the page', async () => {
    const video = document.createElement('video')
    document.body.append(video)
    const pause = vi.spyOn(video, 'pause')
    await mount()
    expect(pause).toHaveBeenCalled()
  })
})
