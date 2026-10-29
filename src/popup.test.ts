// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { HIDDEN_KEY, todayKeyForHost } from './storage'
import { LIMITS_KEY } from './limits'
import { originsForHost } from './sites'
import { fakeChrome, type FakeChrome } from './test/chrome'
import { click, flush, loadPageBody } from './test/dom'
import { startBackground } from './test/content'

let browser: FakeChrome
const TODAY_KEY = todayKeyForHost('reddit.com')

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const visibleSection = () => ['tracked', 'enable', 'untracked', 'loading'].filter((id) => !$(id).hasAttribute('hidden'))

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

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input'))
  input.dispatchEvent(new Event('change'))
}

beforeEach(async () => {
  browser = fakeChrome()
  await startBackground()
})

describe('popup on a page it cannot track', () => {
  it('says so when there is no usable tab', async () => {
    await openPopup(null)
    expect(visibleSection()).toEqual(['untracked'])
    expect($('untracked').textContent?.trim()).toBe("Tab Timer can't track this page.")
  })

  it.each(['chrome://extensions/', 'about:blank', 'not a url'])('says so for %s', async (url) => {
    await openPopup({ id: 3, url })
    expect(visibleSection()).toEqual(['untracked'])
  })

  it('links to the options page', async () => {
    await openPopup(null)
    expect($('manage-btn').textContent).toBe('Manage sites…')
    click($('manage-btn'))
    expect(browser.runtime.openOptionsPage).toHaveBeenCalledOnce()
  })
})

describe('popup on a site not yet enabled', () => {
  it('offers to enable tracking for the whole site', async () => {
    await openPopup({ id: 7, url: 'https://old.reddit.com/r/all' })
    expect(visibleSection()).toEqual(['enable'])
    expect($('enable-site').textContent).toBe('reddit.com')
  })

  it('requests the site, injects the tracker into the tab, and switches to tracking', async () => {
    await openPopup({ id: 7, url: 'https://old.reddit.com/r/all' })
    click($('enable-btn'))
    await flush()
    expect(browser.permissions.request).toHaveBeenCalledWith({ origins: originsForHost('reddit.com') })
    expect(browser.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ['content.js'] })
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
    await openPopup({ id: 1, url: 'https://www.reddit.com/' })
    expect(visibleSection()).toEqual(['tracked'])
    expect($('site').textContent).toBe('reddit.com')
    expect($('today').textContent).toBe('00:01:05')
  })

  it('updates live while open', async () => {
    await openPopup({ id: 1, url: 'https://www.reddit.com/' })
    browser.storage.local.seed({ [TODAY_KEY]: 3_600_000 })
    await flush()
    expect($('today').textContent).toBe('01:00:00')
  })

  it('resets today for the site', async () => {
    browser.storage.local.seed({ [TODAY_KEY]: 65_000, [todayKeyForHost('x.com')]: 5 })
    await openPopup({ id: 1, url: 'https://www.reddit.com/' })
    expect($('reset-btn').getAttribute('aria-label')).toBe("Reset today's time for reddit.com")
    click($('reset-btn'))
    expect($('today').textContent).toBe('00:00:00')
    await flush()
    expect(browser.storage.local.data[TODAY_KEY]).toBe(0)
    expect(browser.storage.local.data[todayKeyForHost('x.com')]).toBe(5)
  })

  it('toggles the overlay everywhere', async () => {
    await openPopup({ id: 1, url: 'https://www.reddit.com/' })
    expect($('toggle-btn').textContent).toBe('Hide overlay')
    click($('toggle-btn'))
    await flush()
    expect(browser.storage.local.data[HIDDEN_KEY]).toBe(true)
    expect($('toggle-btn').textContent).toBe('Show overlay')
    // Shown again from elsewhere (the overlay itself / another popup).
    browser.storage.local.seed({ [HIDDEN_KEY]: false })
    await flush()
    expect($('toggle-btn').textContent).toBe('Hide overlay')
  })

  it('shows and edits the site’s daily limit in minutes', async () => {
    browser.storage.local.seed({ [LIMITS_KEY]: { global: 3_600_000, perSite: { 'reddit.com': 1_800_000 } } })
    await openPopup({ id: 1, url: 'https://www.reddit.com/' })
    const input = $<HTMLInputElement>('site-limit')
    expect(input.value).toBe('30')
    expect(input.getAttribute('aria-label')).toBe('Daily limit in minutes for reddit.com')

    typeInto(input, '45')
    await flush()
    expect(browser.storage.local.data[LIMITS_KEY]).toEqual({ global: 3_600_000, perSite: { 'reddit.com': 2_700_000 } })

    typeInto(input, '')
    await flush()
    expect(browser.storage.local.data[LIMITS_KEY]).toEqual({ global: 3_600_000, perSite: {} })
  })

  it('treats a granted subdomain visit as the same tracked site', async () => {
    await openPopup({ id: 1, url: 'https://new.reddit.com/r/x' })
    expect(visibleSection()).toEqual(['tracked'])
  })
})
