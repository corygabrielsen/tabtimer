// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=1"}
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Overlay from './Overlay'
import FocusTracker from './FocusTracker'
import { PREFS_KEY } from '../core/schema'
import { fakeChrome, type FakeChrome } from '../test/chrome'
import { click, flush, setPageState, trackShadowRoots } from '../test/dom'
import {
  disposeTrackers,
  minutes,
  seconds,
  seedToday,
  startBackground,
  EVERY_HOST,
  trackTracker,
  useClock,
} from '../test/content'

let browser: FakeChrome
const prefs = () => browser.storage.local.data[PREFS_KEY] as { hidden: boolean; scale: number }
let shadowOf: (id: string) => ShadowRoot
const views: Overlay[] = []

async function mount(): Promise<Overlay> {
  const model = trackTracker(new FocusTracker())
  model.start()
  const view = new Overlay(model)
  views.push(view)
  await flush()
  return view
}

const root = () => shadowOf('tabtimer-root')
const pill = () => root().querySelector<HTMLButtonElement>('.pill')
const rows = () => [...root().querySelectorAll<HTMLButtonElement>('.row')]
const button = (cls: string, label: string) =>
  [...root().querySelectorAll<HTMLButtonElement>(cls)].find((b) => b.getAttribute('aria-label') === label)!
const smaller = () => button('.size', 'Make Tab Timer smaller')
const larger = () => button('.size', 'Make Tab Timer larger')
const transform = () => document.getElementById('tabtimer-root')!.style.getPropertyValue('transform')

async function tickView(view: Overlay, ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  view.render()
  await flush()
}

beforeEach(async () => {
  browser = fakeChrome()
  await startBackground(EVERY_HOST)
  useClock(new Date(2026, 5, 10, 12, 0, 0))
  shadowOf = trackShadowRoots()
})

afterEach(() => {
  for (const v of views.splice(0)) {
    v.destroy()
  }
  disposeTrackers()
})

describe('collapsed pill', () => {
  it('shows today’s total for this site, including other tabs', async () => {
    seedToday({ 'youtube.com': minutes(62) + seconds(5) })
    await mount()
    expect(pill()?.textContent).toBe('01:02:05')
    expect(pill()?.getAttribute('aria-label')).toBe('Tab Timer — Today 01:02:05. Activate to expand.')
    expect(pill()?.getAttribute('aria-expanded')).toBe('false')
  })

  it('counts up as focus time accrues', async () => {
    const view = await mount()
    await tickView(view, seconds(3))
    expect(pill()?.textContent).toBe('00:00:03')
    // The accessible name keeps up with the visible time.
    expect(pill()?.getAttribute('aria-label')).toBe('Tab Timer — Today 00:00:03. Activate to expand.')
  })

  it('updates the same element in place rather than rebuilding each second', async () => {
    const view = await mount()
    const first = pill()
    await tickView(view, seconds(2))
    expect(pill()).toBe(first)
  })

  it('refreshes when the tab becomes visible or focused again', async () => {
    await mount()
    seedToday({ 'youtube.com': minutes(5) })
    setPageState({ hidden: true })
    setPageState({ hidden: false })
    await flush()
    expect(pill()?.textContent).toBe('00:05:00')
    seedToday({ 'youtube.com': minutes(6) })
    setPageState({ focused: false })
    setPageState({ focused: true })
    await flush()
    expect(pill()?.textContent).toBe('00:06:00')
  })
})

describe('expanded panel', () => {
  it('lists today, focus and session with their times and definitions', async () => {
    seedToday({ 'youtube.com': minutes(10) })
    const view = await mount()
    setPageState({ focused: false })
    await vi.advanceTimersByTimeAsync(seconds(4)) // session keeps counting
    click(pill())
    await flush()
    expect(rows().map((r) => [r.querySelector('.label')?.textContent, r.querySelector('.time')?.textContent])).toEqual([
      ['Today', '00:10:00'],
      ['Focus', '00:00:00'],
      ['Session', '00:00:04'],
    ])
    expect(rows()[0]?.title).toBe('Today on this site')
    expect(rows().map((r) => r.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false'])
    await tickView(view, seconds(1))
    expect(rows()[2]?.querySelector('.time')?.textContent).toBe('00:00:05')
  })

  it('selecting a timer collapses to a pill showing it', async () => {
    await mount()
    click(pill())
    await flush()
    click(rows()[2])
    await flush()
    expect(rows()).toHaveLength(0)
    expect(pill()?.getAttribute('aria-label')).toMatch(/^Tab Timer — Session \d\d:\d\d:\d\d\. Activate to expand\.$/)
    click(pill())
    await flush()
    expect(rows().map((r) => r.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true'])
  })

  it('collapses on an outside click or Escape, but not on clicks inside', async () => {
    await mount()
    click(pill())
    await flush()
    click(smaller())
    await flush()
    expect(rows()).toHaveLength(3)

    document.body.click()
    await flush()
    expect(rows()).toHaveLength(0)

    click(pill())
    await flush()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await flush()
    expect(rows()).toHaveLength(3)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flush()
    expect(rows()).toHaveLength(0)
  })
})

describe('P4: keyboard focus', () => {
  it('moves with the panel: to the selected row on expand, back to the pill on a choice or Escape', async () => {
    await mount()
    pill()!.focus()
    click(pill())
    await flush()
    expect(root().activeElement).toBe(rows()[0])
    rows()[2]!.focus()
    click(rows()[2])
    await flush()
    expect(root().activeElement).toBe(pill())
    click(pill())
    await flush()
    expect(root().activeElement).toBe(rows()[2])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flush()
    expect(root().activeElement).toBe(pill())
  })

  it('stays where it is when the panel closes from outside', async () => {
    await mount()
    const input = document.createElement('input')
    document.body.append(input)
    click(pill())
    await flush()
    input.focus()
    document.body.click()
    await flush()
    expect(rows()).toHaveLength(0)
    expect(document.activeElement).toBe(input)
    input.remove()
  })
})

describe('size controls', () => {
  it('shrinks in steps down to half size, persisting the choice', async () => {
    await mount()
    expect(transform()).toBe('translateX(-50%) scale(1)')
    click(pill())
    await flush()
    expect(larger().disabled).toBe(true)
    click(smaller())
    click(smaller())
    expect(transform()).toBe('translateX(-50%) scale(0.5)')
    expect(smaller().disabled).toBe(true)
    expect(larger().disabled).toBe(false)
    click(smaller()) // at the floor: no-op
    await flush()
    expect(prefs().scale).toBe(0.5)
    click(larger())
    await flush()
    expect(prefs().scale).toBe(0.75)
  })

  it('restores the saved size, snapping and clamping bad values', async () => {
    browser.storage.local.seed({ [PREFS_KEY]: { hidden: false, scale: 0.8 } })
    await mount()
    expect(transform()).toBe('translateX(-50%) scale(0.75)')
    browser.storage.local.seed({ [PREFS_KEY]: { hidden: false, scale: 0.1 } })
    await flush()
    expect(transform()).toBe('translateX(-50%) scale(0.5)')
    browser.storage.local.seed({ [PREFS_KEY]: { hidden: false, scale: 'huge' } })
    await flush()
    expect(transform()).toBe('translateX(-50%) scale(1)')
  })
})

describe('hiding', () => {
  it('hides everywhere from the close button', async () => {
    await mount()
    click(pill())
    await flush()
    click(button('.close', 'Hide Tab Timer on this page'))
    await flush()
    expect(root().querySelector('.widget')?.childElementCount).toBe(0)
    expect(prefs().hidden).toBe(true)
    // An outside click no longer does anything once hidden.
    document.body.click()
    await flush()
    expect(root().querySelector('.widget')?.childElementCount).toBe(0)
  })

  it('stays hidden on load when the preference is set', async () => {
    browser.storage.local.seed({ [PREFS_KEY]: { hidden: true, scale: 1 } })
    const view = await mount()
    await tickView(view, seconds(2))
    expect(pill()).toBeNull()
  })

  it('follows the preference when toggled from the popup', async () => {
    await mount()
    browser.storage.local.seed({ [PREFS_KEY]: { hidden: true, scale: 1 } })
    await flush()
    expect(pill()).toBeNull()
    browser.storage.local.seed({ [PREFS_KEY]: { hidden: false, scale: 1 } })
    await flush()
    expect(pill()).not.toBeNull()
  })

  it('keeps its own change when a state from before it arrives', async () => {
    let prefs = { hidden: false, scale: 1 }
    let notify = () => {}
    const view = new Overlay({
      readElapsed: () => ({ today: 0, focus: 0, session: 0 }),
      onState: (fn) => ((notify = fn), () => {}),
      get prefs() {
        return prefs
      },
    })
    views.push(view)
    click(pill())
    await flush()
    click(button('.close', 'Hide Tab Timer on this page'))
    notify()
    expect(pill()).toBeNull()
    // Then hidden is saved, and shown again from the popup.
    prefs = { hidden: true, scale: 1 }
    notify()
    prefs = { hidden: false, scale: 1 }
    notify()
    expect(pill()).not.toBeNull()
  })

  it('shows once the worker can answer again', async () => {
    browser.storage.local.error = 'storage unavailable'
    const view = await mount()
    // No state from the worker: nothing renders, but nothing throws.
    expect(pill()).toBeNull()
    browser.storage.local.error = null
    await tickView(view, seconds(10))
    expect(pill()?.textContent).toBe('00:00:00')
  })
})

describe('placement', () => {
  // happy-dom has no popover API; record the calls.
  let shown: Element[]
  beforeEach(() => {
    shown = []
    Object.defineProperty(HTMLElement.prototype, 'showPopover', {
      configurable: true,
      value(this: HTMLElement) {
        shown.push(this)
      },
    })
  })
  afterEach(() => {
    delete (HTMLElement.prototype as { showPopover?: unknown }).showPopover
  })

  const host = () => document.getElementById('tabtimer-root')!

  it('is a manual popover on <html>, in the top layer, where page transforms can’t move it', async () => {
    await mount()
    expect(host().parentNode).toBe(document.documentElement)
    expect(host().getAttribute('popover')).toBe('manual')
    expect(shown).toEqual([host()])
    // The browser's popover box undone.
    for (const prop of ['margin', 'padding', 'border', 'overflow', 'background']) {
      expect(host().style.getPropertyPriority(prop)).toBe('important')
    }
    expect(host().style.getPropertyValue('top')).toMatch(/^0(px)?$/)
    expect(host().style.getPropertyValue('left')).toBe('50%')
  })

  it('outlives the page replacing <body>, and puts itself back if removed', async () => {
    const view = await mount()
    document.body.replaceWith(document.createElement('body'))
    expect(host().isConnected).toBe(true)

    const el = host()
    el.remove()
    view.render()
    expect(el.parentNode).toBe(document.documentElement)
    expect(shown).toEqual([el, el])
    view.render()
    expect(shown).toHaveLength(2)
  })

  it('stays a fixed element where showPopover throws', async () => {
    Object.defineProperty(HTMLElement.prototype, 'showPopover', {
      configurable: true,
      value() {
        throw new DOMException('already showing', 'InvalidStateError')
      },
    })
    await mount()
    expect(host().style.getPropertyValue('position')).toBe('fixed')
  })
})

describe('lifecycle', () => {
  it('replaces a stale overlay instead of stacking duplicates', async () => {
    await mount()
    await mount()
    expect(document.querySelectorAll('#tabtimer-root')).toHaveLength(1)
  })

  it('removes itself and stops reacting on destroy', async () => {
    const view = await mount()
    view.destroy()
    expect(document.getElementById('tabtimer-root')).toBeNull()
    browser.storage.local.seed({ [PREFS_KEY]: { hidden: true, scale: 1 } })
    await flush()
    expect(document.getElementById('tabtimer-root')).toBeNull()
  })
})
