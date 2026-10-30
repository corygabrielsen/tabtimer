import type { BrowserContext, Page, Worker } from '@playwright/test'
import {
  test,
  expect,
  seed,
  read,
  today,
  todayKey,
  openPopup,
  openInterval,
  advance,
  readToday,
  LIMITS_KEY,
  BLOCK_ID,
  MINUTE,
} from './fixtures'

// The activity page: reached from the popup, the settings and the block
// screen, and usable on its own (periods, a site's limit, the table, the
// keyboard).

const SITE_A = 'site-a.test'
const SITE_B = 'site-b.test'

// The page a click opens in a new tab.
async function opens(context: BrowserContext, click: () => Promise<void>): Promise<Page> {
  const [page] = await Promise.all([context.waitForEvent('page'), click()])
  await page.waitForLoadState()
  return page
}

async function activity(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/usage.html`)
  await expect(page.locator('#report')).toBeVisible()
  return page
}

// Some of today's time on both sites, and a little yesterday (just after
// midnight, so it counts in the change at any time of day).
async function seedUsage(sw: Worker, extra: Record<string, unknown> = {}): Promise<void> {
  const yesterday = await sw.evaluate(() => {
    const d = new Date(Date.now() - 86_400_000)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `day:${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  })
  await seed(sw, {
    ...(await today(sw, { [SITE_A]: 20 * MINUTE, [SITE_B]: 5 * MINUTE })),
    [yesterday]: { [SITE_A]: Array.from({ length: 24 }, (_, h) => (h === 0 ? 10 * MINUTE : 0)) },
    ...extra,
  })
}

const blocked = (page: Page) => page.locator(`#${BLOCK_ID}`)

test('opens from the popup', async ({ context, serviceWorker, extensionId, site }) => {
  await seedUsage(serviceWorker)
  const tab = await context.newPage()
  await tab.goto(site(SITE_A))
  const popup = await openPopup(context, serviceWorker, extensionId, site(SITE_A))
  await expect(popup.locator('#strip span')).toHaveCount(24)
  await expect(popup.locator('#strip-axis span')).toHaveText(['12 AM', '6 AM', '12 PM', '6 PM'])
  const page = await opens(context, () => popup.getByRole('link', { name: 'See all activity' }).click())
  expect(page.url()).toBe(`chrome-extension://${extensionId}/usage.html`)
  await expect(page.locator('#total')).toHaveText('25 min')
})

test('opens from the settings', async ({ context, serviceWorker, extensionId }) => {
  await seedUsage(serviceWorker)
  const options = await context.newPage()
  await options.goto(`chrome-extension://${extensionId}/options.html`)
  await expect(options.locator('#week-total')).toHaveText(/min/)
  const page = await opens(context, () => options.getByRole('link', { name: 'See all activity' }).click())
  expect(page.url()).toBe(`chrome-extension://${extensionId}/usage.html`)
})

test('switches between day and week and steps through periods', async ({ context, serviceWorker, extensionId }) => {
  await seedUsage(serviceWorker)
  const page = await activity(context, extensionId)
  const label = page.locator('#period-label')
  const prev = page.locator('#prev')
  const next = page.locator('#next')

  await expect(label).toHaveText('Today')
  await expect(page.locator('#bars .bar')).toHaveCount(24)
  await expect(page.locator('#change')).toHaveText(/^↑ \d+% from yesterday$/)
  await expect(next).toBeDisabled()
  await prev.click()
  await expect(label).toHaveText('Yesterday')
  await expect(page.locator('#total')).toHaveText('10 min')
  await next.click()
  await expect(label).toHaveText('Today')

  await page.getByRole('radio', { name: 'Week' }).check()
  await expect(label).toHaveText('This week')
  await expect(page.locator('#bars .bar')).toHaveCount(7)
  await expect(page.locator('#average')).toHaveText(/^Daily average/)
  await prev.click()
  await expect(label).toHaveText('Last week')
  // Back to the oldest week still kept, then no further.
  for (let i = 0; i < 6 && (await prev.isEnabled()); i++) {
    await prev.click()
  }
  await expect(prev).toBeDisabled()
})

test('a selected site shows its limit, and a new limit there blocks and unblocks live', async ({
  context,
  serviceWorker,
  extensionId,
  site,
}) => {
  await seedUsage(serviceWorker)
  const tab = await context.newPage()
  await tab.goto(site(SITE_A))
  await expect(blocked(tab)).toBeHidden()

  const page = await activity(context, extensionId)
  await page.getByRole('radio', { name: 'Week' }).check()
  await page.locator(`[data-site="${SITE_A}"]`).click()
  await expect(page.locator('#filter-label')).toHaveText(`Showing ${SITE_A}`)
  const picker = page.getByRole('radiogroup', { name: `Daily limit for ${SITE_A}` })
  await expect(picker).toBeVisible()
  await expect(page.locator('.ref-limit')).toHaveCount(0)

  await picker.getByRole('radio', { name: '15 min' }).click()
  await expect(page.locator('.ref-limit')).toHaveText('15 min limit')
  await expect(blocked(tab)).toBeVisible()

  await picker.getByRole('radio', { name: 'Off' }).click()
  await expect(page.locator('.ref-limit')).toHaveCount(0)
  await expect(blocked(tab)).toBeHidden()

  await page.getByRole('button', { name: 'Show all sites' }).click()
  await expect(page.locator('#filter')).toBeHidden()
})

// U1: a live update re-rendered the list and moved the picker; Chromium
// blurs a moved field, and the blur saved the "4" typed on the way to "45".
test('U1: a live update keeps a custom limit being typed', async ({ context, serviceWorker, extensionId }) => {
  await seedUsage(serviceWorker)
  const page = await activity(context, extensionId)
  await page.locator(`[data-site="${SITE_A}"]`).click()
  const picker = page.getByRole('radiogroup', { name: `Daily limit for ${SITE_A}` })
  await picker.getByRole('radio', { name: 'Custom' }).click()
  const field = page.locator('#usage-limit-custom')
  await expect(field).toBeFocused()
  await field.pressSequentially('4')
  // Time recorded meanwhile, enough to reorder the list.
  await seed(serviceWorker, await today(serviceWorker, { [SITE_A]: 21 * MINUTE, [SITE_B]: 30 * MINUTE }))
  await expect(page.locator(`[data-site="${SITE_A}"]`)).toContainText('21 min')
  await expect(page.locator('#site-list .site-btn').first()).toHaveAttribute('data-site', SITE_B)
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('4')
  expect(await read(serviceWorker, LIMITS_KEY)).toBeUndefined()
  await field.pressSequentially('5')
  await field.press('Enter')
  await expect.poll(() => read(serviceWorker, LIMITS_KEY)).toMatchObject({ perSite: { [SITE_A]: 45 } })
})

// The page read today from storage alone, without the open interval's
// uncredited part: it lagged the popup by up to a checkpoint.
test('shows the popup’s minute for a running site before a checkpoint', async ({
  context,
  serviceWorker,
  extensionId,
  site,
}) => {
  await seed(serviceWorker, await today(serviceWorker, { [SITE_A]: 9 * MINUTE }))
  const tab = await context.newPage()
  await tab.goto(site(SITE_A))
  await expect.poll(() => openInterval(serviceWorker)).not.toBeNull()
  await advance(serviceWorker, 70_000)

  // In a window of its own, unfocused, so the site's tab stays in use.
  const url = `chrome-extension://${extensionId}/usage.html`
  const page = await opens(context, () =>
    serviceWorker.evaluate((url) => chrome.windows.create({ url, focused: false }).then(() => undefined), url)
  )
  await expect(page.locator(`[data-site="${SITE_A}"] .site-time`)).toHaveText('10 min')
  await expect(page.locator('#total')).toHaveText('10 min')
  // Not yet credited.
  expect(await readToday(serviceWorker, SITE_A)).toBe(9 * MINUTE)
  const popup = await openPopup(context, serviceWorker, extensionId, site(SITE_A))
  await expect(popup.locator('#today')).toHaveText(/^00:10:/)
})

test('shows the chart as a table', async ({ context, serviceWorker, extensionId }) => {
  await seedUsage(serviceWorker)
  const page = await activity(context, extensionId)
  await page.getByRole('button', { name: 'Show as table' }).click()
  const table = page.getByRole('table')
  await expect(table.locator('tbody tr')).toHaveCount(24)
  await expect(table.locator('thead th')).toHaveText(['Hour', 'Total', SITE_A, SITE_B])
  const hour = await serviceWorker.evaluate(() => new Date().getHours())
  await expect(table.locator('tbody tr').nth(hour).locator('td').first()).toHaveText('25 min')
  await page.getByRole('button', { name: 'Show as chart' }).click()
  await expect(page.locator('#bars')).toBeVisible()
})

test('moves between bars with the keyboard', async ({ context, serviceWorker, extensionId }) => {
  await seedUsage(serviceWorker)
  const page = await activity(context, extensionId)
  const hour = await serviceWorker.evaluate(() => new Date().getHours())
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))

  // The busiest hour takes the chart's one tab stop.
  await page.locator(`#bar-${hour}`).focus()
  expect(await focused()).toMatch(/, 25 min$/)
  await page.keyboard.press('Home')
  expect(await focused()).toMatch(/^12 AM, /)
  await page.keyboard.press('ArrowRight')
  expect(await focused()).toMatch(/^1 AM, /)
  await page.keyboard.press('End')
  expect(await focused()).toMatch(/^11 PM, /)
  await expect(page.locator('#bars [tabindex="0"]')).toHaveCount(1)
})

test('says when nothing is recorded yet', async ({ context, serviceWorker, extensionId }) => {
  await seed(serviceWorker, { [await todayKey(serviceWorker)]: {} })
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/usage.html`)
  await expect(page.getByRole('heading', { name: 'No activity yet' })).toBeVisible()
})
