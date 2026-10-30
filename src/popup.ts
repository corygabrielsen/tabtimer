import { chromeStore, loadThenPatch } from './chrome/store'
import { bus } from './chrome/bus'
import type { StoreChanges } from './ports'
import { formatTime } from './format'
import { dayOf } from './core/day'
import { overAt, totalsAt, type TabState } from './core/messages'
import { overSegments } from './core/snooze'
import { hourLabel, splitAtLimit, withUncredited } from './core/usage'
import { isTracked, originsForSite, trackableSiteOfUrl } from './core/site'
import { limitsFor, msToMinutes, normalizeLimits, siteLimitOf, DEFAULT_LIMITS, type Limits } from './core/limits'
import { dayKey, emptyBuckets, normalizeDay, normalizePrefs, LIMITS_KEY, PREFS_KEY, type DayUsage } from './core/schema'
import { localizeDom, t } from './i18n'
import { byId, formatDuration, h, setDocumentLang, snoozedText, uiLocale } from './ui'
import { drawBar, drawMeter } from './bars'
import { createSiteLimitPicker, type LimitPicker } from './limitPicker'

type ActiveTab = { id: number; url: string }
type View = 'tracked' | 'enable' | 'untracked' | 'loading'
const VIEWS: View[] = ['tracked', 'enable', 'untracked', 'loading']

// Visual state of the tracked view's face.
// open: no limit applies; ok: under every limit; over: blocking now;
// snoozed: over a limit but blocking is paused by "5 more minutes".
type FaceState = 'open' | 'ok' | 'over' | 'snoozed'

function showView(view: View) {
  for (const v of VIEWS) {
    byId(v)?.toggleAttribute('hidden', v !== view)
  }
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

// What the face shows: the worker's state for this tab (null until it
// answers), read at `now`, against the limits as set.
type Snapshot = { tab: TabState | null; limits: Limits; now: number }

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

// Today's time on this site as a timeline: 24 hour bars (split where its
// own limit fell), faint marks every six hours with their names below, and
// the now mark.
function renderStrip(base: string, hours: number[], limit: number | null) {
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
    ...splitAtLimit(hours, limit, true).map((part) => {
      const bar = h('span', { 'data-on': part.within + part.over > 0 })
      drawBar(bar, part, top, null, false)
      return bar
    }),
    nowMark
  )
  const locale = uiLocale()
  axis.replaceChildren(...STRIP_MARKS.map((hour) => placed(h('span', {}, hourLabel(hour, locale)), hour)))
}

function faceFor(base: string, s: Snapshot) {
  const { site: siteLimit, global: globalLimit } = limitsFor(s.limits, base)
  const { tab, now } = s
  const totals = tab ? totalsAt(tab, now) : { siteToday: 0, globalToday: 0 }
  const reason = tab ? overAt(tab, now, 'ignored') : null
  // Over, and the worker moved the block past now: a snooze.
  const resumes = reason && tab?.blockAt != null && tab.blockAt > now ? tab.blockAt - now : null
  let state: FaceState = 'open'
  if (reason) {
    state = resumes === null ? 'over' : 'snoozed'
  } else if (siteLimit !== null || globalLimit !== null) {
    state = 'ok'
  }
  // The meter follows the limit that applies: the one the worker blocks by,
  // else this site's own, else the all-sites cap.
  const scope = tab?.limit?.scope ?? (siteLimit !== null ? 'site' : 'global')
  const meterLimit = scope === 'site' ? siteLimit : globalLimit
  const meterValue = scope === 'site' ? totals.siteToday : totals.globalToday
  const snoozes = tab?.snoozes ?? []
  return { state, reason, resumes, siteLimit, globalLimit, scope, meterLimit, meterValue, snoozes, ...totals }
}

type Face = ReturnType<typeof faceFor>

// "01:10" then ":04", the seconds set smaller.
function renderReadout(el: HTMLElement, ms: number) {
  const time = formatTime(ms)
  const cut = time.lastIndexOf(':')
  el.replaceChildren(time.slice(0, cut), h('small', {}, time.slice(cut)))
}

function renderFace(base: string, s: Snapshot) {
  const face = faceFor(base, s)
  const hero = byId('hero')
  const status = byId('status')
  const today = byId('today')
  const of = byId('readout-of')
  const meterWrap = byId('meter-wrap')
  const meter = byId('meter')
  const summary = byId('summary')
  const globalLine = byId('global-line')

  hero?.setAttribute('data-state', face.state)
  if (today) {
    renderReadout(today, face.siteToday)
  }
  if (status) {
    status.textContent = {
      open: t('popupStatusTracking'),
      ok: t('popupStatusTracking'),
      over: t('popupStatusOver'),
      snoozed: t('popupStatusSnoozed'),
    }[face.state]
    if (face.reason) {
      status.setAttribute('data-tone', 'accent')
    } else {
      status.removeAttribute('data-tone')
    }
  }

  const { meterLimit, meterValue } = face
  // The readout counts this site's time: "of" names its own limit only.
  if (of) {
    of.textContent = face.siteLimit !== null ? t('popupOf', formatDuration(face.siteLimit)) : ''
  }
  if (meterWrap && meter) {
    meterWrap.hidden = meterLimit === null
    meter.hidden = meterLimit === null
    if (meterLimit !== null) {
      const over = overSegments(meterLimit, meterValue, face.snoozes)
      drawMeter(meter, byId('meter-label'), meterValue, meterLimit, over, formatDuration(meterLimit))
      meter.setAttribute('aria-valuemax', String(msToMinutes(meterLimit)))
      meter.setAttribute('aria-valuenow', String(Math.min(msToMinutes(meterValue), msToMinutes(meterLimit))))
      meter.setAttribute(
        'aria-label',
        face.scope === 'site' ? t('popupMeterSiteAria', base) : t('popupMeterGlobalAria')
      )
      meter.setAttribute('aria-valuetext', t('popupUsedOf', [formatDuration(meterValue), formatDuration(meterLimit)]))
    }
  }

  if (summary) {
    renderSummary(summary, face)
  }

  if (globalLine) {
    // Show the all-sites cap separately when the meter is about this site.
    const globalLimit = face.scope === 'site' && face.siteLimit !== null ? face.globalLimit : null
    globalLine.hidden = globalLimit === null
    if (globalLimit !== null) {
      globalLine.textContent = t('popupGlobalLine', [formatDuration(face.globalToday), formatDuration(globalLimit)])
    }
  }
}

// Under: the time left. Over: the snoozes taken, then the time over in the
// accent (the meter's over pieces), then a snooze's time left.
function renderSummary(el: HTMLElement, face: Face) {
  const { reason, meterLimit, meterValue } = face
  if (reason) {
    const over = formatDuration(reason.elapsed - reason.limit)
    const snoozed = snoozedText(face.snoozes.length)
    const left = face.resumes === null ? null : t('popupSnoozeLeft', formatDuration(Math.max(60000, face.resumes)))
    el.replaceChildren(
      snoozed ? `${snoozed}, ` : '',
      h('span', { class: 'over-ink' }, reason.scope === 'site' ? t('popupOverSite', over) : t('popupOverGlobal', over)),
      left ? ` · ${left}` : ''
    )
    return
  }
  if (meterLimit === null) {
    el.textContent = t('popupNoLimit')
    return
  }
  const left = formatDuration(meterLimit - meterValue)
  el.textContent = face.scope === 'site' ? t('popupLeftSite', left) : t('popupLeftGlobal', left)
}

const local = chromeStore('local')

// A site's monogram: its first letter.
function setFav(id: string, site: string) {
  const fav = byId(id)
  if (fav) {
    fav.textContent = site.charAt(0)
  }
}

// `focus`: move focus into the view once shown (the enable view it replaces
// held it).
function renderTracked(tabId: number, base: string, focus = false) {
  const siteEl = byId('site')
  if (siteEl) {
    siteEl.textContent = base
    siteEl.title = base
  }
  setFav('site-fav', base)

  // The face follows the worker's state for this tab (what its page is
  // told), asked again whenever stored time or limits change. The strip,
  // the limits and the prefs are read once, then patched from each change.
  let tab: TabState | null = null
  let day: DayUsage = {}
  let limits: Limits = DEFAULT_LIMITS
  let hidden = false
  const snapshot = (): Snapshot => ({ tab, limits, now: Date.now() })
  const drawFace = () => renderFace(base, snapshot())
  // Today's hours with the time not yet stored in the current one.
  const drawStrip = () => {
    const now = Date.now()
    const totals = tab && { ...tab, running: tab.running ? base : null, sites: { [base]: tab.today }, snoozes: {} }
    const usage = totals ? withUncredited(new Map([[dayOf(now), day]]), totals, now).get(dayOf(now))! : day
    renderStrip(base, usage[base] ?? emptyBuckets(), limitsFor(limits, base).site)
  }
  const draw = () => {
    drawStrip()
    drawFace()
    syncLimitField(limits)
  }
  const todayKey = () => dayKey(dayOf(Date.now()))

  // A state from an earlier worker transaction never replaces the one shown.
  const ask = async () => {
    const res = await bus.send('tabState', { tabId, site: base })
    if (res.ok && (tab === null || res.value.seq >= tab.seq)) {
      tab = res.value
    }
  }

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
        closesWhenHidden: true,
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

  const read = (key: string) => local.get(key).catch(() => undefined)

  // The time, the now mark and the snooze countdown run on while the popup
  // is open; at midnight the strip and the face start the new day.
  let shownKey = todayKey()
  window.setInterval(() => {
    const key = todayKey()
    if (key !== shownKey) {
      shownKey = key
      void Promise.all([read(key), ask()]).then(([d]) => {
        if (todayKey() === key) {
          day = normalizeDay(d)
        }
        draw()
      })
    }
    if (tab?.running) {
      drawStrip()
    }
    moveNow()
    drawFace()
  }, 1000)

  const load = async () => {
    const [d, l, p] = await Promise.all([read(todayKey()), read(LIMITS_KEY), read(PREFS_KEY), ask()])
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
      void ask().then(drawFace)
    }
  }
  void loadThenPatch(local, load, patch).then(() => {
    draw()
    renderToggle()
    showView('tracked')
    if (focus) {
      picker?.focus()
    }
  })
}

function renderEnable(tab: ActiveTab, base: string) {
  const origins = originsForSite(base)
  const siteEl = byId('enable-site')
  if (siteEl) {
    siteEl.textContent = base
    siteEl.title = base
  }
  setFav('enable-fav', base)
  const btn = byId('enable-btn')
  btn?.setAttribute('aria-label', t('popupEnableSiteAria', base))
  showView('enable')

  btn?.addEventListener('click', () => {
    // Must run during the click gesture — request first, no awaits before it.
    void chrome.permissions.request({ origins }).then((granted) => {
      // The worker starts the site's open tabs (permissions.onAdded).
      if (granted) {
        renderTracked(tab.id, base, true)
      }
    })
  })
}

async function init() {
  setDocumentLang()
  localizeDom()
  byId('manage-btn')?.addEventListener('click', () => chrome.runtime.openOptionsPage())

  const tab = await activeTab()
  const base = tab && trackableSiteOfUrl(tab.url)
  if (!tab || !base) {
    showView('untracked')
    return
  }

  // Whatever granted it: our prompt, or Chrome's own site access controls.
  const perms = await chrome.permissions.getAll().catch(() => ({ origins: [] as string[] }))
  const granted = isTracked(perms.origins ?? [], tab.url)

  if (granted) {
    renderTracked(tab.id, base)
  } else {
    renderEnable(tab, base)
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void init()
})
