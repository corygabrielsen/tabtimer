import { chromeStore, loadThenPatch } from './chrome/store'
import { bus } from './chrome/bus'
import type { StoreChanges } from './ports'
import { formatTime } from './format'
import { dayOf } from './core/day'
import { hourLabel } from './core/usage'
import { originsForSite, siteOfUrl } from './core/site'
import {
  blockAt,
  limitsFor,
  msToMinutes,
  normalizeLimits,
  siteLimitOf,
  DEFAULT_LIMITS,
  type Limits,
} from './core/limits'
import {
  dayKey,
  dayTotal,
  emptyBuckets,
  normalizeDay,
  normalizePrefs,
  siteTotal,
  LIMITS_KEY,
  PREFS_KEY,
  type DayUsage,
} from './core/schema'
import { localizeDom, t } from './i18n'
import { byId, formatDuration, h, setDocumentLang, uiLocale } from './ui'
import { createSiteLimitPicker, type LimitPicker } from './limitPicker'

type ActiveTab = { id: number; url: string }
type View = 'tracked' | 'enable' | 'untracked' | 'loading'
const VIEWS: View[] = ['tracked', 'enable', 'untracked', 'loading']

// Visual state of the tracked view's face.
// open: no limit applies; ok: under every limit; over: blocking now;
// snoozed: over a limit but blocking is paused by "5 more minutes".
type FaceState = 'open' | 'ok' | 'over' | 'snoozed'

const RESET_ARM_MS = 4000

function showView(view: View) {
  for (const v of VIEWS) {
    byId(v)?.toggleAttribute('hidden', v !== view)
  }
}

// Hosts extensions can never run on, even with a grant.
const RESTRICTED_HOSTS = new Set(['chromewebstore.google.com', 'chrome.google.com', 'microsoftedge.microsoft.com'])

// The tab's site, or null where tracking can't run (not http(s), a host
// without a dot, or a restricted host).
function trackableSite(tab: ActiveTab): string | null {
  const site = siteOfUrl(tab.url)
  if (site === null) {
    return null
  }
  const { hostname } = new URL(tab.url)
  return hostname.includes('.') && !RESTRICTED_HOSTS.has(hostname) ? site : null
}

// activeTab grants access to the current tab while the popup is open, so we can
// read its URL (and inject on enable) without any host permission.
function activeTab(): Promise<ActiveTab | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0]
      resolve(tab?.id && tab.url ? { id: tab.id, url: tab.url } : null)
    })
  })
}

type Snapshot = { siteToday: number; globalToday: number; limits: Limits; hours: number[] }

// The strip's full height: the day's busiest hour, or this much if less, so a
// few minutes don't fill it.
const STRIP_FLOOR_MS = 10 * 60_000

// The hours the timeline names: midnight, 6, noon and 18.
const STRIP_MARKS = [0, 6, 12, 18]

const at = (hour: number) => `${(hour / 24) * 100}%`

// Where now falls on the strip.
const nowMark = h('i', { class: 'now' })

function moveNow() {
  const now = new Date()
  nowMark.style.left = at(now.getHours() + now.getMinutes() / 60)
}

// Today's time on this site as a timeline: 24 thin bars, faint marks every
// six hours with their names below, and the now mark.
function renderStrip(base: string, hours: number[]) {
  const strip = byId('strip')
  const axis = byId('strip-axis')
  if (!strip || !axis) {
    return
  }
  const top = Math.max(STRIP_FLOOR_MS, ...hours)
  strip.setAttribute('aria-label', t('popupStripAria', base))
  const placed = <E extends HTMLElement>(el: E, hour: number) => {
    el.style.left = at(hour)
    return el
  }
  moveNow()
  strip.replaceChildren(
    ...STRIP_MARKS.map((hour) => placed(h('i', { class: 'mark' }), hour)),
    ...hours.map((ms) => {
      const bar = h('span', { 'data-on': ms > 0 })
      bar.style.setProperty('--v', String(ms / top))
      return bar
    }),
    nowMark
  )
  const locale = uiLocale()
  axis.replaceChildren(...STRIP_MARKS.map((hour) => placed(h('span', {}, hourLabel(hour, locale)), hour)))
}

function faceFor(base: string, s: Snapshot) {
  const { site: siteLimit, global: globalLimit } = limitsFor(s.limits, base)
  // Not accruing, a block is due only when already over.
  const over = blockAt(s.limits, base, s.siteToday, s.globalToday, Date.now(), false)
  const reason = over && {
    scope: over.scope,
    limit: over.limit,
    elapsed: over.scope === 'site' ? s.siteToday : s.globalToday,
  }
  const snoozed = reason !== null && Date.now() < s.limits.snoozeUntil
  let state: FaceState = 'open'
  if (reason) {
    state = snoozed ? 'snoozed' : 'over'
  } else if (siteLimit !== null || globalLimit !== null) {
    state = 'ok'
  }
  return { state, reason, siteLimit, globalLimit }
}

function renderFace(base: string, s: Snapshot) {
  const face = faceFor(base, s)
  const hero = byId('hero')
  const status = byId('status')
  const today = byId('today')
  const meter = byId('meter')
  const summary = byId('summary')
  const globalLine = byId('global-line')

  hero?.setAttribute('data-state', face.state)
  if (today) {
    today.textContent = formatTime(s.siteToday)
  }
  if (status) {
    status.textContent = {
      open: t('popupStatusTracking'),
      ok: t('popupStatusTracking'),
      over: t('popupStatusOver'),
      snoozed: t('popupStatusSnoozed'),
    }[face.state]
  }

  // The meter tracks this site's own limit; fall back to the all-sites cap.
  const meterLimit = face.siteLimit ?? face.globalLimit
  const meterValue = face.siteLimit !== null ? s.siteToday : s.globalToday
  if (meter) {
    meter.hidden = meterLimit === null
    if (meterLimit !== null) {
      const pct = Math.min(100, (meterValue / meterLimit) * 100)
      meter.style.setProperty('--fill', `${pct}%`)
      meter.setAttribute('aria-valuemax', String(msToMinutes(meterLimit)))
      meter.setAttribute('aria-valuenow', String(Math.min(msToMinutes(meterValue), msToMinutes(meterLimit))))
      meter.setAttribute(
        'aria-label',
        face.siteLimit !== null ? t('popupMeterSiteAria', base) : t('popupMeterGlobalAria')
      )
      meter.setAttribute('aria-valuetext', t('popupUsedOf', [formatDuration(meterValue), formatDuration(meterLimit)]))
    }
  }

  if (summary) {
    summary.textContent = summaryText(face, s, meterLimit, meterValue)
  }

  if (globalLine) {
    // Show the all-sites cap separately when the meter is about this site.
    const globalLimit = face.siteLimit !== null ? face.globalLimit : null
    globalLine.hidden = globalLimit === null
    if (globalLimit !== null) {
      globalLine.textContent = t('popupGlobalLine', [formatDuration(s.globalToday), formatDuration(globalLimit)])
    }
  }
}

function summaryText(
  face: ReturnType<typeof faceFor>,
  s: Snapshot,
  meterLimit: number | null,
  meterValue: number
): string {
  if (face.reason) {
    const over = formatDuration(face.reason.elapsed - face.reason.limit)
    const cause = face.reason.scope === 'site' ? t('popupOverSite', over) : t('popupOverGlobal', over)
    if (face.state === 'snoozed') {
      return `${cause}. ${t('popupSnoozeResumes', formatDuration(Math.max(60000, s.limits.snoozeUntil - Date.now())))}`
    }
    return cause
  }
  if (meterLimit === null) {
    return t('popupNoLimit')
  }
  const left = formatDuration(meterLimit - meterValue)
  return face.siteLimit !== null
    ? t('popupLeftSite', [left, formatDuration(meterLimit)])
    : t('popupLeftGlobal', [left, formatDuration(meterLimit)])
}

const local = chromeStore('local')

function renderTracked(base: string) {
  const siteEl = byId('site')
  if (siteEl) {
    siteEl.textContent = base
    siteEl.title = base
  }

  // Today's usage and the limits: read once, then patched from each change.
  let day: DayUsage = {}
  let limits: Limits = DEFAULT_LIMITS
  let hidden = false
  let last: Snapshot | null = null
  const draw = () => {
    last = { siteToday: siteTotal(day, base), globalToday: dayTotal(day), limits, hours: day[base] ?? emptyBuckets() }
    renderStrip(base, last.hours)
    renderFace(base, last)
    syncLimitField(limits)
  }
  const todayKey = () => dayKey(dayOf(Date.now()))

  // --- daily limit for this site: preset chips, or a custom whole-minutes value ---
  let picker: LimitPicker | null = null
  const syncLimitField = (limits: Limits) => {
    const mount = byId('site-limit')
    if (!mount) {
      return
    }
    if (!picker) {
      picker = createSiteLimitPicker({
        id: 'site-limit',
        site: base,
        value: siteLimitOf(limits, base),
        saved: byId('site-limit-saved'),
      })
      mount.replaceWith(picker.el)
      return
    }
    picker.set(siteLimitOf(limits, base))
  }

  // --- overlay switch ---
  const toggleBtn = byId('toggle-btn')
  const renderToggle = () => toggleBtn?.setAttribute('aria-checked', String(!hidden))
  toggleBtn?.addEventListener('click', () => {
    void bus.send('setPrefs', { hidden: !hidden })
  })

  // --- reset: arm, then confirm (today's time can't be recovered) ---
  const resetBtn = byId<HTMLButtonElement>('reset-btn')
  let disarm = 0
  const setArmed = (armed: boolean) => {
    if (!resetBtn) {
      return
    }
    resetBtn.toggleAttribute('data-armed', armed)
    resetBtn.textContent = armed ? t('popupResetConfirm') : t('popupResetToday')
    resetBtn.setAttribute('aria-label', armed ? t('popupResetConfirmAria', base) : t('popupResetAria', base))
  }
  setArmed(false)
  resetBtn?.addEventListener('click', () => {
    if (!resetBtn.hasAttribute('data-armed')) {
      setArmed(true)
      disarm = window.setTimeout(() => setArmed(false), RESET_ARM_MS)
      return
    }
    window.clearTimeout(disarm)
    setArmed(false)
    if (last) {
      renderFace(base, { ...last, siteToday: 0, hours: emptyBuckets() }) // optimistic
    }
    void bus.send('resetToday', { site: base })
  })
  resetBtn?.addEventListener('blur', () => {
    window.clearTimeout(disarm)
    setArmed(false)
  })

  // Keep the now mark, the snooze countdown and the summary current while the
  // popup is open.
  window.setInterval(() => {
    if (last) {
      moveNow()
      renderFace(base, last)
    }
  }, 15000)

  const read = (key: string) => local.get(key).catch(() => undefined)
  const load = async () => {
    const [d, l, p] = await Promise.all([read(todayKey()), read(LIMITS_KEY), read(PREFS_KEY)])
    day = normalizeDay(d)
    limits = normalizeLimits(l)
    hidden = normalizePrefs(p).hidden
  }
  const patch = (changes: StoreChanges) => {
    if (PREFS_KEY in changes) {
      hidden = normalizePrefs(changes[PREFS_KEY]!.newValue).hidden
      renderToggle()
    }
    const key = todayKey()
    if (key in changes) {
      day = normalizeDay(changes[key]!.newValue)
    }
    if (LIMITS_KEY in changes) {
      limits = normalizeLimits(changes[LIMITS_KEY]!.newValue)
    }
    if (key in changes || LIMITS_KEY in changes) {
      draw()
    }
  }
  void loadThenPatch(local, load, patch).then(() => {
    draw()
    renderToggle()
    showView('tracked')
  })
}

function renderEnable(tab: ActiveTab, base: string) {
  const origins = originsForSite(base)
  const siteEl = byId('enable-site')
  if (siteEl) {
    siteEl.textContent = base
    siteEl.title = base
  }
  const btn = byId('enable-btn')
  btn?.setAttribute('aria-label', t('popupEnableSiteAria', base))
  showView('enable')

  btn?.addEventListener('click', () => {
    // Must run during the click gesture — request first, no awaits before it.
    void chrome.permissions.request({ origins }).then((granted) => {
      if (!granted) {
        return
      }
      // Inject now so tracking starts immediately, without a reload.
      void chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {})
      renderTracked(base)
    })
  })
}

async function init() {
  setDocumentLang()
  localizeDom()
  byId('manage-btn')?.addEventListener('click', () => chrome.runtime.openOptionsPage())

  const tab = await activeTab()
  const base = tab && trackableSite(tab)
  if (!tab || !base) {
    showView('untracked')
    return
  }

  const granted = await chrome.permissions.contains({ origins: originsForSite(base) }).catch(() => false)

  if (granted) {
    renderTracked(base)
  } else {
    renderEnable(tab, base)
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void init()
})
