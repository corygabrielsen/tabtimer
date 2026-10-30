// The time graphics every surface shares, drawn the one Calm way (styles in
// src/styles/base.css): grey is time within the limit, a dark mark is
// where the limit fell, the accent is time after it.
import type { LimitSplit } from './core/usage'
import { h } from './ui'

// The gap either side of a limit tick, taken out of the bar so its height
// stays honest.
const TICK_GAP_PX = 2

// Draw one bar of `part` into `el`, its heights as shares of `top`. In the
// slot the limit fell in, a tick marks it (`tick`; a bar too small for one
// shows the accent cap alone), named by `label` on the side with room.
export function drawBar(
  el: HTMLElement,
  part: LimitSplit,
  top: number,
  label: { text: string; side: 'left' | 'right' } | null = null,
  tick = true
): void {
  el.classList.add('hbar')
  // The bar's height as a share of the scale.
  el.style.setProperty('--v', String(top > 0 ? (part.within + part.over) / top : 0))
  const pct = (ms: number) => (top > 0 ? (ms / top) * 100 : 0)
  const split = part.within > 0 && part.over > 0
  const gap = split ? TICK_GAP_PX : 0
  const seg = (cls: string, bottom: string, height: string) => {
    const s = h('i', { class: cls, 'data-part': cls.includes('over') ? 'over' : 'within' })
    s.style.bottom = bottom
    s.style.height = height
    return s
  }
  if (part.within > 0) {
    el.append(seg(`seg base${split ? '' : ' top'}`, '0', `max(1px, calc(${pct(part.within)}% - ${gap}px))`))
  }
  if (part.over > 0) {
    const from = pct(part.within)
    el.append(
      seg(
        `seg over top${split ? '' : ' base'}`,
        `calc(${from}% + ${gap}px)`,
        `max(1px, calc(${pct(part.over)}% - ${gap}px))`
      )
    )
  }
  if (part.crosses && tick) {
    const at = `calc(${pct(part.within)}% - 1px)`
    const tick = h('i', { class: 'tick' })
    tick.style.bottom = at
    el.append(tick)
    if (label) {
      const name = h('span', { class: 'tick-label', 'data-side': label.side }, label.text)
      name.style.bottom = at
      el.append(name)
    }
  }
}

// The meter: grey up to the limit's mark, an empty track to it while under,
// and one accent piece per stretch over (core/snooze.ts overSegments).
// `label` names the limit under its mark.
export function drawMeter(
  meter: HTMLElement,
  labelEl: HTMLElement | null,
  used: number,
  limit: number,
  over: number[],
  label: string
): void {
  const scale = Math.max(limit, used)
  const piece = (cls: string, ms: number) => {
    const s = h('span', { class: cls })
    s.style.flex = `${ms} 1 0`
    return s
  }
  const within = Math.min(used, limit)
  const parts: HTMLElement[] = []
  if (within > 0) {
    parts.push(piece('in', within))
  }
  if (used < limit) {
    parts.push(piece('rest', limit - within))
  }
  parts.push(h('i', { class: 'lim' }))
  parts.push(...over.map((ms) => piece('over', ms)))
  meter.replaceChildren(...parts)
  if (labelEl) {
    const at = (limit / scale) * 100
    const name = h('span', { 'data-edge': at > 92 ? 'end' : undefined }, label)
    name.style.left = `${at}%`
    labelEl.replaceChildren(name)
  }
}
