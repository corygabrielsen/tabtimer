// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { HIDDEN_KEY, todayKeyForHost } from './storage'
import { LIMITS_KEY, BLOCK_SNOOZE_KEY } from './limits'
import { originsForHost } from './sites'
import { fakeChrome, type FakeChrome } from './test/chrome'
import { click, flush, loadPageBody } from './test/dom'
import { startBackground } from './test/content'

let browser: FakeChrome
const TODAY_KEY = todayKeyForHost('reddit.com')
const MIN = 60_000

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const visibleSection = () => ['tracked', 'enable', 'untracked', 'loading'].filter((id) => !$(id).hasAttribute('hidden'))
const face = () => $('hero').getAttribute('data-state')
const text = (id: string) => $(id).textContent?.replace(/\s+/g, ' ').trim()

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

// Type a value without committing it (what each keystroke does).
function type(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input'))
}

// Type then commit (blur or Enter fire `change`).
function commit(input: HTMLInputElement, value: string): void {
  type(input, value)
  input.dispatchEvent(new Event('change'))
}

const storedLimits = () => browser.storage.local.data[LIMITS_KEY]

beforeEach(async () => {
  browser = fakeChrome()
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

  it('requests the site, injects the tracker into the tab, and switches to tracking', async () => {
    await openPopup({ id: 7, url: 'https://old.reddit.com/r/all' })
    click($('enable-btn'))
    await flush()
    expect(browser.permissions.request).toHaveBeenCalledWith({ origins: originsForHost('reddit.com') })
    expect(browser.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ['content.js'] })
    expect(visibleSection()).toEqual(['tracked'])
  })

  it('falls back to offering tracking if the permission check fails', async () => {
    browser.permissions.contains.mockImplementation(() => Promise.reject(new Error('nope')))
    await openPopup({ id: 7, url: 'https://reddit.com/' })
    expect(visibleSection()).toEqual(['enable'])
  })

  it('switches to tracking even if injecting into the tab fails', async () => {
    browser.scripting.executeScript.mockImplementation(() => Promise.reject(new Error('no access')))
    await openPopup({ id: 7, url: 'https://reddit.com/' })
    click($('enable-btn'))
    await flush()
    expect(visibleSection()).toEqual(['tracked'])
  })

  it('stays put if the permission prompt is declined', async () => {
    browser.acceptPermissionPrompts = false
    await openPopup({ id: 7, url: 'https://reddit.com/' })
    click($('enable-btn'))
    await flush()
    expect(browser.scripting.executeScript).not.toHaveBeenCalled()
    expect(visibleSection()).toEqual(['enable'])
  })
})

describe('popup on a tracked site', () => {
  beforeEach(() => {
    browser.granted = new Set(originsForHost('reddit.com'))
  })

  it('shows the site and today’s total across tabs', async () => {
    browser.storage.local.seed({ [TODAY_KEY]: 65_000 })
    await openReddit()
    expect(visibleSection()).toEqual(['tracked'])
    expect($('site').textContent).toBe('reddit.com')
    expect($('today').textContent).toBe('00:01:05')
  })

  it('updates live while open', async () => {
    await openReddit()
    browser.storage.local.seed({ [TODAY_KEY]: 3_600_000 })
    await flush()
    expect($('today').textContent).toBe('01:00:00')
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
      expect(text('summary')).toBe('No daily limit. Set one below to get blocked when time is up.')
      expect($('global-line').hidden).toBe(true)
    })

    it('under the site limit: meter and time left', async () => {
      browser.storage.local.seed({
        [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 60 * MIN } },
        [TODAY_KEY]: 23 * MIN,
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
      expect(text('summary')).toBe('37 min left of your 1 h limit')
    })

    it('over the site limit: limit reached, by how much', async () => {
      browser.storage.local.seed({
        [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 45 * MIN } },
        [TODAY_KEY]: 48 * MIN,
      })
      await openReddit()
      expect(face()).toBe('over')
      expect(text('status')).toBe('Limit reached')
      expect(text('summary')).toBe("Over this site's limit by 3 min.")
      expect($('meter').getAttribute('aria-valuenow')).toBe('45') // clamped to the max
    })

    it('over the all-sites cap only: names the cap', async () => {
      browser.storage.local.seed({
        [LIMITS_KEY]: { global: 30 * MIN, perSite: {} },
        [TODAY_KEY]: 10 * MIN,
        [todayKeyForHost('x.com')]: 25 * MIN,
      })
      await openReddit()
      expect(face()).toBe('over')
      expect(text('summary')).toBe('Over the all-sites limit by 5 min.')
      expect($('meter').getAttribute('aria-label')).toBe('Time used of the daily limit for all tracked sites')
    })

    it('with only an all-sites cap: the meter follows the cap', async () => {
      browser.storage.local.seed({
        [LIMITS_KEY]: { global: 180 * MIN, perSite: {} },
        [TODAY_KEY]: 12 * MIN,
        [todayKeyForHost('x.com')]: 48 * MIN,
      })
      await openReddit()
      expect(face()).toBe('ok')
      expect(text('summary')).toBe('2 h left of the 3 h limit for all sites')
      expect($('global-line').hidden).toBe(true)
    })

    it('with both limits: the all-sites total gets its own line', async () => {
      browser.storage.local.seed({
        [LIMITS_KEY]: { global: 180 * MIN, perSite: { 'reddit.com': 60 * MIN } },
        [TODAY_KEY]: 20 * MIN,
        [todayKeyForHost('x.com')]: 65 * MIN,
      })
      await openReddit()
      expect($('global-line').hidden).toBe(false)
      expect(text('global-line')).toBe('All tracked sites today: 1 h 25 min of 3 h')
    })

    it('snoozed: still over, says when blocking resumes', async () => {
      browser.storage.local.seed({
        [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 45 * MIN } },
        [TODAY_KEY]: 48 * MIN,
        [BLOCK_SNOOZE_KEY]: Date.now() + 4 * MIN,
      })
      await openReddit()
      expect(face()).toBe('snoozed')
      expect(text('status')).toBe('Snoozed')
      expect(text('summary')).toBe("Over this site's limit by 3 min. Blocking resumes in 4 min.")
    })

    it('follows limit changes made elsewhere', async () => {
      browser.storage.local.seed({ [TODAY_KEY]: 20 * MIN })
      await openReddit()
      expect(face()).toBe('open')
      browser.storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 10 * MIN } } })
      await flush()
      expect(face()).toBe('over')
      expect($<HTMLInputElement>('site-limit').value).toBe('10')
    })
  })

  it('keeps the snooze countdown current while open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
    try {
      browser.storage.local.seed({
        [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 45 * MIN } },
        [TODAY_KEY]: 48 * MIN,
        [BLOCK_SNOOZE_KEY]: Date.now() + 4 * MIN,
      })
      await openReddit()
      expect(text('summary')).toContain('Blocking resumes in 4 min.')
      vi.advanceTimersByTime(2 * MIN)
      expect(text('summary')).toContain('Blocking resumes in 2 min.')
      // Once the snooze lapses the face goes back to blocking.
      vi.advanceTimersByTime(3 * MIN)
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
    click($('reset-btn'))
    click($('reset-btn'))
    await flush()
    expect($('today').textContent).toBe('00:00:00')
  })

  describe('reset today', () => {
    beforeEach(() => {
      browser.storage.local.seed({ [TODAY_KEY]: 65_000, [todayKeyForHost('x.com')]: 5 })
    })

    it('asks for a second click before resetting', async () => {
      await openReddit()
      const btn = $('reset-btn')
      expect(btn.getAttribute('aria-label')).toBe("Reset today's time for reddit.com")
      click(btn)
      await flush()
      expect(btn.textContent).toBe('Click again to reset')
      expect(btn.getAttribute('aria-label')).toBe("Confirm: reset today's time for reddit.com")
      expect(browser.storage.local.data[TODAY_KEY]).toBe(65_000)
    })

    it('resets only this site on the second click', async () => {
      await openReddit()
      click($('reset-btn'))
      click($('reset-btn'))
      expect($('today').textContent).toBe('00:00:00') // optimistic
      await flush()
      expect(browser.storage.local.data[TODAY_KEY]).toBe(0)
      expect(browser.storage.local.data[todayKeyForHost('x.com')]).toBe(5)
      expect($('reset-btn').textContent).toBe('Reset today')
    })

    it('disarms when focus leaves the button', async () => {
      await openReddit()
      click($('reset-btn'))
      $('reset-btn').dispatchEvent(new Event('blur'))
      expect($('reset-btn').textContent).toBe('Reset today')
      click($('reset-btn'))
      await flush()
      expect(browser.storage.local.data[TODAY_KEY]).toBe(65_000)
    })

    it('disarms by itself after a few seconds', async () => {
      vi.useFakeTimers()
      try {
        await openReddit()
        click($('reset-btn'))
        vi.advanceTimersByTime(4000)
        expect($('reset-btn').textContent).toBe('Reset today')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('on-page timer switch', () => {
    it('hides and shows the overlay everywhere', async () => {
      await openReddit()
      const sw = $('toggle-btn')
      expect(sw.getAttribute('role')).toBe('switch')
      expect(sw.getAttribute('aria-checked')).toBe('true')
      click(sw)
      await flush()
      expect(browser.storage.local.data[HIDDEN_KEY]).toBe(true)
      expect(sw.getAttribute('aria-checked')).toBe('false')
      // Shown again from elsewhere (the overlay itself / another popup).
      browser.storage.local.seed({ [HIDDEN_KEY]: false })
      await flush()
      expect(sw.getAttribute('aria-checked')).toBe('true')
    })
  })

  describe('daily limit field', () => {
    beforeEach(() => {
      browser.storage.local.seed({ [LIMITS_KEY]: { global: 60 * MIN, perSite: { 'reddit.com': 30 * MIN } } })
    })

    it('shows the saved limit in minutes, labelled for the site', async () => {
      await openReddit()
      const input = $<HTMLInputElement>('site-limit')
      expect(input.value).toBe('30')
      expect(input.getAttribute('aria-label')).toBe('Daily limit in minutes for reddit.com')
    })

    // B3: a per-keystroke save turned a half-typed "30" into a 3-minute limit
    // and could block the open tab immediately.
    it('B3: does not save while typing, only on commit', async () => {
      await openReddit()
      const input = $<HTMLInputElement>('site-limit')
      type(input, '4')
      await flush()
      expect(storedLimits()).toEqual({ global: 60 * MIN, perSite: { 'reddit.com': 30 * MIN } })
      commit(input, '45')
      await flush()
      expect(storedLimits()).toEqual({ global: 60 * MIN, perSite: { 'reddit.com': 45 * MIN } })
      expect(text('site-limit-saved')).toBe('Saved')
    })

    it('clears the limit when blanked', async () => {
      await openReddit()
      commit($<HTMLInputElement>('site-limit'), '  ')
      await flush()
      expect(storedLimits()).toEqual({ global: 60 * MIN, perSite: {} })
    })

    it.each(['abc', '0', '-5', '2.5', '1441'])('rejects %s without saving', async (bad) => {
      await openReddit()
      const input = $<HTMLInputElement>('site-limit')
      commit(input, bad)
      await flush()
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect($('site-limit-error').hidden).toBe(false)
      expect(text('site-limit-error')).toBe('Enter whole minutes from 1 to 1440, or leave blank for no limit.')
      expect(storedLimits()).toEqual({ global: 60 * MIN, perSite: { 'reddit.com': 30 * MIN } })
    })

    it('clears the error once the value is fixed, and Escape restores the saved value', async () => {
      await openReddit()
      const input = $<HTMLInputElement>('site-limit')
      commit(input, 'x')
      type(input, '15')
      expect(input.getAttribute('aria-invalid')).toBe('false')
      expect($('site-limit-error').hidden).toBe(true)

      commit(input, 'nope')
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      expect(input.value).toBe('30')
      expect(input.getAttribute('aria-invalid')).toBe('false')
    })

    it('normalizes leading zeros', async () => {
      await openReddit()
      const input = $<HTMLInputElement>('site-limit')
      commit(input, '007')
      await flush()
      expect(input.value).toBe('7')
      expect(storedLimits()).toEqual({ global: 60 * MIN, perSite: { 'reddit.com': 7 * MIN } })
    })
  })
})
