// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { LIMITS_KEY } from './limits'
import { SUGGESTED_SITES, originsForHost } from './sites'
import { fakeChrome, type FakeChrome } from './test/chrome'
import { click, flush, loadPageBody } from './test/dom'

let browser: FakeChrome

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

async function openOptions(): Promise<void> {
  loadPageBody('options.html')
  vi.resetModules()
  await import('./options')
  await flush()
}

function row(list: 'suggested' | 'custom', host: string): HTMLLIElement | undefined {
  return [...$(list).querySelectorAll<HTMLLIElement>('li')].find(
    (li) => li.querySelector('.host')?.textContent === host
  )
}
const toggle = (li: HTMLLIElement | undefined) => li?.querySelector<HTMLButtonElement>('.toggle')
const limitInput = (li: HTMLLIElement | undefined) => li?.querySelector<HTMLInputElement>('input')

function commit(input: HTMLInputElement | null | undefined, value: string): void {
  input!.value = value
  input!.dispatchEvent(new Event('change'))
}

const storedLimits = () => browser.storage.local.data[LIMITS_KEY]

beforeEach(() => {
  browser = fakeChrome()
})

describe('site list', () => {
  it('lists every suggested site, none enabled on a fresh install', async () => {
    await openOptions()
    const items = [...$('suggested').querySelectorAll('li')]
    expect(items.map((li) => li.querySelector('.name')?.textContent)).toEqual(SUGGESTED_SITES.map((s) => s.label))
    expect(items.every((li) => li.querySelector('.toggle')?.getAttribute('aria-pressed') === 'false')).toBe(true)
    expect($('custom-h').hasAttribute('hidden')).toBe(true)
  })

  it('marks granted sites enabled and lists custom ones alphabetically', async () => {
    browser.granted = new Set([
      ...originsForHost('reddit.com'),
      ...originsForHost('zeta.dev'),
      ...originsForHost('alpha.org'),
    ])
    await openOptions()
    expect(toggle(row('suggested', 'reddit.com'))?.textContent).toBe('Enabled')
    expect(toggle(row('suggested', 'x.com'))?.textContent).toBe('Enable')
    expect([...$('custom').querySelectorAll('.host')].map((h) => h.textContent)).toEqual(['alpha.org', 'zeta.dev'])
    expect($('custom-h').hasAttribute('hidden')).toBe(false)
  })

  it('enables a suggested site via a permission prompt and re-renders', async () => {
    await openOptions()
    click(toggle(row('suggested', 'youtube.com')))
    await flush()
    expect(browser.permissions.request).toHaveBeenCalledWith({ origins: originsForHost('youtube.com') })
    expect(toggle(row('suggested', 'youtube.com'))?.getAttribute('aria-pressed')).toBe('true')
  })

  it('disables an enabled site', async () => {
    browser.granted = new Set([...originsForHost('reddit.com'), ...originsForHost('alpha.org')])
    await openOptions()
    click(toggle(row('suggested', 'reddit.com')))
    click(toggle(row('custom', 'alpha.org')))
    await flush()
    expect(browser.granted.size).toBe(0)
    expect(toggle(row('suggested', 'reddit.com'))?.getAttribute('aria-pressed')).toBe('false')
    expect(row('custom', 'alpha.org')).toBeUndefined()
  })

  it('enables every suggested site at once', async () => {
    await openOptions()
    click($('enable-suggested'))
    await flush()
    expect(browser.granted).toEqual(new Set(SUGGESTED_SITES.flatMap((s) => originsForHost(s.host))))
  })
})

describe('adding a site', () => {
  it('normalizes a pasted URL to its site, enables it and clears the field', async () => {
    await openOptions()
    $<HTMLInputElement>('add-input').value = 'https://www.example.co/some/page'
    $('add-form').dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect(browser.permissions.request).toHaveBeenCalledWith({ origins: originsForHost('example.co') })
    expect(row('custom', 'example.co')).toBeDefined()
    expect($<HTMLInputElement>('add-input').value).toBe('')
  })

  it('ignores input that is not a domain', async () => {
    await openOptions()
    $<HTMLInputElement>('add-input').value = 'localhost'
    const submit = new Event('submit', { cancelable: true })
    $('add-form').dispatchEvent(submit)
    await flush()
    expect(submit.defaultPrevented).toBe(true)
    expect(browser.permissions.request).not.toHaveBeenCalled()
  })

  it('keeps the input if the prompt is declined', async () => {
    browser.acceptPermissionPrompts = false
    await openOptions()
    $<HTMLInputElement>('add-input').value = 'example.co'
    $('add-form').dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect($<HTMLInputElement>('add-input').value).toBe('example.co')
  })
})

describe('limits', () => {
  it('offers a per-site limit only for enabled sites', async () => {
    browser.granted = new Set(originsForHost('reddit.com'))
    await openOptions()
    expect(limitInput(row('suggested', 'reddit.com'))).not.toBeNull()
    expect(limitInput(row('suggested', 'x.com'))).toBeNull()
    expect(limitInput(row('suggested', 'reddit.com'))?.getAttribute('aria-label')).toBe(
      'Daily limit in minutes for reddit.com'
    )
  })

  it('shows saved limits in minutes', async () => {
    browser.granted = new Set([...originsForHost('reddit.com'), ...originsForHost('alpha.org')])
    browser.storage.local.seed({
      [LIMITS_KEY]: { global: 90 * 60_000, perSite: { 'reddit.com': 15 * 60_000, 'alpha.org': 60_000 } },
    })
    await openOptions()
    expect($<HTMLInputElement>('global-limit').value).toBe('90')
    expect(limitInput(row('suggested', 'reddit.com'))?.value).toBe('15')
    expect(limitInput(row('custom', 'alpha.org'))?.value).toBe('1')
  })

  it('saves a per-site limit, and clears it when blanked', async () => {
    browser.granted = new Set(originsForHost('reddit.com'))
    await openOptions()
    commit(limitInput(row('suggested', 'reddit.com')), '20')
    await flush()
    expect(storedLimits()).toEqual({ global: null, perSite: { 'reddit.com': 20 * 60_000 } })
    commit(limitInput(row('suggested', 'reddit.com')), '')
    await flush()
    expect(storedLimits()).toEqual({ global: null, perSite: {} })
  })

  it('saves the global limit, ignoring nonsense', async () => {
    await openOptions()
    commit($<HTMLInputElement>('global-limit'), '120')
    await flush()
    expect(storedLimits()).toEqual({ global: 120 * 60_000, perSite: {} })
    commit($<HTMLInputElement>('global-limit'), '-3')
    await flush()
    expect(storedLimits()).toEqual({ global: null, perSite: {} })
  })

  it('keeps the global limit when a per-site limit changes', async () => {
    browser.granted = new Set(originsForHost('x.com'))
    browser.storage.local.seed({ [LIMITS_KEY]: { global: 60_000, perSite: {} } })
    await openOptions()
    commit(limitInput(row('suggested', 'x.com')), '5')
    await flush()
    expect(storedLimits()).toEqual({ global: 60_000, perSite: { 'x.com': 5 * 60_000 } })
  })
})

it('localizes the page', async () => {
  await openOptions()
  expect(document.querySelector('h1')?.textContent).toBe('Settings')
  expect($('global-limit').getAttribute('placeholder')).toBe('off')
})
