// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { LIMITS_KEY, PREFS_KEY } from './core/schema'
import { originsForSite } from './core/site'
import { fakeChrome, type FakeChrome } from './test/chrome'
import { $, click, enterCustom as enterCustomIn, flush, loadPageBody, normText } from './test/dom'
import { dayEntry, seedToday, startBackground, storedToday } from './test/content'
import { bus } from './chrome/bus'

let browser: FakeChrome
const MIN = 60_000

const visibleSection = () => ['tracked', 'enable', 'untracked', 'loading'].filter((id) => !$(id).hasAttribute('hidden'))
const face = () => $('hero').getAttribute('data-state')
const text = (id: string) => normText($(id))

// Open the popup: load its markup, run popup.ts, fire DOMContentLoaded at
// this instance only (earlier tests' instances must not re-run).
async function openPopup(tab: { id?: number; url?: string } | null): Promise<void> {
  browser.openTabs = tab ? [{ active: true, ...tab }] : []
  loadPageBody('popup.html')
  vi.resetModules()
  const add = vi.spyOn(document, 'addEventListener')
  await import('./popup')
  const onReady = add.mock.calls.find(([type]) => type === 'DOMContentLoaded')?.[1] as () => void
  add.mockRestore()
  onReady()
  await flush()
}

const openReddit = () => openPopup({ id: 1, url: 'https://www.reddit.com/' })

// The daily-limit chip group.
const limitChips = () => [...$('site-limit').querySelectorAll<HTMLButtonElement>('[role="radio"]')]
const limitChip = (label: string) => limitChips().find((c) => c.textContent === label)
const checkedChip = () => limitChips().find((c) => c.getAttribute('aria-checked') === 'true')
const customField = () => $<HTMLInputElement>('site-limit-custom')

const enterCustom = (value: string, key = 'Enter') => enterCustomIn($('site-limit'), value, key)

const storedLimits = () => browser.storage.local.data[LIMITS_KEY]

beforeEach(async () => {
  browser = fakeChrome()
  browser.sender = { id: browser.runtime.id, url: browser.runtime.getURL('popup.html') }
  await startBackground()
})

describe('popup on a page it cannot track', () => {
  it('says so when there is no usable tab', async () => {
    await openPopup(null)
    expect(visibleSection()).toEqual(['untracked'])
    expect(text('untracked-title')).toBe("This page can't be tracked")
  })

  it.each([
    'chrome://extensions/',
    'about:blank',
    'not a url',
    'file:///home/me/notes.txt',
    'https://chromewebstore.google.com/detail/abc',
    'http://localhost:3000/',
    // U2: bare public suffixes (path-style S3, private-suffix hosts).
    'https://s3.amazonaws.com/bucket/key',
    'https://githubusercontent.com/',
    'https://vercel.app/',
  ])('says so for %s', async (url) => {
    await openPopup({ id: 3, url })
    expect(visibleSection()).toEqual(['untracked'])
  })

  it('links to the settings page', async () => {
    await openPopup(null)
    expect($('manage-btn').textContent).toBe('Settings')
    click($('manage-btn'))
    expect(browser.runtime.openOptionsPage).toHaveBeenCalledOnce()
  })

  it('localizes the document language', async () => {
    await openPopup(null)
    expect(document.documentElement.lang).toBe('en-US')
  })
})

describe('popup on a site not yet tracked', () => {
  it('offers one action to track the whole site', async () => {
    await openPopup({ id: 7, url: 'https://old.reddit.com/r/all' })
    expect(visibleSection()).toEqual(['enable'])
    expect($('enable-site').textContent).toBe('reddit.com')
    expect($('enable-btn').getAttribute('aria-label')).toBe('Track time on reddit.com')
  })

  it('requests the site and switches to tracking; the worker injects the tracker', async () => {
    await openPopup({ id: 7, url: 'https://old.reddit.com/r/all' })
    click($('enable-btn'))
    await flush()
    expect(browser.permissions.request).toHaveBeenCalledWith({ origins: originsForSite('reddit.com') })
    expect(browser.scripting.executeScript).toHaveBeenCalledExactlyOnceWith({
      target: { tabId: 7 },
      files: ['content.js'],
    })
    expect(visibleSection()).toEqual(['tracked'])
  })

  it('moves focus into the tracked view it switches to', async () => {
    await openPopup({ id: 7, url: 'https://old.reddit.com/r/all' })
    $('enable-btn').focus()
    click($('enable-btn'))
    await flush()
    expect(document.activeElement).toBe(limitChip('Off'))
  })

  it('falls back to offering tracking if the permission check fails', async () => {
    browser.permissions.getAll.mockImplementation(() => Promise.reject(new Error('nope')))
    await openPopup({ id: 7, url: 'https://reddit.com/' })
    expect(visibleSection()).toEqual(['enable'])
  })

  it('stays put if the permission prompt is declined', async () => {
    browser.acceptPermissionPrompts = false
    await openPopup({ id: 7, url: 'https://reddit.com/' })
    click($('enable-btn'))
    await flush()
    expect(visibleSection()).toEqual(['enable'])
  })
})

describe("popup on a site granted through Chrome's own site access", () => {
  it.each([
    [['https://www.reddit.com/*'], 'https://www.reddit.com/r/all'],
    [['*://*/*'], 'https://www.reddit.com/'],
    [['https://*/*'], 'https://old.reddit.com/'],
  ])('U5: %j shows %s as tracked', async (origins, url) => {
    browser.granted = new Set(origins)
    await openPopup({ id: 7, url })
    expect(visibleSection()).toEqual(['tracked'])
    expect($('site').textContent).toBe('reddit.com')
  })

  it('offers tracking for the rest of a site only part of which is granted', async () => {
    browser.granted = new Set(['https://www.reddit.com/*'])
    await openPopup({ id: 7, url: 'https://old.reddit.com/' })
    expect(visibleSection()).toEqual(['enable'])
  })
})

describe('popup on a tracked site', () => {
  beforeEach(() => {
    browser.granted = new Set(originsForSite('reddit.com'))
  })

  it('shows the site and today’s total across tabs', async () => {
    seedToday({ 'reddit.com': 65_000 })
    await openReddit()
    expect(visibleSection()).toEqual(['tracked'])
    expect($('site').textContent).toBe('reddit.com')
    expect($('today').textContent).toBe('00:01:05')
  })

  it('updates live while open', async () => {
    await openReddit()
    seedToday({ 'reddit.com': 3_600_000 })
    await flush()
    expect($('today').textContent).toBe('01:00:00')
  })

  it('shows today on this site by hour, and links to all activity', async () => {
    const at = (hour: number) => new Date(new Date().setHours(hour, 0, 0, 0))
    seedToday({ 'reddit.com': 20 * MIN }, at(9))
    seedToday({ 'youtube.com': 5 * MIN }, at(10))
    await openReddit()
    const strip = $('strip')
    expect(strip.getAttribute('role')).toBe('img')
    expect(strip.getAttribute('aria-label')).toBe('Today on reddit.com, by hour')
    const bars = [...strip.querySelectorAll<HTMLElement>('span')]
    expect(bars).toHaveLength(24)
    expect(bars[9]!.style.getPropertyValue('--v')).toBe('1')
    expect(bars[9]!.hasAttribute('data-on')).toBe(true)
    expect(bars[10]!.style.getPropertyValue('--v')).toBe('0')
    expect(bars[10]!.hasAttribute('data-on')).toBe(false)
    const link = $<HTMLAnchorElement>('activity-link')
    expect(link.textContent).toBe('See all activity')
    expect(link.getAttribute('href')).toBe('usage.html')
    expect(link.target).toBe('_blank')
  })

  it('reads as a timeline: hour marks, their names, and now', async () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 28, 15, 0), toFake: ['Date'] })
    await openReddit()
    const marks = [...$('strip').querySelectorAll<HTMLElement>('.mark')].map((m) => m.style.left)
    expect(marks).toEqual(['0%', '25%', '50%', '75%'])
    const axis = $('strip-axis')
    expect(axis.getAttribute('aria-hidden')).toBe('true')
    expect([...axis.children].map((l) => l.textContent)).toEqual(['12 AM', '6 AM', '12 PM', '6 PM'])
    expect([...axis.children].map((l) => (l as HTMLElement).style.left)).toEqual(['0%', '25%', '50%', '75%'])
    expect($('strip').querySelector<HTMLElement>('.now')?.style.left).toBe('62.5%')
  })

  it('scales a quiet day’s strip to a floor, not its one busy minute', async () => {
    seedToday({ 'reddit.com': 2 * MIN }, new Date(new Date().setHours(9, 0, 0, 0)))
    await openReddit()
    expect($('strip').querySelectorAll<HTMLElement>('span')[9]!.style.getPropertyValue('--v')).toBe('0.2')
  })

  it('treats a granted subdomain visit as the same tracked site', async () => {
    await openPopup({ id: 1, url: 'https://new.reddit.com/r/x' })
    expect(visibleSection()).toEqual(['tracked'])
  })

  describe('state', () => {
    it('with no limit: tracking, no meter, invites setting one', async () => {
      await openReddit()
      expect(face()).toBe('open')
      expect(text('status')).toBe('Tracking')
      expect($('meter').hidden).toBe(true)
      expect(text('summary')).toBe('No limit')
      expect($('global-line').hidden).toBe(true)
    })

    it('under the site limit: meter and time left', async () => {
      browser.storage.local.seed({
        [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 60 } },
        ...dayEntry({ 'reddit.com': 23 * MIN }),
      })
      await openReddit()
      expect(face()).toBe('ok')
      expect(text('status')).toBe('Tracking')
      const meter = $('meter')
      expect(meter.hidden).toBe(false)
      expect(meter.getAttribute('role')).toBe('meter')
      expect(meter.getAttribute('aria-valuenow')).toBe('23')
      expect(meter.getAttribute('aria-valuemax')).toBe('60')
      expect(meter.getAttribute('aria-valuetext')).toBe('23 min of 1 h')
      expect(meter.getAttribute('aria-label')).toBe('Time used of the daily limit for reddit.com')
      expect(text('summary')).toBe('37 min left')
    })

    it('over the site limit: limit reached, by how much', async () => {
      browser.storage.local.seed({
        [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 45 } },
        ...dayEntry({ 'reddit.com': 48 * MIN }),
      })
      await openReddit()
      expect(face()).toBe('over')
      expect(text('status')).toBe('Limit reached')
      expect(text('summary')).toBe('3 min over')
      expect($('meter').getAttribute('aria-valuenow')).toBe('45') // clamped to the max
    })

    // x.com tracked too: its time counts toward the all-sites total.
    const trackX = () => {
      browser.granted = new Set([...originsForSite('reddit.com'), ...originsForSite('x.com')])
    }

    it('X4: leaves sites no longer tracked out of the all-sites total', async () => {
      browser.storage.local.seed({
        [LIMITS_KEY]: { global: 30, perSite: {} },
        ...dayEntry({ 'reddit.com': 10 * MIN, 'x.com': 25 * MIN }),
      })
      await openReddit()
      expect(face()).toBe('ok')
      expect(text('summary')).toBe('20 min left (all sites)')
    })

    it('over the all-sites cap only: names the cap', async () => {
      trackX()
      browser.storage.local.seed({
        [LIMITS_KEY]: { global: 30, perSite: {} },
        ...dayEntry({ 'reddit.com': 10 * MIN, 'x.com': 25 * MIN }),
      })
      await openReddit()
      expect(face()).toBe('over')
      expect(text('summary')).toBe('5 min over (all sites)')
      expect($('meter').getAttribute('aria-label')).toBe('Time used of the daily limit for all tracked sites')
    })

    it('with only an all-sites cap: the meter follows the cap', async () => {
      trackX()
      browser.storage.local.seed({
        [LIMITS_KEY]: { global: 180, perSite: {} },
        ...dayEntry({ 'reddit.com': 12 * MIN, 'x.com': 48 * MIN }),
      })
      await openReddit()
      expect(face()).toBe('ok')
      expect(text('summary')).toBe('2 h left (all sites)')
      expect($('global-line').hidden).toBe(true)
    })

    it('with both limits: the all-sites total gets its own line', async () => {
      trackX()
      browser.storage.local.seed({
        [LIMITS_KEY]: { global: 180, perSite: { 'reddit.com': 60 } },
        ...dayEntry({ 'reddit.com': 20 * MIN, 'x.com': 65 * MIN }),
      })
      await openReddit()
      expect($('global-line').hidden).toBe(false)
      expect(text('global-line')).toBe('All sites: 1 h 25 min of 3 h')
    })

    it('snoozed: still over, says when blocking resumes', async () => {
      browser.storage.local.seed({
        [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 45 }, snoozeUntil: Date.now() + 2 * MIN },
        ...dayEntry({ 'reddit.com': 48 * MIN }),
      })
      await openReddit()
      expect(face()).toBe('snoozed')
      expect(text('status')).toBe('Snoozed')
      expect(text('summary')).toBe('3 min over · 2 min left')
    })

    it('over: the time over as one accent piece after the limit’s mark', async () => {
      browser.storage.local.seed({
        [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 60 }, snoozeUntil: Date.now() + 2 * MIN },
        ...dayEntry({ 'reddit.com': 70 * MIN }),
      })
      await openReddit()
      expect($('today').textContent).toBe('01:10:00')
      expect($('today').querySelector('small')).toBeNull()
      expect(text('readout-of')).toBe('/ 01:00:00')
      expect(text('summary')).toBe('10 min over · 2 min left')
      expect($('summary').querySelector('.over-ink')?.textContent).toBe('10 min over')
      const meter = $('meter')
      expect([...meter.children].map((c) => c.className)).toEqual(['in', 'lim', 'over'])
      expect(document.getElementById('meter-label')).toBeNull()
      expect($('status').getAttribute('data-tone')).toBe('accent')
    })

    it('under the limit: the meter runs to an empty track and the limit’s mark', async () => {
      browser.storage.local.seed({
        [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 60 } },
        ...dayEntry({ 'reddit.com': 20 * MIN }),
      })
      await openReddit()
      expect([...$('meter').children].map((c) => c.className)).toEqual(['in', 'rest', 'lim'])
      expect($('status').hasAttribute('data-tone')).toBe(false)
    })

    it('over, not snoozed, when the snooze was set before the clock went back', async () => {
      browser.storage.local.seed({
        [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 45 }, snoozeUntil: Date.now() + 60 * MIN },
        ...dayEntry({ 'reddit.com': 48 * MIN }),
      })
      await openReddit()
      expect(face()).toBe('over')
    })

    it('follows limit changes made elsewhere', async () => {
      seedToday({ 'reddit.com': 20 * MIN })
      await openReddit()
      expect(face()).toBe('open')
      browser.storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 10 } } })
      await flush()
      expect(face()).toBe('over')
      expect(checkedChip()?.textContent).toBe('10m')
    })
  })

  // U7: open over midnight, the strip kept yesterday's bars as today's until
  // the new day's first write.
  it('U7: starts the new day at midnight without a write', async () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 28, 23, 59, 58), toFake: ['setInterval', 'Date'] })
    try {
      seedToday({ 'reddit.com': 40 * MIN }, new Date(2026, 9, 28, 23))
      await openReddit()
      const on = () => $('strip').querySelectorAll('span[data-on]').length
      expect(on()).toBe(1)
      vi.advanceTimersByTime(3000)
      await flush()
      expect(on()).toBe(0)
      expect($('today').textContent).toBe('00:00:00')
    } finally {
      vi.useRealTimers()
    }
  })

  it('moves the now mark while open, without redrawing the strip', async () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 28, 15, 0), toFake: ['setInterval', 'Date'] })
    try {
      await openReddit()
      const bar = $('strip').querySelector('span')
      vi.advanceTimersByTime(60 * MIN)
      expect($('strip').querySelector<HTMLElement>('.now')?.style.left).toBe(`${(16 / 24) * 100}%`)
      expect($('strip').querySelector('span')).toBe(bar)
    } finally {
      vi.useRealTimers()
    }
  })

  // KNOWN-2 / A3: the face was worked out from storage, which lacks the open
  // interval's uncredited part, so it lagged the page's overlay by up to a
  // checkpoint (a minute), blocking included.
  describe('A3: as the worker sees the tab', () => {
    const page = { url: 'https://www.reddit.com/', frameId: 0, documentLifecycle: 'active' }
    // Tab 1 reports itself in use, then `ms` pass.
    const inUse = async (ms: number) => {
      const popup = browser.sender
      browser.sender = { ...page, id: browser.runtime.id, tab: { id: 1, windowId: 1 } }
      await bus.send('presence', { visible: true, focused: true, media: false, blocked: false })
      browser.sender = popup
      vi.setSystemTime(Date.now() + ms)
    }

    it('counts the time not yet credited, and blocks when the page does', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
      try {
        browser.storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 1 }, snoozeUntil: 0 } })
        await inUse(50_000)
        await openReddit()
        expect(storedToday('reddit.com')).toBe(0)
        expect($('today').textContent).toBe('00:00:50')
        expect(face()).toBe('ok')
        // It runs on while the tab does, and goes over when the page blocks.
        vi.advanceTimersByTime(10_000)
        expect($('today').textContent).toBe('00:01:00')
        expect(face()).toBe('over')
      } finally {
        vi.useRealTimers()
      }
    })

    it('NEW-3: draws the time not yet credited in the strip’s current hour', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
      try {
        await inUse(30_000)
        await openReddit()
        const hour = () => $('strip').querySelectorAll<HTMLElement>('span')[new Date().getHours()]!
        expect(storedToday('reddit.com')).toBe(0)
        expect(hour().hasAttribute('data-on')).toBe(true)
        expect(hour().style.getPropertyValue('--v')).toBe('0.05')
        vi.advanceTimersByTime(30_000)
        expect(hour().style.getPropertyValue('--v')).toBe('0.1')
      } finally {
        vi.useRealTimers()
      }
    })

    it('counts another tab’s running time only as that tab’s page is told', async () => {
      await inUse(30_000)
      await openPopup({ id: 2, url: 'https://www.reddit.com/' })
      expect($('today').textContent).toBe('00:00:00')
    })
  })

  it('keeps a write that lands while it is loading', async () => {
    seedToday({ 'reddit.com': 65_000 })
    browser.storage.local.writeDuringNextRead(dayEntry({ 'reddit.com': 3_600_000 }))
    await openReddit()
    expect($('today').textContent).toBe('01:00:00')
  })

  it('ignores another day’s usage', async () => {
    seedToday({ 'reddit.com': 65_000 })
    await openReddit()
    const bar = $('strip').querySelector('span')
    browser.storage.local.set(dayEntry({ 'reddit.com': 3_600_000 }, new Date(Date.now() - 86_400_000)))
    await flush()
    expect($('today').textContent).toBe('00:01:05')
    expect($('strip').querySelector('span')).toBe(bar)
  })

  it('keeps the snooze countdown current while open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
    try {
      browser.storage.local.seed({
        [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 45 }, snoozeUntil: Date.now() + 2 * MIN },
        ...dayEntry({ 'reddit.com': 48 * MIN }),
      })
      await openReddit()
      expect(text('summary')).toContain('· 2 min left')
      vi.advanceTimersByTime(MIN)
      expect(text('summary')).toContain('· 1 min left')
      // Once the snooze lapses the face goes back to blocking.
      vi.advanceTimersByTime(2 * MIN)
      expect(face()).toBe('over')
    } finally {
      vi.useRealTimers()
    }
  })

  it('still renders when storage and the background are unavailable', async () => {
    browser.storage.local.error = 'storage is unavailable'
    browser.runtime.onMessage.listeners.clear()
    await openReddit()
    expect(visibleSection()).toEqual(['tracked'])
    expect($('today').textContent).toBe('00:00:00')
    expect($('toggle-btn').getAttribute('aria-checked')).toBe('true')
    click($('toggle-btn'))
    await flush()
    expect($('today').textContent).toBe('00:00:00')
  })

  describe('on-page timer switch', () => {
    it('hides and shows the overlay everywhere', async () => {
      await openReddit()
      const sw = $('toggle-btn')
      expect(sw.getAttribute('role')).toBe('switch')
      expect(sw.getAttribute('aria-checked')).toBe('true')
      click(sw)
      await flush()
      expect((browser.storage.local.data[PREFS_KEY] as { hidden: boolean }).hidden).toBe(true)
      expect(sw.getAttribute('aria-checked')).toBe('false')
      // Shown again from elsewhere (the overlay itself / another popup).
      browser.storage.local.seed({ [PREFS_KEY]: { hidden: false, scale: 1 } })
      await flush()
      expect(sw.getAttribute('aria-checked')).toBe('true')
    })
  })

  describe('daily limit', () => {
    beforeEach(() => {
      browser.storage.local.seed({ [LIMITS_KEY]: { global: 60, perSite: { 'reddit.com': 30 }, snoozeUntil: 0 } })
    })

    it('offers preset chips for the site, with the saved limit selected', async () => {
      await openReddit()
      expect($('site-limit').querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe(
        'Daily limit for reddit.com'
      )
      expect(limitChips().map((c) => c.textContent)).toEqual(['Off', '15m', '30m', '1h', '2h', 'Custom'])
      expect(checkedChip()?.textContent).toBe('30m')
    })

    it('saves a preset as soon as it is picked', async () => {
      await openReddit()
      click(limitChip('2h'))
      await flush()
      expect(storedLimits()).toEqual({ global: 60, perSite: { 'reddit.com': 120 }, snoozeUntil: 0 })
      expect(text('site-limit-saved')).toBe('Saved')
      expect(text('summary')).toBe('2 h left')
    })

    it('Off clears the limit', async () => {
      await openReddit()
      click(limitChip('Off'))
      await flush()
      expect(storedLimits()).toEqual({ global: 60, perSite: {}, snoozeUntil: 0 })
    })

    // B3: a per-keystroke save turned a half-typed "30" into a 3-minute limit
    // and could block the open tab immediately.
    it('B3: a custom value saves only on Enter, then shows as its own chip', async () => {
      await openReddit()
      click(limitChip('Custom'))
      customField().value = '4'
      customField().dispatchEvent(new Event('input'))
      await flush()
      expect(storedLimits()).toEqual({ global: 60, perSite: { 'reddit.com': 30 }, snoozeUntil: 0 })
      customField().value = '45'
      customField().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await flush()
      expect(storedLimits()).toEqual({ global: 60, perSite: { 'reddit.com': 45 }, snoozeUntil: 0 })
      expect(checkedChip()?.textContent).toBe('45m')
      expect(text('site-limit-saved')).toBe('Saved')
    })

    // U3: closing the popup mid-edit (a click back in the page) dropped the
    // typed value.
    it('U3: saves an open custom edit when the popup closes', async () => {
      await openReddit()
      click(limitChip('Custom'))
      customField().value = '45'
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      visibility.mockRestore()
      await flush()
      expect(storedLimits()).toEqual({ global: 60, perSite: { 'reddit.com': 45 }, snoozeUntil: 0 })
    })

    // U4/X6: "Saved" showed, and the chip stayed, when the write failed.
    it('U4: a failed save shows no Saved notice and keeps the stored limit', async () => {
      await openReddit()
      browser.storage.local.error = 'quota'
      click(limitChip('2h'))
      await flush()
      expect(text('site-limit-saved')).toBe('')
      expect(checkedChip()?.textContent).toBe('30m')
    })

    it.each(['abc', '0', '-5', '2.5', '1441'])('rejects %s without saving', async (bad) => {
      await openReddit()
      enterCustom(bad)
      await flush()
      expect(customField().getAttribute('aria-invalid')).toBe('true')
      expect($('site-limit-error').hidden).toBe(false)
      expect(text('site-limit-error')).toBe('Enter whole minutes from 1 to 1440.')
      expect(storedLimits()).toEqual({ global: 60, perSite: { 'reddit.com': 30 }, snoozeUntil: 0 })
    })

    it('Escape cancels the custom value and keeps the saved one', async () => {
      await openReddit()
      enterCustom('90', 'Escape')
      await flush()
      expect(checkedChip()?.textContent).toBe('30m')
      expect(storedLimits()).toEqual({ global: 60, perSite: { 'reddit.com': 30 }, snoozeUntil: 0 })
    })

    it('a custom value equal to a preset selects the preset', async () => {
      await openReddit()
      enterCustom('060')
      await flush()
      expect(storedLimits()).toEqual({ global: 60, perSite: { 'reddit.com': 60 }, snoozeUntil: 0 })
      expect(checkedChip()?.textContent).toBe('1h')
      expect(limitChips().at(-1)?.textContent).toBe('Custom')
    })
  })
})
