// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { LIMITS_KEY, PREFS_KEY } from './core/schema'
import { SUGGESTED_SITES, originsForSite } from './core/site'
import { bus } from './chrome/bus'
import { fakeChrome, type FakeChrome } from './test/chrome'
import { $, click, enterCustom, flush, loadPageBody, normText } from './test/dom'
import { dayEntry, seedToday, startBackground, storedToday } from './test/content'

let browser: FakeChrome
const MIN = 60_000

const text = normText

async function openOptions(): Promise<void> {
  loadPageBody('options.html')
  vi.resetModules()
  await import('./options')
  await flush()
}

const grant = (...hosts: string[]) => {
  browser.granted = new Set(hosts.flatMap(originsForSite))
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

function submitAdd(value: string): Event {
  $<HTMLInputElement>('add-input').value = value
  const submit = new Event('submit', { cancelable: true })
  $('add-form').dispatchEvent(submit)
  return submit
}

const storedLimits = () => browser.storage.local.data[LIMITS_KEY]

const prefs = () => browser.storage.local.data[PREFS_KEY] as { hidden: boolean; scale: number } | undefined

beforeEach(async () => {
  browser = fakeChrome()
  browser.sender = { id: browser.runtime.id, url: browser.runtime.getURL('options.html') }
  await startBackground()
})

describe('tracked sites', () => {
  it('starts empty on a fresh install, with every suggestion on offer', async () => {
    await openOptions()
    expect(trackedHosts()).toEqual([])
    expect($('tracked-empty').hidden).toBe(false)
    expect(text($('tracked-count'))).toBe('')
    expect(chips().map((b) => b.textContent)).toEqual(SUGGESTED_SITES.map((s) => s.label))
    expect($('enable-suggested').hidden).toBe(false)
    expect($('suggested').hidden).toBe(false)
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
      [LIMITS_KEY]: { global: null, perSite: { 'x.com': 10 } },
      ...dayEntry({ 'reddit.com': 23 * MIN, 'x.com': 12 * MIN }),
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
    seedToday({ 'reddit.com': 125 * MIN })
    await flush()
    expect(todayCell('reddit.com')?.textContent).toBe('2 h 05 min')
    browser.storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 60 } } })
    await flush()
    expect(todayCell('reddit.com')?.textContent).toBe('2 h 05 min (over)')
  })

  // Storage lacks the open interval's uncredited part, so a row lagged the
  // popup and the page by up to a checkpoint (a minute), its flag included.
  describe('as the worker sees it', () => {
    const page = { url: 'https://www.reddit.com/', frameId: 0, documentLifecycle: 'active' }
    // Tab 1 reports itself in use, then `ms` pass.
    const report = async (visible: boolean) => {
      const options = browser.sender
      browser.sender = { ...page, id: browser.runtime.id, tab: { id: 1, windowId: 1 } }
      await bus.send('presence', { visible, focused: true, media: false, blocked: false })
      browser.sender = options
    }
    const inUse = async (ms: number) => {
      await report(true)
      vi.setSystemTime(Date.now() + ms)
    }

    it('counts the time not yet credited, and flags the limit when the page blocks', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
      try {
        grant('reddit.com')
        browser.storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 1 }, snoozeUntil: 0 } })
        await inUse(40_000)
        await openOptions()
        expect(storedToday('reddit.com')).toBe(0)
        expect(todayCell('reddit.com')?.textContent).toBe('1 min')
        expect(todayCell('reddit.com')?.hasAttribute('data-over')).toBe(false)
        // It runs on while the tab does.
        vi.advanceTimersByTime(20_000)
        expect(todayCell('reddit.com')?.textContent).toBe('1 min (over)')
        expect(todayCell('reddit.com')?.hasAttribute('data-over')).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('stops running once the tab stops', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
      try {
        grant('reddit.com')
        await inUse(80_000)
        await openOptions()
        await report(false)
        await flush()
        expect(storedToday('reddit.com')).toBe(80_000)
        vi.advanceTimersByTime(MIN)
        expect(todayCell('reddit.com')?.textContent).toBe('1 min')
      } finally {
        vi.useRealTimers()
      }
    })

    it('NEW-2: counts it in this week too', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
      try {
        grant('reddit.com')
        seedToday({ 'reddit.com': 4 * MIN + 20_000 })
        await inUse(40_000)
        await openOptions()
        expect(text($('week-total'))).toBe('5 min')
        vi.advanceTimersByTime(40_000)
        expect(text($('week-total'))).toBe('6 min')
      } finally {
        vi.useRealTimers()
      }
    })

    it('shows storage’s time when the worker doesn’t answer', async () => {
      grant('reddit.com')
      seedToday({ 'reddit.com': 5 * MIN })
      browser.storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 5 } } })
      // Not an extension page: the worker refuses it.
      browser.sender = { id: browser.runtime.id, url: 'https://reddit.com/' }
      await openOptions()
      expect(todayCell('reddit.com')?.textContent).toBe('5 min (over)')
    })
  })

  it('tracks a suggested site from its chip and keeps focus nearby', async () => {
    await openOptions()
    const youtube = chip('youtube.com')
    expect(youtube?.getAttribute('aria-label')).toBe('Track YouTube (youtube.com)')
    click(youtube)
    await flush()
    expect(browser.permissions.request).toHaveBeenCalledWith({ origins: originsForSite('youtube.com') })
    expect(trackedHosts()).toEqual(['youtube.com'])
    expect(chip('youtube.com')).toBeUndefined()
    // YouTube was the last chip; focus lands on the new last one.
    expect(document.activeElement).toBe(chip('x.com'))
  })

  it('NEW-1: keeps focus on a chip when another site is tracked from elsewhere', async () => {
    await openOptions()
    const youtube = chip('youtube.com')!
    youtube.focus()
    browser.grant(originsForSite('reddit.com'))
    await flush()
    expect(chip('reddit.com')).toBeUndefined()
    expect(chip('youtube.com')).toBe(youtube)
    expect(document.activeElement).toBe(youtube)
  })

  it('keeps focus on a chip whose prompt was declined', async () => {
    browser.acceptPermissionPrompts = false
    await openOptions()
    click(chip('reddit.com'))
    await flush()
    expect(browser.granted.size).toBe(0)
    expect(chip('reddit.com')).toBeDefined()
  })

  // U5: a declined prompt left its focus target set; the next render (an
  // approved add) moved focus out of the Add field to the declined chip.
  it('U5: a declined prompt leaves no focus target behind', async () => {
    browser.acceptPermissionPrompts = false
    await openOptions()
    click(chip('youtube.com'))
    await flush()
    browser.acceptPermissionPrompts = true
    $('add-input').focus()
    submitAdd('example.co')
    await flush()
    expect(trackedHosts()).toEqual(['example.co'])
    expect(document.activeElement).toBe($('add-input'))
  })

  it('a failed stop leaves no focus target behind', async () => {
    grant('reddit.com')
    browser.permissions.remove.mockImplementation(() => Promise.reject(new Error('nope')))
    await openOptions()
    click(stopButton('reddit.com'))
    await flush()
    $('add-input').focus()
    browser.grant(originsForSite('x.com'))
    await flush()
    expect(trackedHosts()).toEqual(['reddit.com', 'x.com'])
    expect(document.activeElement).toBe($('add-input'))
  })

  it('tracking every suggestion keeps focus on the page', async () => {
    await openOptions()
    $('enable-suggested').focus()
    click($('enable-suggested'))
    await flush()
    expect($('enable-suggested').closest('[hidden]')).not.toBeNull()
    expect(document.activeElement).toBe($('add-input'))
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
    expect(browser.permissions.remove).toHaveBeenCalledExactlyOnceWith({ origins: originsForSite('beta.org') })
    expect(browser.granted).toEqual(new Set(originsForSite('alpha.org')))
    expect(trackedHosts()).toEqual(['alpha.org'])
  })

  it("X3/U5: a grant from Chrome's own site access is its site's row, and Stop removes it", async () => {
    // Shapes chrome://extensions and the toolbar's site access grant.
    browser.granted = new Set(['https://www.reddit.com/*', 'http://www.reddit.com/*', '*://x.com/*'])
    seedToday({ 'reddit.com': 3 * MIN })
    await openOptions()
    expect(trackedHosts()).toEqual(['reddit.com', 'x.com'])
    expect(text(todayCell('reddit.com'))).toBe('3 min')
    click(stopButton('reddit.com'))
    await flush()
    expect(browser.permissions.remove).toHaveBeenCalledExactlyOnceWith({
      origins: ['https://www.reddit.com/*', 'http://www.reddit.com/*'],
    })
    expect(browser.granted).toEqual(new Set(['*://x.com/*']))
    expect(trackedHosts()).toEqual(['x.com'])
  })

  it('X3: an all-sites grant is one All sites row that Stop removes, with nothing left to suggest', async () => {
    browser.granted = new Set(['*://*/*', ...originsForSite('reddit.com')])
    await openOptions()
    expect(trackedHosts()).toEqual(['reddit.com', '*'])
    expect(row('*')?.querySelector('strong')?.textContent).toBe('All sites')
    expect(row('*')?.querySelector('.limit-toggle')).toBeNull()
    expect(text($('tracked-count'))).toBe('2')
    expect(chips()).toEqual([])
    click(stopButton('*'))
    await flush()
    expect(browser.permissions.remove).toHaveBeenCalledExactlyOnceWith({ origins: ['*://*/*'] })
    expect(trackedHosts()).toEqual(['reddit.com'])
    expect(chip('x.com')).toBeDefined()
  })

  it('tracks every suggested site at once, then drops the Suggested section', async () => {
    await openOptions()
    expect(document.querySelector<HTMLElement>('.suggest-head')!.hidden).toBe(false)
    click($('enable-suggested'))
    await flush()
    expect(browser.granted).toEqual(new Set(SUGGESTED_SITES.flatMap((s) => originsForSite(s.host))))
    expect(chips()).toEqual([])
    expect(document.querySelector<HTMLElement>('.suggest-head')!.hidden).toBe(true)
    expect($('suggested').hidden).toBe(true)
  })
})

describe('adding a site', () => {
  it('normalizes a pasted URL to its site, tracks it and clears the field', async () => {
    await openOptions()
    const submit = submitAdd('https://www.example.co/some/page')
    await flush()
    expect(submit.defaultPrevented).toBe(true)
    expect(browser.permissions.request).toHaveBeenCalledWith({ origins: originsForSite('example.co') })
    expect(trackedHosts()).toEqual(['example.co'])
    expect($<HTMLInputElement>('add-input').value).toBe('')
    expect($('add-error').hidden).toBe(true)
  })

  it.each([
    ['', 'Enter a domain.'],
    ['localhost', 'Not a valid domain.'],
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
      [LIMITS_KEY]: { global: 90, perSite: { 'reddit.com': 15, 'alpha.org': 50 } },
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
    browser.storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 30 } } })
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
    expect(storedLimits()).toEqual({ global: null, perSite: { 'reddit.com': 60 }, snoozeUntil: 0 })
    expect(text(limitToggle('reddit.com'))).toBe('1h')
    expect(text(limitPanel('reddit.com')?.querySelector('.saved'))).toBe('Saved')
    click(radio(limitPanel('reddit.com'), 'Off'))
    await flush()
    expect(storedLimits()).toEqual({ global: null, perSite: {}, snoozeUntil: 0 })
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
    expect(storedLimits()).toEqual({ global: null, perSite: { 'reddit.com': 50 }, snoozeUntil: 0 })
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

  // U1: a grant change rebuilt every row, and with it the picker; the move
  // blurred the custom field, and its blur saved what was typed so far.
  it('U1: keeps a custom limit being typed when the grants change', async () => {
    grant('x.com')
    await openOptions()
    const li = row('x.com')
    click(limitToggle('x.com'))
    click(radio(limitPanel('x.com'), 'Custom'))
    const input = $<HTMLInputElement>('limit-x.com-custom')
    input.focus()
    input.value = '4'
    browser.grant(originsForSite('reddit.com'))
    await flush()
    expect(trackedHosts()).toEqual(['reddit.com', 'x.com'])
    // Not rebuilt or moved (happy-dom doesn't blur a moved node; Chromium does).
    expect(row('x.com')).toBe(li)
    expect(document.activeElement).toBe(input)
    expect(input.closest('[hidden]')).toBeNull()
    expect(storedLimits()).toBeUndefined()
  })

  it('follows per-site limits changed elsewhere', async () => {
    grant('reddit.com')
    await openOptions()
    browser.storage.local.seed({ [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 120 } } })
    await flush()
    expect(text(limitToggle('reddit.com'))).toBe('2h')
    expect(checkedRadio(limitPanel('reddit.com'))).toBe('2h')
  })

  it('saves the all-sites cap from its presets, a custom value, or Off', async () => {
    await openOptions()
    const picker = globalPicker()
    expect(picker.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('All sites')
    expect(radios(picker).map((c) => c.textContent)).toEqual(['Off', '1h', '2h', '3h', '4h', 'Custom'])
    expect(checkedRadio(picker)).toBe('Off')
    click(radio(picker, '3h'))
    await flush()
    expect(storedLimits()).toEqual({ global: 180, perSite: {}, snoozeUntil: 0 })
    expect(text($('global-limit-saved'))).toBe('Saved')
    enterCustom(picker, '-3')
    await flush()
    expect(storedLimits()).toEqual({ global: 180, perSite: {}, snoozeUntil: 0 })
    expect($('global-limit-error').hidden).toBe(false)
    enterCustom(picker, '-3', 'Escape')
    enterCustom(picker, '150')
    await flush()
    expect(storedLimits()).toEqual({ global: 150, perSite: {}, snoozeUntil: 0 })
    expect(checkedRadio(picker)).toBe('2h 30m')
    click(radio(picker, 'Off'))
    await flush()
    expect(storedLimits()).toEqual({ global: null, perSite: {}, snoozeUntil: 0 })
  })

  // U4/X6: "Saved" showed, and the new cap stayed, when the write failed.
  it('U4: a failed save shows no Saved notice and keeps the stored cap', async () => {
    browser.storage.local.seed({ [LIMITS_KEY]: { global: 60, perSite: {} } })
    await openOptions()
    browser.storage.local.error = 'quota'
    click(radio(globalPicker(), '3h'))
    await flush()
    expect(text($('global-limit-saved'))).toBe('')
    expect(checkedRadio(globalPicker())).toBe('1h')
  })

  it('U4: a failed site limit save reverts the row', async () => {
    grant('x.com')
    await openOptions()
    browser.storage.local.error = 'quota'
    click(limitToggle('x.com'))
    click(radio(limitPanel('x.com'), '15m'))
    await flush()
    expect(text(limitToggle('x.com'))).toBe('Off')
    expect(checkedRadio(limitPanel('x.com'))).toBe('Off')
    expect(text(limitPanel('x.com')?.querySelector('.saved'))).toBe('')
  })

  it('follows a cap changed elsewhere', async () => {
    await openOptions()
    browser.storage.local.seed({ [LIMITS_KEY]: { global: 45, perSite: {} } })
    await flush()
    expect(checkedRadio(globalPicker())).toBe('45m')
  })

  it('keeps the all-sites cap when a per-site limit changes', async () => {
    grant('x.com')
    browser.storage.local.seed({ [LIMITS_KEY]: { global: 1, perSite: {} } })
    await openOptions()
    click(limitToggle('x.com'))
    click(radio(limitPanel('x.com'), '15m'))
    await flush()
    expect(storedLimits()).toEqual({ global: 1, perSite: { 'x.com': 15 }, snoozeUntil: 0 })
  })
})

describe('on-page timer', () => {
  const sizes = () => [...document.querySelectorAll<HTMLInputElement>('input[name="overlay-size"]')]
  const checkedSize = () => sizes().find((r) => r.checked)?.value

  it('reflects the stored preferences', async () => {
    browser.storage.local.seed({ [PREFS_KEY]: { hidden: true, scale: 0.75 } })
    await openOptions()
    expect($('overlay-switch').getAttribute('aria-checked')).toBe('false')
    expect(checkedSize()).toBe('0.75')
  })

  it('defaults to shown at full size', async () => {
    browser.storage.local.seed({ [PREFS_KEY]: { scale: 'garbage' } })
    await openOptions()
    expect($('overlay-switch').getAttribute('aria-checked')).toBe('true')
    expect(checkedSize()).toBe('1')
  })

  it('hides and shows the timer', async () => {
    await openOptions()
    click($('overlay-switch'))
    await flush()
    expect(prefs()?.hidden).toBe(true)
    expect($('overlay-switch').getAttribute('aria-checked')).toBe('false')
    expect(text($('overlay-saved'))).toBe('Saved')
    click($('overlay-switch'))
    await flush()
    expect(prefs()?.hidden).toBe(false)
  })

  // U4/X6: the switch flipped and "Saved" showed when the write failed.
  it('U4: a failed save reverts the switch and the size, without Saved', async () => {
    await openOptions()
    browser.storage.local.error = 'quota'
    click($('overlay-switch'))
    await flush()
    expect($('overlay-switch').getAttribute('aria-checked')).toBe('true')
    const small = sizes().find((r) => r.value === '0.5')!
    small.checked = true
    small.dispatchEvent(new Event('change'))
    await flush()
    expect(checkedSize()).toBe('1')
    expect(text($('overlay-saved'))).toBe('')
  })

  it('sets the timer size', async () => {
    await openOptions()
    const small = sizes().find((r) => r.value === '0.5')!
    small.checked = true
    small.dispatchEvent(new Event('change'))
    await flush()
    expect(prefs()?.scale).toBe(0.5)
  })

  it('follows changes made from the overlay', async () => {
    await openOptions()
    browser.storage.local.seed({ [PREFS_KEY]: { hidden: true, scale: 0.5 } })
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
    expect(prefs()).toBeUndefined()
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

describe('this week', () => {
  // A Wednesday: the week (from Sunday the 25th) has had four days.
  const NOW = new Date(2026, 9, 28, 16, 40)
  const at = (day: number, hour = 12) => new Date(2026, 9, day, hour)

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })

  it('is hidden until anything is recorded', async () => {
    await openOptions()
    expect($('week-card').hidden).toBe(true)
  })

  it('shows the week’s total, daily average and a bar per day', async () => {
    browser.storage.local.seed({
      ...dayEntry({ 'reddit.com': 60 * MIN }, at(26)),
      ...dayEntry({ 'reddit.com': 20 * MIN, 'x.com': 20 * MIN }, at(28)),
      ...dayEntry({ 'reddit.com': 500 * MIN }, at(24)), // last week
    })
    await openOptions()
    expect($('week-card').hidden).toBe(false)
    expect(text($('week-total'))).toBe('1 h 40 min')
    expect(text($('week-average'))).toBe('Daily average 25 min')
    const days = [...$('week-bars').querySelectorAll<HTMLElement>('.week-bar')]
    expect(days).toHaveLength(7)
    expect(days.map((d) => d.style.getPropertyValue('--v'))).toEqual([
      '0',
      '1',
      '0',
      '0.6666666666666666',
      '0',
      '0',
      '0',
    ])
    expect(days.map((d) => d.hasAttribute('data-today'))).toEqual([false, false, false, true, false, false, false])
    expect([...$('week-bars').querySelectorAll('.week-day > span:last-child')].map((s) => s.textContent).join('')).toBe(
      'SMTWTFS'
    )
    const link = $<HTMLAnchorElement>('week-link')
    expect(link.getAttribute('href')).toBe('usage.html')
    expect(link.target).toBe('_blank')
  })

  it('updates as time is recorded', async () => {
    browser.storage.local.seed(dayEntry({ 'reddit.com': 10 * MIN }, at(28)))
    await openOptions()
    browser.storage.local.set(dayEntry({ 'reddit.com': 30 * MIN }, at(28)))
    await flush()
    expect(text($('week-total'))).toBe('30 min')
  })

  it('keeps a write that lands while it is loading', async () => {
    browser.storage.local.seed(dayEntry({ 'reddit.com': 10 * MIN }, at(28)))
    browser.storage.local.writeDuringNextRead(dayEntry({ 'reddit.com': 30 * MIN }, at(28)))
    await openOptions()
    expect(text($('week-total'))).toBe('30 min')
  })

  // U7: left open over midnight with nothing running, the page kept
  // yesterday's figures as today's until a write.
  it('U7: starts the new day and week at midnight without a write', async () => {
    grant('reddit.com')
    vi.useFakeTimers({ now: new Date(2026, 9, 31, 23, 59, 58), toFake: ['setInterval', 'Date'] })
    browser.storage.local.seed({
      [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 30 }, snoozeUntil: 0 },
      ...dayEntry({ 'reddit.com': 40 * MIN }, new Date(2026, 9, 31, 12)),
    })
    await openOptions()
    expect(todayCell('reddit.com')?.textContent).toBe('40 min (over)')
    expect(text($('week-total'))).toBe('40 min')
    vi.advanceTimersByTime(3000)
    await flush()
    expect(todayCell('reddit.com')?.textContent).toBe('0 min')
    expect(todayCell('reddit.com')?.hasAttribute('data-over')).toBe(false)
    expect(text($('week-total'))).toBe('0 min')
  })

  it('leaves the week alone when a day outside it changes', async () => {
    browser.storage.local.seed(dayEntry({ 'reddit.com': 10 * MIN }, at(28)))
    await openOptions()
    const bars = $('week-bars').firstElementChild
    browser.storage.local.set(dayEntry({ 'reddit.com': 30 * MIN }, at(24)))
    await flush()
    expect($('week-bars').firstElementChild).toBe(bars)
    expect(text($('week-total'))).toBe('10 min')
  })
})
