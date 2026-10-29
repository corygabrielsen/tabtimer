import { storage, todayKeyForHost, HIDDEN_KEY, ELAPSED_KEY_PREFIX, baseHost, readGlobalElapsedToday } from './storage'
import { sendMessage } from './messages'
import { formatTime } from './format'
import { originsForHost } from './sites'
import {
  readLimits,
  readSnoozeUntil,
  setPerSiteLimit,
  msToMinutes,
  parseLimitMinutes,
  evaluateLimits,
  LIMITS_KEY,
  BLOCK_SNOOZE_KEY,
  type Limits,
} from './limits'
import { localizeDom, t } from './i18n'
import { byId, bindMinutesField, formatDuration, setDocumentLang } from './ui'

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

function renderTracked(tab: ActiveTab, base: string) {
  const key = todayKeyForHost(tab.hostname)
  const siteEl = byId('site')
  if (siteEl) {
    siteEl.textContent = base
    siteEl.title = base
  }

  const snapshot = async (): Promise<Snapshot> => {
    const [siteToday, globalToday, limits, snoozeUntil] = await Promise.all([
      storage.get(key, 0, 'local').catch(() => 0),
      readGlobalElapsedToday().catch(() => 0),
      readLimits(),
      readSnoozeUntil(),
    ])
    return { siteToday, globalToday, limits, snoozeUntil }
  }

  let last: Snapshot | null = null
  const refresh = async () => {
    last = await snapshot()
    renderFace(base, last)
    syncLimitField(last.limits)
  }

  // --- daily limit for this site (commit on change, never per keystroke) ---
  const limitInput = byId<HTMLInputElement>('site-limit')
  const limitError = byId('site-limit-error')
  const syncLimitField = (limits: Limits) => {
    if (!limitInput || document.activeElement === limitInput) {
      return
    }
    const ms = limits.perSite[base]
    const value = typeof ms === 'number' ? String(msToMinutes(ms)) : ''
    limitInput.value = value
    limitInput.defaultValue = value
  }
  if (limitInput && limitError) {
    limitInput.setAttribute('aria-label', t('popupLimitAria', base))
    bindMinutesField(limitInput, limitError, byId('site-limit-saved'), (value) =>
      setPerSiteLimit(base, parseLimitMinutes(value))
    )
  }

  // --- overlay switch ---
  const toggleBtn = byId('toggle-btn')
  const renderToggle = async () => {
    const hidden = await storage.get(HIDDEN_KEY, false, 'local').catch(() => false)
    toggleBtn?.setAttribute('aria-checked', String(!hidden))
  }
  toggleBtn?.addEventListener('click', async () => {
    const hidden = await storage.get(HIDDEN_KEY, false, 'local').catch(() => false)
    await storage.set(HIDDEN_KEY, !hidden, 'local').catch(() => undefined)
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
    void sendMessage({ type: 'resetKey', key }).catch(() => undefined)
  })
  resetBtn?.addEventListener('blur', () => {
    window.clearTimeout(disarm)
    setArmed(false)
  })

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') {
      return
    }
    if (changes[HIDDEN_KEY]) {
      void renderToggle()
    }
    const relevant = Object.keys(changes).some(
      (k) => k === LIMITS_KEY || k === BLOCK_SNOOZE_KEY || k.startsWith(`${ELAPSED_KEY_PREFIX}_`)
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
  const origins = originsForHost(base)
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
      renderTracked(tab, base)
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

  const base = baseHost(tab.hostname)
  const granted = await chrome.permissions.contains({ origins: originsForHost(base) }).catch(() => false)

  if (granted) {
    renderTracked(tab, base)
  } else {
    renderEnable(tab, base)
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void init()
})
