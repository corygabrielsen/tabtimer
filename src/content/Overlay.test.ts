// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=1"}
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import View from './Overlay'
import Model from './FocusTracker'
import { HIDDEN_KEY, SCALE_KEY, todayKeyForHost } from '../storage'
import { fakeChrome, type FakeChrome } from '../test/chrome'
import { click, flush, setPageState, trackShadowRoots } from '../test/dom'
import { disposeModels, minutes, seconds, startBackground, trackModel, useClock } from '../test/content'

let browser: FakeChrome
let shadowOf: (id: string) => ShadowRoot
const views: View[] = []

async function mount(): Promise<View> {
  const model = trackModel(new Model())
  model.start()
  const view = new View(model)
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

async function tickView(view: View, ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  view.updateDisplayText()
  await flush()
}

beforeEach(async () => {
  browser = fakeChrome()
  await startBackground()
  useClock(new Date(2026, 5, 10, 12, 0, 0))
  shadowOf = trackShadowRoots()
})

afterEach(() => {
  for (const v of views.splice(0)) {
    v.destroy()
  }
  disposeModels()
})

describe('collapsed pill', () => {
  it('shows today’s total for this site, including other tabs', async () => {
    browser.storage.local.seed({ [todayKeyForHost('youtube.com')]: minutes(62) + seconds(5) })
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
    browser.storage.local.seed({ [todayKeyForHost('youtube.com')]: minutes(5) })
    setPageState({ hidden: true })
    setPageState({ hidden: false })
    await flush()
    expect(pill()?.textContent).toBe('00:05:00')
    browser.storage.local.seed({ [todayKeyForHost('youtube.com')]: minutes(6) })
    setPageState({ focused: false })
    setPageState({ focused: true })
    await flush()
    expect(pill()?.textContent).toBe('00:06:00')
  })
})

describe('expanded panel', () => {
  it('lists today, focus and session with their times and definitions', async () => {
    browser.storage.local.seed({ [todayKeyForHost('youtube.com')]: minutes(10) })
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
    expect(rows()[0]?.title).toMatch(/across tabs/)
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
    expect(browser.storage.local.data[SCALE_KEY]).toBe(0.5)
    click(larger())
    await flush()
    expect(browser.storage.local.data[SCALE_KEY]).toBe(0.75)
  })

  it('restores the saved size, snapping and clamping bad values', async () => {
    browser.storage.local.seed({ [SCALE_KEY]: 0.8 })
    await mount()
    expect(transform()).toBe('translateX(-50%) scale(0.75)')
    browser.storage.local.seed({ [SCALE_KEY]: 0.1 })
    await flush()
    expect(transform()).toBe('translateX(-50%) scale(0.5)')
    browser.storage.local.seed({ [SCALE_KEY]: 'huge' })
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
    expect(browser.storage.local.data[HIDDEN_KEY]).toBe(true)
    // An outside click no longer does anything once hidden.
    document.body.click()
    await flush()
    expect(root().querySelector('.widget')?.childElementCount).toBe(0)
  })

  it('stays hidden on load when the preference is set', async () => {
    browser.storage.local.seed({ [HIDDEN_KEY]: true })
    const view = await mount()
    await tickView(view, seconds(2))
    expect(pill()).toBeNull()
  })

  it('follows the preference when toggled from the popup', async () => {
    await mount()
    browser.storage.local.seed({ [HIDDEN_KEY]: true })
    await flush()
    expect(pill()).toBeNull()
    browser.storage.local.seed({ [HIDDEN_KEY]: false })
    await flush()
    expect(pill()).not.toBeNull()
  })

  it('recovers once storage is readable again', async () => {
    browser.storage.local.error = 'storage unavailable'
    await mount()
    // readElapsed fails too, so nothing renders, but nothing throws.
    browser.storage.local.error = null
    setPageState({ focused: false })
    setPageState({ focused: true })
    await flush()
    expect(pill()?.textContent).toBe('00:00:00')
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
    browser.storage.local.seed({ [HIDDEN_KEY]: true })
    await flush()
    expect(document.getElementById('tabtimer-root')).toBeNull()
  })
})
