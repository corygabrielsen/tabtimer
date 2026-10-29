import { SUGGESTED_SITES, originsForSite, siteFromOrigin, normalizeSiteInput } from './core/site'
import { msToMinutes, minutesToMs, normalizeLimits, DEFAULT_LIMITS, type LimitEdit, type Limits } from './core/limits'
import { dayOf } from './core/day'
import { dayBars, dayLabel, hasAnyUsage, historyOf, periodOf, periodTotal, summarize } from './core/usage'
import { dayKey, normalizeDay, normalizePrefs, siteTotal, DAY_KEY_PREFIX, LIMITS_KEY, PREFS_KEY } from './core/schema'
import { chromeStore } from './chrome/store'
import { bus } from './chrome/bus'
import { localizeDom, t } from './i18n'
import { h, byId, firstDayOfWeek, flashSaved, formatDuration, setDocumentLang, uiLocale } from './ui'
import { createLimitPicker, formatChipMinutes, SITE_PRESETS, GLOBAL_PRESETS, type LimitPicker } from './limitPicker'

const LABELS = new Map(SUGGESTED_SITES.map((s) => [s.host, s.label]))
const SIZES = [0.5, 0.75, 1]

function enable(hosts: string[]): Promise<boolean> {
  // Must run during a user gesture — call request first, no awaits before it.
  return chrome.permissions.request({ origins: hosts.flatMap(originsForSite) }).catch(() => false)
}

function disable(host: string): Promise<boolean> {
  return chrome.permissions.remove({ origins: originsForSite(host) }).catch(() => false)
}

async function grantedHosts(): Promise<Set<string>> {
  const perms = await chrome.permissions.getAll().catch(() => ({ origins: [] as string[] }))
  return new Set((perms.origins ?? []).map(siteFromOrigin))
}

const local = chromeStore('local')

function readLimits(): Promise<Limits> {
  return local
    .get(LIMITS_KEY)
    .then(normalizeLimits)
    .catch(() => DEFAULT_LIMITS)
}

// Each site's time today, from the one stored object for today.
function readTodays(): Promise<(host: string) => number> {
  return local
    .get(dayKey(dayOf(Date.now())))
    .then(normalizeDay)
    .catch(() => normalizeDay(undefined))
    .then((day) => (host: string) => siteTotal(day, host))
}

// Limits change only through the service worker, which applies each edit to
// the latest stored limits (so edits from here and the popup both survive).
async function saveLimit(edit: LimitEdit): Promise<void> {
  await bus.send('setLimit', edit)
}

// --- Tracked site rows -------------------------------------------------------

const toMinutes = (ms: number | null | undefined): number | null =>
  typeof ms === 'number' && ms > 0 ? msToMinutes(ms) : null
const toMs = (minutes: number | null): number | null => (minutes === null ? null : minutesToMs(minutes))

// The table is too narrow for a chip row per site, so each row shows its limit
// as a compact button that expands the row with the same picker the popup uses.
// One row is open at a time, and stays open across re-renders.
let openLimitHost: string | null = null
const rowLimits = new Map<string, (limits: Limits) => void>()

function limitCell(host: string, currentMs: number | undefined): { toggle: HTMLElement; panel: HTMLElement } {
  const id = `limit-${host}`
  const panelId = `${id}-panel`
  const toggle = h('button', {
    type: 'button',
    class: 'limit-toggle',
    'aria-expanded': 'false',
    'aria-controls': panelId,
    'data-host': host,
  })
  const saved = h('span', { class: 'saved', role: 'status' })
  const label = (minutes: number | null) => {
    toggle.textContent = minutes === null ? t('limitOff') : formatChipMinutes(minutes)
    toggle.setAttribute(
      'aria-label',
      t('optionsLimitToggleAria', [host, minutes === null ? t('limitOff') : formatDuration(minutes * 60000)])
    )
  }
  const picker: LimitPicker = createLimitPicker({
    id,
    presets: SITE_PRESETS,
    label: t('optionsSiteLimitAria', host),
    fieldLabel: t('limitCustomSiteAria', host),
    value: toMinutes(currentMs),
    saved,
    commit: (minutes) => saveLimit({ scope: 'site', site: host, ms: toMs(minutes) }),
    onChange: label,
    onEscape: () => {
      setOpen(false)
      toggle.focus()
    },
  })
  const panel = h('div', { class: 'limit-panel', id: panelId, hidden: true }, picker.el, saved)
  const setOpen = (open: boolean) => {
    if (open && openLimitHost !== host) {
      // Close whichever other row is open.
      document.querySelector<HTMLButtonElement>('.limit-toggle[aria-expanded="true"]')?.click()
    }
    openLimitHost = open ? host : openLimitHost === host ? null : openLimitHost
    toggle.setAttribute('aria-expanded', String(open))
    panel.hidden = !open
  }
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true'
    setOpen(open)
    if (open) {
      picker.focus()
    }
  })
  label(toMinutes(currentMs))
  rowLimits.set(host, (limits) => {
    const minutes = toMinutes(limits.perSite[host])
    picker.set(minutes)
    label(minutes)
  })
  if (openLimitHost === host) {
    setOpen(true)
  }
  return { toggle, panel }
}

function todayText(ms: number, limitMs: number | undefined): string {
  return typeof limitMs === 'number' && ms >= limitMs ? t('optionsTodayOver', formatDuration(ms)) : formatDuration(ms)
}

function siteRow(host: string, limitMs: number | undefined, todayMs: number): HTMLLIElement {
  const label = LABELS.get(host)
  const name = h(
    'div',
    { class: 'site-name' },
    h('strong', { title: label ?? host }, label ?? host),
    label ? h('span', { title: host }, host) : null
  )
  const today = h(
    'span',
    {
      class: 'site-today figure',
      'data-today-host': host,
      'data-over': typeof limitMs === 'number' && todayMs >= limitMs,
      'aria-label': t('optionsTodayAria', [host, formatDuration(todayMs)]),
    },
    todayText(todayMs, limitMs)
  )
  const { toggle, panel } = limitCell(host, limitMs)
  const stop = h(
    'button',
    { type: 'button', class: 'btn btn-quiet stop', 'aria-label': t('optionsStopAria', host), 'data-host': host },
    t('optionsStop')
  )
  stop.addEventListener('click', () => {
    pendingFocus = { list: 'tracked', host }
    void disable(host)
  })
  return h('li', { class: 'site-row', 'data-host': host }, name, today, toggle, stop, panel)
}

function suggestionChip(label: string, host: string): HTMLLIElement {
  const btn = h(
    'button',
    { type: 'button', class: 'chip', 'aria-label': t('optionsTrackAria', [label, host]), 'data-host': host },
    label
  )
  btn.addEventListener('click', () => {
    pendingFocus = { list: 'suggested', host }
    void enable([host])
  })
  return h('li', {}, btn)
}

// After a row disappears (stop / track), keep keyboard focus nearby instead of
// dropping it to <body>.
let pendingFocus: { list: 'tracked' | 'suggested'; host: string } | null = null

function restoreFocus(prevOrder: { tracked: string[]; suggested: string[] }) {
  if (!pendingFocus) {
    return
  }
  const { list, host } = pendingFocus
  pendingFocus = null
  const sel = list === 'tracked' ? '#tracked-sites .stop' : '#suggested .chip'
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(sel)]
  const still = buttons.find((b) => b.dataset.host === host)
  if (still) {
    still.focus() // the request was declined; stay put
    return
  }
  const idx = prevOrder[list].indexOf(host)
  const next = buttons[Math.min(Math.max(idx, 0), buttons.length - 1)]
  if (next) {
    next.focus()
  } else {
    byId(list === 'tracked' ? 'add-input' : 'enable-suggested')?.focus()
  }
}

let order = { tracked: [] as string[], suggested: [] as string[] }

// Grant changes can arrive back to back; only the newest render may paint, or
// a slower, older one would restore rows that were just removed.
let renderSeq = 0

async function render() {
  const seq = ++renderSeq
  const trackedUl = byId<HTMLUListElement>('tracked-sites')
  const suggestedUl = byId<HTMLUListElement>('suggested')
  if (!trackedUl || !suggestedUl) {
    return
  }

  const [granted, limits] = await Promise.all([grantedHosts(), readLimits()])

  // Suggested sites first (by label), then the user's own (by host).
  const tracked = [
    ...SUGGESTED_SITES.filter((s) => granted.has(s.host)).map((s) => s.host),
    ...[...granted].filter((host) => !LABELS.has(host)).sort(),
  ]
  const today = await readTodays()
  if (seq !== renderSeq) {
    return
  }
  if (openLimitHost !== null && !tracked.includes(openLimitHost)) {
    openLimitHost = null
  }
  rowLimits.clear()
  trackedUl.replaceChildren(...tracked.map((host) => siteRow(host, limits.perSite[host], today(host))))
  byId('tracked-empty')?.toggleAttribute('hidden', tracked.length > 0)
  const count = byId('tracked-count')
  if (count) {
    count.textContent = tracked.length > 0 ? String(tracked.length) : ''
  }
  document.querySelector('.cols')?.toggleAttribute('hidden', tracked.length === 0)

  const untracked = SUGGESTED_SITES.filter((s) => !granted.has(s.host))
  suggestedUl.replaceChildren(...untracked.map((s) => suggestionChip(s.label, s.host)))
  byId('suggested-empty')?.toggleAttribute('hidden', untracked.length > 0)
  byId('enable-suggested')?.toggleAttribute('hidden', untracked.length === 0)

  const prev = order
  order = { tracked, suggested: untracked.map((s) => s.host) }
  restoreFocus(prev)
}

async function refreshTodays() {
  const [limits, today] = await Promise.all([readLimits(), readTodays()])
  for (const sync of rowLimits.values()) {
    sync(limits)
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-today-host]')) {
    const host = el.dataset.todayHost ?? ''
    const ms = today(host)
    el.textContent = todayText(ms, limits.perSite[host])
    el.toggleAttribute('data-over', typeof limits.perSite[host] === 'number' && ms >= (limits.perSite[host] ?? 0))
    el.setAttribute('aria-label', t('optionsTodayAria', [host, formatDuration(ms)]))
  }
}

// --- Add a site ---------------------------------------------------------------

function initAddForm() {
  const form = byId<HTMLFormElement>('add-form')
  const input = byId<HTMLInputElement>('add-input')
  const error = byId('add-error')
  if (!form || !input || !error) {
    return
  }
  const showError = (message: string | null) => {
    error.hidden = message === null
    error.textContent = message ?? ''
    input.setAttribute('aria-invalid', String(message !== null))
  }
  input.addEventListener('input', () => {
    if (!error.hidden) {
      showError(null)
    }
  })
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const host = normalizeSiteInput(input.value)
    if (!host) {
      showError(input.value.trim() ? t('optionsAddInvalid') : t('optionsAddEmpty'))
      input.focus()
      return
    }
    if (order.tracked.includes(host)) {
      showError(t('optionsAddDuplicate', host))
      input.focus()
      return
    }
    showError(null)
    void enable([host]).then((ok) => {
      if (ok) {
        input.value = ''
      }
    })
  })
}

// --- Global limit -------------------------------------------------------------

async function initGlobalLimit() {
  const mount = byId('global-limit')
  if (!mount) {
    return
  }
  const limits = await readLimits()
  const picker = createLimitPicker({
    id: 'global-limit',
    presets: GLOBAL_PRESETS,
    label: t('optionsGlobalLimit'),
    fieldLabel: t('limitCustomGlobalAria'),
    value: toMinutes(limits.global),
    saved: byId('global-limit-saved'),
    commit: (minutes) => saveLimit({ scope: 'global', ms: toMs(minutes) }),
  })
  mount.replaceWith(picker.el)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[LIMITS_KEY]) {
      void readLimits().then((l) => picker.set(toMinutes(l.global)))
    }
  })
}

// --- On-page timer ------------------------------------------------------------

function nearestSize(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) {
    return 1
  }
  return SIZES.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), 1)
}

async function initOverlay() {
  const sw = byId('overlay-switch')
  const radios = [...document.querySelectorAll<HTMLInputElement>('input[name="overlay-size"]')]
  const saved = byId('overlay-saved')

  const renderSwitch = (hidden: boolean) => sw?.setAttribute('aria-checked', String(!hidden))
  const renderSize = (scale: unknown) => {
    const v = nearestSize(scale)
    for (const r of radios) {
      r.checked = Number(r.value) === v
    }
  }

  const { hidden, scale } = await local
    .get(PREFS_KEY)
    .then(normalizePrefs)
    .catch(() => normalizePrefs(undefined))
  renderSwitch(hidden)
  renderSize(scale)

  sw?.addEventListener('click', async () => {
    const next = sw.getAttribute('aria-checked') === 'true' // checked -> hide
    renderSwitch(next)
    await bus.send('setPrefs', { hidden: next })
    flashSaved(saved)
  })
  for (const r of radios) {
    r.addEventListener('change', async () => {
      if (r.checked) {
        await bus.send('setPrefs', { scale: Number(r.value) })
        flashSaved(saved)
      }
    })
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') {
      return
    }
    if (changes[PREFS_KEY]) {
      const prefs = normalizePrefs(changes[PREFS_KEY].newValue)
      renderSwitch(prefs.hidden)
      renderSize(prefs.scale)
    }
  })
}

// --- This week ---------------------------------------------------------------

// The week so far: its total, the daily average and a bar per day.
async function renderWeek() {
  const card = byId('week-card')
  if (!card) {
    return
  }
  const history = historyOf(await local.getAll().catch(() => ({})))
  card.hidden = !hasAnyUsage(history)
  if (card.hidden) {
    return
  }
  const locale = uiLocale()
  const today = dayOf(Date.now())
  const week = periodOf('week', 0, today, firstDayOfWeek(locale))
  const summary = summarize(history, week, today, null)
  byId('week-total')!.textContent = formatDuration(summary.total)
  byId('week-average')!.textContent = t('usageDailyAverage', formatDuration(summary.average))
  const totals = dayBars(history, week.days).map((bar) => periodTotal([bar]))
  const top = Math.max(1, ...totals)
  byId('week-bars')!.replaceChildren(
    ...week.days.map((day, i) => {
      const bar = h('span', { class: 'week-bar', 'data-today': day === today })
      bar.style.setProperty('--v', String(totals[i]! / top))
      return h('span', { class: 'week-day' }, bar, h('span', {}, dayLabel(day, locale, { weekday: 'narrow' })))
    })
  )
}

// --- Boot -----------------------------------------------------------------------

byId('enable-suggested')?.addEventListener('click', () => {
  void enable(SUGGESTED_SITES.map((s) => s.host))
})

// Re-render whenever a grant changes (including the prompts above).
chrome.permissions.onAdded.addListener(() => void render())
chrome.permissions.onRemoved.addListener(() => void render())

// Today's totals tick in the background while this page is open; a new limit
// can also flip a row to over.
chrome.storage.onChanged.addListener((changes, area) => {
  const keys = Object.keys(changes)
  if (area === 'local' && keys.some((k) => k === LIMITS_KEY || k.startsWith(DAY_KEY_PREFIX))) {
    void refreshTodays()
  }
  if (area === 'local' && keys.some((k) => k.startsWith(DAY_KEY_PREFIX))) {
    void renderWeek()
  }
})

setDocumentLang()
localizeDom()
initAddForm()
void initGlobalLimit()
void initOverlay()
void render()
void renderWeek()
