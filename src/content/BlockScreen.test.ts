// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://old.reddit.com/r/all"}
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import BlockScreen from './BlockScreen'
import FocusTracker from './FocusTracker'
import { bus } from '../chrome/bus'
import { SNOOZE_MS } from '../core/limits'
import { LIMITS_KEY } from '../core/schema'
import { fakeChrome, type FakeChrome } from '../test/chrome'
import { click, flush, normText, trackShadowRoots } from '../test/dom'
import {
  disposeTrackers,
  isBlocked,
  minutes,
  seedLimits,
  seedToday,
  startBackground,
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
const snoozeButton = () => screen().querySelector<HTMLButtonElement>('.snooze')

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
  await startBackground()
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
    expect(normText(screen().querySelector('.title'))).toBe("Time's up")
    expect(normText(screen().querySelector('.host'))).toBe('reddit.com')
    expect(normText(screen().querySelector('.detail'))).toBe('00:30:00 today · 00:30:00 limit')
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
    expect(normText(screen().querySelector('.host'))).toBe('all tracked sites')
    expect(normText(screen().querySelector('.detail'))).toBe('01:00:00 today · 01:00:00 limit')
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
    expect(normText(screen().querySelector('.host'))).toBe('reddit.com')
    expect(normText(screen().querySelector('.detail'))).toBe('00:16:00 today · 00:15:00 limit')
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
    expect(document.documentElement.style.getPropertyValue('overflow')).toBe('hidden')
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

  it('lifts the block when today is reset from the popup', async () => {
    seedLimits({ perSite: { 'reddit.com': 30 } })
    logged('reddit.com', minutes(45))
    const blocker = await mount()
    expect(isBlocked()).toBe(true)
    browser.sender = { id: browser.runtime.id, url: browser.runtime.getURL('popup.html') }
    await bus.send('resetToday', { site: 'reddit.com' })
    browser.sender = null
    await flush()
    blocker.tick()
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
    expect(normText(screen().querySelector('.snooze'))).toBe('5 more minutes')
    click(snoozeButton())
    expect(isBlocked()).toBe(false)
    await flush()
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

  it('moves focus to the snooze button when it appears', async () => {
    await mount()
    expect(screen().activeElement).toBe(snoozeButton())
    // Focus inside a closed shadow root retargets to its host.
    expect(document.activeElement).toBe(host())
  })

  it('pulls focus back when something on the page takes it', async () => {
    const pageLink = page('a')
    pageLink.href = '#'
    await mount()
    pageLink.focus()
    expect(document.activeElement).toBe(host())
    expect(screen().activeElement).toBe(snoozeButton())
  })

  it('cycles Tab and Shift+Tab through its buttons', async () => {
    await mount()
    const manage = screen().querySelector<HTMLButtonElement>('.manage')!
    const activity = screen().querySelector<HTMLButtonElement>('.activity')!
    const seen: (Element | null)[] = []
    for (const shiftKey of [false, false, false, true, true]) {
      const tab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
      screen().activeElement!.dispatchEvent(tab)
      expect(tab.defaultPrevented).toBe(true)
      seen.push(screen().activeElement)
    }
    expect(seen).toEqual([activity, manage, snoozeButton(), manage, activity])
  })

  it('leaves other keys alone', async () => {
    await mount()
    const key = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    snoozeButton()!.dispatchEvent(key)
    expect(key.defaultPrevented).toBe(false)
    expect(screen().activeElement).toBe(snoozeButton())
  })

  it('cannot be dismissed with Escape', async () => {
    await mount()
    const dialog = screen().querySelector<HTMLDialogElement>('dialog')!
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    snoozeButton()!.dispatchEvent(esc)
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
    expect(screen().activeElement).toBe(snoozeButton())
  })

  it('still shows if showModal is refused', async () => {
    // e.g. the page detached the host element.
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {
      throw new DOMException('not connected', 'InvalidStateError')
    })
    await mount()
    expect(isBlocked()).toBe(true)
    expect(screen().querySelector('dialog')!.hasAttribute('open')).toBe(true)
    expect(screen().activeElement).toBe(snoozeButton())
  })

  it('gives focus back to the page when dismissed', async () => {
    const pageButton = page('button')
    pageButton.focus()
    await mount()
    expect(document.activeElement).toBe(host())
    click(snoozeButton())
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
    click(snoozeButton())
    expect(document.activeElement).not.toBe(gone)
  })

  it('takes the snooze length from SNOOZE_MS', async () => {
    await mount()
    expect(normText(screen().querySelector('.snooze'))).toBe(`${SNOOZE_MS / 60_000} more minutes`)
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

    click(snoozeButton())
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

    click(snoozeButton())
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
    expect(screen().activeElement).toBe(snoozeButton())
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
    expect(fresh.style.getPropertyValue('overflow')).toBe('hidden')
    expect(fresh.style.getPropertyPriority('overflow')).toBe('important')
    click(snoozeButton())
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
    expect(screen().activeElement).toBe(snoozeButton())
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
    const focus = vi.spyOn(snoozeButton()!, 'focus').mockImplementation(() => undefined)
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
    click(snoozeButton())
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
    expect(style().getPropertyValue('overflow')).toBe('hidden')
    click(snoozeButton())
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
    click(snoozeButton())
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
    click(snoozeButton())
    style().setProperty('overflow', 'scroll')
    blocker.destroy()
    expect(style().getPropertyValue('overflow')).toBe('scroll')
  })
  it('hides overflow on <body> too, and restores the body’s own', async () => {
    const body = document.body.style
    body.setProperty('overflow-y', 'auto', 'important')
    await mount()
    expect(body.getPropertyValue('overflow')).toBe('hidden')
    expect(body.getPropertyPriority('overflow')).toBe('important')
    click(snoozeButton())
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
    click(snoozeButton())
    expect(style().getPropertyValue('overflow')).toBe('auto')
    expect(document.body.style.getPropertyValue('overflow')).toBe('clip')
  })

  it('puts the window back where it was on dismissal', async () => {
    await mount()
    const scrollTo = vi.spyOn(window, 'scrollTo')
    // Hiding overflow clamped the window's offset while blocked.
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 500 })
    try {
      click(snoozeButton())
      expect(scrollTo).toHaveBeenCalledWith({ left: 0, top: 0, behavior: 'instant' })
    } finally {
      delete (window as { scrollY?: number }).scrollY
      scrollTo.mockRestore()
    }
  })
})
