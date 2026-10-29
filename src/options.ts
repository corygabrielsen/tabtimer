import { SUGGESTED_SITES, originsForHost, hostFromOrigin, normalizeHost } from './sites'
import { readLimits, setGlobalLimit, setPerSiteLimit, msToMinutes, parseLimitMinutes, LIMITS_KEY } from './limits'
import { storage, todayKeyForHost, HIDDEN_KEY, SCALE_KEY, ELAPSED_KEY_PREFIX } from './storage'
import { localizeDom, t } from './i18n'
import { h, byId, bindMinutesField, flashSaved, formatDuration, setDocumentLang } from './ui'

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

function limitField(host: string, currentMs: number | undefined): { wrap: HTMLElement; error: HTMLElement } {
  const value = typeof currentMs === 'number' ? String(msToMinutes(currentMs)) : ''
  const errorId = `limit-error-${host}`
  const input = h('input', {
    class: 'field',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    placeholder: t('optionsLimitOff'),
    'aria-label': t('optionsSiteLimitAria', host),
    'aria-describedby': errorId,
    'data-host': host,
  })
  input.value = value
  input.defaultValue = value
  const saved = h('span', { class: 'saved', role: 'status' })
  const error = h('p', { id: errorId, class: 'error', hidden: true })
  bindMinutesField(input, error, saved, (v) => setPerSiteLimit(host, parseLimitMinutes(v)))
  const wrap = h('span', { class: 'minutes' }, input, h('span', { class: 'unit' }, t('optionsMinutes')), saved)
  return { wrap, error }
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
  const { wrap, error } = limitField(host, limitMs)
  const stop = h(
    'button',
    { type: 'button', class: 'btn btn-quiet stop', 'aria-label': t('optionsStopAria', host), 'data-host': host },
    t('optionsStop')
  )
  stop.addEventListener('click', () => {
    pendingFocus = { list: 'tracked', host }
    void disable(host)
  })
  return h('li', { class: 'site-row', 'data-host': host }, name, today, wrap, stop, error)
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

async function render() {
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
  const input = byId<HTMLInputElement>('global-limit')
  const error = byId('global-limit-error')
  if (!input || !error) {
    return
  }
  const sync = async () => {
    if (document.activeElement === input) {
      return
    }
    const limits = await readLimits()
    const value = limits.global ? String(msToMinutes(limits.global)) : ''
    input.value = value
    input.defaultValue = value
  }
  await sync()
  bindMinutesField(input, error, byId('global-limit-saved'), (v) => setGlobalLimit(parseLimitMinutes(v)))
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[LIMITS_KEY]) {
      void sync()
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
