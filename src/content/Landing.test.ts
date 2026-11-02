// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { landingLevel, LANDING_MS } from '../core/limits'
import { trackShadowRoots } from '../test/dom'
import Landing, { CLEAR_MS } from './Landing'

const HOST_ID = 'tabtimer-landing'
const NOON = new Date(2026, 5, 10, 12).getTime()

// A tracker whose time to the block is `left` as of `asOf` and counts down
// with the clock while `running` (null: no block ahead).
class FakeTracker {
  left: number | null = null
  asOf = NOON
  running = true
  private listeners = new Set<() => void>()
  blockIn = () => (this.left === null ? null : Math.max(0, this.left - (this.running ? Date.now() - this.asOf : 0)))
  onState = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  // A new state from the worker: `left` from now.
  push(left: number | null, running = true) {
    this.left = left
    this.asOf = Date.now()
    this.running = running
    for (const listener of this.listeners) {
      listener()
    }
  }
  get subscribed() {
    return this.listeners.size
  }
}

let tracker: FakeTracker
let land: ReturnType<typeof vi.fn>
let landing: Landing | null
let shadowOf: (id: string) => ShadowRoot
// happy-dom has no popover API; record the calls.
let popovers: string[]

const host = () => document.getElementById(HOST_ID)!
const style = (prop: string) => host().style.getPropertyValue(prop)
const opacity = () => Number(style('opacity'))
const shown = () => style('display') === 'block'
const run = (ms: number) => vi.advanceTimersByTimeAsync(ms)

function mount(): Landing {
  landing = new Landing(tracker, land as () => void)
  return landing
}

function reducedMotion(on: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: on && query.includes('reduce') }))
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOON })
  tracker = new FakeTracker()
  land = vi.fn()
  landing = null
  shadowOf = trackShadowRoots()
  popovers = []
  Object.defineProperty(HTMLElement.prototype, 'showPopover', {
    configurable: true,
    value: () => popovers.push('show'),
  })
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
    configurable: true,
    value: () => popovers.push('hide'),
  })
  reducedMotion(false)
})

afterEach(() => {
  landing?.destroy()
  delete (HTMLElement.prototype as { showPopover?: unknown }).showPopover
  delete (HTMLElement.prototype as { hidePopover?: unknown }).hidePopover
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the soft landing', () => {
  it('is a bare full-bleed surface on the block screen’s background, out of reach of input and assistive tech', () => {
    mount()
    expect(host().parentNode).toBe(document.documentElement)
    expect(host().getAttribute('popover')).toBe('manual')
    expect(host().getAttribute('aria-hidden')).toBe('true')
    expect(host().inert).toBe(true)
    expect(style('pointer-events')).toBe('none')
    expect(style('background')).toBe('var(--bg)')
    expect(style('position')).toBe('fixed')
    expect(style('inset')).toMatch(/^0(px)?$/)
    // Only the background: no title, readout, chart, buttons or text.
    expect([...shadowOf(HOST_ID).children].map((el) => el.localName)).toEqual(['style'])
    expect(shadowOf(HOST_ID).textContent).not.toMatch(/break|minutes|close/i)
  })

  it('shows nothing with no block ahead, or one LANDING_MS or more away', () => {
    mount()
    tracker.push(null)
    expect(shown()).toBe(false)
    tracker.push(LANDING_MS)
    expect(shown()).toBe(false)
    tracker.push(60_000)
    expect(shown()).toBe(false)
    expect(popovers).toEqual([])
  })

  it('fades in by the time left, frame by frame, into the top layer', async () => {
    mount()
    tracker.push(8000)
    expect(shown()).toBe(true)
    expect(popovers).toEqual(['show'])
    expect(opacity()).toBeCloseTo(landingLevel(8000))
    expect(style('transition')).toBe('none')
    let last = opacity()
    for (let i = 0; i < 20; i++) {
      await run(100)
      expect(opacity()).toBeGreaterThan(last)
      last = opacity()
    }
    expect(opacity()).toBeCloseTo(landingLevel(6000), 2)
    expect(popovers).toEqual(['show'])
  })

  it('hands over to the block screen when it reaches the block, then goes at once', async () => {
    mount()
    land.mockImplementation(() => expect(shown()).toBe(true))
    tracker.push(1000)
    await run(1050)
    expect(land).toHaveBeenCalledTimes(1)
    expect(shown()).toBe(false)
    expect(opacity()).toBe(0)
    expect(popovers).toEqual(['show', 'hide'])
    // Blocked: it stays down, and doesn't put the block screen up again.
    landing!.tick()
    await run(1000)
    expect(land).toHaveBeenCalledTimes(1)
    expect(shown()).toBe(false)
  })

  it('never shows for a block already due', () => {
    mount()
    tracker.push(0)
    expect(shown()).toBe(false)
    expect(land).not.toHaveBeenCalled()
  })

  it('holds where it is while no time accrues, and goes on from there', async () => {
    mount()
    tracker.push(5000)
    await run(1000)
    const held = opacity()
    const frame = vi.spyOn(globalThis, 'requestAnimationFrame')
    tracker.push(4000, false)
    expect(opacity()).toBeCloseTo(held)
    await run(30_000)
    landing!.tick()
    expect(opacity()).toBeCloseTo(held)
    // No frames while it holds, beyond the one that looks after each tick.
    expect(frame.mock.calls.length).toBeLessThanOrEqual(3)
    tracker.push(4000, true)
    await run(2000)
    expect(opacity()).toBeCloseTo(landingLevel(2000), 2)
  })

  it.each([
    ['a snooze granted elsewhere', 2 * 60_000],
    ['the limit raised', 5 * 60_000],
    ['the limit removed, the site untracked or the day over', null],
  ])('clears quickly with %s', async (_, left) => {
    mount()
    tracker.push(4000)
    await run(500)
    tracker.push(left)
    expect(style('transition')).toBe(`opacity ${CLEAR_MS}ms ease-out`)
    expect(opacity()).toBe(0)
    expect(shown()).toBe(true)
    await run(CLEAR_MS)
    expect(shown()).toBe(false)
    expect(popovers).toEqual(['show', 'hide'])
    expect(land).not.toHaveBeenCalled()
  })

  it('comes back if the block is ahead again while it clears', async () => {
    mount()
    tracker.push(4000)
    tracker.push(null)
    await run(CLEAR_MS / 2)
    tracker.push(3000)
    expect(style('transition')).toBe('none')
    expect(opacity()).toBeCloseTo(landingLevel(3000))
    await run(CLEAR_MS)
    expect(shown()).toBe(true)
    expect(popovers).toEqual(['show'])
  })

  it('with reduced motion, still fades, once a tick instead of every frame', async () => {
    reducedMotion(true)
    const frame = vi.spyOn(globalThis, 'requestAnimationFrame')
    mount()
    tracker.push(8000)
    const first = opacity()
    await run(1000)
    expect(opacity()).toBe(first)
    landing!.tick()
    expect(opacity()).toBeCloseTo(landingLevel(7000))
    expect(frame).not.toHaveBeenCalled()
  })

  it('puts itself back in the top layer if the page took it off', async () => {
    mount()
    tracker.push(8000)
    const el = host()
    el.remove()
    await run(20)
    expect(el.parentNode).toBe(document.documentElement)
    expect(popovers).toEqual(['show', 'show'])
  })

  it('stays a fixed element where the popover API throws', () => {
    Object.defineProperty(HTMLElement.prototype, 'showPopover', {
      configurable: true,
      value() {
        throw new DOMException('already showing', 'InvalidStateError')
      },
    })
    Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
      configurable: true,
      value() {
        throw new DOMException('not showing', 'InvalidStateError')
      },
    })
    mount()
    tracker.push(8000)
    expect(shown()).toBe(true)
    tracker.push(0)
    expect(shown()).toBe(false)
  })

  it('removes itself and stops following the tracker on destroy', async () => {
    const view = mount()
    tracker.push(4000)
    tracker.push(null)
    view.destroy()
    landing = null
    expect(document.getElementById(HOST_ID)).toBeNull()
    expect(tracker.subscribed).toBe(0)
    await run(CLEAR_MS)
    expect(popovers).toEqual(['show'])
  })
})
