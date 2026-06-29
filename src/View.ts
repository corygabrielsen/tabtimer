import type Model from './Model'
import type { ElapsedState } from './Model'
import { formatTime } from './format'
import { storage, HIDDEN_KEY, SCALE_KEY } from './storage'
import { t } from './i18n'

// Top of the stacking context so the widget stays visible above page chrome.
const MAX_Z_INDEX = 2147483647

const HOST_ID = 'tabtimer-root'

const MIN_SCALE = 0.5
const MAX_SCALE = 1
const SCALE_STEP = 0.25

// Snap to a step and clamp to the allowed range; fall back to 1 on garbage.
function clampScale(value: number): number {
  if (!Number.isFinite(value)) {
    return 1
  }
  const snapped = Math.round(value / SCALE_STEP) * SCALE_STEP
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, snapped))
}

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

// Map our display keys to the model's keys.
function getElapsedForKey(elapsed: ElapsedState, key: TimerKey): number {
  if (key === 'session') {
    return elapsed.countup.elapsed
  }
  return elapsed[key].elapsed
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
    color: #5f5f5f;
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

export default class View {
  private host: HTMLDivElement
  private shadow: ShadowRoot
  private mount: HTMLDivElement
  private expanded = false
  private hidden = false
  private scale = 1
  private selectedTimer: TimerKey = 'today'
  private timeElements: Map<TimerKey | 'collapsed', HTMLElement> = new Map()
  private needsRebuild = true
  private outsideClickAttached = false

  constructor(private model: Model) {
    // Drop a stale widget left by a previous instance (re-injection / SPA
    // remount) so we never stack duplicate hosts.
    document.getElementById(HOST_ID)?.remove()

    this.host = document.createElement('div')
    this.host.id = HOST_ID
    this.applyHostStyles()

    // Closed shadow root: the page can't query into it, and its CSS is isolated.
    this.shadow = this.host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = STYLES
    this.mount = document.createElement('div')
    this.mount.className = 'widget'
    this.shadow.append(style, this.mount)

    document.body.appendChild(this.host)

    // Respect the saved hide/size preferences before the first paint.
    Promise.all([storage.get(HIDDEN_KEY, false, 'local'), storage.get(SCALE_KEY, 1, 'local')])
      .then(([hidden, scale]) => {
        this.hidden = hidden
        this.scale = clampScale(scale)
        this.applyScale()
        this.render()
      })
      .catch(() => this.render())

    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    window.addEventListener('focus', this.handleFocus)
    chrome.storage.onChanged.addListener(this.handlePrefsChange)
  }

  private applyScale() {
    // Scale the whole widget — text, padding, everything — as one unit, kept
    // pinned to the top-center.
    this.host.style.setProperty('transform', `translateX(-50%) scale(${this.scale})`, 'important')
  }

  private setScale(scale: number) {
    const next = clampScale(scale)
    if (next === this.scale) {
      return
    }
    this.scale = next
    this.applyScale()
    void storage.set(SCALE_KEY, next, 'local').catch(() => {})
  }

  private applyHostStyles() {
    // Structural styles only, marked important so page rules can't dislodge the
    // widget; everything visual is handled inside the shadow root.
    const s = this.host.style
    s.setProperty('position', 'fixed', 'important')
    s.setProperty('top', '0', 'important')
    s.setProperty('left', '50%', 'important')
    s.setProperty('transform-origin', 'top center', 'important')
    s.setProperty('z-index', String(MAX_Z_INDEX), 'important')
    this.applyScale()
  }

  private render() {
    if (this.hidden) {
      this.timeElements.clear()
      this.mount.replaceChildren()
      return
    }

    this.model
      .readElapsed()
      .then((elapsed) => {
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
      })
      .catch(() => {
        // Storage/SW error (e.g. extension context invalidated); skip this
        // frame rather than throwing an unhandled rejection every second.
      })
  }

  private updateTimes(elapsed: ElapsedState) {
    if (this.expanded) {
      for (const key of TIMER_KEYS) {
        const el = this.timeElements.get(key)
        if (el) {
          el.textContent = formatTime(getElapsedForKey(elapsed, key))
        }
      }
    } else {
      const el = this.timeElements.get('collapsed')
      if (el) {
        el.textContent = formatTime(getElapsedForKey(elapsed, this.selectedTimer))
      }
    }
  }

  private buildCollapsed(elapsed: ElapsedState): HTMLButtonElement {
    const pill = document.createElement('button')
    pill.type = 'button'
    pill.className = 'pill'
    pill.setAttribute('aria-expanded', 'false')
    pill.setAttribute('aria-label', t('overlayPillAria', LABELS[this.selectedTimer]))
    pill.textContent = formatTime(getElapsedForKey(elapsed, this.selectedTimer))
    this.timeElements.set('collapsed', pill)

    pill.addEventListener('click', (e) => {
      e.stopPropagation()
      this.setExpanded(true)
    })

    return pill
  }

  private buildExpanded(elapsed: ElapsedState): HTMLDivElement {
    const panel = document.createElement('div')
    panel.className = 'panel'
    panel.setAttribute('role', 'group')
    panel.setAttribute('aria-label', t('overlayLabel'))

    for (const key of TIMER_KEYS) {
      const isSelected = key === this.selectedTimer

      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'row'
      row.title = TOOLTIPS[key]
      row.setAttribute('aria-pressed', String(isSelected))

      const label = document.createElement('span')
      label.className = 'label'
      label.textContent = LABELS[key]

      const time = document.createElement('span')
      time.className = 'time'
      time.textContent = formatTime(getElapsedForKey(elapsed, key))
      this.timeElements.set(key, time)

      row.append(label, time)
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
    const controls = document.createElement('div')
    controls.className = 'controls'

    const sizes = document.createElement('div')
    sizes.className = 'sizes'

    const smaller = document.createElement('button')
    smaller.type = 'button'
    smaller.className = 'size'
    smaller.textContent = '−'
    smaller.setAttribute('aria-label', t('overlaySmaller'))
    smaller.disabled = this.scale <= MIN_SCALE

    const larger = document.createElement('button')
    larger.type = 'button'
    larger.className = 'size'
    larger.textContent = '+'
    larger.setAttribute('aria-label', t('overlayLarger'))
    larger.disabled = this.scale >= MAX_SCALE

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
    sizes.append(smaller, larger)

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'close'
    close.textContent = '×'
    close.setAttribute('aria-label', t('overlayHide'))
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      this.setHidden(true)
    })

    controls.append(sizes, close)
    return controls
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
    void storage.set(HIDDEN_KEY, hidden, 'local').catch(() => {})
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

  updateDisplayText() {
    this.render()
  }

  destroy() {
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    window.removeEventListener('focus', this.handleFocus)
    chrome.storage.onChanged.removeListener(this.handlePrefsChange)
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

  // React when the hide/size preferences are changed elsewhere (popup, options,
  // or another tab's overlay).
  private handlePrefsChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    if (areaName !== 'local') {
      return
    }

    const hiddenChange = changes[HIDDEN_KEY]
    if (hiddenChange) {
      const hidden = Boolean(hiddenChange.newValue)
      if (hidden !== this.hidden) {
        this.hidden = hidden
        this.expanded = false
        this.detachOutsideClick()
        this.needsRebuild = true
        this.render()
      }
    }

    const scaleChange = changes[SCALE_KEY]
    if (scaleChange) {
      const scale = clampScale(Number(scaleChange.newValue))
      if (scale !== this.scale) {
        this.scale = scale
        this.applyScale()
      }
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
