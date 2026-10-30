// The time graphics every surface shares, drawn the one Calm way (styles in
// src/styles/base.css): grey is time within the limit, a dark mark is the
// limit on a daily scale, the accent is time after it.
import { msToMinutes, type BlockScope } from './core/limits'
import type { LimitSplit } from './core/usage'
import { formatTime } from './format'
import { t } from './i18n'
import { formatDuration, h } from './ui'

// The readout: today's time, then " / " and the limit, both HH:MM:SS
// (`limit` null: the time alone). Styles: base.css .readout.
export function drawReadout(timeEl: HTMLElement, limitEl: HTMLElement, ms: number, limit: number | null): void {
  timeEl.textContent = formatTime(ms)
  limitEl.textContent = limit === null ? '' : `/ ${formatTime(limit)}`
}

// The meter against the limit that applies (`scope`, on `site`): grey up to
// the limit's mark (an empty track to it while under), then one accent
// piece for any time over; named for assistive tech. The readout states
// the limit.
export function drawLimitMeter(meter: HTMLElement, used: number, limit: number, scope: BlockScope, site: string): void {
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
  if (used > limit) {
    parts.push(piece('over', used - limit))
  }
  meter.replaceChildren(...parts)
  meter.setAttribute('aria-valuemax', String(msToMinutes(limit)))
  meter.setAttribute('aria-valuenow', String(Math.min(msToMinutes(used), msToMinutes(limit))))
  meter.setAttribute('aria-label', scope === 'site' ? t('popupMeterSiteAria', site) : t('popupMeterGlobalAria'))
  meter.setAttribute('aria-valuetext', t('popupUsedOf', [formatDuration(used), formatDuration(limit)]))
}

// An hour chart's full height: the busiest hour, or this much if less, so
// a few minutes don't fill it.
export const HOUR_FLOOR_MS = 10 * 60_000

// Half the gap between a bar's grey and its accent, taken out of each so
// the bar's height stays honest.
const SPLIT_GAP_PX = 1

// Draw one bar of `part` into `el`, its heights as shares of `top`: grey for
// the time before the daily limit was reached, the accent after. An hour
// bar has no limit mark: the limit is a daily total, not an hour's.
export function drawBar(el: HTMLElement, part: LimitSplit, top: number): void {
  el.classList.add('hbar')
  // The bar's height as a share of the scale.
  el.style.setProperty('--v', String(top > 0 ? (part.within + part.over) / top : 0))
  const pct = (ms: number) => (top > 0 ? (ms / top) * 100 : 0)
  const split = part.within > 0 && part.over > 0
  const gap = split ? SPLIT_GAP_PX : 0
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
}
