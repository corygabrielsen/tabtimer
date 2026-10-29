// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { LIMITS_KEY } from './limits'
import { HIDDEN_KEY, SCALE_KEY, todayKeyForHost } from './storage'
import { SUGGESTED_SITES, originsForHost } from './sites'
import { fakeChrome, type FakeChrome } from './test/chrome'
import { click, flush, loadPageBody } from './test/dom'

let browser: FakeChrome
const MIN = 60_000

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim()

async function openOptions(): Promise<void> {
  loadPageBody('options.html')
  vi.resetModules()
  await import('./options')
  await flush()
}

const grant = (...hosts: string[]) => {
  browser.granted = new Set(hosts.flatMap(originsForHost))
}

// The Tracking table, one row per tracked site, keyed by host.
const trackedHosts = () => [...$('tracked-sites').querySelectorAll<HTMLLIElement>('li')].map((li) => li.dataset.host)
const row = (host: string) => $('tracked-sites').querySelector<HTMLLIElement>(`li[data-host="${host}"]`)
const stopButton = (host: string) => row(host)?.querySelector<HTMLButtonElement>('.stop')
// Each row's limit: a compact toggle that expands the row with the chip picker.
const limitToggle = (host: string) => row(host)?.querySelector<HTMLButtonElement>('.limit-toggle')
const limitPanel = (host: string) => row(host)?.querySelector<HTMLElement>('.limit-panel')
const radios = (root: Element | null | undefined) => [
  ...(root?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []),
]
const radio = (root: Element | null | undefined, label: string) => radios(root).find((c) => c.textContent === label)
const checkedRadio = (root: Element | null | undefined) =>
  radios(root).find((c) => c.getAttribute('aria-checked') === 'true')?.textContent
const globalPicker = () => $('global-limit')
const todayCell = (host: string) => row(host)?.querySelector<HTMLElement>('[data-today-host]')

// Suggested sites that aren't tracked yet, as one-tap buttons.
const chips = () => [...$('suggested').querySelectorAll<HTMLButtonElement>('button')]
const chip = (host: string) => chips().find((b) => b.dataset.host === host)

// Pick Custom in a picker and type a value, then press `key`.
function enterCustom(root: Element | null | undefined, value: string, key = 'Enter'): void {
  click(radios(root).at(-1))
  const input = root!.querySelector<HTMLInputElement>('input')!
  input.value = value
  input.dispatchEvent(new KeyboardEvent('keydown', { key }))
}

function submitAdd(value: string): Event {
  $<HTMLInputElement>('add-input').value = value
  const submit = new Event('submit', { cancelable: true })
  $('add-form').dispatchEvent(submit)
  return submit
}

const storedLimits = () => browser.storage.local.data[LIMITS_KEY]

beforeEach(() => {
  browser = fakeChrome()
})

describe('tracked sites', () => {
  it('starts empty on a fresh install, with every suggestion on offer', async () => {
    await openOptions()
    expect(trackedHosts()).toEqual([])
    expect($('tracked-empty').hidden).toBe(false)
    expect(text($('tracked-count'))).toBe('')
    expect(chips().map((b) => b.textContent)).toEqual(SUGGESTED_SITES.map((s) => s.label))
    expect($('enable-suggested').hidden).toBe(false)
    expect($('suggested-empty').hidden).toBe(true)
  })

  it('lists suggested sites first by name, then custom ones alphabetically', async () => {
    grant('youtube.com', 'zeta.dev', 'reddit.com', 'alpha.org')
    await openOptions()
    expect(trackedHosts()).toEqual(['reddit.com', 'youtube.com', 'alpha.org', 'zeta.dev'])
    expect(text($('tracked-count'))).toBe('4')
    expect($('tracked-empty').hidden).toBe(true)
    // Suggested rows show the name and the domain; custom rows the domain.
    expect(text(row('reddit.com')?.querySelector('.site-name strong'))).toBe('Reddit')
    expect(text(row('reddit.com')?.querySelector('.site-name span'))).toBe('reddit.com')
    expect(text(row('alpha.org')?.querySelector('.site-name'))).toBe('alpha.org')
    // Tracked sites aren't offered again.
    expect(chip('reddit.com')).toBeUndefined()
    expect(chip('x.com')).toBeDefined()
  })

  it('keeps long domains readable in full via a title', async () => {
    grant('a-rather-long-registrable-domain-name.co')
    await openOptions()
    const name = row('a-rather-long-registrable-domain-name.co')?.querySelector('strong')
    expect(name?.textContent).toBe('a-rather-long-registrable-domain-name.co')
    expect(name?.getAttribute('title')).toBe('a-rather-long-registrable-domain-name.co')
  })

  it('shows today’s time per site, marking a site over its limit', async () => {
    grant('reddit.com', 'x.com')
    browser.storage.local.seed({
      [LIMITS_KEY]: { global: null, perSite: { 'x.com': 10 * MIN } },
      [todayKeyForHost('reddit.com')]: 23 * MIN,
      [todayKeyForHost('x.com')]: 12 * MIN,
    })
    await openOptions()
    expect(todayCell('reddit.com')?.textContent).toBe('23 min')
    expect(todayCell('reddit.com')?.hasAttribute('data-over')).toBe(false)
    expect(todayCell('x.com')?.textContent).toBe('12 min (over)')
    expect(todayCell('x.com')?.hasAttribute('data-over')).toBe(true)
    expect(todayCell('reddit.com')?.getAttribute('aria-label')).toBe('reddit.com: 23 min today')
  })

  it('updates today’s time live, and when a limit changes', async () => {
    grant('reddit.com')
    await openOptions()
    browser.storage.local.seed({ [todayKeyForHost('reddit.com')]: 125 * MIN })
    await flush()
    expect(todayCell('reddit.com')?.textContent).toBe('2 h 05 min')
    browser.storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 60 * MIN } } })
    await flush()
    expect(todayCell('reddit.com')?.textContent).toBe('2 h 05 min (over)')
  })

  it('tracks a suggested site from its chip and keeps focus nearby', async () => {
    await openOptions()
    const youtube = chip('youtube.com')
    expect(youtube?.getAttribute('aria-label')).toBe('Track YouTube (youtube.com)')
    click(youtube)
    await flush()
    expect(browser.permissions.request).toHaveBeenCalledWith({ origins: originsForHost('youtube.com') })
    expect(trackedHosts()).toEqual(['youtube.com'])
    expect(chip('youtube.com')).toBeUndefined()
    // YouTube was the last chip; focus lands on the new last one.
    expect(document.activeElement).toBe(chip('x.com'))
  })

  it('keeps focus on a chip whose prompt was declined', async () => {
    browser.acceptPermissionPrompts = false
    await openOptions()
    click(chip('reddit.com'))
    await flush()
    expect(browser.granted.size).toBe(0)
    expect(chip('reddit.com')).toBeDefined()
  })

  it('stops tracking a site and moves focus to the next row', async () => {
    grant('reddit.com', 'x.com', 'alpha.org')
    await openOptions()
    expect(stopButton('reddit.com')?.getAttribute('aria-label')).toBe('Stop tracking reddit.com')
    click(stopButton('reddit.com'))
    await flush()
    expect(trackedHosts()).toEqual(['x.com', 'alpha.org'])
    expect(chip('reddit.com')).toBeDefined()
    expect(document.activeElement).toBe(stopButton('x.com'))

    click(stopButton('alpha.org'))
    click(stopButton('x.com'))
    await flush()
    expect(browser.granted.size).toBe(0)
    expect($('tracked-empty').hidden).toBe(false)
    expect(document.activeElement).toBe($('add-input'))
  })

  it('stopping the second of two custom sites revokes exactly that site', async () => {
    grant('alpha.org', 'beta.org')
    await openOptions()
    expect(trackedHosts()).toEqual(['alpha.org', 'beta.org'])
    click(stopButton('beta.org'))
    await flush()
    expect(browser.permissions.remove).toHaveBeenCalledExactlyOnceWith({ origins: originsForHost('beta.org') })
    expect(browser.granted).toEqual(new Set(originsForHost('alpha.org')))
    expect(trackedHosts()).toEqual(['alpha.org'])
  })

  it('tracks every suggested site at once, then says so', async () => {
    await openOptions()
    click($('enable-suggested'))
    await flush()
    expect(browser.granted).toEqual(new Set(SUGGESTED_SITES.flatMap((s) => originsForHost(s.host))))
    expect(chips()).toEqual([])
    expect($('suggested-empty').hidden).toBe(false)
    expect($('enable-suggested').hidden).toBe(true)
  })
})

describe('adding a site', () => {
  it('normalizes a pasted URL to its site, tracks it and clears the field', async () => {
    await openOptions()
    const submit = submitAdd('https://www.example.co/some/page')
    await flush()
    expect(submit.defaultPrevented).toBe(true)
    expect(browser.permissions.request).toHaveBeenCalledWith({ origins: originsForHost('example.co') })
    expect(trackedHosts()).toEqual(['example.co'])
    expect($<HTMLInputElement>('add-input').value).toBe('')
    expect($('add-error').hidden).toBe(true)
  })

  it.each([
    ['', 'Enter a domain to track, like example.com.'],
    ['localhost', "That isn't a domain. Try something like example.com."],
  ])('explains why %j cannot be added', async (value, message) => {
    await openOptions()
    submitAdd(value)
    await flush()
    expect(browser.permissions.request).not.toHaveBeenCalled()
    expect($('add-error').hidden).toBe(false)
    expect(text($('add-error'))).toBe(message)
    expect($('add-input').getAttribute('aria-invalid')).toBe('true')
  })

  it('says when a site is already tracked', async () => {
    grant('reddit.com')
    await openOptions()
    submitAdd('old.reddit.com')
    await flush()
    expect(browser.permissions.request).not.toHaveBeenCalled()
    expect(text($('add-error'))).toBe('reddit.com is already tracked.')
  })

  it('clears the error as soon as the field is edited', async () => {
    await openOptions()
    submitAdd('localhost')
    $('add-input').dispatchEvent(new Event('input'))
    expect($('add-error').hidden).toBe(true)
    expect($('add-input').getAttribute('aria-invalid')).toBe('false')
  })

  it('keeps the input if the prompt is declined', async () => {
    browser.acceptPermissionPrompts = false
    await openOptions()
    submitAdd('example.co')
    await flush()
    expect($<HTMLInputElement>('add-input').value).toBe('example.co')
  })
})

describe('limits', () => {
  it('shows each tracked site’s limit as a compact toggle', async () => {
    grant('reddit.com', 'alpha.org', 'x.com')
    browser.storage.local.seed({
      [LIMITS_KEY]: { global: 90 * MIN, perSite: { 'reddit.com': 15 * MIN, 'alpha.org': 50 * MIN } },
    })
    await openOptions()
    expect(text(limitToggle('reddit.com'))).toBe('15m')
    expect(text(limitToggle('alpha.org'))).toBe('50m')
    expect(text(limitToggle('x.com'))).toBe('Off')
    expect(limitToggle('reddit.com')?.getAttribute('aria-label')).toBe('Daily limit for reddit.com: 15 min')
    expect(limitToggle('x.com')?.getAttribute('aria-label')).toBe('Daily limit for x.com: Off')
    expect(limitToggle('reddit.com')?.getAttribute('aria-expanded')).toBe('false')
    expect(limitPanel('reddit.com')?.hidden).toBe(true)
    // The all-sites cap: a non-preset value is its own chip.
    expect(checkedRadio(globalPicker())).toBe('1h 30m')
  })

  it('expands a row into the same chip picker, one row at a time', async () => {
    grant('reddit.com', 'x.com')
    browser.storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 30 * MIN } } })
    await openOptions()
    click(limitToggle('reddit.com'))
    const panel = limitPanel('reddit.com')
    expect(panel?.hidden).toBe(false)
    expect(limitToggle('reddit.com')?.getAttribute('aria-expanded')).toBe('true')
    expect(limitToggle('reddit.com')?.getAttribute('aria-controls')).toBe(panel?.id)
    expect(panel?.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Daily limit for reddit.com')
    expect(radios(panel).map((c) => c.textContent)).toEqual(['Off', '15m', '30m', '1h', '2h', 'Custom'])
    expect(document.activeElement).toBe(radio(panel, '30m'))

    click(limitToggle('x.com'))
    expect(limitPanel('reddit.com')?.hidden).toBe(true)
    expect(limitPanel('x.com')?.hidden).toBe(false)
    click(limitToggle('x.com'))
    expect(limitPanel('x.com')?.hidden).toBe(true)
  })

  it('saves a per-site preset at once and updates the toggle', async () => {
    grant('reddit.com')
    await openOptions()
    click(limitToggle('reddit.com'))
    click(radio(limitPanel('reddit.com'), '1h'))
    await flush()
    expect(storedLimits()).toEqual({ global: null, perSite: { 'reddit.com': 60 * MIN } })
    expect(text(limitToggle('reddit.com'))).toBe('1h')
    expect(text(limitPanel('reddit.com')?.querySelector('.saved'))).toBe('Saved')
    click(radio(limitPanel('reddit.com'), 'Off'))
    await flush()
    expect(storedLimits()).toEqual({ global: null, perSite: {} })
    expect(text(limitToggle('reddit.com'))).toBe('Off')
  })

  it('saves a custom per-site limit, and flags an invalid one inline', async () => {
    grant('reddit.com')
    await openOptions()
    click(limitToggle('reddit.com'))
    const panel = limitPanel('reddit.com')
    enterCustom(panel, '1.5')
    await flush()
    expect(storedLimits()).toBeUndefined()
    const input = panel?.querySelector('input')
    expect(input?.getAttribute('aria-invalid')).toBe('true')
    const error = panel?.querySelector<HTMLElement>('.error')
    expect(error?.hidden).toBe(false)
    expect(input?.getAttribute('aria-describedby')).toContain(error?.id)

    input!.value = '50'
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await flush()
    expect(storedLimits()).toEqual({ global: null, perSite: { 'reddit.com': 50 * MIN } })
    expect(checkedRadio(panel)).toBe('50m')
    expect(text(limitToggle('reddit.com'))).toBe('50m')
  })

  it('Escape in the chips collapses the row back to its toggle', async () => {
    grant('reddit.com')
    await openOptions()
    click(limitToggle('reddit.com'))
    radio(limitPanel('reddit.com'), 'Off')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    )
    expect(limitPanel('reddit.com')?.hidden).toBe(true)
    expect(document.activeElement).toBe(limitToggle('reddit.com'))
  })

  it('keeps the open row open when the table re-renders', async () => {
    grant('reddit.com', 'x.com')
    await openOptions()
    click(limitToggle('x.com'))
    click(stopButton('reddit.com'))
    await flush()
    expect(trackedHosts()).toEqual(['x.com'])
    expect(limitPanel('x.com')?.hidden).toBe(false)
  })

  it('follows per-site limits changed elsewhere', async () => {
    grant('reddit.com')
    await openOptions()
    browser.storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 120 * MIN } } })
    await flush()
    expect(text(limitToggle('reddit.com'))).toBe('2h')
    expect(checkedRadio(limitPanel('reddit.com'))).toBe('2h')
  })

  it('saves the all-sites cap from its presets, a custom value, or Off', async () => {
    await openOptions()
    const picker = globalPicker()
    expect(picker.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('All tracked sites combined')
    expect(radios(picker).map((c) => c.textContent)).toEqual(['Off', '1h', '2h', '3h', '4h', 'Custom'])
    expect(checkedRadio(picker)).toBe('Off')
    click(radio(picker, '3h'))
    await flush()
    expect(storedLimits()).toEqual({ global: 180 * MIN, perSite: {} })
    expect(text($('global-limit-saved'))).toBe('Saved')
    enterCustom(picker, '-3')
    await flush()
    expect(storedLimits()).toEqual({ global: 180 * MIN, perSite: {} })
    expect($('global-limit-error').hidden).toBe(false)
    enterCustom(picker, '-3', 'Escape')
    enterCustom(picker, '150')
    await flush()
    expect(storedLimits()).toEqual({ global: 150 * MIN, perSite: {} })
    expect(checkedRadio(picker)).toBe('2h 30m')
    click(radio(picker, 'Off'))
    await flush()
    expect(storedLimits()).toEqual({ global: null, perSite: {} })
  })

  it('follows a cap changed elsewhere', async () => {
    await openOptions()
    browser.storage.local.seed({ [LIMITS_KEY]: { global: 45 * MIN, perSite: {} } })
    await flush()
    expect(checkedRadio(globalPicker())).toBe('45m')
  })

  it('keeps the all-sites cap when a per-site limit changes', async () => {
    grant('x.com')
    browser.storage.local.seed({ [LIMITS_KEY]: { global: MIN, perSite: {} } })
    await openOptions()
    click(limitToggle('x.com'))
    click(radio(limitPanel('x.com'), '15m'))
    await flush()
    expect(storedLimits()).toEqual({ global: MIN, perSite: { 'x.com': 15 * MIN } })
  })
})

describe('on-page timer', () => {
  const sizes = () => [...document.querySelectorAll<HTMLInputElement>('input[name="overlay-size"]')]
  const checkedSize = () => sizes().find((r) => r.checked)?.value

  it('reflects the stored preferences', async () => {
    browser.storage.local.seed({ [HIDDEN_KEY]: true, [SCALE_KEY]: 0.75 })
    await openOptions()
    expect($('overlay-switch').getAttribute('aria-checked')).toBe('false')
    expect(checkedSize()).toBe('0.75')
  })

  it('defaults to shown at full size', async () => {
    browser.storage.local.seed({ [SCALE_KEY]: 'garbage' })
    await openOptions()
    expect($('overlay-switch').getAttribute('aria-checked')).toBe('true')
    expect(checkedSize()).toBe('1')
  })

  it('hides and shows the timer', async () => {
    await openOptions()
    click($('overlay-switch'))
    await flush()
    expect(browser.storage.local.data[HIDDEN_KEY]).toBe(true)
    expect($('overlay-switch').getAttribute('aria-checked')).toBe('false')
    expect(text($('overlay-saved'))).toBe('Saved')
    click($('overlay-switch'))
    await flush()
    expect(browser.storage.local.data[HIDDEN_KEY]).toBe(false)
  })

  it('sets the timer size', async () => {
    await openOptions()
    const small = sizes().find((r) => r.value === '0.5')!
    small.checked = true
    small.dispatchEvent(new Event('change'))
    await flush()
    expect(browser.storage.local.data[SCALE_KEY]).toBe(0.5)
  })

  it('follows changes made from the overlay', async () => {
    await openOptions()
    browser.storage.local.seed({ [HIDDEN_KEY]: true, [SCALE_KEY]: 0.5 })
    await flush()
    expect($('overlay-switch').getAttribute('aria-checked')).toBe('false')
    expect(checkedSize()).toBe('0.5')
  })
})

describe('when browser APIs fail', () => {
  it('still renders an empty, usable page', async () => {
    browser.storage.local.error = 'storage is unavailable'
    browser.permissions.getAll.mockImplementation(() => Promise.reject(new Error('nope')))
    await openOptions()
    expect($('tracked-empty').hidden).toBe(false)
    expect($('overlay-switch').getAttribute('aria-checked')).toBe('true')
    click($('overlay-switch'))
    const small = document.querySelector<HTMLInputElement>('input[name="overlay-size"][value="0.5"]')!
    small.checked = true
    small.dispatchEvent(new Event('change'))
    await flush()
    expect(browser.storage.local.data[HIDDEN_KEY]).toBeUndefined()
  })

  it('treats failed permission requests as declined', async () => {
    grant('reddit.com')
    browser.permissions.request.mockImplementation(() => Promise.reject(new Error('no gesture')))
    browser.permissions.remove.mockImplementation(() => Promise.reject(new Error('nope')))
    await openOptions()
    click(chip('x.com'))
    click(stopButton('reddit.com'))
    await flush()
    expect(trackedHosts()).toEqual(['reddit.com'])
  })
})

it('localizes the page', async () => {
  await openOptions()
  expect(document.querySelector('h1')?.textContent).toBe('Settings')
  expect(text($('global-limit')?.querySelector('[role="radio"]'))).toBe('Off')
  expect(document.documentElement.lang).toBe('en-US')
  expect($('privacy-link').textContent).toBe('Privacy policy')
})
