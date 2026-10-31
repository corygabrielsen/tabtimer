import { chromeStore, loadThenPatch } from './chrome/store'
import { bus } from './chrome/bus'
import type { StoreChanges } from './ports'
import { hourOfSlot, hoursIntoDay, inDayOrder, logicalDay } from './core/day'
import { overAt, totalsAt, type TabState } from './core/messages'
import { hourLabel, withUncredited } from './core/usage'
import { isTracked, originsForSite, trackableSiteOfUrl } from './core/site'
import { limitsFor, normalizeLimits, siteLimitOf, DEFAULT_LIMITS, type Limits } from './core/limits'
import { dayKey, emptyBuckets, normalizeDay, normalizePrefs, LIMITS_KEY, PREFS_KEY, type DayUsage } from './core/schema'
import { localizeDom, t } from './i18n'
import { byId, formatDuration, h, setDocumentLang, uiLocale } from './ui'
import { drawBar, drawReadout, HOUR_FLOOR_MS } from './bars'
import { createSiteLimitPicker, type LimitPicker } from './limitPicker'

type ActiveTab = { id: number; url: string }
type View = 'tracked' | 'enable' | 'untracked' | 'loading'
const VIEWS: View[] = ['tracked', 'enable', 'untracked', 'loading']

// Visual state of the tracked view's face.
// open: no limit applies; ok: under every limit; over: blocking now;
// snoozed: over a limit but blocking is paused by "2 more minutes".
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

// Where the timeline's named marks fall, in hours from the day's start
// (with midnight: midnight, 6, noon and 18).
const STRIP_MARKS = [0, 6, 12, 18]

const at = (slot: number) => `${(slot / 24) * 100}%`

// Where now falls on the strip.
const nowMark = h('i', { class: 'now' })

function moveNow(dayStart: number) {
  nowMark.style.left = at(hoursIntoDay(Date.now(), dayStart))
}

// Today's time on this site as a timeline from the hour the day starts at:
// 24 hour bars (`hours`, by wall-clock hour), faint marks every six hours
// with their names below, and the now mark.
function renderStrip(base: string, hours: number[], dayStart: number) {
  const strip = byId('strip')
  const axis = byId('strip-axis')
  if (!strip || !axis) {
    return
  }
  const top = Math.max(HOUR_FLOOR_MS, ...hours)
  strip.setAttribute('aria-label', t('popupStripAria', base))
  const placed = <E extends HTMLElement>(el: E, slot: number) => {
    el.style.left = at(slot)
    return el
  }
  moveNow(dayStart)
  strip.replaceChildren(
    ...STRIP_MARKS.map((slot) => placed(h('i', { class: 'mark' }), slot)),
    ...inDayOrder(hours, dayStart).map((ms) => {
      const bar = h('span', { 'data-on': ms > 0 })
      drawBar(bar, ms, top)
      return bar
    }),
    nowMark
  )
  const locale = uiLocale()
  axis.replaceChildren(
    ...STRIP_MARKS.map((slot) => placed(h('span', {}, hourLabel(hourOfSlot(slot, dayStart), locale)), slot))
  )
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
  // The summary follows the limit that applies: the one the worker blocks
  // by, else this site's own, else the all-sites cap.
  const scope = tab?.limit?.scope ?? (siteLimit !== null ? 'site' : 'global')
  const applied = scope === 'site' ? siteLimit : globalLimit
  const used = scope === 'site' ? totals.siteToday : totals.globalToday
  return { state, reason, resumes, siteLimit, globalLimit, scope, applied, used, ...totals }
}

type Face = ReturnType<typeof faceFor>

function renderFace(base: string, s: Snapshot) {
  const face = faceFor(base, s)
  const hero = byId('hero')
  const status = byId('status')
  const today = byId('today')
  const of = byId('readout-of')
  const summary = byId('summary')
  const globalLine = byId('global-line')

  hero?.setAttribute('data-state', face.state)
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

  // The readout counts this site's time, against its own limit only.
  if (today && of) {
    drawReadout(today, of, face.siteToday, face.siteLimit)
  }
  if (summary) {
    renderSummary(summary, face)
  }

  if (globalLine) {
    // Show the all-sites cap separately when the summary is about this site.
    const globalLimit = face.scope === 'site' && face.siteLimit !== null ? face.globalLimit : null
    globalLine.hidden = globalLimit === null
    if (globalLimit !== null) {
      globalLine.textContent = t('popupGlobalLine', [formatDuration(face.globalToday), formatDuration(globalLimit)])
    }
  }
}

// Under: the time left. Over: the time over in the accent, then a snooze's
// time left.
function renderSummary(el: HTMLElement, face: Face) {
  const { reason, applied, used } = face
  if (reason) {
    const over = formatDuration(reason.elapsed - reason.limit)
    const left = face.resumes === null ? null : t('popupSnoozeLeft', formatDuration(Math.max(60000, face.resumes)))
    el.replaceChildren(
      h('span', { class: 'over-ink' }, reason.scope === 'site' ? t('popupOverSite', over) : t('popupOverGlobal', over)),
      left ? ` · ${left}` : ''
    )
    return
  }
  if (applied === null) {
    el.textContent = t('popupNoLimit')
    return
  }
  const left = formatDuration(applied - used)
  el.textContent = face.scope === 'site' ? t('popupLeftSite', left) : t('popupLeftGlobal', left)
}

const local = chromeStore('local')

// `focus`: move focus into the view once shown (the enable view it replaces
// held it).
function renderTracked(tabId: number, base: string, focus = false) {
  const siteEl = byId('site')
  if (siteEl) {
    siteEl.textContent = base
    siteEl.title = base
  }

  // The face follows the worker's state for this tab (what its page is
  // told), asked again whenever stored time or limits change. The strip,
  // the limits and the prefs are read once, then patched from each change.
  let tab: TabState | null = null
  let day: DayUsage = {}
  let limits: Limits = DEFAULT_LIMITS
  let hidden = false
  let dayStart = 0
  const snapshot = (): Snapshot => ({ tab, limits, now: Date.now() })
  const drawFace = () => renderFace(base, snapshot())
  // Today's hours with the time not yet stored in the current one.
  const drawStrip = () => {
    const now = Date.now()
    const today = logicalDay(now, dayStart)
    const totals = tab && { ...tab, dayStart, running: tab.running ? base : null, sites: { [base]: tab.today } }
    const usage = totals ? (withUncredited(new Map([[today, day]]), totals, now).get(today) ?? day) : day
    renderStrip(base, usage[base] ?? emptyBuckets(), dayStart)
  }
  const draw = () => {
    drawStrip()
    drawFace()
    syncLimitField(limits)
  }
  const todayKey = () => dayKey(logicalDay(Date.now(), dayStart))

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
  // is open; when the next day starts (at the hour set, which may change
  // meanwhile) the strip and the face start it.
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
    moveNow(dayStart)
    drawFace()
  }, 1000)

  const load = async () => {
    const [l, p] = await Promise.all([read(LIMITS_KEY), read(PREFS_KEY), ask()])
    limits = normalizeLimits(l)
    ;({ hidden, dayStart } = normalizePrefs(p))
    // Which day is today depends on the hour it starts at.
    shownKey = todayKey()
    day = normalizeDay(await read(shownKey))
  }
  const patch = (changes: StoreChanges) => {
    if (PREFS_KEY in changes) {
      const prefs = normalizePrefs(changes[PREFS_KEY]!.newValue)
      hidden = prefs.hidden
      renderToggle()
      if (prefs.dayStart !== dayStart) {
        // Another hour starts the day: the strip turns now, or on the next
        // tick once it has read the day it now is.
        dayStart = prefs.dayStart
        if (todayKey() === shownKey) {
          drawStrip()
          void ask().then(drawFace)
        }
      }
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
