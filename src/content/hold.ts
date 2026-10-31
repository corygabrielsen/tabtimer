// Press and hold: a button (its fill shows the progress) that acts only
// after it is held down for `duration()` (read at each press), by pointer or
// touch only: no key holds it, so typing can't.
// The label never changes: the fill is the only feedback, and letting go
// early drains it back. The block screen's snooze, a deliberate act (styles
// in BlockScreen.ts).
import { holdMs } from '../core/limits'
import { h } from '../ui'

// The shortest hold, the first snooze of the day's.
export const HOLD_MS = holdMs(0)
// Quarter steps: a haptic tick at each, and the progress shown in them when
// motion is reduced.
export const HOLD_STEPS = 4
// How long the done state shows before the action runs.
export const DONE_MS = 600
// The drain back after an early release (its CSS transition).
const DRAIN_MS = 320

// label: the button's, in every state; hint: the description for assistive
// tech.
export type HoldLabels = { label: string; hint: string }

type State = 'rest' | 'holding' | 'done'

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

export class HoldButton {
  readonly el: HTMLButtonElement
  // The press-and-hold hint, for the button's description.
  readonly hint: HTMLSpanElement
  // A polite live region: what the hold did.
  readonly status: HTMLSpanElement
  private state: State = 'rest'
  private start = 0
  // This press's hold length.
  private ms = HOLD_MS
  private frame = 0
  private steps = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private labels: HoldLabels,
    private onDone: () => void,
    private reduced: () => boolean = reducedMotion,
    private duration: () => number = () => HOLD_MS
  ) {
    this.hint = h('span', { class: 'sr', id: 'hold-hint' }, labels.hint)
    this.status = h('span', { class: 'sr', 'aria-live': 'polite' })
    this.el = h(
      'button',
      { type: 'button', class: 'btn hold', 'aria-describedby': 'hold-hint' },
      h('span', { class: 'fill' }),
      h('span', { class: 'lbl' }, h('span', { class: 'txt' }, labels.label))
    )
    const el = this.el
    el.addEventListener('pointerdown', (e) => {
      if (e.button === 0) {
        // The default stays: the press focuses the button (no focus ring), as any
        // button press does.
        this.press()
      }
    })
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
      el.addEventListener(type, this.release)
    }
    // A click (or a key's) does nothing: only holding counts.
    el.addEventListener('click', (e) => e.preventDefault())
    el.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  // Back to rest, at once (the block screen hid, or showed again).
  reset(): void {
    cancelAnimationFrame(this.frame)
    this.clearTimer()
    this.state = 'rest'
    this.el.classList.remove('holding', 'released', 'done')
    this.setProgress(0)
    this.status.textContent = ''
  }

  private press() {
    if (this.state !== 'rest') {
      return
    }
    this.clearTimer()
    this.state = 'holding'
    this.start = performance.now()
    this.ms = this.duration()
    this.steps = 0
    this.el.classList.remove('released')
    this.el.classList.add('holding')
    this.frame = requestAnimationFrame(this.tick)
  }

  private tick = (now: number) => {
    const p = Math.min(1, Math.max(0, now - this.start) / this.ms)
    this.setProgress(p)
    const step = Math.floor(p * HOLD_STEPS)
    if (step > this.steps && step < HOLD_STEPS) {
      this.steps = step
      vibrate(8)
    }
    if (p >= 1) {
      this.finish()
      return
    }
    this.frame = requestAnimationFrame(this.tick)
  }

  // Let go before the end: the progress drains back.
  private release = () => {
    if (this.state !== 'holding') {
      return
    }
    cancelAnimationFrame(this.frame)
    this.state = 'rest'
    this.el.classList.remove('holding')
    this.el.classList.add('released')
    this.setProgress(0)
    this.timer = setTimeout(() => {
      this.timer = null
      this.el.classList.remove('released')
    }, DRAIN_MS)
  }

  private finish() {
    this.state = 'done'
    vibrate([10, 40, 18])
    this.el.classList.remove('holding')
    this.el.classList.add('done')
    this.status.textContent = this.labels.label
    this.timer = setTimeout(() => {
      this.timer = null
      this.onDone()
    }, DONE_MS)
  }

  // Progress 0..1, in quarter steps when motion is reduced.
  private setProgress(p: number) {
    const shown = this.reduced() ? Math.floor(p * HOLD_STEPS) / HOLD_STEPS : p
    this.el.style.setProperty('--p', String(shown))
  }

  private clearTimer() {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

function vibrate(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    // Not allowed without a user gesture, or not supported: no haptics.
  }
}
