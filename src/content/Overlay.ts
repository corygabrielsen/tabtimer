import type FocusTracker from './FocusTracker'
import type { ElapsedState } from './FocusTracker'
import { formatTime } from '../format'
import { bus as chromeBus } from '../chrome/bus'
import { MAX_SCALE, MIN_SCALE, SCALE_STEP, snapScale } from '../core/schema'
import type { Bus } from '../ports'
import { t } from '../i18n'
import { h } from '../ui'
import { mountShadowHost } from './shadowHost'

const HOST_ID = 'tabtimer-root'

type TimerKey = 'today' | 'focus' | 'session'

const TIMER_KEYS: TimerKey[] = ['today', 'focus', 'session']

const LABELS: Record<TimerKey, string> = {
  today: t('labelToday'),
  focus: t('labelFocus'),
  session: t('labelSession'),
}

// Hover definitions — these three are otherwise easy to confuse.
const TOOLTIPS: Record<TimerKey, string> = {
  today: t('tooltipToday'),
  focus: t('tooltipFocus'),
  session: t('tooltipSession'),
}

// All widget styling lives inside the shadow root, so the host page's CSS
// can't reach in and the widget's styles can't leak out.
const STYLES = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .widget {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: #f5f5f5;
    font-variant-numeric: tabular-nums;
    -webkit-user-select: none;
    user-select: none;
  }
  .pill {
    display: block;
    margin: 0;
    border: 0;
    background: rgba(0, 0, 0, 0.72);
    color: #f5f5f5;
    padding: 3px 9px;
    border-radius: 0 0 2px 2px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    letter-spacing: 0.02em;
  }
  .panel {
    background: rgba(0, 0, 0, 0.82);
    border-radius: 0 0 2px 2px;
    overflow: hidden;
    min-width: 130px;
  }
  .row {
    display: flex;
    width: 100%;
    justify-content: space-between;
    align-items: center;
    gap: 18px;
    margin: 0;
    padding: 3px 9px;
    border: 0;
    border-left: 2px solid transparent;
    background: transparent;
    color: #8a8a8a;
    cursor: pointer;
    text-align: left;
    font: inherit;
    font-size: 12px;
    transition: background 0.1s;
  }
  .row:hover { background: rgba(255, 255, 255, 0.05); }
  .row[aria-pressed='true'] {
    color: #f5f5f5;
    border-left-color: #f5f5f5;
  }
  .label { font-size: 11px; }
  .controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 5px 3px;
    border-top: 1px solid rgba(255, 255, 255, 0.07);
  }
  .sizes {
    display: flex;
    gap: 2px;
  }
  .size,
  .close {
    margin: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: #8a8a8a;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    line-height: 1;
    padding: 1px 6px;
  }
  .size:hover:not(:disabled),
  .close:hover {
    color: #f5f5f5;
  }
  .size:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .pill:focus-visible,
  .row:focus-visible,
  .size:focus-visible,
  .close:focus-visible {
    outline: 1px solid #9a9a9a;
    outline-offset: -1px;
  }
  @media (prefers-reduced-motion: reduce) {
    .row { transition: none; }
  }
`

export default class Overlay {
  private host: HTMLDivElement
  private shadow: ShadowRoot
  private attach: () => boolean
  private mount: HTMLDivElement
  private expanded = false
  // Hidden until the service worker sends the preferences.
  private hidden = true
  private scale = 1
  // The preferences the worker last sent (JSON).
  private prefs: string | null = null
  private selectedTimer: TimerKey = 'today'
  private timeElements: Map<TimerKey | 'collapsed', HTMLElement> = new Map()
  private needsRebuild = true
  private outsideClickAttached = false

  private unsubscribeState: () => void

  constructor(
    private tracker: Pick<FocusTracker, 'readElapsed' | 'onState' | 'prefs'>,
    private bus: Bus = chromeBus
  ) {
    const { host, shadow, attach } = mountShadowHost(HOST_ID, STYLES)
    this.host = host
    this.shadow = shadow
    this.attach = attach
    this.applyHostStyles()
    this.raise()
    this.mount = h('div', { class: 'widget' })
    this.shadow.append(this.mount)

    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    window.addEventListener('focus', this.handleFocus)
    // Fresh totals and preferences from the service worker (a hidden tab
    // redraws when shown).
    this.applyPrefs()
    this.unsubscribeState = tracker.onState(() => {
      this.applyPrefs()
      if (!document.hidden) {
        this.render()
      }
    })
  }

  private applyScale() {
    // Scale the whole widget — text, padding, everything — as one unit, kept
    // pinned to the top-center.
    this.host.style.setProperty('transform', `translateX(-50%) scale(${this.scale})`, 'important')
  }

  private setScale(scale: number) {
    const next = snapScale(scale)
    if (next === this.scale) {
      return
    }
    this.scale = next
    this.applyScale()
    void this.bus.send('setPrefs', { scale: next })
  }

  private applyHostStyles() {
    // Structural styles only, marked important so page rules can't dislodge the
    // widget; everything visual is handled inside the shadow root. A manual
    // popover, in the top layer: a transform or filter the page puts on <html>
    // or <body> can't become its containing block and move it. The rest
    // undoes the browser's popover box.
    this.host.popover = 'manual'
    const s = this.host.style
    for (const [prop, value] of [
      ['inset', 'auto'],
      ['margin', '0'],
      ['padding', '0'],
      ['border', '0'],
      ['background', 'transparent'],
      ['overflow', 'visible'],
    ] as const) {
      s.setProperty(prop, value, 'important')
    }
    s.setProperty('top', '0', 'important')
    s.setProperty('left', '50%', 'important')
    s.setProperty('transform-origin', 'top center', 'important')
    this.applyScale()
  }

  // Into the top layer; again after the page took the host off.
  private raise() {
    try {
      this.host.showPopover()
    } catch {
      // Already showing, or popovers unsupported: it stays a fixed element.
    }
  }

  // Draw the current times: in place when only they changed.
  render() {
    if (this.attach()) {
      this.raise()
    }
    if (this.hidden) {
      this.timeElements.clear()
      this.mount.replaceChildren()
      return
    }

    const elapsed = this.tracker.readElapsed()
    // If we just need fresh times, update text in place without rebuilding.
    if (!this.needsRebuild && this.timeElements.size > 0) {
      this.updateTimes(elapsed)
      return
    }

    this.needsRebuild = false
    this.timeElements.clear()

    if (this.expanded) {
      this.mount.replaceChildren(this.buildExpanded(elapsed))
    } else {
      this.mount.replaceChildren(this.buildCollapsed(elapsed))
    }
  }

  private updateTimes(elapsed: ElapsedState) {
    if (this.expanded) {
      for (const key of TIMER_KEYS) {
        const el = this.timeElements.get(key)
        if (el) {
          el.textContent = formatTime(elapsed[key])
        }
      }
    } else {
      const el = this.timeElements.get('collapsed')
      if (el) {
        this.setPillTime(el, elapsed)
      }
    }
  }

  // The pill's accessible name carries the time too: aria-label replaces
  // its text content for assistive tech.
  private setPillTime(pill: HTMLElement, elapsed: ElapsedState) {
    const time = formatTime(elapsed[this.selectedTimer])
    pill.textContent = time
    pill.setAttribute('aria-label', t('overlayPillAria', [LABELS[this.selectedTimer], time]))
  }

  private buildCollapsed(elapsed: ElapsedState): HTMLButtonElement {
    const pill = h('button', { type: 'button', class: 'pill', 'aria-expanded': 'false' })
    this.setPillTime(pill, elapsed)
    this.timeElements.set('collapsed', pill)

    pill.addEventListener('click', (e) => {
      e.stopPropagation()
      this.setExpanded(true)
    })

    return pill
  }

  private buildExpanded(elapsed: ElapsedState): HTMLDivElement {
    const panel = h('div', { class: 'panel', role: 'group', 'aria-label': t('overlayLabel') })

    for (const key of TIMER_KEYS) {
      const time = h('span', { class: 'time' }, formatTime(elapsed[key]))
      this.timeElements.set(key, time)
      const row = h(
        'button',
        { type: 'button', class: 'row', title: TOOLTIPS[key], 'aria-pressed': String(key === this.selectedTimer) },
        h('span', { class: 'label' }, LABELS[key]),
        time
      )
      row.addEventListener('click', (e) => {
        e.stopPropagation()
        this.selectedTimer = key
        this.setExpanded(false)
      })

      panel.appendChild(row)
    }

    panel.appendChild(this.buildControls())
    return panel
  }

  // Thin footer strip: size steppers on the left, dismiss on the right.
  private buildControls(): HTMLDivElement {
    const sizeButton = (label: string, text: string, disabled: boolean) =>
      h('button', { type: 'button', class: 'size', 'aria-label': label, disabled }, text)
    const smaller = sizeButton(t('overlaySmaller'), '−', this.scale <= MIN_SCALE)
    const larger = sizeButton(t('overlayLarger'), '+', this.scale >= MAX_SCALE)
    const syncSizeButtons = () => {
      smaller.disabled = this.scale <= MIN_SCALE
      larger.disabled = this.scale >= MAX_SCALE
    }
    smaller.addEventListener('click', (e) => {
      e.stopPropagation()
      this.setScale(this.scale - SCALE_STEP)
      syncSizeButtons()
    })
    larger.addEventListener('click', (e) => {
      e.stopPropagation()
      this.setScale(this.scale + SCALE_STEP)
      syncSizeButtons()
    })

    const close = h('button', { type: 'button', class: 'close', 'aria-label': t('overlayHide') }, '×')
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      this.setHidden(true)
    })

    return h('div', { class: 'controls' }, h('div', { class: 'sizes' }, smaller, larger), close)
  }

  private setExpanded(expanded: boolean) {
    this.expanded = expanded
    this.needsRebuild = true
    if (expanded) {
      this.attachOutsideClick()
    } else {
      this.detachOutsideClick()
    }
    this.render()
  }

  private setHidden(hidden: boolean) {
    this.hidden = hidden
    this.expanded = false
    this.detachOutsideClick()
    this.needsRebuild = true
    void this.bus.send('setPrefs', { hidden })
    this.render()
  }

  // Only listen for outside clicks / Escape while the panel is open, rather
  // than holding a permanent document-wide hook on every page.
  private attachOutsideClick() {
    if (this.outsideClickAttached) {
      return
    }
    document.addEventListener('click', this.handleOutsideClick)
    document.addEventListener('keydown', this.handleKeydown)
    this.outsideClickAttached = true
  }

  private detachOutsideClick() {
    if (!this.outsideClickAttached) {
      return
    }
    document.removeEventListener('click', this.handleOutsideClick)
    document.removeEventListener('keydown', this.handleKeydown)
    this.outsideClickAttached = false
  }

  destroy() {
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    window.removeEventListener('focus', this.handleFocus)
    this.unsubscribeState()
    this.detachOutsideClick()
    this.host.remove()
  }

  private handleOutsideClick = (e: MouseEvent) => {
    // Clicks inside the (closed) shadow root retarget to the host element.
    if (this.expanded && !this.host.contains(e.target as Node)) {
      this.setExpanded(false)
    }
  }

  private handleKeydown = (e: KeyboardEvent) => {
    if (this.expanded && e.key === 'Escape') {
      this.setExpanded(false)
    }
  }

  // Take the hide/size preferences when the worker's differ from the last
  // it sent: changed elsewhere (popup, options, or another tab's overlay).
  // This overlay's own changes are already applied.
  private applyPrefs() {
    const prefs = this.tracker.prefs
    const key = JSON.stringify(prefs)
    if (!prefs || key === this.prefs) {
      return
    }
    this.prefs = key
    const { hidden, scale } = prefs
    if (hidden !== this.hidden) {
      this.hidden = hidden
      this.expanded = false
      this.detachOutsideClick()
      this.needsRebuild = true
      this.render()
    }
    const clamped = snapScale(scale)
    if (clamped !== this.scale) {
      this.scale = clamped
      this.applyScale()
    }
  }

  handleFocus = () => {
    this.render()
  }

  handleVisibilityChange = () => {
    if (!document.hidden) {
      this.render()
    }
  }
}
