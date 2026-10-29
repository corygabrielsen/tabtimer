import type { BrowserContext, Page, Worker } from '@playwright/test'
import { test, expect, seed, today, todayKey, openPopup, clickInShadow, LIMITS_KEY, BLOCK_ID, MINUTE } from './fixtures'

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

// Some of today's time on both sites, and a little yesterday.
async function seedUsage(sw: Worker, extra: Record<string, unknown> = {}): Promise<void> {
  const yesterday = await sw.evaluate(() => {
    const d = new Date(Date.now() - 86_400_000)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `day:${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  })
  await seed(sw, {
    ...(await today(sw, { [SITE_A]: 20 * MINUTE, [SITE_B]: 5 * MINUTE })),
    [yesterday]: { [SITE_A]: Array.from({ length: 24 }, (_, h) => (h === 9 ? 10 * MINUTE : 0)) },
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

test('opens from the block screen, which stays up', async ({ context, serviceWorker, extensionId, site }) => {
  await seedUsage(serviceWorker, { [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: 10 * MINUTE } } })
  const tab = await context.newPage()
  await tab.goto(site(SITE_A))
  await expect(blocked(tab)).toBeVisible()

  const page = await opens(context, () => clickInShadow(tab, BLOCK_ID, '.activity'))
  expect(page.url()).toBe(`chrome-extension://${extensionId}/usage.html`)
  await page.close()
  await tab.bringToFront()
  await expect(blocked(tab)).toBeVisible()
})

test('switches between day and week and steps through periods', async ({ context, serviceWorker, extensionId }) => {
  await seedUsage(serviceWorker)
  const page = await activity(context, extensionId)
  const label = page.locator('#period-label')
  const prev = page.locator('#prev')
  const next = page.locator('#next')

  await expect(label).toHaveText('Today')
  await expect(page.locator('#bars .bar')).toHaveCount(24)
  await expect(page.locator('#change')).toHaveText('↑ 150% from yesterday')
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
