import { SUGGESTED_SITES, grantsOf, originsForSite, normalizeSiteInput, type Grants } from './core/site'
import { limitsFor, minutesToMs, normalizeLimits, siteLimitOf, DEFAULT_LIMITS, type Limits } from './core/limits'
import { dayOf } from './core/day'
import {
  barTotal,
  dayLabel,
  hasAnyUsage,
  historyOf,
  patchHistory,
  periodOf,
  summarize,
  withUncredited,
  type History,
} from './core/usage'
import { siteOverAt, siteTodayAt } from './core/messages'
import { normalizePrefs, snapScale, DEFAULT_PREFS, LIMITS_KEY, PREFS_KEY, type Prefs } from './core/schema'
import { chromeStore, loadThenPatch } from './chrome/store'
import type { StoreChanges } from './ports'
import { bus } from './chrome/bus'
import { liveToday } from './liveToday'
import { localizeDom, t } from './i18n'
import { h, byId, firstDayOfWeek, flashSaved, formatDuration, placeChildren, setDocumentLang, uiLocale } from './ui'
import {
  createLimitPicker,
  createSiteLimitPicker,
  formatChipMinutes,
  GLOBAL_PRESETS,
  type LimitPicker,
} from './limitPicker'

const LABELS = new Map(SUGGESTED_SITES.map((s) => [s.host, s.label]))

function enable(hosts: string[]): Promise<boolean> {
  // Must run during a user gesture — call request first, no awaits before it.
  return chrome.permissions.request({ origins: hosts.flatMap(originsForSite) }).catch(() => false)
}

// Stop: remove exactly the origins granted, however they were granted.
function disable(origins: string[]): Promise<boolean> {
  return chrome.permissions.remove({ origins }).catch(() => false)
}

async function granted(): Promise<Grants> {
  const perms = await chrome.permissions.getAll().catch(() => ({ origins: [] as string[] }))
  return grantsOf(perms.origins ?? [])
}

const local = chromeStore('local')

// The stored limits, days and prefs, read once and then patched from each
// change (onStorageChange).
let limits: Limits = DEFAULT_LIMITS
let history: History = new Map()
let prefs: Prefs = DEFAULT_PREFS
// Today's times as the worker sees them, the open interval's included.
const live = liveToday(
  () => history.get(dayOf(Date.now())) ?? {},
  () => {
    refreshTodays()
    renderWeek()
  }
)
const loaded = loadThenPatch(
  local,
  async () => {
    const [items] = await Promise.all([local.getAll().catch(() => ({}) as Record<string, unknown>), live.ready])
    limits = normalizeLimits(items[LIMITS_KEY])
    history = historyOf(items)
    prefs = normalizePrefs(items[PREFS_KEY])
  },
  (changes) => onStorageChange(changes)
)

// --- Tracked site rows -------------------------------------------------------

// The table is too narrow for a chip row per site, so each row shows its limit
// as a compact button that expands the row with the same picker the popup uses.
// One row is open at a time, and stays open across re-renders.
let openLimitHost: string | null = null
const rowLimits = new Map<string, (limits: Limits) => void>()

function limitCell(host: string, current: number | null): { toggle: HTMLElement; panel: HTMLElement } {
  const id = `limit-${host}`
  const panelId = `${id}-panel`
  const toggle = h('button', {
    type: 'button',
    class: 'limit-toggle',
    'data-label': t('optionsColLimit'),
    'aria-expanded': 'false',
    'aria-controls': panelId,
    'data-host': host,
  })
  const saved = h('span', { class: 'saved', role: 'status' })
  const label = (minutes: number | null) => {
    toggle.textContent = minutes === null ? t('limitOff') : formatChipMinutes(minutes)
    toggle.setAttribute(
      'aria-label',
      t('optionsLimitToggleAria', [host, minutes === null ? t('limitOff') : formatDuration(minutesToMs(minutes))])
    )
  }
  const picker = createSiteLimitPicker({
    id,
    site: host,
    label: t('optionsSiteLimitAria', host),
    value: current,
    saved,
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
  label(current)
  rowLimits.set(host, (limits) => {
    const minutes = siteLimitOf(limits, host)
    picker.set(minutes)
    label(minutes)
  })
  if (openLimitHost === host) {
    setOpen(true)
  }
  return { toggle, panel }
}

// A row's time today, flagged once it reaches the site's limit.
function paintToday(el: HTMLElement, host: string): void {
  const now = Date.now()
  const ms = siteTodayAt(live.totals(), host, now)
  const over = siteOverAt(live.totals(), host, limitsFor(limits, host).site, now)
  el.textContent = over ? t('optionsTodayOver', formatDuration(ms)) : formatDuration(ms)
  el.toggleAttribute('data-over', over)
  el.setAttribute('aria-label', t('optionsTodayAria', [host, formatDuration(ms)]))
}

// `origins`: the row's grants as of the latest render.
function stopButton(host: string, name: string, origins: () => string[]): HTMLButtonElement {
  const stop = h(
    'button',
    { type: 'button', class: 'btn btn-quiet btn-sm stop', 'aria-label': t('optionsStopAria', name), 'data-host': host },
    t('optionsStop')
  )
  stop.addEventListener('click', () => {
    awaitFocus({ list: 'tracked', host }, disable(origins()))
  })
  return stop
}

function siteRow(host: string, origins: () => string[]): HTMLLIElement {
  const label = LABELS.get(host)
  const name = h(
    'div',
    { class: 'site-name' },
    h('strong', { title: label ?? host }, label ?? host),
    label ? h('span', { title: host }, host) : null
  )
  const today = h('span', { class: 'site-today figure', 'data-label': t('optionsColToday'), 'data-today-host': host })
  paintToday(today, host)
  const { toggle, panel } = limitCell(host, siteLimitOf(limits, host))
  return h('li', { class: 'site-row', 'data-host': host }, name, today, toggle, stopButton(host, host, origins), panel)
}

// A grant for every site (from Chrome's own site access controls): its own
// row, with nothing to count or limit apart.
const ALL_SITES = '*'

function allSitesRow(origins: () => string[]): HTMLLIElement {
  const name = t('optionsGlobalLimit')
  return h(
    'li',
    { class: 'site-row', 'data-host': ALL_SITES },
    h('div', { class: 'site-name' }, h('strong', { title: name }, name)),
    h('span'),
    h('span'),
    stopButton(ALL_SITES, name, origins)
  )
}

function suggestionChip(label: string, host: string): HTMLLIElement {
  const btn = h(
    'button',
    { type: 'button', class: 'chip', 'aria-label': t('optionsTrackAria', [label, host]), 'data-host': host },
    label
  )
  btn.addEventListener('click', () => {
    awaitFocus({ list: 'suggested', host }, enable([host]))
  })
  return h('li', {}, btn)
}

// After a row disappears (stop / track), keep keyboard focus nearby instead of
// dropping it to <body>.
type FocusTarget = { list: 'tracked' | 'suggested'; host: string }
let pendingFocus: FocusTarget | null = null

// Where focus goes once a grant change re-renders; dropped if the change
// didn't happen (no render follows to use it).
function awaitFocus(target: FocusTarget, changed: Promise<boolean>): void {
  pendingFocus = target
  void changed.then((ok) => {
    if (!ok && pendingFocus === target) {
      pendingFocus = null
    }
  })
}

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
    byId('add-input')?.focus()
  }
}

let order = { tracked: [] as string[], suggested: [] as string[] }

// The rows and chips, by host, kept across renders: a grant change updates
// the list around them, so a limit being edited in a row is never rebuilt
// or moved (that blurs it, and a blur saves what was typed so far).
const rows = new Map<string, HTMLLIElement>()
const rowOrigins = new Map<string, string[]>()
const chips = new Map<string, HTMLLIElement>()

function rowFor(host: string, origins: string[]): HTMLLIElement {
  rowOrigins.set(host, origins)
  let li = rows.get(host)
  if (!li) {
    const current = () => rowOrigins.get(host) ?? []
    li = host === ALL_SITES ? allSitesRow(current) : siteRow(host, current)
    rows.set(host, li)
  }
  return li
}

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

  const [grants] = await Promise.all([granted(), loaded])
  const sites = grants.sites

  // Suggested sites first (by label), then the user's own (by host).
  const tracked = [
    ...SUGGESTED_SITES.filter((s) => sites.has(s.host)).map((s) => s.host),
    ...[...sites.keys()].filter((host) => !LABELS.has(host)).sort(),
  ]
  if (seq !== renderSeq) {
    return
  }
  if (openLimitHost !== null && !tracked.includes(openLimitHost)) {
    openLimitHost = null
  }
  const hosts = grants.all.length > 0 ? [...tracked, ALL_SITES] : tracked
  for (const host of rows.keys()) {
    if (!hosts.includes(host)) {
      rows.delete(host)
      rowOrigins.delete(host)
      rowLimits.delete(host)
    }
  }
  const items = hosts.map((host) => rowFor(host, host === ALL_SITES ? grants.all : sites.get(host)!))
  placeChildren(trackedUl, items)
  byId('tracked-empty')?.toggleAttribute('hidden', items.length > 0)
  const count = byId('tracked-count')
  if (count) {
    count.textContent = items.length > 0 ? String(items.length) : ''
  }
  document.querySelector('.cols')?.toggleAttribute('hidden', items.length === 0)

  // Every site granted: nothing left to suggest.
  const untracked = grants.all.length > 0 ? [] : SUGGESTED_SITES.filter((s) => !sites.has(s.host))
  const chipFor = (label: string, host: string) => {
    const chip = chips.get(host) ?? suggestionChip(label, host)
    chips.set(host, chip)
    return chip
  }
  placeChildren(
    suggestedUl,
    untracked.map((s) => chipFor(s.label, s.host))
  )
  // Every suggestion tracked: no Suggested section at all.
  document.querySelector('.suggest-head')?.toggleAttribute('hidden', untracked.length === 0)
  suggestedUl.hidden = untracked.length === 0

  const prev = order
  order = {
    tracked: hosts,
    suggested: untracked.map((s) => s.host),
  }
  restoreFocus(prev)
}

function refreshTodays() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-today-host]')) {
    paintToday(el, el.dataset.todayHost ?? '')
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

let globalPicker: LimitPicker | null = null

async function initGlobalLimit() {
  const mount = byId('global-limit')
  if (!mount) {
    return
  }
  await loaded
  const picker = createLimitPicker({
    id: 'global-limit',
    presets: GLOBAL_PRESETS,
    label: t('optionsGlobalLimit'),
    fieldLabel: t('limitCustomGlobalAria'),
    value: limits.global,
    saved: byId('global-limit-saved'),
    // The service worker applies each edit to the latest stored limits, so
    // edits from here and the popup both survive.
    commit: async (minutes) => (await bus.send('setLimit', { scope: 'global', minutes })).ok,
  })
  mount.replaceWith(picker.el)
  globalPicker = picker
}

// --- On-page timer ------------------------------------------------------------

const sw = byId('overlay-switch')
const radios = [...document.querySelectorAll<HTMLInputElement>('input[name="overlay-size"]')]

function paintPrefs({ hidden, scale }: Prefs): void {
  sw?.setAttribute('aria-checked', String(!hidden))
  const v = snapScale(scale)
  for (const r of radios) {
    r.checked = Number(r.value) === v
  }
}

async function initOverlay() {
  const saved = byId('overlay-saved')
  await loaded
  paintPrefs(prefs)

  // Saved once the worker confirms; otherwise back to the stored prefs.
  const confirm = (ok: boolean) => (ok ? flashSaved(saved) : paintPrefs(prefs))
  sw?.addEventListener('click', async () => {
    const next = sw.getAttribute('aria-checked') === 'true' // checked -> hide
    sw.setAttribute('aria-checked', String(!next))
    confirm((await bus.send('setPrefs', { hidden: next })).ok)
  })
  for (const r of radios) {
    r.addEventListener('change', async () => {
      if (r.checked) {
        confirm((await bus.send('setPrefs', { scale: Number(r.value) })).ok)
      }
    })
  }
}

// --- This week ---------------------------------------------------------------

const locale = uiLocale()
const thisWeek = () => periodOf('week', 0, dayOf(Date.now()), firstDayOfWeek(locale))

// The week so far: its total, the daily average and a bar per day.
function renderWeek() {
  const card = byId('week-card')
  if (!card) {
    return
  }
  const now = Date.now()
  const today = dayOf(now)
  const shown = withUncredited(history, live.totals(), now)
  card.hidden = !hasAnyUsage(shown, today)
  if (card.hidden) {
    return
  }
  const week = thisWeek()
  const summary = summarize(shown, week, today, null)
  byId('week-total')!.textContent = formatDuration(summary.total)
  byId('week-average')!.textContent = t('usageDailyAverage', formatDuration(summary.average))
  const totals = summary.bars.map((bar) => barTotal(bar))
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
  // The button goes with the last suggestion.
  awaitFocus({ list: 'suggested', host: '' }, enable(SUGGESTED_SITES.map((s) => s.host)))
})

// Re-render whenever a grant changes (including the prompts above).
chrome.permissions.onAdded.addListener(() => void render())
chrome.permissions.onRemoved.addListener(() => void render())

// Time ticks in the background while this page is open, and limits and prefs
// can change from the popup or the activity page.
function onStorageChange(changes: StoreChanges): void {
  const days = patchHistory(history, changes)
  if (LIMITS_KEY in changes) {
    limits = normalizeLimits(changes[LIMITS_KEY]!.newValue)
    for (const sync of rowLimits.values()) {
      sync(limits)
    }
    globalPicker?.set(limits.global)
  }
  if (PREFS_KEY in changes) {
    prefs = normalizePrefs(changes[PREFS_KEY]!.newValue)
    paintPrefs(prefs)
  }
  // A new limit can flip a row to over.
  if (LIMITS_KEY in changes) {
    refreshTodays()
  }
  const week = thisWeek().days
  if (days.some((day) => week.includes(day))) {
    renderWeek()
  }
}

setDocumentLang()
localizeDom()
initAddForm()
void initGlobalLimit()
void initOverlay()
void render()
void loaded.then(renderWeek)
