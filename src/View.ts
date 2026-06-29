import type Model from './Model'
import type { ElapsedState } from './Model'

function pad(num: number): string {
  return num.toString().padStart(2, '0')
}

function formatTime(millis: number): string {
  const seconds = Math.floor(millis / 1000)
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

// Map our keys to the model's keys
function getElapsedForKey(elapsed: ElapsedState, key: TimerKey): number {
  if (key === 'session') {
    return elapsed.countup.elapsed
  }
  return elapsed[key].elapsed
}

export default class View {
  private container: HTMLDivElement
  private expanded = false
  private selectedTimer: TimerKey = 'today'
  private timeElements: Map<TimerKey | 'collapsed', HTMLSpanElement> = new Map()
  private needsRebuild = true

  constructor(private model: Model) {
    this.container = document.createElement('div')
    this.container.id = 'tabtimer-root'
    this.applyContainerStyles()
    document.body.appendChild(this.container)

    this.render()

    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    window.addEventListener('blur', this.handleBlur)
    window.addEventListener('focus', this.handleFocus)
    document.addEventListener('click', this.handleOutsideClick)
  }

  private applyContainerStyles() {
    const s = this.container.style
    s.position = 'fixed'
    s.top = '0'
    s.left = '50%'
    s.transform = 'translateX(-50%)'
    s.zIndex = '2147483647'
    s.fontFamily = 'system-ui, -apple-system, sans-serif'
    s.fontSize = '13px'
    s.userSelect = 'none'
  }

  private render() {
    this.model.readElapsed().then((elapsed) => {
      // If we just need to update times, do that without rebuilding DOM
      if (!this.needsRebuild && this.timeElements.size > 0) {
        this.updateTimes(elapsed)
        return
      }

      this.needsRebuild = false
      this.timeElements.clear()
      this.container.innerHTML = ''

      if (this.expanded) {
        this.renderExpanded(elapsed)
      } else {
        this.renderCollapsed(elapsed)
      }
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

  private renderCollapsed(elapsed: ElapsedState) {
    const div = document.createElement('div')
    const millis = getElapsedForKey(elapsed, this.selectedTimer)

    Object.assign(div.style, {
      background: 'rgba(0, 0, 0, 0.85)',
      color: '#fff',
      padding: '6px 14px',
      borderRadius: '0 0 8px 8px',
      cursor: 'pointer',
      fontFamily: 'monospace',
      fontSize: '13px',
      fontWeight: '500',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    })

    div.textContent = formatTime(millis)
    this.timeElements.set('collapsed', div as unknown as HTMLSpanElement)

    div.addEventListener('click', (e) => {
      e.stopPropagation()
      this.expanded = true
      this.needsRebuild = true
      this.render()
    })

    this.container.appendChild(div)
  }

  private renderExpanded(elapsed: ElapsedState) {
    const panel = document.createElement('div')

    Object.assign(panel.style, {
      background: 'rgba(0, 0, 0, 0.9)',
      color: '#fff',
      borderRadius: '0 0 10px 10px',
      overflow: 'hidden',
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
      minWidth: '160px',
    })

    for (const key of TIMER_KEYS) {
      const row = document.createElement('div')
      const isSelected = key === this.selectedTimer
      const millis = getElapsedForKey(elapsed, key)

      Object.assign(row.style, {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '10px 14px',
        cursor: 'pointer',
        background: isSelected ? 'rgba(99, 102, 241, 0.3)' : 'transparent',
        borderLeft: isSelected ? '3px solid #6366f1' : '3px solid transparent',
        transition: 'background 0.15s',
      })

      row.addEventListener('mouseenter', () => {
        if (!isSelected) {
          row.style.background = 'rgba(255,255,255,0.1)'
        }
      })
      row.addEventListener('mouseleave', () => {
        row.style.background = isSelected ? 'rgba(99, 102, 241, 0.3)' : 'transparent'
      })

      const label = document.createElement('span')
      label.textContent = LABELS[key]
      Object.assign(label.style, {
        color: isSelected ? '#a5b4fc' : '#999',
        fontSize: '12px',
        fontWeight: '500',
      })

      const time = document.createElement('span')
      time.textContent = formatTime(millis)
      Object.assign(time.style, {
        fontFamily: 'monospace',
        fontSize: '13px',
        fontWeight: '600',
        color: isSelected ? '#fff' : '#ccc',
      })
      this.timeElements.set(key, time)

      row.appendChild(label)
      row.appendChild(time)

      row.addEventListener('click', (e) => {
        e.stopPropagation()
        this.selectedTimer = key
        this.expanded = false
        this.needsRebuild = true
        this.render()
      })

      panel.appendChild(row)
    }

    this.container.appendChild(panel)
  }

  updateDisplayText() {
    this.render()
  }

  private handleOutsideClick = (e: MouseEvent) => {
    if (this.expanded && !this.container.contains(e.target as Node)) {
      this.expanded = false
      this.needsRebuild = true
      this.render()
    }
  }

  handleBlur = () => {
    // Keep showing current state
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
