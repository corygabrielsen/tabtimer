import type Model from './Model'
import type { ElapsedState } from './Model'

// Top of the stacking context so the widget stays visible above page chrome.
const MAX_Z_INDEX = 2147483647

const HOST_ID = 'tabtimer-root'

function pad(num: number): string {
  return num.toString().padStart(2, '0')
}

function formatTime(millis: number): string {
  const seconds = Math.floor(Math.max(0, millis) / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  return `${pad(hours)}:${pad(minutes % 60)}:${pad(seconds % 60)}`
}

type TimerKey = 'today' | 'focus' | 'session'

const TIMER_KEYS: TimerKey[] = ['today', 'focus', 'session']

const LABELS: Record<TimerKey, string> = {
  today: 'Today',
  focus: 'Focus',
  session: 'Session',
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
    font-family: system-ui, -apple-system, sans-serif;
    color: #fff;
    -webkit-user-select: none;
    user-select: none;
  }
  .pill {
    display: block;
    margin: 0;
    border: 0;
    background: rgba(0, 0, 0, 0.85);
    color: #fff;
    padding: 6px 14px;
    border-radius: 0 0 8px 8px;
    cursor: pointer;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .panel {
    background: rgba(0, 0, 0, 0.92);
    border-radius: 0 0 10px 10px;
    overflow: hidden;
    min-width: 168px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
  .row {
    display: flex;
    width: 100%;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    margin: 0;
    padding: 10px 14px;
    border: 0;
    border-left: 3px solid transparent;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    font: inherit;
    transition: background 0.15s;
  }
  .row:hover { background: rgba(255, 255, 255, 0.1); }
  .row[aria-pressed='true'] {
    background: rgba(99, 102, 241, 0.3);
    border-left-color: #6366f1;
  }
  .label {
    color: #c7c9d1;
    font-size: 12px;
    font-weight: 500;
  }
  .row[aria-pressed='true'] .label { color: #c7d2fe; }
  .time {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    font-weight: 600;
    color: #e5e7eb;
  }
  .row[aria-pressed='true'] .time { color: #fff; }
  .pill:focus-visible,
  .row:focus-visible {
    outline: 2px solid #a5b4fc;
    outline-offset: -2px;
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

    this.render()

    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    window.addEventListener('focus', this.handleFocus)
  }

  private applyHostStyles() {
    // Structural styles only, marked important so page rules can't dislodge the
    // widget; everything visual is handled inside the shadow root.
    const s = this.host.style
    s.setProperty('position', 'fixed', 'important')
    s.setProperty('top', '0', 'important')
    s.setProperty('left', '50%', 'important')
    s.setProperty('transform', 'translateX(-50%)', 'important')
    s.setProperty('z-index', String(MAX_Z_INDEX), 'important')
  }

  private render() {
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
    pill.setAttribute('aria-label', `Tab Timer — ${LABELS[this.selectedTimer]}. Activate to expand.`)
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
    panel.setAttribute('aria-label', 'Tab Timer')

    for (const key of TIMER_KEYS) {
      const isSelected = key === this.selectedTimer

      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'row'
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

    return panel
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

  handleFocus = () => {
    this.render()
  }

  handleVisibilityChange = () => {
    if (!document.hidden) {
      this.render()
    }
  }
}
