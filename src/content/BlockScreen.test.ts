// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://old.reddit.com/r/all"}
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import BlockScreen from './BlockScreen'
import FocusTracker from './FocusTracker'
import { bus } from '../chrome/bus'
import { SNOOZE_MS, type Limits } from '../core/limits'
import { LIMITS_KEY, SNOOZE_KEY } from '../core/schema'
import { fakeChrome, type FakeChrome } from '../test/chrome'
import { click, flush, text, trackShadowRoots } from '../test/dom'
import { disposeTrackers, minutes, seedToday, startBackground, trackTracker, useClock } from '../test/content'

const NOON = new Date(2026, 5, 10, 12, 0, 0)

let browser: FakeChrome
let shadowOf: (id: string) => ShadowRoot
const blockers: BlockScreen[] = []

function limits(l: Partial<Limits>): void {
  browser.storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: {}, ...l } })
}

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
const isBlocked = () => host().style.getPropertyValue('display') === 'block'
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
    seedToday({ 'x.com': minutes(500) }, new Date(2026, 5, 9, 12))
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
    limits({ perSite: { 'reddit.com': minutes(30) } })
    logged('reddit.com', minutes(30))
  })

  it('offers five more minutes, then blocks again', async () => {
    const blocker = await mount()
    expect(text(screen(), '.snooze')).toBe('5 more minutes')
    click(snoozeButton())
    expect(isBlocked()).toBe(false)
    await flush()
    expect(browser.storage.local.data[SNOOZE_KEY]).toBe(Date.now() + SNOOZE_MS)

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
    browser.storage.local.seed({ [SNOOZE_KEY]: Date.now() + SNOOZE_MS })
    await flush()
    expect(isBlocked()).toBe(false)
  })

  it('honours a snooze already running when the page loads', async () => {
    browser.storage.local.seed({ [SNOOZE_KEY]: Date.now() + 60_000 })
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
    limits({ perSite: { 'reddit.com': minutes(1) } })
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
    expect(text(screen(), '.snooze')).toBe(`${SNOOZE_MS / 60_000} more minutes`)
  })
})

describe('media behind the block screen', () => {
  beforeEach(() => {
    limits({ perSite: { 'reddit.com': minutes(1) } })
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
})

describe('fullscreen', () => {
  let fullscreenElement: Element | null
  let exitFullscreen: ReturnType<typeof vi.fn<() => Promise<void>>>

  beforeEach(() => {
    limits({ perSite: { 'reddit.com': minutes(1) } })
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
    limits({ perSite: { 'reddit.com': minutes(1) } })
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
    limits({ perSite: {} })
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
})

describe('scroll input while blocked', () => {
  beforeEach(() => {
    limits({ perSite: { 'reddit.com': minutes(1) } })
    logged('reddit.com', minutes(2))
  })

  afterEach(() => {
    document.documentElement.removeAttribute('style')
    document.body.removeAttribute('style')
  })

  // Dispatch a cancelable event at `target` and report whether it was prevented.
  function prevented(event: Event, target: EventTarget = document.body): boolean {
    target.dispatchEvent(event)
    return event.defaultPrevented
  }
  const wheel = (init: WheelEventInit = {}) => {
    const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
    // happy-dom drops modifier keys from WheelEventInit.
    Object.defineProperty(e, 'ctrlKey', { value: init.ctrlKey ?? false })
    return e
  }
  const touchmove = () => new Event('touchmove', { bubbles: true, cancelable: true })
  const key = (k: string, init: KeyboardEventInit = {}) =>
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, composed: true, ...init })
  const mousedown = (button: number) => new MouseEvent('mousedown', { button, bubbles: true, cancelable: true })
  const SCROLL_KEYS = [' ', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']

  it('swallows wheel, touch, scroll keys, and middle-click autoscroll', async () => {
    await mount()
    expect(isBlocked()).toBe(true)
    expect(prevented(wheel({ deltaY: 100 }))).toBe(true)
    expect(prevented(touchmove())).toBe(true)
    expect(prevented(mousedown(1))).toBe(true)
    for (const k of SCROLL_KEYS) {
      expect(prevented(key(k)), k).toBe(true)
    }
  })

  it('leaves other input alone', async () => {
    await mount()
    expect(prevented(mousedown(0))).toBe(false)
    expect(prevented(key('a'))).toBe(false)
    // Zoom, and history navigation.
    expect(prevented(wheel({ deltaY: 100, ctrlKey: true }))).toBe(false)
    expect(prevented(key('ArrowLeft', { altKey: true }))).toBe(false)
    expect(prevented(key('ArrowRight', { metaKey: true }))).toBe(false)
  })

  it('lets Space press a block screen button', async () => {
    await mount()
    expect(screen().activeElement).toBe(snoozeButton())
    expect(prevented(key(' '), snoozeButton()!)).toBe(false)
    expect(prevented(key('PageDown'), snoozeButton()!)).toBe(true)
  })

  it('stops listening once dismissed', async () => {
    await mount()
    click(snoozeButton())
    expect(isBlocked()).toBe(false)
    expect(prevented(wheel({ deltaY: 100 }))).toBe(false)
    expect(prevented(touchmove())).toBe(false)
    expect(prevented(mousedown(1))).toBe(false)
    expect(prevented(key('PageDown'))).toBe(false)
  })

  it('stops listening once destroyed', async () => {
    const blocker = await mount()
    blocker.destroy()
    expect(prevented(wheel({ deltaY: 100 }))).toBe(false)
    expect(prevented(touchmove())).toBe(false)
    expect(prevented(key('End'))).toBe(false)
  })

  it('puts back an inner scroller that scrolls anyway', async () => {
    const scroller = page('div')
    scroller.scrollTop = 40
    const fresh = page('div')
    await mount()
    scroller.scrollTop = 300
    scroller.dispatchEvent(new Event('scroll'))
    expect(scroller.scrollTop).toBe(40)
    // One at the origin when blocking began goes back there.
    fresh.scrollTop = 50
    fresh.dispatchEvent(new Event('scroll'))
    expect(fresh.scrollTop).toBe(0)

    click(snoozeButton())
    scroller.scrollTop = 300
    scroller.dispatchEvent(new Event('scroll'))
    expect(scroller.scrollTop).toBe(300)
  })

  it('puts the window back if it scrolls anyway', async () => {
    await mount()
    const scrollTo = vi.spyOn(window, 'scrollTo')
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 500 })
    try {
      document.dispatchEvent(new Event('scroll'))
      expect(scrollTo).toHaveBeenCalledWith({ left: 0, top: 0, behavior: 'instant' })
      scrollTo.mockClear()
      // On dismissal too: hiding overflow can clamp the window's offset.
      click(snoozeButton())
      expect(scrollTo).toHaveBeenCalledWith({ left: 0, top: 0, behavior: 'instant' })
    } finally {
      delete (window as { scrollY?: number }).scrollY
      scrollTo.mockRestore()
    }
  })

  it('ignores scroll events from elsewhere', async () => {
    await mount()
    expect(() => window.dispatchEvent(new Event('scroll'))).not.toThrow()
  })
})
