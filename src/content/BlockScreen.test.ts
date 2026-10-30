// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://old.reddit.com/r/all"}
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import BlockScreen from './BlockScreen'
import FocusTracker from './FocusTracker'
import { SNOOZE_MS } from '../core/limits'
import { DONE_MS, HOLD_MS } from './hold'
import { LIMITS_KEY } from '../core/schema'
import { fakeChrome, type FakeChrome } from '../test/chrome'
import { bucketsOf } from '../test/data'
import { click, flush, normText, trackShadowRoots } from '../test/dom'
import {
  disposeTrackers,
  isBlocked,
  minutes,
  seedLimits,
  seedToday,
  startBackground,
  EVERY_HOST,
  trackTracker,
  useClock,
} from '../test/content'

const NOON = new Date(2026, 5, 10, 12, 0, 0)

let browser: FakeChrome
let shadowOf: (id: string) => ShadowRoot
const blockers: BlockScreen[] = []

function logged(host: string, ms: number): void {
  seedToday({ [host]: ms })
}

async function mount(): Promise<BlockScreen> {
  const model = trackTracker(new FocusTracker())
  model.start()
  const blocker = new BlockScreen(model)
  blockers.push(blocker)
  await flush()
  return blocker
}

const host = () => document.getElementById('tabtimer-block')!
const screen = () => shadowOf('tabtimer-block')
const closeButton = () => screen().querySelector<HTMLButtonElement>('.close')
const holdButton = () => screen().querySelector<HTMLButtonElement>('.hold')

// Hold "5 more minutes" down to the end, as a pointer would, and let the
// done state run out.
async function snooze(): Promise<void> {
  const hold = holdButton()!
  hold.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
  vi.advanceTimersByTime(HOLD_MS + 50)
  hold.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  vi.advanceTimersByTime(DONE_MS)
  await flush()
}

// An element of the host page, removed after the test.
const pageElements: Element[] = []
function page<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  document.body.prepend(el)
  pageElements.push(el)
  return el
}

beforeEach(async () => {
  browser = fakeChrome()
  await startBackground(EVERY_HOST)
  useClock(NOON)
  shadowOf = trackShadowRoots()
})

afterEach(() => {
  for (const b of blockers.splice(0)) {
    b.destroy()
  }
  disposeTrackers()
  for (const el of pageElements.splice(0)) {
    el.remove()
  }
})

describe('deciding to block', () => {
  it('never blocks without any limit', async () => {
    logged('reddit.com', minutes(600))
    await mount()
    expect(isBlocked()).toBe(false)
  })

  it('stays out of the way under the per-site limit', async () => {
    seedLimits({ perSite: { 'reddit.com': 30 } })
    logged('reddit.com', minutes(29))
    await mount()
    expect(isBlocked()).toBe(false)
  })

  it('blocks once today’s time reaches the per-site limit', async () => {
    seedLimits({ perSite: { 'reddit.com': 30 } })
    logged('reddit.com', minutes(30))
    await mount()
    expect(isBlocked()).toBe(true)
    expect(normText(screen().querySelector('h1'))).toBe("Time's up")
    expect(normText(screen().querySelector('.site .name'))).toBe('reddit.com')
    expect(normText(screen().querySelector('.used'))).toBe('30 min today')
  })

  it('counts this tab’s not-yet-reported time toward the limit', async () => {
    seedLimits({ perSite: { 'reddit.com': 30 } })
    logged('reddit.com', minutes(30) - 5000)
    const blocker = await mount()
    expect(isBlocked()).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    await blocker.tick()
    expect(isBlocked()).toBe(true)
  })

  it('ignores another site’s per-site limit', async () => {
    seedLimits({ perSite: { 'x.com': 1 } })
    logged('reddit.com', minutes(60))
    logged('x.com', minutes(60))
    await mount()
    expect(isBlocked()).toBe(false)
  })

  it('blocks on the global cap summed across all tracked sites', async () => {
    seedLimits({ global: 60 })
    logged('reddit.com', minutes(10))
    logged('x.com', minutes(30))
    logged('youtube.com', minutes(20))
    await mount()
    expect(isBlocked()).toBe(true)
    expect(normText(screen().querySelector('.site .name'))).toBe('reddit.com')
    expect(normText(screen().querySelector('.used'))).toBe('1 h today on all sites')
    // One site's hours can't be split at the all-sites limit.
    expect(screen().querySelectorAll('.tick, .seg.over')).toHaveLength(0)
  })

  it('does not count earlier days toward the global cap', async () => {
    seedLimits({ global: 60 })
    logged('reddit.com', minutes(10))
    seedToday({ 'x.com': minutes(500) }, new Date(2026, 5, 9, 12))
    await mount()
    expect(isBlocked()).toBe(false)
  })

  it('names the site, not the global cap, when both are exceeded', async () => {
    seedLimits({ global: 20, perSite: { 'reddit.com': 15 } })
    logged('reddit.com', minutes(16))
    logged('x.com', minutes(10))
    await mount()
    expect(normText(screen().querySelector('.site .name'))).toBe('reddit.com')
    expect(normText(screen().querySelector('.used'))).toBe('16 min today · 1 min over')
  })

  it('fails open when limits cannot be read', async () => {
    seedLimits({ perSite: { 'reddit.com': 1 } })
    logged('reddit.com', minutes(5))
    browser.storage.local.error = 'storage unavailable'
    await mount()
    expect(isBlocked()).toBe(false)
  })

  it('locks page scrolling only while blocked', async () => {
    seedLimits({ perSite: { 'reddit.com': 1 } })
    logged('reddit.com', minutes(5))
    await mount()
    expect(document.documentElement.style.getPropertyValue('overflow-y')).toBe('hidden')
    seedLimits({ perSite: {} })
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
    seedLimits({ perSite: { 'reddit.com': 30 } })
    await flush()
    expect(isBlocked()).toBe(true)
  })

  it('lifts the block when the limit is raised or removed', async () => {
    seedLimits({ global: 30 })
    logged('reddit.com', minutes(45))
    await mount()
    expect(isBlocked()).toBe(true)
    seedLimits({ global: 60 })
    await flush()
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
    seedLimits({ perSite: { 'reddit.com': 30 } })
    logged('reddit.com', minutes(30))
  })

  it('offers five more minutes, then blocks again', async () => {
    const blocker = await mount()
    expect(normText(holdButton())).toBe('Hold for 5 more minutes')
    await snooze()
    expect(isBlocked()).toBe(false)
    expect(browser.storage.local.data[LIMITS_KEY]).toMatchObject({ snoozeUntil: Date.now() + SNOOZE_MS })

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
    seedLimits({ perSite: { 'reddit.com': 30 }, snoozeUntil: Date.now() + SNOOZE_MS })
    await flush()
    expect(isBlocked()).toBe(false)
  })

  it('honours a snooze already running when the page loads', async () => {
    seedLimits({ perSite: { 'reddit.com': 30 }, snoozeUntil: Date.now() + 60_000 })
    await mount()
    expect(isBlocked()).toBe(false)
  })
})

describe('block screen', () => {
  beforeEach(() => {
    seedLimits({ perSite: { 'reddit.com': 1 } })
    logged('reddit.com', minutes(2))
  })

  it('is an alert dialog in a closed shadow root', async () => {
    await mount()
    expect(host().shadowRoot).toBeNull()
    const dialog = screen().querySelector('.screen')!
    expect(dialog.getAttribute('role')).toBe('alertdialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(screen().getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe("Time's up")
    expect(screen().getElementById(dialog.getAttribute('aria-describedby')!)).toBe(screen().querySelector('.used'))
  })

  it('opens Settings', async () => {
    await mount()
    const settings = screen().querySelector('.settings')
    expect(settings?.textContent).toBe('Settings')
    click(settings)
    await flush()
    expect(browser.runtime.openOptionsPage).toHaveBeenCalledOnce()
  })

  it('opens the activity page in a new tab and stays blocked', async () => {
    await mount()
    const activity = screen().querySelector('.activity')
    expect(activity?.textContent).toBe('See activity')
    click(activity)
    await flush()
    expect(browser.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://tabtimer-test/usage.html' })
    expect(isBlocked()).toBe(true)
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
    seedLimits({ perSite: { 'reddit.com': 1 } })
    await flush()
    expect(document.getElementById('tabtimer-block')).toBeNull()
  })

  it('is a modal dialog shown in the top layer', async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    await mount()
    expect(showModal).toHaveBeenCalledOnce()
    const dialog = screen().querySelector<HTMLDialogElement>('dialog.screen')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    // showModal(), not show(): the e2e suite checks :modal in Chromium.
    expect(dialog.open).toBe(true)
  })

  it('moves focus to Close tab when it appears, its ring showing', async () => {
    await mount()
    expect(screen().activeElement).toBe(closeButton())
    // Focus inside a closed shadow root retargets to its host.
    expect(document.activeElement).toBe(host())
    // happy-dom never matches :focus-visible: the ring comes by class, and
    // goes with a pointer press or when focus moves.
    expect(closeButton()!.classList.contains('is-focus')).toBe(true)
    screen()
      .querySelector('dialog')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(closeButton()!.classList.contains('is-focus')).toBe(false)
  })

  it('closes the tab through the worker from Close tab', async () => {
    await mount()
    expect(normText(closeButton())).toBe('Close tab')
    click(closeButton())
    await flush()
    expect(browser.tabs.remove).toHaveBeenCalledOnce()
    expect(isBlocked()).toBe(true)
  })

  it('pulls focus back when something on the page takes it', async () => {
    const pageLink = page('a')
    pageLink.href = '#'
    await mount()
    pageLink.focus()
    expect(document.activeElement).toBe(host())
    expect(screen().activeElement).toBe(closeButton())
  })

  it('cycles Tab and Shift+Tab through its buttons', async () => {
    await mount()
    const settings = screen().querySelector<HTMLButtonElement>('.settings')!
    const activity = screen().querySelector<HTMLButtonElement>('.activity')!
    const seen: (Element | null)[] = []
    for (const shiftKey of [false, false, false, false, true, true]) {
      const tab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
      screen().activeElement!.dispatchEvent(tab)
      expect(tab.defaultPrevented).toBe(true)
      seen.push(screen().activeElement)
    }
    expect(seen).toEqual([holdButton(), settings, activity, closeButton(), activity, settings])
  })

  it('leaves other keys alone', async () => {
    await mount()
    const key = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    closeButton()!.dispatchEvent(key)
    expect(key.defaultPrevented).toBe(false)
    expect(screen().activeElement).toBe(closeButton())
  })

  it('cannot be dismissed with Escape', async () => {
    await mount()
    const dialog = screen().querySelector<HTMLDialogElement>('dialog')!
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    closeButton()!.dispatchEvent(esc)
    expect(esc.defaultPrevented).toBe(true)
    const cancel = new Event('cancel', { cancelable: true })
    dialog.dispatchEvent(cancel)
    expect(cancel.defaultPrevented).toBe(true)
    expect(dialog.open).toBe(true)
  })

  it('reopens if the browser closes it while still blocked', async () => {
    await mount()
    const dialog = screen().querySelector<HTMLDialogElement>('dialog')!
    dialog.close()
    await flush()
    expect(dialog.open).toBe(true)
    expect(isBlocked()).toBe(true)
    expect(screen().activeElement).toBe(closeButton())
  })

  it('still shows if showModal is refused', async () => {
    // e.g. the page detached the host element.
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {
      throw new DOMException('not connected', 'InvalidStateError')
    })
    await mount()
    expect(isBlocked()).toBe(true)
    expect(screen().querySelector('dialog')!.hasAttribute('open')).toBe(true)
    expect(screen().activeElement).toBe(closeButton())
  })

  it('gives focus back to the page when dismissed', async () => {
    const pageButton = page('button')
    pageButton.focus()
    await mount()
    expect(document.activeElement).toBe(host())
    await snooze()
    expect(document.activeElement).toBe(pageButton)
    expect(screen().querySelector<HTMLDialogElement>('dialog')!.open).toBe(false)
  })

  it('gives focus back on destroy too, and skips an element that is gone', async () => {
    const pageButton = page('button')
    pageButton.focus()
    const blocker = await mount()
    blocker.destroy()
    expect(document.activeElement).toBe(pageButton)

    const gone = page('button')
    gone.focus()
    await mount()
    gone.remove()
    await snooze()
    expect(document.activeElement).not.toBe(gone)
  })

  it('takes the snooze length from SNOOZE_MS', async () => {
    await mount()
    expect(normText(holdButton())).toBe(`Hold for ${SNOOZE_MS / 60_000} more minutes`)
  })
})

describe('what it shows', () => {
  // Half an hour at 10, 40 min in this hour (noon) against a 1 h limit.
  beforeEach(() => {
    browser.storage.local.seed({
      'day:2026-06-10': { 'reddit.com': bucketsOf({ 10: minutes(30), 12: minutes(40) }), 'x.com': bucketsOf({ 9: 1 }) },
    })
    seedLimits({ perSite: { 'reddit.com': 60 } })
  })

  it('sums up today as the worker counts it: the time, and the time over', async () => {
    await mount()
    expect(isBlocked()).toBe(true)
    expect(normText(screen().querySelector('.used'))).toBe('1 h 10 min today · 10 min over')
    expect(normText(screen().querySelector('.used .over-ink'))).toBe('10 min over')
  })

  it('charts today by hour: grey within the limit, the overage capped, the limit named, now marked', async () => {
    await mount()
    const chart = screen().querySelector('.chart')!
    expect(chart.getAttribute('role')).toBe('img')
    expect(chart.getAttribute('aria-label')).toBe('Today on reddit.com, by hour')
    const col = (hour: number) => chart.querySelector(`[data-hour="${hour}"]`)!
    expect(chart.querySelectorAll('[data-hour]')).toHaveLength(24)
    expect(chart.querySelectorAll('[data-now]')).toEqual(expect.objectContaining({ length: 1 }))
    expect(col(12).hasAttribute('data-now')).toBe(true)
    // Hour 10 within the limit; noon crosses it.
    expect([...col(10).querySelectorAll('.seg')].map((el) => el.getAttribute('data-part'))).toEqual(['within'])
    expect([...col(12).querySelectorAll('.seg')].map((el) => el.getAttribute('data-part'))).toEqual(['within', 'over'])
    expect(normText(col(12).querySelector('.tick-label'))).toBe('1 h')
    expect(chart.querySelectorAll('.tick')).toHaveLength(1)
    expect([...chart.querySelectorAll('.val')].map(normText)).toEqual(['30m', '40m'])
    const axis = [...chart.querySelectorAll('.axis span')].map(normText)
    expect(axis.at(-1)).toBe('Now')
    // Noon gives way to Now beside it.
    expect(axis).toHaveLength(4)
    expect(chart.querySelector('.axis .now')?.getAttribute('style')).toContain('--h: 12')
  })

  it('counts the time a snooze took when it blocks again', async () => {
    const blocker = await mount()
    await snooze()
    expect(isBlocked()).toBe(false)
    await vi.advanceTimersByTimeAsync(SNOOZE_MS)
    blocker.tick()
    await flush()
    expect(isBlocked()).toBe(true)
    expect(normText(screen().querySelector('.used'))).toBe('1 h 15 min today · 15 min over')
    // Back at rest.
    expect(holdButton()!.className).toBe('btn hold')
  })

  it('redraws only when what it shows changes', async () => {
    const blocker = await mount()
    const plot = screen().querySelector('.plot')
    blocker.tick()
    expect(screen().querySelector('.plot')).toBe(plot)
  })
})

describe('summary line', () => {
  it('is the time alone when not over', async () => {
    seedLimits({ perSite: { 'reddit.com': 30 } })
    logged('reddit.com', minutes(30))
    await mount()
    expect(normText(screen().querySelector('.used'))).toBe('30 min today')
    expect(screen().querySelector('.used .over-ink')).toBeNull()
  })
})

describe('media behind the block screen', () => {
  beforeEach(() => {
    seedLimits({ perSite: { 'reddit.com': 1 } })
    logged('reddit.com', minutes(2))
  })

  // happy-dom media never plays; fake a playing element whose pause() works.
  function playing(media: HTMLMediaElement): HTMLMediaElement {
    let paused = false
    Object.defineProperty(media, 'paused', { configurable: true, get: () => paused })
    vi.spyOn(media as HTMLMediaElement, 'pause').mockImplementation(() => {
      paused = true
    })
    return media
  }

  it('pauses playing video and audio', async () => {
    const video = playing(page('video'))
    const audio = playing(page('audio'))
    const idle = page('video')
    const idlePause = vi.spyOn(idle, 'pause')
    await mount()
    expect(video.pause).toHaveBeenCalledOnce()
    expect(audio.pause).toHaveBeenCalledOnce()
    expect(idlePause).not.toHaveBeenCalled()
  })

  it('keeps media paused while blocked, and does not resume it after', async () => {
    const video = playing(page('video'))
    await mount()
    video.dispatchEvent(new Event('play'))
    expect(video.pause).toHaveBeenCalledTimes(2)

    await snooze()
    expect(video.paused).toBe(true)
    // Once dismissed, the page may play again.
    video.dispatchEvent(new Event('play'))
    expect(video.pause).toHaveBeenCalledTimes(2)
  })

  it('ignores play events from non-media elements', async () => {
    await mount()
    expect(() => document.body.dispatchEvent(new Event('play'))).not.toThrow()
  })

  it('pauses media inside the page’s shadow roots, and keeps it paused', async () => {
    const outer = page('div').attachShadow({ mode: 'open' })
    const inner = outer.appendChild(document.createElement('div')).attachShadow({ mode: 'open' })
    const video = playing(inner.appendChild(document.createElement('video')))
    const blocker = await mount()
    expect(video.pause).toHaveBeenCalledOnce()
    // play doesn't leave the shadow root; the root's own listener sees it.
    video.dispatchEvent(new Event('play'))
    expect(video.pause).toHaveBeenCalledTimes(2)

    // A player added while blocked is paused on the next tick.
    const late = playing(outer.appendChild(document.createElement('audio')))
    blocker.tick()
    expect(late.pause).toHaveBeenCalledOnce()

    await snooze()
    video.dispatchEvent(new Event('play'))
    expect(video.pause).toHaveBeenCalledTimes(2)
  })

  it('pauses media in a same-origin frame', async () => {
    // happy-dom loads no frames; give this one a document of its own.
    const doc = document.implementation.createHTMLDocument()
    // (A <frame>: an <iframe> would log happy-dom's refusal to load it.)
    const frame = document.createElement('frame')
    document.body.append(frame)
    pageElements.push(frame)
    Object.defineProperty(frame, 'contentDocument', { value: doc })
    const audio = playing(doc.body.appendChild(doc.createElement('audio')))
    await mount()
    expect(audio.pause).toHaveBeenCalledOnce()
    audio.dispatchEvent(new Event('play'))
    expect(audio.pause).toHaveBeenCalledTimes(2)
  })
})

describe('staying on the page', () => {
  beforeEach(() => {
    seedLimits({ perSite: { 'reddit.com': 1 } })
    logged('reddit.com', minutes(2))
  })

  it('mounts outside <body>, so a page replacing it keeps the block screen', async () => {
    await mount()
    expect(host().parentNode).toBe(document.documentElement)
    document.body.replaceWith(document.createElement('body'))
    expect(host().isConnected).toBe(true)
    expect(isBlocked()).toBe(true)
  })

  it('puts itself back, on top, when the page removes it', async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    const blocker = await mount()
    host().remove()
    blocker.tick()
    expect(document.getElementById('tabtimer-block')?.parentNode).toBe(document.documentElement)
    expect(showModal).toHaveBeenCalledTimes(2)
    expect(screen().activeElement).toBe(closeButton())
    // Nothing else changed: no further raise.
    blocker.tick()
    expect(showModal).toHaveBeenCalledTimes(2)
  })

  it('locks scrolling on a <body> the page swaps in while blocked', async () => {
    const blocker = await mount()
    const fresh = document.createElement('body')
    fresh.style.setProperty('overflow', 'auto')
    document.body.replaceWith(fresh)
    blocker.tick()
    expect(fresh.style.getPropertyValue('overflow-y')).toBe('hidden')
    expect(fresh.style.getPropertyPriority('overflow-y')).toBe('important')
    await snooze()
    expect(fresh.style.getPropertyValue('overflow')).toBe('auto')
    expect(fresh.style.getPropertyPriority('overflow')).toBe('')
  })
})

describe('staying on top', () => {
  // happy-dom has no top layer: stand in for :modal / :popover-open.
  let topLayer: Element[]

  beforeEach(() => {
    seedLimits({ perSite: { 'reddit.com': 1 } })
    logged('reddit.com', minutes(2))
    topLayer = []
    const matches = Element.prototype.matches
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':modal, :popover-open' ? topLayer.includes(this) : matches.call(this, selector)
    })
    const query = document.querySelectorAll.bind(document)
    vi.spyOn(document, 'querySelectorAll').mockImplementation((selector: string) =>
      selector === ':modal, :popover-open' ? (topLayer as never) : query(selector)
    )
  })

  it('raises itself above a page dialog or popover opened over it', async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    const blocker = await mount()
    expect(showModal).toHaveBeenCalledTimes(1)

    // Found on the next tick (it may sit in a shadow root, where toggle events
    // don't reach the document).
    topLayer.push(page('dialog'))
    blocker.tick()
    expect(showModal).toHaveBeenCalledTimes(2)
    expect(screen().activeElement).toBe(closeButton())
    // Now below the block screen: left alone.
    blocker.tick()
    expect(showModal).toHaveBeenCalledTimes(2)

    // A popover's toggle event raises it at once.
    const popover = page('div')
    topLayer.push(popover)
    popover.dispatchEvent(new Event('toggle'))
    expect(showModal).toHaveBeenCalledTimes(3)
    popover.dispatchEvent(new Event('toggle'))
    blocker.tick()
    expect(showModal).toHaveBeenCalledTimes(3)
  })

  it('leaves alone what was open before it blocked, and what closes', async () => {
    const open = page('div')
    topLayer.push(open)
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    const blocker = await mount()
    blocker.tick()
    expect(showModal).toHaveBeenCalledTimes(1)
    topLayer.splice(0)
    open.dispatchEvent(new Event('toggle'))
    blocker.tick()
    expect(showModal).toHaveBeenCalledTimes(1)
  })

  it('raises itself when a page dialog takes focus it can’t take back', async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    await mount()
    const dialogButton = page('button')
    // The page's modal dialog makes the block screen inert.
    const focus = vi.spyOn(closeButton()!, 'focus').mockImplementation(() => undefined)
    dialogButton.focus()
    // Raised once the page's script is done.
    expect(showModal).toHaveBeenCalledTimes(1)
    await flush()
    expect(showModal).toHaveBeenCalledTimes(2)
    focus.mockRestore()

    // Focus it can take back: no raise.
    page('button').focus()
    await flush()
    expect(showModal).toHaveBeenCalledTimes(2)
    expect(document.activeElement).toBe(host())
  })
})

describe('fullscreen', () => {
  let fullscreenElement: Element | null
  let exitFullscreen: ReturnType<typeof vi.fn<() => Promise<void>>>

  beforeEach(() => {
    seedLimits({ perSite: { 'reddit.com': 1 } })
    logged('reddit.com', minutes(2))
    fullscreenElement = null
    exitFullscreen = vi.fn(() => {
      fullscreenElement = null
      return Promise.resolve()
    })
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement })
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exitFullscreen })
  })

  afterEach(() => {
    delete (document as { fullscreenElement?: unknown }).fullscreenElement
    delete (document as { exitFullscreen?: unknown }).exitFullscreen
  })

  it('leaves fullscreen when it blocks', async () => {
    fullscreenElement = page('video')
    await mount()
    expect(exitFullscreen).toHaveBeenCalledOnce()
  })

  it('leaves fullscreen again if the page re-enters it while blocked', async () => {
    await mount()
    expect(exitFullscreen).not.toHaveBeenCalled()
    fullscreenElement = page('div')
    document.dispatchEvent(new Event('fullscreenchange'))
    expect(exitFullscreen).toHaveBeenCalledOnce()
    // The exit's own fullscreenchange finds nothing in fullscreen.
    document.dispatchEvent(new Event('fullscreenchange'))
    expect(exitFullscreen).toHaveBeenCalledOnce()
  })

  it('swallows a refused exit', async () => {
    exitFullscreen.mockImplementation(() => Promise.reject(new TypeError('not allowed')))
    fullscreenElement = page('div')
    await mount()
    await flush()
    expect(isBlocked()).toBe(true)
  })

  it('lets the page go fullscreen once dismissed', async () => {
    await mount()
    await snooze()
    fullscreenElement = page('div')
    document.dispatchEvent(new Event('fullscreenchange'))
    expect(exitFullscreen).not.toHaveBeenCalled()
  })
})

describe('page scroll lock', () => {
  const style = () => document.documentElement.style

  beforeEach(() => {
    seedLimits({ perSite: { 'reddit.com': 1 } })
    logged('reddit.com', minutes(2))
  })

  afterEach(() => {
    document.documentElement.removeAttribute('style')
    document.body.removeAttribute('style')
  })

  it('restores the page’s own inline overflow and its priority', async () => {
    style().setProperty('overflow', 'scroll', 'important')
    await mount()
    expect(style().getPropertyValue('overflow-y')).toBe('hidden')
    await snooze()
    expect(style().getPropertyValue('overflow')).toBe('scroll')
    expect(style().getPropertyPriority('overflow')).toBe('important')
  })

  it('restores a non-important inline overflow as non-important', async () => {
    style().setProperty('overflow', 'auto')
    const blocker = await mount()
    blocker.destroy()
    expect(style().getPropertyValue('overflow')).toBe('auto')
    expect(style().getPropertyPriority('overflow')).toBe('')
  })

  it('restores per-axis overflow', async () => {
    style().setProperty('overflow-y', 'scroll', 'important')
    await mount()
    await snooze()
    expect(style().getPropertyValue('overflow-y')).toBe('scroll')
    expect(style().getPropertyPriority('overflow-y')).toBe('important')
    expect(style().getPropertyValue('overflow-x')).toBe('')
  })

  it('leaves the page’s overflow alone if it never blocked', async () => {
    seedLimits({ perSite: {} })
    style().setProperty('overflow', 'clip')
    const blocker = await mount()
    expect(isBlocked()).toBe(false)
    // The page changes its own overflow; tearing down must not undo that.
    style().setProperty('overflow', 'scroll')
    blocker.destroy()
    expect(style().getPropertyValue('overflow')).toBe('scroll')
  })

  it('does not restore twice', async () => {
    const blocker = await mount()
    await snooze()
    style().setProperty('overflow', 'scroll')
    blocker.destroy()
    expect(style().getPropertyValue('overflow')).toBe('scroll')
  })
  it('hides overflow on <body> too, and restores the body’s own', async () => {
    const body = document.body.style
    body.setProperty('overflow-y', 'auto', 'important')
    await mount()
    expect(body.getPropertyValue('overflow-y')).toBe('hidden')
    expect(body.getPropertyPriority('overflow-y')).toBe('important')
    await snooze()
    expect(body.getPropertyValue('overflow-y')).toBe('auto')
    expect(body.getPropertyPriority('overflow-y')).toBe('important')
    expect(body.getPropertyValue('overflow-x')).toBe('')
  })

  it('clears the body’s overflow again when it had none', async () => {
    const blocker = await mount()
    blocker.destroy()
    expect(document.body.getAttribute('style') ?? '').toBe('')
  })

  it('keeps an overflow the page set while blocked', async () => {
    style().setProperty('overflow', 'auto')
    await mount()
    document.body.style.setProperty('overflow', 'clip')
    await snooze()
    expect(style().getPropertyValue('overflow')).toBe('auto')
    expect(document.body.style.getPropertyValue('overflow')).toBe('clip')
  })

  it('P3: restores the axis the page left alone when it changed the other while blocked', async () => {
    await mount()
    style().overflowX = 'auto'
    await snooze()
    expect(style().getPropertyValue('overflow-x')).toBe('auto')
    expect(style().getPropertyValue('overflow-y')).toBe('')
  })

  it('puts the window back where it was on dismissal', async () => {
    await mount()
    const scrollTo = vi.spyOn(window, 'scrollTo')
    // Hiding overflow clamped the window's offset while blocked.
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 500 })
    try {
      await snooze()
      expect(scrollTo).toHaveBeenCalledWith({ left: 0, top: 0, behavior: 'instant' })
    } finally {
      delete (window as { scrollY?: number }).scrollY
      scrollTo.mockRestore()
    }
  })
})
