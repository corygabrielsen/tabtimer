// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { emptyBuckets, LIMITS_KEY } from './core/schema'
import { fakeChrome, type FakeChrome } from './test/chrome'
import { click, flush, loadPageBody } from './test/dom'
import { startBackground, useClock } from './test/content'

const MIN = 60_000
// A Wednesday afternoon. Weeks start on Sunday (en-US), so this week began
// on the 25th.
const NOW = new Date(2026, 9, 28, 16, 40)

let browser: FakeChrome

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const text = (id: string) => $(id).textContent?.replace(/\s+/g, ' ').trim()
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
  const usage: Record<string, number[]> = {}
  for (const [site, hours] of Object.entries(sites)) {
    usage[site] = emptyBuckets()
    for (const [hour, minutes] of Object.entries(hours)) {
      usage[site][Number(hour)] = minutes * MIN
    }
  }
  return { [`day:${date}`]: usage }
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
  [LIMITS_KEY]: { global: null, perSite: { 'reddit.com': 30 * MIN, 'x.com': 60 * MIN } },
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
    expect(text('change')).toBe('↑ 248% from last week')
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

  it('shows a drop from the period before', async () => {
    browser.storage.local.set({ ...day('2026-10-20', { 'reddit.com': { 20: 300 } }) })
    await flush()
    expect(text('change')).toBe('↓ 59% from last week')
    expect($('change').getAttribute('aria-label')).toBe('Down 59 percent from last week')
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
    expect([...bars()[14]!.querySelectorAll<HTMLElement>('.seg')].map((s) => s.dataset.series)).toEqual(['site'])
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
    expect(browser.storage.local.data[LIMITS_KEY]).toMatchObject({ perSite: { 'reddit.com': 60 * MIN } })
    expect(row('reddit.com').hasAttribute('data-over')).toBe(false)
    expect($('site-panel').querySelector('[aria-checked="true"]')?.textContent).toBe('1h')
    click([...$('site-panel').querySelectorAll('[role="radio"]')].find((c) => c.textContent === 'Off'))
    await flush()
    expect(row('reddit.com').querySelector('.site-meter')).toBeNull()
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
