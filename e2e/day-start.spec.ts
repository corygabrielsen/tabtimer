import type { Worker } from '@playwright/test'
import { test, expect, advance, openInterval, read, seed, BLOCK_ID, LIMITS_KEY, MINUTE, OVERLAY_ID } from './fixtures'

// "Day starts at": the daily budget runs from the hour chosen, not midnight.
// The clock can't be set to 01:00, so each test takes the worker's current
// hour H: a day starting at H + 1 puts now in the day before (as 01:00 is,
// with the day starting at 06:00), and a day starting at H has just reset.

const SITE_A = 'site-a.test'
const PREFS_KEY = 'prefs'

// The worker's local hour, the time left in it, and the day:* keys for
// today's and yesterday's dates.
function clock(sw: Worker): Promise<{ hour: number; left: number; today: string; yesterday: string }> {
  return sw.evaluate(() => {
    const now = new Date()
    const key = (back: number) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
      const pad = (n: number) => String(n).padStart(2, '0')
      return `day:${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1).getTime()
    return { hour: now.getHours(), left: next - now.getTime(), today: key(0), yesterday: key(1) }
  })
}

const prefs = (dayStart: number) => ({ [PREFS_KEY]: { hidden: false, scale: 1, dayStart } })
const LIMIT = { [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: 30 } } }
// A day's usage on SITE_A: `ms` in `hour`.
const usage = (hour: number, ms: number) => ({
  [SITE_A]: Array.from({ length: 24 }, (_, h) => (h === hour ? ms : 0)),
})
const total = async (sw: Worker, key: string) =>
  (((await read(sw, key)) as Record<string, number[]> | undefined)?.[SITE_A] ?? []).reduce((a, b) => a + b, 0)

// The worker's clock runs ahead on advance(), the page's doesn't: each test
// blocks before advancing, or advances without blocking.
const needsLater = (now: { hour: number; left: number }) => now.hour === 23 || now.left < 2 * MINUTE

test('before the day starts, the day before’s limit still blocks', async ({ context, serviceWorker, site }) => {
  const now = await clock(serviceWorker)
  test.skip(needsLater(now), 'needs a later hour the day can start at')
  await seed(serviceWorker, { ...prefs(now.hour + 1), ...LIMIT, [now.yesterday]: usage(now.hour, 40 * MINUTE) })
  const page = await context.newPage()
  await page.goto(site(SITE_A))
  await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
  expect(await read(serviceWorker, now.today)).toBeUndefined()
  // With the day starting at midnight, that time was yesterday's: no block.
  await seed(serviceWorker, prefs(0))
  await expect(page.locator(`#${BLOCK_ID}`)).toBeHidden()
})

test('before the day starts, time spent counts toward the day before', async ({ context, serviceWorker, site }) => {
  const now = await clock(serviceWorker)
  test.skip(needsLater(now), 'needs a later hour the day can start at')
  await seed(serviceWorker, { ...prefs(now.hour + 1), ...LIMIT, [now.yesterday]: usage(now.hour, 20 * MINUTE) })
  const page = await context.newPage()
  await page.goto(site(SITE_A))
  await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached()
  await expect(page.locator(`#${BLOCK_ID}`)).toBeHidden()
  await expect.poll(() => openInterval(serviceWorker)).not.toBeNull()
  await advance(serviceWorker, 30_000)
  await page.goto('about:blank')
  await expect.poll(() => total(serviceWorker, now.yesterday)).toBeGreaterThanOrEqual(20 * MINUTE + 30_000)
  expect(await read(serviceWorker, now.today)).toBeUndefined()
})

test('from the hour the day starts, the budget is fresh', async ({ context, serviceWorker, site }) => {
  const now = await clock(serviceWorker)
  test.skip(now.left < 2 * MINUTE, 'too near the next hour')
  // Over the limit in the hour before this one: the day before's, filed
  // under yesterday's date.
  const before = (now.hour + 23) % 24
  await seed(serviceWorker, { ...prefs(now.hour), ...LIMIT, [now.yesterday]: usage(before, 40 * MINUTE) })

  const page = await context.newPage()
  await page.goto(site(SITE_A))
  await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached()
  await expect(page.locator(`#${BLOCK_ID}`)).toBeHidden()
  await expect.poll(() => openInterval(serviceWorker)).not.toBeNull()
  await advance(serviceWorker, 30_000)
  await page.goto('about:blank')
  // New time goes to today's date; the day before keeps its own.
  await expect.poll(() => total(serviceWorker, now.today)).toBeGreaterThanOrEqual(30_000)
  expect(await total(serviceWorker, now.yesterday)).toBe(40 * MINUTE)
})

test('the day start chosen in settings is saved and shown again', async ({ context, serviceWorker, extensionId }) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)
  const picker = page.getByLabel('Day starts at')
  await expect(picker).toHaveValue('0')
  await expect(picker.locator('option').first()).toHaveText('Midnight')
  await picker.selectOption('6')
  await expect(page.locator('#day-start-saved')).toHaveText('Saved')
  await expect.poll(() => read(serviceWorker, PREFS_KEY)).toMatchObject({ dayStart: 6 })
  await page.reload()
  await expect(page.getByLabel('Day starts at')).toHaveValue('6')
})
