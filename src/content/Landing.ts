import { landingLevel, LANDING_MS } from '../core/limits'
import type FocusTracker from './FocusTracker'
import { mountShadowHost } from './shadowHost'

const HOST_ID = 'tabtimer-landing'

// How fast the landing clears when the block it led to is no longer ahead.
export const CLEAR_MS = 300

type Tracker = Pick<FocusTracker, 'blockIn' | 'onState'>

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

// The soft landing: over the last LANDING_MS before the block, the block
// screen's background (its surface, nothing on it) fades in over the page,
// in the top layer as the block screen is. Its level follows the tracker's
// time to the block (FocusTracker.blockIn, overAt's rule), so it holds
// while no time accrues and clears when the block is no longer ahead. It
// takes no pointer, focus or keys and is hidden from assistive tech: the
// page stays fully usable until the block screen takes over.
export default class Landing {
  private host: HTMLDivElement
  private attach: () => boolean
  private shown = false
  // The time to the block last drawn (null: none drawn).
  private drawn: number | null = null
  private frame: number | null = null
  private clearTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribeState: () => void

  // `land`: put the block screen up (BlockScreen.tick), the moment the
  // landing reaches it.
  constructor(
    private tracker: Tracker,
    private land: () => void
  ) {
    const { host, attach } = mountShadowHost(HOST_ID, '')
    this.host = host
    this.attach = attach
    host.popover = 'manual'
    host.inert = true
    host.setAttribute('aria-hidden', 'true')
    const s = host.style
    // The popover's box undone: full-bleed, on the block screen's surface.
    for (const [prop, value] of [
      ['inset', '0'],
      ['width', '100%'],
      ['height', '100%'],
      ['max-width', 'none'],
      ['max-height', 'none'],
      ['margin', '0'],
      ['padding', '0'],
      ['border', '0'],
      ['overflow', 'hidden'],
      ['background', 'var(--bg)'],
      ['pointer-events', 'none'],
      ['opacity', '0'],
      ['display', 'none'],
    ] as const) {
      s.setProperty(prop, value, 'important')
    }
    this.unsubscribeState = tracker.onState(() => this.tick())
  }

  // Called each tick (content.ts, after the block screen's) and whenever
  // the worker's state changes.
  tick(): void {
    this.cancelFrame()
    // A frame after it looks again: whether the time to the block moves.
    this.drawn = null
    this.update()
  }

  destroy(): void {
    this.cancelFrame()
    this.cancelClear()
    this.unsubscribeState()
    this.host.remove()
  }

  // Per frame while it fades in (each tick with reduced motion), and only
  // while the time to the block moves.
  private update = () => {
    this.frame = null
    const left = this.tracker.blockIn()
    if (left === null || left >= LANDING_MS) {
      this.clear()
      return
    }
    if (left <= 0) {
      // The block screen takes over, opaque, before the landing goes.
      if (this.shown) {
        this.land()
      }
      this.hide()
      return
    }
    this.show(landingLevel(left))
    if (left !== this.drawn && !reducedMotion()) {
      this.frame = requestAnimationFrame(this.update)
    }
    this.drawn = left
  }

  private show(level: number) {
    this.cancelClear()
    const s = this.host.style
    s.setProperty('transition', 'none', 'important')
    s.setProperty('opacity', String(level), 'important')
    if (this.attach() || !this.shown) {
      this.shown = true
      s.setProperty('display', 'block', 'important')
      try {
        this.host.showPopover()
      } catch {
        // Already showing, or popovers unsupported: it stays a fixed element.
      }
    }
  }

  // The block is no longer ahead: fade out quickly.
  private clear() {
    this.drawn = null
    if (!this.shown || this.clearTimer !== null) {
      return
    }
    const s = this.host.style
    s.setProperty('transition', `opacity ${CLEAR_MS}ms ease-out`, 'important')
    s.setProperty('opacity', '0', 'important')
    this.clearTimer = setTimeout(() => {
      this.clearTimer = null
      this.hide()
    }, CLEAR_MS)
  }

  private hide() {
    this.cancelClear()
    this.drawn = null
    if (!this.shown) {
      return
    }
    this.shown = false
    const s = this.host.style
    s.setProperty('transition', 'none', 'important')
    s.setProperty('opacity', '0', 'important')
    s.setProperty('display', 'none', 'important')
    try {
      this.host.hidePopover()
    } catch {
      // Not showing, or popovers unsupported.
    }
  }

  private cancelFrame() {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame)
      this.frame = null
    }
  }

  private cancelClear() {
    if (this.clearTimer !== null) {
      clearTimeout(this.clearTimer)
      this.clearTimer = null
    }
  }
}
