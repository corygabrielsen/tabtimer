import { SUGGESTED_SITES, originsForHost, hostFromOrigin, normalizeHost } from './sites'
import {
  readLimits,
  setGlobalLimit,
  setPerSiteLimit,
  msToMinutes,
  minutesToMs,
  LIMITS_KEY,
  type Limits,
} from './core/limits'
import { storage, todayKeyForHost, HIDDEN_KEY, SCALE_KEY, ELAPSED_KEY_PREFIX } from './storage'
import { localizeDom, t } from './i18n'
import { h, byId, flashSaved, formatDuration, setDocumentLang } from './ui'
import { createLimitPicker, formatChipMinutes, SITE_PRESETS, GLOBAL_PRESETS, type LimitPicker } from './limitPicker'

const LABELS = new Map(SUGGESTED_SITES.map((s) => [s.host, s.label]))
const SIZES = [0.5, 0.75, 1]

function enable(hosts: string[]): Promise<boolean> {
  // Must run during a user gesture — call request first, no awaits before it.
  return chrome.permissions.request({ origins: hosts.flatMap(originsForHost) }).catch(() => false)
}

function disable(host: string): Promise<boolean> {
  return chrome.permissions.remove({ origins: originsForHost(host) }).catch(() => false)
}

async function grantedHosts(): Promise<Set<string>> {
  const perms = await chrome.permissions.getAll().catch(() => ({ origins: [] as string[] }))
  return new Set((perms.origins ?? []).map(hostFromOrigin))
}

function readToday(host: string): Promise<number> {
  return storage.get(todayKeyForHost(host), 0, 'local').catch(() => 0)
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
    commit: (minutes) => setPerSiteLimit(host, toMs(minutes)),
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
  const todays = await Promise.all(tracked.map(readToday))
  if (seq !== renderSeq) {
    return
  }
  if (openLimitHost !== null && !tracked.includes(openLimitHost)) {
    openLimitHost = null
  }
  rowLimits.clear()
  trackedUl.replaceChildren(...tracked.map((host, i) => siteRow(host, limits.perSite[host], todays[i] ?? 0)))
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
  const limits = await readLimits()
  for (const sync of rowLimits.values()) {
    sync(limits)
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-today-host]')) {
    const host = el.dataset.todayHost ?? ''
    const ms = await readToday(host)
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
    const host = normalizeHost(input.value)
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
    commit: (minutes) => setGlobalLimit(toMs(minutes)),
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

  const [hidden, scale] = await Promise.all([
    storage.get(HIDDEN_KEY, false, 'local').catch(() => false),
    storage.get(SCALE_KEY, 1, 'local').catch(() => 1),
  ])
  renderSwitch(hidden)
  renderSize(scale)

  sw?.addEventListener('click', async () => {
    const next = sw.getAttribute('aria-checked') === 'true' // checked -> hide
    renderSwitch(next)
    await storage.set(HIDDEN_KEY, next, 'local').catch(() => undefined)
    flashSaved(saved)
  })
  for (const r of radios) {
    r.addEventListener('change', async () => {
      if (r.checked) {
        await storage.set(SCALE_KEY, Number(r.value), 'local').catch(() => undefined)
        flashSaved(saved)
      }
    })
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') {
      return
    }
    if (changes[HIDDEN_KEY]) {
      renderSwitch(Boolean(changes[HIDDEN_KEY].newValue))
    }
    if (changes[SCALE_KEY]) {
      renderSize(changes[SCALE_KEY].newValue)
    }
  })
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
  if (area === 'local' && keys.some((k) => k === LIMITS_KEY || k.startsWith(`${ELAPSED_KEY_PREFIX}_`))) {
    void refreshTodays()
  }
})

setDocumentLang()
localizeDom()
initAddForm()
void initGlobalLimit()
void initOverlay()
void render()
