// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DONE_MS, HOLD_MS, HoldButton } from './hold'

const LABELS = {
  rest: 'Hold for 5 more minutes',
  holding: 'Keep holding',
  done: '5 more minutes',
  hint: 'Press and hold',
}

let reduced = false
let done: ReturnType<typeof vi.fn<() => void>>
let hold: HoldButton

const progress = () => Number(hold.el.style.getPropertyValue('--p'))
const text = () => hold.el.querySelector('.txt')?.textContent
const pointer = (type: string, init: PointerEventInit = {}) =>
  hold.el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }))
const key = (type: 'keydown' | 'keyup', init: KeyboardEventInit) => {
  const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  hold.el.dispatchEvent(e)
  return e
}

beforeEach(() => {
  vi.useFakeTimers()
  reduced = false
  done = vi.fn()
  hold = new HoldButton(LABELS, done, () => reduced)
  document.body.append(hold.el, hold.hint, hold.status)
})

afterEach(() => {
  hold.el.remove()
  vi.useRealTimers()
})

describe('press and hold', () => {
  it('rests as an outlined button with its ring, described as press and hold', () => {
    expect(hold.el.className).toBe('btn hold')
    expect(text()).toBe(LABELS.rest)
    expect(hold.el.querySelector('svg.ring')).not.toBeNull()
    expect(hold.el.getAttribute('aria-describedby')).toBe(hold.hint.id)
    expect(hold.hint.textContent).toBe('Press and hold')
    expect(hold.status.getAttribute('aria-live')).toBe('polite')
  })

  it('acts after HOLD_MS held, through a done state', () => {
    pointer('pointerdown')
    expect(hold.el.classList.contains('holding')).toBe(true)
    expect(text()).toBe(LABELS.holding)
    vi.advanceTimersByTime(HOLD_MS / 2)
    expect(progress()).toBeGreaterThan(0.4)
    expect(progress()).toBeLessThan(0.6)
    vi.advanceTimersByTime(HOLD_MS / 2 + 50)
    expect(progress()).toBe(1)
    expect(hold.el.classList.contains('done')).toBe(true)
    expect(hold.el.querySelector('svg.check')).not.toBeNull()
    expect(text()).toBe(LABELS.done)
    expect(hold.status.textContent).toBe(LABELS.done)
    // The done state shows before the action runs; letting go now changes
    // nothing.
    pointer('pointerup')
    expect(done).not.toHaveBeenCalled()
    // Nor does pressing again.
    pointer('pointerdown')
    expect(hold.el.classList.contains('done')).toBe(true)
    vi.advanceTimersByTime(DONE_MS)
    expect(done).toHaveBeenCalledOnce()
  })

  it('a click, or a short press, does nothing', () => {
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    hold.el.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    // A long touch doesn't open a menu either.
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    hold.el.dispatchEvent(menu)
    expect(menu.defaultPrevented).toBe(true)
    pointer('pointerdown')
    vi.advanceTimersByTime(200)
    pointer('pointerup')
    vi.advanceTimersByTime(HOLD_MS + DONE_MS)
    expect(done).not.toHaveBeenCalled()
  })

  it('drains back when let go early, then can be held again', () => {
    pointer('pointerdown')
    vi.advanceTimersByTime(HOLD_MS * 0.75)
    pointer('pointerleave')
    expect(progress()).toBe(0)
    expect(hold.el.classList.contains('released')).toBe(true)
    expect(text()).toBe(LABELS.rest)
    vi.advanceTimersByTime(400)
    expect(hold.el.className).toBe('btn hold')
    // The time held before doesn't count toward the next hold.
    pointer('pointerdown')
    vi.advanceTimersByTime(HOLD_MS - 100)
    expect(hold.el.classList.contains('done')).toBe(false)
    vi.advanceTimersByTime(200 + DONE_MS)
    expect(done).toHaveBeenCalledOnce()
  })

  it('ignores buttons other than the main one', () => {
    pointer('pointerdown', { button: 2 })
    vi.advanceTimersByTime(HOLD_MS + DONE_MS)
    expect(done).not.toHaveBeenCalled()
    expect(hold.el.classList.contains('holding')).toBe(false)
  })

  it('lets go when the pointer is cancelled or focus leaves', () => {
    for (const end of [() => pointer('pointercancel'), () => hold.el.dispatchEvent(new FocusEvent('blur'))]) {
      pointer('pointerdown')
      vi.advanceTimersByTime(HOLD_MS / 2)
      end()
      expect(progress()).toBe(0)
    }
    vi.advanceTimersByTime(HOLD_MS + DONE_MS)
    expect(done).not.toHaveBeenCalled()
  })
})

describe('by keyboard', () => {
  for (const [name, init] of [
    ['Space', { code: 'Space', key: ' ' }],
    ['Enter', { code: 'Enter', key: 'Enter' }],
  ] as const) {
    it(`holds while ${name} is down`, () => {
      expect(key('keydown', init).defaultPrevented).toBe(true)
      // Auto-repeat doesn't restart it.
      vi.advanceTimersByTime(HOLD_MS / 2)
      key('keydown', { ...init, repeat: true })
      vi.advanceTimersByTime(HOLD_MS / 2 + 50)
      expect(hold.el.classList.contains('done')).toBe(true)
      vi.advanceTimersByTime(DONE_MS)
      expect(done).toHaveBeenCalledOnce()
    })

    it(`lets go when ${name} comes up early`, () => {
      key('keydown', init)
      vi.advanceTimersByTime(HOLD_MS / 2)
      key('keyup', init)
      expect(progress()).toBe(0)
      vi.advanceTimersByTime(HOLD_MS + DONE_MS)
      expect(done).not.toHaveBeenCalled()
    })
  }

  it('lets go on Escape, and ignores other keys', () => {
    expect(key('keydown', { key: 'a' }).defaultPrevented).toBe(false)
    key('keyup', { key: 'a' })
    expect(hold.el.classList.contains('holding')).toBe(false)
    key('keydown', { code: 'Space', key: ' ' })
    vi.advanceTimersByTime(HOLD_MS / 2)
    key('keydown', { key: 'Escape' })
    expect(progress()).toBe(0)
    vi.advanceTimersByTime(HOLD_MS + DONE_MS)
    expect(done).not.toHaveBeenCalled()
  })
})

describe('reduced motion', () => {
  it('steps the progress in quarters instead of moving smoothly', () => {
    reduced = true
    pointer('pointerdown')
    const seen = new Set<number>()
    for (let t = 0; t < HOLD_MS; t += 50) {
      vi.advanceTimersByTime(50)
      seen.add(progress())
    }
    expect([...seen].sort()).toEqual([0, 0.25, 0.5, 0.75, 1])
    vi.advanceTimersByTime(100 + DONE_MS)
    expect(done).toHaveBeenCalledOnce()
  })

  it('moves smoothly otherwise', () => {
    pointer('pointerdown')
    vi.advanceTimersByTime(HOLD_MS * 0.3)
    expect(progress() % 0.25).not.toBe(0)
  })
})

describe('reset', () => {
  it('goes back to rest from any state, its pending action dropped', () => {
    pointer('pointerdown')
    vi.advanceTimersByTime(HOLD_MS + 50)
    expect(hold.el.classList.contains('done')).toBe(true)
    hold.reset()
    expect(hold.el.className).toBe('btn hold')
    expect(progress()).toBe(0)
    expect(text()).toBe(LABELS.rest)
    expect(hold.status.textContent).toBe('')
    vi.advanceTimersByTime(DONE_MS)
    expect(done).not.toHaveBeenCalled()

    pointer('pointerdown')
    vi.advanceTimersByTime(HOLD_MS / 2)
    hold.reset()
    vi.advanceTimersByTime(HOLD_MS + DONE_MS)
    expect(done).not.toHaveBeenCalled()
  })

  it('swallows vibration the browser refuses', () => {
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: () => {
        throw new Error('not allowed')
      },
    })
    pointer('pointerdown')
    vi.advanceTimersByTime(HOLD_MS + DONE_MS + 50)
    expect(done).toHaveBeenCalledOnce()
    Reflect.deleteProperty(navigator, 'vibrate')
  })
})
