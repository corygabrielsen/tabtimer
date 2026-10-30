// Small typed DOM helpers shared by the extension pages. Text is always set
// through textContent; nothing here parses HTML.
import { MAX_LIMIT_MINUTES, MIN_LIMIT_MINUTES } from './core/limits'
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

// Make `nodes` the children of `parent`, in order, without moving the child
// that holds focus: a moved or removed node loses focus (and fires blur),
// which would end an edit in progress there. Its siblings move around it.
export function placeChildren(parent: Element, nodes: Node[]): void {
  const active = document.activeElement
  const kept = nodes.find((node) => node.parentNode === parent && active !== null && node.contains(active)) as
    ChildNode | undefined
  if (!kept) {
    parent.replaceChildren(...nodes)
    return
  }
  for (const child of [...parent.childNodes]) {
    if (!nodes.includes(child)) {
      child.remove()
    }
  }
  const at = nodes.indexOf(kept)
  kept.before(...nodes.slice(0, at))
  kept.after(...nodes.slice(at + 1))
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

// How many snoozes were taken: "Snoozed twice" ('' for none).
export function snoozedText(count: number): string {
  if (count <= 0) {
    return ''
  }
  return count === 1 ? t('snoozedOnce') : count === 2 ? t('snoozedTwice') : t('snoozedTimes', String(count))
}

// Read a minutes field: null when blank, else a whole number of minutes in
// the settable range, or 'invalid'.
export function validateMinutes(raw: string): number | null | 'invalid' {
  const value = raw.trim()
  if (value === '') {
    return null
  }
  const n = Number(value)
  return /^\d+$/.test(value) && n >= MIN_LIMIT_MINUTES && n <= MAX_LIMIT_MINUTES ? n : 'invalid'
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
