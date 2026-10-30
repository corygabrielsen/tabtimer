// Press and hold: a button (its fill shows the progress) that acts only
// after HOLD_MS held down, by pointer or touch only: no key holds it, so
// typing can't.
// Letting go early drains the progress back and says, briefly, to hold. The
// block screen's snooze, a deliberate act (styles in BlockScreen.ts).
import { h, svg } from '../ui'

export const HOLD_MS = 2000
// Quarter steps: a haptic tick at each, and the progress shown in them when
// motion is reduced.
export const HOLD_STEPS = 4
// How long the done state shows before the action runs.
export const DONE_MS = 600
// The drain back after an early release (its CSS transition).
const DRAIN_MS = 320
// How long "Hold to continue" shows after an early release.
export const NUDGE_MS = 1500

// rest, holding and done: the label in each state; early: after letting go
// too soon; hint: the description for assistive tech.
export type HoldLabels = { rest: string; holding: string; done: string; early: string; hint: string }

type State = 'rest' | 'holding' | 'done'

const CHECK = (): SVGSVGElement => svg('0 0 20 20', 'check', ['path', { d: 'M4.75 10.25l3.5 3.5 7-7.5' }])

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

export class HoldButton {
  readonly el: HTMLButtonElement
  // The press-and-hold hint, for the button's description.
  readonly hint: HTMLSpanElement
  // A polite live region: what the hold did.
  readonly status: HTMLSpanElement
  private label: HTMLSpanElement
  private state: State = 'rest'
  private start = 0
  private frame = 0
  private steps = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private nudge: ReturnType<typeof setTimeout> | null = null

  constructor(
    private labels: HoldLabels,
    private onDone: () => void,
    private reduced: () => boolean = reducedMotion
  ) {
    this.hint = h('span', { class: 'sr', id: 'hold-hint' }, labels.hint)
    this.status = h('span', { class: 'sr', 'aria-live': 'polite' })
    this.label = h('span', { class: 'lbl' })
    this.el = h(
      'button',
      { type: 'button', class: 'btn hold', 'aria-describedby': 'hold-hint' },
      h('span', { class: 'fill' }),
      this.label
    )
    this.show(null, labels.rest)
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
    this.clearNudge()
    this.state = 'rest'
    this.el.classList.remove('holding', 'released', 'done')
    this.setProgress(0)
    this.show(null, this.labels.rest)
    this.status.textContent = ''
  }

  private press() {
    if (this.state !== 'rest') {
      return
    }
    this.clearTimer()
    this.clearNudge()
    this.state = 'holding'
    this.start = performance.now()
    this.steps = 0
    this.el.classList.remove('released')
    this.el.classList.add('holding')
    this.show(null, this.labels.holding)
    this.frame = requestAnimationFrame(this.tick)
  }

  private tick = (now: number) => {
    const p = Math.min(1, Math.max(0, now - this.start) / HOLD_MS)
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
    this.show(null, this.labels.early)
    this.timer = setTimeout(() => {
      this.timer = null
      this.el.classList.remove('released')
    }, DRAIN_MS)
    this.nudge = setTimeout(() => {
      this.nudge = null
      this.show(null, this.labels.rest)
    }, NUDGE_MS)
  }

  private finish() {
    this.state = 'done'
    vibrate([10, 40, 18])
    this.el.classList.remove('holding')
    this.el.classList.add('done')
    this.show(CHECK(), this.labels.done)
    this.status.textContent = this.labels.done
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

  private show(icon: SVGSVGElement | null, text: string) {
    this.label.replaceChildren(...(icon ? [icon] : []), h('span', { class: 'txt' }, text))
  }

  private clearNudge() {
    if (this.nudge !== null) {
      clearTimeout(this.nudge)
      this.nudge = null
    }
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
