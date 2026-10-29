// Small typed DOM helpers shared by the popup and options page. Text is always
// set through textContent; nothing here parses HTML.
import { t } from './i18n'

type Attrs = Record<string, string | boolean | undefined>
type Child = Node | string | null | undefined | false

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) {
      continue
    }
    el.setAttribute(name, value === true ? '' : value)
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue
    }
    el.append(child)
  }
  return el
}

export function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

// Localize <html lang> to the browser UI language (the strings come from it).
export function setDocumentLang(): void {
  const lang = chrome.i18n.getUILanguage?.()
  if (lang) {
    document.documentElement.lang = lang
  }
}

// Human duration for limits and remaining time: "45 min", "2 h", "1 h 05 min".
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (hours === 0) {
    return t('durMinutes', String(minutes))
  }
  if (minutes === 0) {
    return t('durHours', String(hours))
  }
  return t('durHoursMinutes', [String(hours), String(minutes).padStart(2, '0')])
}

export const MAX_LIMIT_MINUTES = 1440

export type MinutesParse = { ok: true; value: string } | { ok: false }

// Validate a minutes field: blank (no limit) or a whole number 1..1440.
// Returns the canonical text to hand to parseLimitMinutes.
export function validateMinutes(raw: string): MinutesParse {
  const value = raw.trim()
  if (value === '') {
    return { ok: true, value }
  }
  if (!/^\d+$/.test(value)) {
    return { ok: false }
  }
  const n = Number(value)
  if (n < 1 || n > MAX_LIMIT_MINUTES) {
    return { ok: false }
  }
  return { ok: true, value: String(n) }
}

// Briefly show a "Saved" acknowledgement in a polite live region.
export function flashSaved(el: HTMLElement | null): void {
  if (!el) {
    return
  }
  el.textContent = t('savedNotice')
  el.classList.add('is-on')
  const prev = Number(el.dataset.timer)
  if (prev) {
    window.clearTimeout(prev)
  }
  el.dataset.timer = String(
    window.setTimeout(() => {
      el.classList.remove('is-on')
    }, 1600)
  )
}

// Wire a minutes field: validate on input (feedback only), commit on change
// (blur or Enter), never per keystroke — a half-typed "3" of "30" must not
// become a 3-minute limit.
export function bindMinutesField(
  input: HTMLInputElement,
  errorEl: HTMLElement,
  savedEl: HTMLElement | null,
  commit: (canonical: string) => Promise<void>
): void {
  const check = (): MinutesParse => {
    const result = validateMinutes(input.value)
    input.setAttribute('aria-invalid', String(!result.ok))
    errorEl.hidden = result.ok
    errorEl.textContent = result.ok ? '' : t('limitInvalid', String(MAX_LIMIT_MINUTES))
    return result
  }
  input.addEventListener('input', () => {
    // Only clear a shown error while typing; don't nag mid-entry.
    if (input.getAttribute('aria-invalid') === 'true') {
      check()
    }
  })
  input.addEventListener('change', () => {
    const result = check()
    if (!result.ok) {
      return
    }
    input.value = result.value
    input.defaultValue = result.value
    void commit(result.value).then(() => flashSaved(savedEl))
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.getAttribute('aria-invalid') === 'true') {
      e.preventDefault()
      input.value = input.defaultValue
      check()
    }
  })
}
