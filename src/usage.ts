// The activity page: a day by hour or a week by day, stacked by site, with
// each site's time and limit below. Reads storage directly; the one write
// (a site's limit) goes to the service worker as setLimit.
import { chromeStore, loadThenPatch } from './chrome/store'
import { dayOf, type DayStamp } from './core/day'
import { limitsFor, msToMinutes, normalizeLimits, siteLimitOf, DEFAULT_LIMITS, type Limits } from './core/limits'
import { LIMITS_KEY } from './core/schema'
import {
  barTotal,
  dayLabel,
  hasAnyUsage,
  historyOf,
  hourLabel,
  maxOffset,
  niceScale,
  patchHistory,
  periodOf,
  rangeLabel,
  stack,
  summarize,
  type Bar,
  type History,
  type Mode,
  type Period,
  type Summary,
} from './core/usage'
import { localizeDom, t } from './i18n'
import { createSiteLimitPicker, formatChipMinutes, type LimitPicker } from './limitPicker'
import { byId, firstDayOfWeek, formatDuration, h, setDocumentLang, uiLocale } from './ui'

const local = chromeStore('local')

type State = {
  mode: Mode
  offset: number
  // The site the chart is filtered to (null: every site).
  site: string | null
  table: boolean
  // The bar that takes focus in the chart (roving tabindex).
  bar: number
  history: History
  limits: Limits
}

const state: State = {
  mode: 'day',
  offset: 0,
  site: null,
  table: false,
  bar: -1,
  history: new Map(),
  limits: DEFAULT_LIMITS,
}

const locale = uiLocale()
const firstDay = firstDayOfWeek(locale)

// The limit picker for the selected site, kept across renders so an edit in
// progress survives a live update.
let picker: { site: string; picker: LimitPicker; saved: HTMLElement } | null = null

const today = (): DayStamp => dayOf(Date.now())

// A site's limit, in ms (null: none).
const siteLimit = (site: string): number | null => limitsFor(state.limits, site).site

// --- Labels -------------------------------------------------------------------

function periodLabel(period: Period): string {
  const first = period.days[0]!
  if (period.mode === 'day') {
    if (period.offset === 0) {
      return t('usageToday')
    }
    if (period.offset === 1) {
      return t('usageYesterday')
    }
    return dayLabel(first, locale, { weekday: 'long', month: 'long', day: 'numeric' })
  }
  if (period.offset === 0) {
    return t('usageThisWeek')
  }
  if (period.offset === 1) {
    return t('usageLastWeek')
  }
  return weekRange(period)
}

function weekRange(period: Period): string {
  return rangeLabel(period.days[0]!, period.days.at(-1)!, locale)
}

// A slot's name: "2 PM" in a day, "Monday, Oct 26" in a week.
function slotLabel(period: Period, i: number, short: boolean): string {
  if (period.mode === 'day') {
    return hourLabel(i, locale)
  }
  return dayLabel(
    period.days[i]!,
    locale,
    short ? { weekday: 'short' } : { weekday: 'long', month: 'short', day: 'numeric' }
  )
}

function changeText(period: Period, change: number): { text: string; aria: string } | null {
  const pct = Math.round(Math.abs(change) * 100)
  if (pct === 0) {
    return null
  }
  const since =
    period.mode === 'day'
      ? period.offset === 0
        ? t('usageSinceYesterday')
        : t('usageSinceDayBefore')
      : period.offset === 0
        ? t('usageSinceLastWeek')
        : t('usageSinceWeekBefore')
  const subs = [String(pct), since]
  return change > 0
    ? { text: t('usageUp', subs), aria: t('usageUpAria', subs) }
    : { text: t('usageDown', subs), aria: t('usageDownAria', subs) }
}

// --- Chart --------------------------------------------------------------------

// The values a bar stacks: the top sites then Other, or the one site.
function segments(bar: Bar, summary: Summary): number[] {
  return state.site === null ? stack(bar, summary.top) : [barTotal(bar, state.site)]
}

// A horizontal reference line across the plot, labelled at its left end.
function refLine(kind: 'average' | 'limit', ms: number, top: number, label: string): HTMLElement {
  const line = h('div', { class: `ref ref-${kind}`, 'aria-hidden': 'true' }, h('span', {}, label))
  line.style.setProperty('--y', `${(ms / top) * 100}%`)
  return line
}

function chart(period: Period, summary: Summary): HTMLElement {
  const totals = summary.bars.map((bar) => barTotal(bar, state.site))
  const week = period.mode === 'week'
  const limit = week && state.site !== null ? siteLimit(state.site) : null
  const average = week && summary.total > 0 ? summary.average : null
  // An empty or quiet chart still spans a readable range.
  const floor = week ? 60 * 60_000 : 30 * 60_000
  const { step, top } = niceScale(Math.max(...totals, average ?? 0, limit ?? 0, floor))

  const grid = h('div', { class: 'grid', 'aria-hidden': 'true' })
  for (let v = 0; v <= top; v += step) {
    const line = h('div', { class: 'gridline' }, h('span', {}, v === 0 ? '0' : formatChipMinutes(msToMinutes(v))))
    line.style.setProperty('--y', `${(v / top) * 100}%`)
    grid.append(line)
  }

  if (state.bar < 0 || state.bar >= totals.length) {
    state.bar = Math.max(0, totals.indexOf(Math.max(...totals)))
  }
  const bars = h('div', {
    class: 'bars',
    role: 'group',
    id: 'bars',
    'aria-label': week
      ? t('usageChartWeekAria', weekRange(period))
      : t('usageChartDayAria', dayLabel(period.days[0]!, locale, { month: 'long', day: 'numeric' })),
  })
  summary.bars.forEach((bar, i) => {
    const total = totals[i]!
    const value = formatDuration(total)
    const col = h('div', {
      class: 'bar',
      role: 'img',
      id: `bar-${i}`,
      tabindex: i === state.bar ? '0' : '-1',
      'aria-label': t('usageBarAria', [slotLabel(period, i, false), value]),
      'data-value': total > 0 ? value : undefined,
    })
    col.style.setProperty('--h', `${(total / top) * 100}%`)
    segments(bar, summary).forEach((ms, series) => {
      if (ms > 0) {
        const seg = h('span', { class: 'seg', 'data-series': state.site === null ? String(series) : 'site' })
        seg.style.height = `${(ms / top) * 100}%`
        col.append(seg)
      }
    })
    bars.append(col)
  })
  bars.addEventListener('keydown', (e) => moveBar(e, totals.length))

  const plot = h('div', { class: 'plot' }, grid, bars)
  if (average !== null) {
    plot.append(refLine('average', average, top, t('usageAverageLine')))
  }
  if (limit !== null) {
    plot.append(refLine('limit', limit, top, t('usageLimitLine', formatDuration(limit))))
  }
  if (summary.total === 0) {
    plot.append(h('p', { class: 'none' }, week ? t('usageNoneWeek') : t('usageNoneDay')))
  }

  const axis = h('div', { class: 'axis', 'aria-hidden': 'true' })
  for (let i = 0; i < totals.length; i++) {
    axis.append(h('span', {}, week || i % 6 === 0 ? slotLabel(period, i, true) : ''))
  }
  return h('div', { class: `chart-body mode-${period.mode}` }, plot, axis)
}

function moveBar(e: KeyboardEvent, count: number): void {
  const next = { ArrowLeft: state.bar - 1, ArrowRight: state.bar + 1, Home: 0, End: count - 1 }[e.key]
  if (next === undefined) {
    return
  }
  e.preventDefault()
  const target = byId(`bar-${Math.min(Math.max(next, 0), count - 1)}`)
  byId(`bar-${state.bar}`)?.setAttribute('tabindex', '-1')
  state.bar = Math.min(Math.max(next, 0), count - 1)
  target?.setAttribute('tabindex', '0')
  target?.focus()
}

// The chart as a table: one row per slot, a column per stacked series.
function table(period: Period, summary: Summary): HTMLElement {
  // Per-site columns only when showing every site: the top sites, then
  // Other if anyone else had time.
  const columns = state.site === null ? summary.top.length + (hasOther(summary) ? 1 : 0) : 0
  const names = [...summary.top, t('usageOther')].slice(0, columns)
  const head = h(
    'tr',
    {},
    h('th', { scope: 'col' }, period.mode === 'day' ? t('usageColHour') : t('usageColDay')),
    h('th', { scope: 'col' }, t('usageColTotal')),
    ...names.map((name) => h('th', { scope: 'col' }, name))
  )
  const rows = summary.bars.map((bar, i) =>
    h(
      'tr',
      {},
      h('th', { scope: 'row' }, slotLabel(period, i, false)),
      h('td', {}, formatDuration(barTotal(bar, state.site))),
      ...segments(bar, summary)
        .slice(0, columns)
        .map((ms) => h('td', {}, formatDuration(ms)))
    )
  )
  const caption = h('caption', { class: 'visually-hidden' }, periodLabel(period))
  return h('table', { class: 'data' }, caption, h('thead', {}, head), h('tbody', {}, ...rows))
}

const hasOther = (summary: Summary) => summary.sites.length > summary.top.length

function legend(summary: Summary): HTMLElement[] {
  if (state.site !== null || state.table || summary.total === 0) {
    return []
  }
  const other = hasOther(summary)
  const item = (name: string, series: number) =>
    h('li', {}, h('span', { class: 'swatch', 'data-series': String(series), 'aria-hidden': 'true' }), name)
  return [...summary.top.map((site, i) => item(site, i)), ...(other ? [item(t('usageOther'), summary.top.length)] : [])]
}

// --- Sites --------------------------------------------------------------------

function limitPanel(site: string): HTMLElement {
  if (picker?.site !== site) {
    const saved = h('span', { class: 'saved', role: 'status' })
    picker = { site, picker: createSiteLimitPicker({ id: 'usage-limit', site, value: null, saved }), saved }
  }
  picker.picker.set(siteLimitOf(state.limits, site))
  return h(
    'div',
    { class: 'site-panel', id: 'site-panel' },
    h('div', { class: 'site-panel-head' }, h('span', {}, t('popupLimitAria', site)), picker.saved),
    picker.picker.el
  )
}

function siteRow(period: Period, site: string, ms: number, days: number): HTMLLIElement {
  const limit = siteLimit(site)
  const selected = state.site === site
  // A daily limit compares against a day: the day's time, or the week's
  // daily average.
  const used = period.mode === 'day' ? ms : ms / Math.max(1, days)
  const button = h(
    'button',
    {
      type: 'button',
      class: 'site-btn',
      id: `site-${site}`,
      'aria-pressed': String(selected),
      'aria-controls': selected ? 'site-panel' : undefined,
      'data-site': site,
      'data-over': limit !== null && used >= limit,
    },
    h('span', { class: 'site-name' }, site),
    h('span', { class: 'site-time' }, formatDuration(ms))
  )
  if (limit !== null) {
    const meter = h('span', { class: 'site-meter', 'aria-hidden': 'true' })
    meter.style.setProperty('--fill', `${Math.min(100, (used / limit) * 100)}%`)
    const words =
      period.mode === 'day'
        ? t('usageOfLimit', [formatDuration(used), formatDuration(limit)])
        : t('usageAverageOfLimit', [formatDuration(used), formatDuration(limit)])
    button.append(meter, h('span', { class: 'visually-hidden' }, words))
  }
  button.addEventListener('click', () => {
    state.site = selected ? null : site
    render()
    byId(`site-${site}`)?.focus()
  })
  return h('li', { class: 'site-row', 'data-selected': selected }, button, selected ? limitPanel(site) : null)
}

// --- Render -------------------------------------------------------------------

function render(): void {
  const focused = document.activeElement?.id || null
  const day = today()
  const empty = !hasAnyUsage(state.history, day)
  byId('empty')!.hidden = !empty
  byId('report')!.hidden = empty
  byId('mode')!.hidden = empty
  if (empty) {
    return
  }

  const period = periodOf(state.mode, state.offset, day, firstDay)
  state.offset = period.offset
  const now = new Date()
  const summary = summarize(state.history, period, day, state.site, now.getHours() + now.getMinutes() / 60)
  const week = period.mode === 'week'

  byId('period-label')!.textContent = periodLabel(period)
  const prev = byId<HTMLButtonElement>('prev')!
  const next = byId<HTMLButtonElement>('next')!
  prev.disabled = period.offset >= maxOffset(state.mode, day, firstDay)
  next.disabled = period.offset === 0
  prev.setAttribute('aria-label', week ? t('usagePrevWeek') : t('usagePrevDay'))
  next.setAttribute('aria-label', week ? t('usageNextWeek') : t('usageNextDay'))

  byId('total')!.textContent = formatDuration(summary.total)
  const change = byId('change')!
  const delta = summary.change === null ? null : changeText(period, summary.change)
  change.hidden = delta === null
  change.textContent = delta?.text ?? ''
  if (delta) {
    change.setAttribute('aria-label', delta.aria)
  }
  const average = byId('average')!
  average.hidden = !week
  average.textContent = week ? t('usageDailyAverage', formatDuration(summary.average)) : ''

  byId('filter')!.hidden = state.site === null
  byId('filter-label')!.textContent = state.site === null ? '' : t('usageShowing', state.site)

  const chartEl = byId('chart')!
  const tableWrap = byId('table-wrap')!
  chartEl.hidden = state.table
  tableWrap.hidden = !state.table
  chartEl.replaceChildren(...(state.table ? [] : [chart(period, summary)]))
  tableWrap.replaceChildren(...(state.table ? [table(period, summary)] : []))
  byId('legend')!.replaceChildren(...legend(summary))
  const toggle = byId('table-toggle')!
  toggle.textContent = state.table ? t('usageShowChart') : t('usageShowTable')
  toggle.setAttribute('aria-expanded', String(state.table))

  const sites = [...summary.sites]
  if (state.site !== null && !sites.some((s) => s.site === state.site)) {
    sites.push({ site: state.site, ms: 0 })
  }
  byId('site-list')!.replaceChildren(...sites.map((s) => siteRow(period, s.site, s.ms, summary.days)))
  byId('sites-h')!.parentElement!.hidden = sites.length === 0

  if (focused) {
    byId(focused)?.focus()
  }
}

async function load(): Promise<void> {
  const items = await local.getAll().catch(() => ({}) as Record<string, unknown>)
  state.history = historyOf(items)
  state.limits = normalizeLimits(items[LIMITS_KEY])
  render()
}

function init(): void {
  setDocumentLang()
  localizeDom()
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
    radio.addEventListener('change', () => {
      if (radio.checked) {
        state.mode = radio.value === 'week' ? 'week' : 'day'
        state.offset = 0
        state.bar = -1
        render()
      }
    })
  }
  const step = (by: number) => () => {
    state.offset += by
    state.bar = -1
    render()
  }
  byId('prev')?.addEventListener('click', step(1))
  byId('next')?.addEventListener('click', step(-1))
  byId('clear')?.addEventListener('click', () => {
    const site = state.site
    state.site = null
    render()
    byId(`site-${site}`)?.focus()
  })
  byId('table-toggle')?.addEventListener('click', () => {
    state.table = !state.table
    render()
  })
  // Time accrues and limits change while the page is open: patch the state,
  // and draw again only if the shown period (or the one it compares with)
  // changed.
  void loadThenPatch(local, load, (changes) => {
    const days = patchHistory(state.history, changes)
    const limits = LIMITS_KEY in changes
    if (limits) {
      state.limits = normalizeLimits(changes[LIMITS_KEY]!.newValue)
    }
    const period = periodOf(state.mode, state.offset, today(), firstDay)
    if (limits || days.some((day) => period.days.includes(day) || period.previous.includes(day))) {
      render()
    }
  })
}

init()
