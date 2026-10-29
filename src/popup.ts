import { chromeStore } from './chrome/store'
import { bus } from './chrome/bus'
import { formatTime } from './format'
import { dayOf } from './core/day'
import { originsForSite, siteOf } from './core/site'
import { msToMinutes, minutesToMs, evaluateLimits, normalizeLimits, type Limits } from './core/limits'
import {
  dayKey,
  dayTotal,
  normalizeDay,
  normalizePrefs,
  normalizeSnooze,
  siteTotal,
  DAY_KEY_PREFIX,
  LIMITS_KEY,
  PREFS_KEY,
  SNOOZE_KEY,
} from './core/schema'
import { localizeDom, t } from './i18n'
import { byId, formatDuration, setDocumentLang } from './ui'
import { createLimitPicker, SITE_PRESETS, type LimitPicker } from './limitPicker'

type ActiveTab = { id: number; hostname: string; protocol: string }
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

function isTrackable(tab: ActiveTab): boolean {
  return (
    (tab.protocol === 'http:' || tab.protocol === 'https:') &&
    tab.hostname.includes('.') &&
    !RESTRICTED_HOSTS.has(tab.hostname)
  )
}

// activeTab grants access to the current tab while the popup is open, so we can
// read its URL (and inject on enable) without any host permission.
function activeTab(): Promise<ActiveTab | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0]
      if (!tab?.id || !tab.url) {
        resolve(null)
        return
      }
      try {
        const url = new URL(tab.url)
        resolve({ id: tab.id, hostname: url.hostname, protocol: url.protocol })
      } catch {
        resolve(null)
      }
    })
  })
}

type Snapshot = { siteToday: number; globalToday: number; limits: Limits; snoozeUntil: number }

function faceFor(base: string, s: Snapshot) {
  const siteLimit = s.limits.perSite[base]
  const hasSite = typeof siteLimit === 'number' && siteLimit > 0
  const hasGlobal = typeof s.limits.global === 'number' && s.limits.global > 0
  const reason = evaluateLimits(s.limits, base, s.siteToday, s.globalToday)
  const snoozed = reason !== null && Date.now() < s.snoozeUntil
  let state: FaceState = 'open'
  if (reason) {
    state = snoozed ? 'snoozed' : 'over'
  } else if (hasSite || hasGlobal) {
    state = 'ok'
  }
  return { state, reason, hasSite, hasGlobal, siteLimit: hasSite ? siteLimit : null }
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
  const meterLimit = face.siteLimit ?? (face.hasGlobal ? s.limits.global : null)
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
    const showGlobal = face.hasGlobal && face.siteLimit !== null && s.limits.global !== null
    globalLine.hidden = !showGlobal
    if (showGlobal && s.limits.global !== null) {
      globalLine.textContent = t('popupGlobalLine', [formatDuration(s.globalToday), formatDuration(s.limits.global)])
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
      return `${cause} ${t('popupSnoozeResumes', formatDuration(Math.max(60000, s.snoozeUntil - Date.now())))}`
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

  const snapshot = async (): Promise<Snapshot> => {
    const read = (key: string) => local.get(key).catch(() => undefined)
    const [day, limits, snoozeUntil] = await Promise.all([
      read(dayKey(dayOf(Date.now()))).then(normalizeDay),
      read(LIMITS_KEY).then(normalizeLimits),
      read(SNOOZE_KEY).then(normalizeSnooze),
    ])
    return { siteToday: siteTotal(day, base), globalToday: dayTotal(day), limits, snoozeUntil }
  }

  let last: Snapshot | null = null
  const refresh = async () => {
    last = await snapshot()
    renderFace(base, last)
    syncLimitField(last.limits)
  }

  // --- daily limit for this site: preset chips, or a custom whole-minutes value ---
  const siteMinutes = (limits: Limits): number | null => {
    const ms = limits.perSite[base]
    return typeof ms === 'number' && ms > 0 ? msToMinutes(ms) : null
  }
  let picker: LimitPicker | null = null
  const syncLimitField = (limits: Limits) => {
    const mount = byId('site-limit')
    if (!mount) {
      return
    }
    if (!picker) {
      picker = createLimitPicker({
        id: 'site-limit',
        presets: SITE_PRESETS,
        label: t('popupLimitAria', base),
        fieldLabel: t('limitCustomSiteAria', base),
        value: siteMinutes(limits),
        saved: byId('site-limit-saved'),
        commit: async (minutes) => {
          await bus.send('setLimit', { scope: 'site', site: base, ms: minutes === null ? null : minutesToMs(minutes) })
        },
      })
      mount.replaceWith(picker.el)
      return
    }
    picker.set(siteMinutes(limits))
  }

  // --- overlay switch ---
  const toggleBtn = byId('toggle-btn')
  const readHidden = () =>
    local
      .get(PREFS_KEY)
      .then((v) => normalizePrefs(v).hidden)
      .catch(() => false)
  const renderToggle = async () => {
    toggleBtn?.setAttribute('aria-checked', String(!(await readHidden())))
  }
  toggleBtn?.addEventListener('click', async () => {
    await bus.send('setPrefs', { hidden: !(await readHidden()) })
    await renderToggle()
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
      renderFace(base, { ...last, siteToday: 0 }) // optimistic
    }
    void bus.send('resetToday', { site: base })
  })
  resetBtn?.addEventListener('blur', () => {
    window.clearTimeout(disarm)
    setArmed(false)
  })

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') {
      return
    }
    if (changes[PREFS_KEY]) {
      void renderToggle()
    }
    const relevant = Object.keys(changes).some(
      (k) => k === LIMITS_KEY || k === SNOOZE_KEY || k.startsWith(DAY_KEY_PREFIX)
    )
    if (relevant) {
      void refresh()
    }
  })
  // Keep the snooze countdown and summary current while the popup is open.
  window.setInterval(() => {
    if (last) {
      renderFace(base, last)
    }
  }, 15000)

  void Promise.all([refresh(), renderToggle()]).then(() => showView('tracked'))
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
  if (!tab || !isTrackable(tab)) {
    showView('untracked')
    return
  }

  const base = siteOf(tab.hostname)
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
