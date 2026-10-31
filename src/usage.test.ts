// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { LIMITS_KEY, PREFS_KEY } from './core/schema'
import { originsForSite } from './core/site'
import { bus } from './chrome/bus'
import { fakeChrome, type FakeChrome } from './test/chrome'
import { $, click, flush, loadPageBody, normText } from './test/dom'
import { bucketsOf } from './test/data'
import { startBackground, useClock } from './test/content'

const MIN = 60_000
// A Wednesday afternoon. Weeks start on Sunday (en-US), so this week began
// on the 25th.
const NOW = new Date(2026, 9, 28, 16, 40)

let browser: FakeChrome

const text = (id: string) => normText($(id))
const bars = () => [...document.querySelectorAll<HTMLElement>('#bars .bar')]
const rows = () => [...document.querySelectorAll<HTMLElement>('#site-list .site-btn')]
const row = (site: string) => document.querySelector<HTMLElement>(`#site-list [data-site="${site}"]`)!
const legend = () => [...document.querySelectorAll('#legend li')].map((li) => li.textContent)
const mode = (value: 'day' | 'week') => {
  const radio = document.querySelector<HTMLInputElement>(`input[name="mode"][value="${value}"]`)!
  radio.checked = true
  radio.dispatchEvent(new Event('change'))
}

// A day:* entry: each site's minutes per hour ({ hour: minutes }).
function day(date: string, sites: Record<string, Record<number, number>>): Record<string, unknown> {
  const ms = (hours: Record<number, number>) =>
    Object.fromEntries(Object.entries(hours).map(([hour, minutes]) => [hour, minutes * MIN]))
  return {
    [`day:${date}`]: Object.fromEntries(Object.entries(sites).map(([site, hours]) => [site, bucketsOf(ms(hours))])),
  }
}

const SEED = {
  ...day('2026-10-21', { 'reddit.com': { 20: 40 } }),
  ...day('2026-10-27', { 'reddit.com': { 9: 20 }, 'github.com': { 10: 20 } }),
  ...day('2026-10-28', {
    'reddit.com': { 9: 10, 14: 38 },
    'github.com': { 10: 30 },
    'youtube.com': { 14: 5, 15: 12 },
    'x.com': { 15: 3 },
    'wikipedia.org': { 15: 1 },
  }),
  [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 30, 'x.com': 60 } },
}

async function open(seed: Record<string, unknown> = SEED): Promise<void> {
  browser.storage.local.seed(seed)
  loadPageBody('usage.html')
  vi.resetModules()
  await import('./usage')
  await flush()
}

beforeEach(async () => {
  browser = fakeChrome()
  browser.sender = { id: browser.runtime.id, url: browser.runtime.getURL('usage.html') }
  useClock(NOW)
  await startBackground()
})

describe('with nothing recorded', () => {
  it('invites choosing sites', async () => {
    await open({})
    expect($('empty').hidden).toBe(false)
    expect($('report').hidden).toBe(true)
    expect($('mode').hidden).toBe(true)
    expect(text('empty-h')).toBe('No activity yet')
    expect($('empty').querySelector('a')?.getAttribute('href')).toBe('options.html')
  })
})

describe('while loading', () => {
  it('keeps a write that lands while the page reads storage', async () => {
    browser.storage.local.writeDuringNextRead(day('2026-10-28', { 'reddit.com': { 9: 60 } }))
    await open()
    expect(text('total')).toBe('1 h')
  })
})

describe('day view', () => {
  beforeEach(() => open())

  it('shows today by hour, with its total and change', () => {
    expect(text('period-label')).toBe('Today')
    expect(text('total')).toBe('1 h 39 min')
    expect(text('change')).toBe('↑ 148% from yesterday')
    expect($('change').getAttribute('aria-label')).toBe('Up 148 percent from yesterday')
    expect($('average').hidden).toBe(true)
    expect(bars()).toHaveLength(24)
  })

  it('names each bar for assistive tech', () => {
    expect(bars()[14]!.getAttribute('aria-label')).toBe('2 PM, 43 min')
    expect(bars()[3]!.getAttribute('aria-label')).toBe('3 AM, 0 min')
    expect(bars()[14]!.dataset.value).toBe('43 min')
    expect(bars()[3]!.hasAttribute('data-value')).toBe(false)
    expect($('bars').getAttribute('aria-label')).toMatch(/^Time by hour, October 28\./)
  })

  it('stacks the top three sites, then Other', () => {
    expect(legend()).toEqual(['reddit.com', 'github.com', 'youtube.com', 'Other'])
    const series = (i: number) => [...bars()[i]!.querySelectorAll<HTMLElement>('.seg')].map((s) => s.dataset.series)
    expect(series(14)).toEqual(['0', '2'])
    expect(series(15)).toEqual(['2', '3'])
    expect(series(3)).toEqual([])
  })

  it('lists every site, most time first, with a bar against its limit', () => {
    expect(rows().map((r) => r.dataset.site)).toEqual([
      'reddit.com',
      'github.com',
      'youtube.com',
      'x.com',
      'wikipedia.org',
    ])
    expect(row('reddit.com').hasAttribute('data-over')).toBe(true)
    expect(row('reddit.com').querySelector('.visually-hidden')?.textContent).toBe('48 min of 30 min limit')
    expect(row('x.com').querySelector<HTMLElement>('.site-meter')?.style.getPropertyValue('--fill')).toBe('5%')
    expect(row('github.com').querySelector('.site-meter')).toBeNull()
  })

  it('moves back within the kept days, never into the future', () => {
    expect($<HTMLButtonElement>('next').disabled).toBe(true)
    expect($('prev').getAttribute('aria-label')).toBe('Previous day')
    click($('prev'))
    expect(text('period-label')).toBe('Yesterday')
    expect(text('total')).toBe('40 min')
    expect($('change').hidden).toBe(true) // nothing the day before
    click($('prev'))
    expect(text('period-label')).toBe('Monday, October 26')
    for (let i = 0; i < 40; i++) {
      click($('prev'))
    }
    expect(text('period-label')).toBe('Tuesday, September 29')
    expect($<HTMLButtonElement>('prev').disabled).toBe(true)
    click($('next'))
    expect(text('period-label')).toBe('Wednesday, September 30')
  })

  // U6: the step button pressed into the end of the range was disabled
  // with focus on it, and focus fell to <body>.
  it('U6: keeps focus on the period when a step button runs out', () => {
    $('prev').focus()
    for (let i = 0; i < 42; i++) {
      click($('prev'))
    }
    expect($<HTMLButtonElement>('prev').disabled).toBe(true)
    expect(document.activeElement).toBe($('period-label'))
    $('next').focus()
    click($('next'))
    expect(document.activeElement).toBe($('next'))
    for (let i = 0; i < 41; i++) {
      click($('next'))
    }
    expect($<HTMLButtonElement>('next').disabled).toBe(true)
    expect(document.activeElement).toBe($('period-label'))
  })

  // U7: open over midnight, "Today" kept showing yesterday until a write.
  it('U7: starts the new day at midnight without a write', async () => {
    vi.setSystemTime(new Date(2026, 9, 28, 23, 59, 59))
    vi.advanceTimersByTime(2000)
    await flush()
    expect(text('period-label')).toBe('Today')
    expect(text('total')).toBe('0 min')
    expect(document.querySelector('.none')?.textContent).toBe('No activity.')
  })

  it('says so on a day with no usage', () => {
    click($('prev'))
    click($('prev'))
    expect(document.querySelector('.none')?.textContent).toBe('No activity.')
    expect(legend()).toEqual([])
    expect($('site-list').children).toHaveLength(0)
    expect($('sites-h').parentElement!.hidden).toBe(true)
  })

  it('moves between bars with the arrow keys', () => {
    const chart = $('bars')
    const focused = () => bars().findIndex((b) => b.tabIndex === 0)
    expect(focused()).toBe(14) // the busiest hour
    bars()[14]!.focus()
    const key = (k: string) => chart.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true }))
    key('ArrowRight')
    expect(focused()).toBe(15)
    expect(document.activeElement).toBe(bars()[15])
    key('Home')
    expect(focused()).toBe(0)
    key('ArrowLeft')
    expect(focused()).toBe(0)
    key('End')
    expect(focused()).toBe(23)
    expect(key('a')).toBe(true) // not handled
  })

  it('keeps focus on a bar through a live update', async () => {
    bars()[9]!.focus()
    browser.storage.local.set({ ...day('2026-10-28', { 'reddit.com': { 9: 50 } }) })
    await flush()
    expect(text('total')).toBe('50 min')
    expect(document.activeElement?.id).toBe('bar-9')
  })
})

describe('week view', () => {
  beforeEach(async () => {
    await open()
    mode('week')
  })

  it('shows this week by day, with a daily average', () => {
    expect(text('period-label')).toBe('This week')
    expect(bars()).toHaveLength(7)
    expect(bars()[2]!.getAttribute('aria-label')).toBe('Tuesday, Oct 27, 40 min')
    expect(text('total')).toBe('2 h 19 min')
    // U3: last week up to Wednesday 4:40 PM had nothing (its time came later).
    expect($('change').hidden).toBe(true)
    expect(text('average')).toBe('Daily average 35 min') // Sun-Wed
    expect(document.querySelector('.ref-average')).not.toBeNull()
    expect(document.querySelector('.ref-limit')).toBeNull()
    expect([...document.querySelectorAll('.axis span')].map((s) => s.textContent)).toEqual([
      'Sun',
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
    ])
  })

  it('compares a site’s daily average with its limit', () => {
    expect(row('reddit.com').querySelector('.visually-hidden')?.textContent).toBe(
      'Daily average 17 min of 30 min limit'
    )
  })

  it('steps back by weeks', () => {
    expect($('prev').getAttribute('aria-label')).toBe('Previous week')
    click($('prev'))
    expect(text('period-label')).toBe('Last week')
    expect(text('total')).toBe('40 min')
    expect($('change').hidden).toBe(true)
    click($('prev'))
    expect(text('period-label')).toBe('Oct 11 – 17')
    expect(text('change')).toBe('')
    expect(document.querySelector('.none')?.textContent).toBe('No activity.')
    expect(document.querySelector('.ref-average')).toBeNull()
    click($('prev'))
    click($('prev'))
    click($('prev'))
    expect(text('period-label')).toBe('Sep 27 – Oct 3')
    expect($<HTMLButtonElement>('prev').disabled).toBe(true)
  })

  it('goes back to today when switching to day', () => {
    click($('prev'))
    mode('day')
    expect(text('period-label')).toBe('Today')
    click($('prev'))
    click($('prev'))
    // A change event on the radio being unchecked does nothing.
    document.querySelector('input[name="mode"][value="week"]')!.dispatchEvent(new Event('change'))
    expect(text('period-label')).toBe('Monday, October 26')
  })

  it('ignores storage changes it doesn’t show', async () => {
    const before = $('chart').firstElementChild
    browser.storage.local.set({ prefs: { hidden: true, scale: 1 } })
    await flush()
    expect($('chart').firstElementChild).toBe(before)
  })

  it('keeps a day outside the period without drawing, and drops a pruned one', async () => {
    const before = $('chart').firstElementChild
    browser.storage.local.set({ ...day('2026-10-02', { 'reddit.com': { 20: 300 } }) })
    await flush()
    expect($('chart').firstElementChild).toBe(before)
    void browser.storage.local.remove(['day:2026-10-21'])
    await flush()
    expect(text('change')).toBe('')
    expect($('change').hidden).toBe(true)
    for (let i = 0; i < 4; i++) {
      click($('prev'))
    }
    expect(text('period-label')).toBe('Sep 27 – Oct 3')
    expect(text('total')).toBe('5 h')
  })

  it('shows a drop from the period before', async () => {
    browser.storage.local.set({ ...day('2026-10-20', { 'reddit.com': { 20: 300 } }) })
    await flush()
    expect(text('change')).toBe('↓ 54% from last week')
    expect($('change').getAttribute('aria-label')).toBe('Down 54 percent from last week')
    click($('prev'))
    browser.storage.local.set({ ...day('2026-10-14', { 'reddit.com': { 20: 340 } }) })
    await flush()
    expect($('change').hidden).toBe(true) // no change worth showing
    browser.storage.local.set({ ...day('2026-10-14', { 'reddit.com': { 20: 170 } }) })
    await flush()
    expect(text('change')).toBe('↑ 100% from the week before')
  })
})

describe('a selected site', () => {
  beforeEach(() => open())

  it('filters the chart and offers its limit inline', () => {
    click(row('reddit.com'))
    expect(row('reddit.com').getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(row('reddit.com'))
    expect($('filter').hidden).toBe(false)
    expect(text('filter-label')).toBe('Showing reddit.com')
    expect(text('total')).toBe('48 min')
    expect(legend()).toEqual([])
    expect(bars()[14]!.getAttribute('aria-label')).toBe('2 PM, 38 min')
    // One tone, usage only: no split at its limit, no limit mark.
    const series = (i: number) => [...bars()[i]!.querySelectorAll<HTMLElement>('.seg')].map((s) => s.dataset.series)
    expect(series(9)).toEqual(['site'])
    expect(series(14)).toEqual(['site'])
    expect(document.querySelector('#bars .tick, #bars .tick-label, #bars [data-part]')).toBeNull()
    const panel = $('site-panel')
    expect(panel.textContent).toContain('Daily limit for reddit.com')
    expect(panel.querySelector('[aria-checked="true"]')?.textContent).toBe('30m')
  })

  it('draws its limit across the week', () => {
    mode('week')
    click(row('x.com'))
    expect(document.querySelector('.ref-limit')?.textContent).toBe('1 h limit')
  })

  it('saves a new limit through the service worker', async () => {
    click(row('reddit.com'))
    click([...$('site-panel').querySelectorAll('[role="radio"]')].find((c) => c.textContent === '1h'))
    await flush()
    expect(browser.storage.local.data[LIMITS_KEY]).toMatchObject({ perSite: { 'reddit.com': 60 } })
    expect(row('reddit.com').hasAttribute('data-over')).toBe(false)
    expect($('site-panel').querySelector('[aria-checked="true"]')?.textContent).toBe('1h')
    click([...$('site-panel').querySelectorAll('[role="radio"]')].find((c) => c.textContent === 'Off'))
    await flush()
    expect(row('reddit.com').querySelector('.site-meter')).toBeNull()
  })

  // U1: each render rebuilt the list and moved the picker into a new row;
  // the move blurred the custom field, whose blur saved the "4" typed on
  // the way to "45" and blocked the site.
  it('U1: keeps a custom limit being typed through a live update', async () => {
    click(row('reddit.com'))
    const panel = $('site-panel')
    const custom = [...$('site-panel').querySelectorAll<HTMLElement>('[role="radio"]')].at(-1)!
    click(custom)
    const input = $<HTMLInputElement>('usage-limit-custom')
    const blurs = vi.fn()
    input.addEventListener('blur', blurs)
    input.value = '4'
    input.dispatchEvent(new Event('input'))
    browser.storage.local.set(day('2026-10-28', { 'reddit.com': { 9: 11, 14: 38 }, 'zzz.com': { 16: 90 } }))
    await flush()
    expect(row('reddit.com').textContent).toContain('49 min')
    // Not moved (happy-dom doesn't blur a moved node; Chromium does).
    expect($('site-panel')).toBe(panel)
    expect(panel.closest('li')).toBe(row('reddit.com').closest('li'))
    expect(blurs).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)
    expect(input.closest('[hidden]')).toBeNull()
    expect(browser.storage.local.data[LIMITS_KEY]).toMatchObject({ perSite: { 'reddit.com': 30 } })
    input.value = '45'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await flush()
    expect(browser.storage.local.data[LIMITS_KEY]).toMatchObject({ perSite: { 'reddit.com': 45 } })
  })

  it('stays listed in a period it had no time in', () => {
    click(row('youtube.com'))
    click($('prev'))
    expect(rows().map((r) => r.dataset.site)).toEqual(['github.com', 'reddit.com', 'youtube.com'])
    expect(row('youtube.com').textContent).toContain('0 min')
  })

  it('clears by selecting it again, or with Show all sites', () => {
    click(row('reddit.com'))
    click(row('reddit.com'))
    expect($('filter').hidden).toBe(true)
    expect($('site-panel')).toBeNull()
    click(row('github.com'))
    click(row('reddit.com'))
    expect(row('github.com').getAttribute('aria-pressed')).toBe('false')
    click($('clear'))
    expect($('filter').hidden).toBe(true)
    expect(text('total')).toBe('1 h 39 min')
    expect(document.activeElement).toBe(row('reddit.com'))
  })
})

// Storage lacks the open interval's uncredited part, so today lagged the
// on-page timer, the popup and Settings by up to a checkpoint (a minute),
// the over mark included.
describe('today as the worker sees it', () => {
  const page = { url: 'https://www.reddit.com/', frameId: 0, documentLifecycle: 'active' }
  // Tab 1 on reddit.com reports itself in use, or not. The tab is the sender
  // only until the worker takes the message.
  const report = async (visible: boolean) => {
    const own = browser.sender
    browser.sender = { ...page, id: browser.runtime.id, tab: { id: 1, windowId: 1 } }
    const sent = bus.send('presence', { visible, focused: true, media: false, blocked: false })
    await Promise.resolve()
    browser.sender = own
    await sent
  }
  // 29 min 24 s stored in the current hour (4 PM), against a 30 min limit.
  const seed: Record<string, unknown> = {
    ...day('2026-10-28', { 'reddit.com': { 16: 29.4 }, 'github.com': { 10: 5 } }),
    [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 30 }, snoozeUntil: 0 },
  }
  const shown = () => ({
    total: text('total'),
    bar: bars()[16]!.getAttribute('aria-label'),
    time: row('reddit.com').querySelector('.site-time')?.textContent,
    over: row('reddit.com').hasAttribute('data-over'),
  })

  beforeEach(async () => {
    browser.granted = new Set(originsForSite('reddit.com'))
    browser.storage.local.seed(seed)
    await report(true)
    vi.setSystemTime(Date.now() + 40_000)
  })

  it('counts the time not yet credited in today, its hour and its over mark', async () => {
    await open(seed)
    expect(browser.storage.local.data['day:2026-10-28']).toEqual(seed['day:2026-10-28'])
    expect(shown()).toEqual({ total: '35 min', bar: '4 PM, 30 min', time: '30 min', over: true })
    // It runs on while the tab does.
    vi.advanceTimersByTime(40_000)
    expect(shown()).toEqual({ total: '36 min', bar: '4 PM, 31 min', time: '31 min', over: true })
  })

  it('adds it to today’s bar in the week', async () => {
    await open(seed)
    mode('week')
    expect(bars()[3]!.getAttribute('aria-label')).toBe('Wednesday, Oct 28, 35 min')
    expect(row('reddit.com').querySelector('.site-time')?.textContent).toBe('30 min')
  })

  it('leaves another day as stored', async () => {
    await open(seed)
    click($('prev'))
    expect(text('total')).toBe('0 min')
  })

  it('stops running once the tab stops', async () => {
    await open(seed)
    expect(shown().time).toBe('30 min')
    await report(false)
    await flush()
    vi.advanceTimersByTime(60_000)
    expect(shown()).toEqual({ total: '35 min', bar: '4 PM, 30 min', time: '30 min', over: true })
  })

  it('shows storage’s time when the worker doesn’t answer', async () => {
    // Not an extension page: the worker refuses it.
    browser.sender = { id: browser.runtime.id, url: 'https://reddit.com/' }
    await open(seed)
    expect(shown()).toEqual({ total: '34 min', bar: '4 PM, 29 min', time: '29 min', over: false })
  })
})

describe('table view', () => {
  beforeEach(() => open())

  it('shows the chart as a table, and back', () => {
    click($('table-toggle'))
    expect($('chart').hidden).toBe(true)
    expect($('table-toggle').textContent).toBe('Show as chart')
    expect($('table-toggle').getAttribute('aria-expanded')).toBe('true')
    const table = $('table-wrap').querySelector('table')!
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
      'Hour',
      'Total',
      'reddit.com',
      'github.com',
      'youtube.com',
      'Other',
    ])
    const r15 = [...table.querySelectorAll('tbody tr')][15]!
    expect([...r15.children].map((c) => c.textContent)).toEqual(['3 PM', '16 min', '0 min', '0 min', '12 min', '4 min'])
    expect(table.querySelectorAll('tbody tr')).toHaveLength(24)
    expect(legend()).toEqual([])
    click($('table-toggle'))
    expect($('chart').hidden).toBe(false)
    expect($('table-wrap').children).toHaveLength(0)
  })

  it('has one column for a selected site, by day in a week', () => {
    mode('week')
    click(row('reddit.com'))
    click($('table-toggle'))
    const table = $('table-wrap').querySelector('table')!
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['Day', 'Total'])
    expect(table.querySelectorAll('tbody tr')).toHaveLength(7)
    expect(table.querySelector('caption')?.textContent).toBe('This week')
  })
})

describe('storage it can’t read', () => {
  it('shows the empty state', async () => {
    browser.storage.local.error = 'broken'
    loadPageBody('usage.html')
    vi.resetModules()
    await import('./usage')
    await flush()
    expect($('empty').hidden).toBe(false)
  })
})

describe('with days starting at 06:00', () => {
  const SIX = { [PREFS_KEY]: { hidden: false, scale: 1, dayStart: 6 } }

  it('runs today’s hours from 6 AM, and counts 1 AM toward the evening before', async () => {
    vi.setSystemTime(new Date(2026, 9, 29, 1, 30))
    await open({ ...SEED, ...SIX })
    expect(text('period-label')).toBe('Today')
    // 28 October is still today: its 2 PM is eight hours in.
    expect(text('total')).toBe('1 h 39 min')
    expect(bars()).toHaveLength(24)
    expect(bars()[0]!.getAttribute('aria-label')).toBe('6 AM, 0 min')
    expect(bars()[8]!.getAttribute('aria-label')).toBe('2 PM, 43 min')
    expect(bars()[23]!.getAttribute('aria-label')).toBe('5 AM, 0 min')
    expect([...document.querySelectorAll('.axis span')].map((s) => s.textContent).filter(Boolean)).toEqual([
      '6 AM',
      '12 PM',
      '6 PM',
      '12 AM',
    ])
  })

  it('starts the new day at 06:00, not midnight', async () => {
    vi.setSystemTime(new Date(2026, 9, 28, 23, 59, 59))
    await open({ ...SEED, ...SIX })
    vi.advanceTimersByTime(2000)
    await flush()
    expect(text('total')).toBe('1 h 39 min')
    vi.setSystemTime(new Date(2026, 9, 29, 5, 59, 59))
    vi.advanceTimersByTime(2000)
    await flush()
    expect(text('period-label')).toBe('Today')
    expect(text('total')).toBe('0 min')
  })

  it('follows a change of the day start at once', async () => {
    vi.setSystemTime(new Date(2026, 9, 29, 1, 30))
    await open()
    // Midnight: the 29th, with nothing yet.
    expect(text('total')).toBe('0 min')
    browser.storage.local.seed(SIX)
    await flush()
    expect(text('total')).toBe('1 h 39 min')
    expect(bars()[0]!.getAttribute('aria-label')).toBe('6 AM, 0 min')
  })
})
