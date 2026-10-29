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

// The browser UI language, the one the strings come from.
export function uiLocale(): string {
  return chrome.i18n.getUILanguage?.() || 'en'
}

// The locale's first day of the week (0 = Sunday … 6 = Saturday); Sunday
// where the browser can't say.
export function firstDayOfWeek(locale: string): number {
  type WeekInfo = { firstDay: number }
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => WeekInfo; weekInfo?: WeekInfo }
    const firstDay = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay
    return typeof firstDay === 'number' ? firstDay % 7 : 0
  } catch {
    return 0
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

// Validate a minutes field: blank or a whole number 1..1440. Returns the
// canonical text (leading zeros dropped).
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
