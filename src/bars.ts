// The time readout and hour bars every surface shares (styles in
// src/styles/base.css). Hour bars are one tone: usage only; the readout
// states the time against the limit.
import { formatTime } from './format'
import { h } from './ui'

// The readout: today's time, then " / " and the limit, both HH:MM:SS
// (`limit` null: the time alone). Styles: base.css .readout.
export function drawReadout(timeEl: HTMLElement, limitEl: HTMLElement, ms: number, limit: number | null): void {
  timeEl.textContent = formatTime(ms)
  limitEl.textContent = limit === null ? '' : `/ ${formatTime(limit)}`
}

// An hour chart's full height: the busiest hour, or this much if less, so
// a few minutes don't fill it.
export const HOUR_FLOOR_MS = 10 * 60_000

// Draw one hour's bar of `ms` into `el`, its height a share of `top`: one
// tone, usage only. The limit is a daily total, stated by the readout.
export function drawBar(el: HTMLElement, ms: number, top: number): void {
  el.classList.add('hbar')
  // The bar's height as a share of the scale.
  el.style.setProperty('--v', String(top > 0 ? ms / top : 0))
  if (ms > 0) {
    const seg = h('i', { class: 'seg', 'data-part': 'usage' })
    seg.style.bottom = '0'
    seg.style.height = `max(1px, ${(ms / top) * 100}%)`
    el.append(seg)
  }
}
