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
    padding-top: 8px;
    font-family: var(--font);
    color: var(--text);
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
    -webkit-user-select: none;
    user-select: none;
  }
  /* The time only; over the limit, the one accent state. */
  .pill {
    display: block;
    height: 32px;
    margin: 0;
    padding: 0 14px;
    border: 1px solid var(--edge);
    border-radius: 999px;
    background: var(--sheet);
    box-shadow: var(--shadow-sm);
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    line-height: 30px;
    pointer-events: auto;
    transition: background-color 0.15s;
  }
  .pill:hover { background: var(--hover); }
  .pill[data-over] {
    border-color: var(--accent-ink);
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .panel {
    min-width: 168px;
    padding: 4px;
    overflow: hidden;
    border: 1px solid var(--edge);
    border-radius: 16px;
    background: var(--sheet);
    box-shadow: var(--shadow);
    pointer-events: auto;
  }
  .row {
    display: flex;
    width: 100%;
    justify-content: space-between;
    align-items: center;
    gap: 20px;
    min-height: 32px;
    margin: 0;
    padding: 0 12px;
    border: 0;
    border-radius: 12px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    text-align: left;
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    transition: background-color 0.15s;
  }
  .row:hover { background: var(--hover); color: var(--text); }
  .row[aria-pressed='true'] {
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-weight: 600;
  }
  .label { font-size: 12px; }
  .controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 4px;
    padding: 4px 0 0;
    border-top: 1px solid var(--line);
  }
  .sizes {
    display: flex;
    gap: 2px;
  }
  .size,
  .close {
    width: 32px;
    height: 28px;
    margin: 0;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--quiet-ink);
    cursor: pointer;
    font: inherit;
    font-size: 15px;
    font-weight: 600;
    line-height: 1;
  }
  .size:hover:not(:disabled),
  .close:hover {
    background: var(--hover);
    color: var(--text);
  }
  .size:disabled {
    color: var(--edge);
    cursor: default;
  }
  .pill:focus-visible,
  .row:focus-visible,
  .size:focus-visible,
  .close:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    .pill, .row { transition: none; }
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
  // The element focus moves to after a rebuild: the pill, or the selected
  // row.
  private focusTarget: HTMLElement | null = null

  private unsubscribeState: () => void

  constructor(
    private tracker: Pick<FocusTracker, 'readElapsed' | 'onState' | 'prefs' | 'isOver'>,
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
      // Only the pill and panel take clicks, not the gap above the pill.
      ['pointer-events', 'none'],
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
    pill.toggleAttribute('data-over', this.tracker.isOver())
    pill.setAttribute('aria-label', t('overlayPillAria', [LABELS[this.selectedTimer], time]))
  }

  private buildCollapsed(elapsed: ElapsedState): HTMLButtonElement {
    const pill = h('button', { type: 'button', class: 'pill', 'aria-expanded': 'false' })
    this.setPillTime(pill, elapsed)
    this.timeElements.set('collapsed', pill)

    this.focusTarget = pill

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
      if (key === this.selectedTimer) {
        this.focusTarget = row
      }
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

  // Focus inside the widget moves with the rebuild: to the selected row on
  // expand, to the pill on collapse.
  private setExpanded(expanded: boolean) {
    const focused = this.shadow.activeElement !== null
    this.expanded = expanded
    this.needsRebuild = true
    if (expanded) {
      this.attachOutsideClick()
    } else {
      this.detachOutsideClick()
    }
    this.render()
    if (focused) {
      this.focusTarget?.focus({ preventScroll: true })
    }
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
