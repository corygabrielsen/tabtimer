import type { Page } from '@playwright/test'
import { test, expect, seed, today, LIMITS_KEY, OVERLAY_ID, BLOCK_ID, MINUTE } from './fixtures'

// The soft landing: over the last 10 s before a block, the block screen's
// background fades in over a page that stays fully usable, then the block
// screen takes over.

const SITE = 'site-a.test'
const LANDING_ID = 'tabtimer-landing'
const LIMIT = { [LIMITS_KEY]: { global: null, perSite: { [SITE]: 1 } } }

// The landing's display, opacity and pointer-events, as the page computes them.
const landing = (page: Page) =>
  page.evaluate((id) => {
    const el = document.getElementById(id)
    if (!el) {
      return null
    }
    const s = getComputedStyle(el)
    return { display: s.display, opacity: Number(s.opacity), pointerEvents: s.pointerEvents }
  }, LANDING_ID)

const opacity = async (page: Page) => (await landing(page))?.opacity ?? 0

// A tab on SITE with `spent` of its 1-minute limit already used today.
async function openAt(
  context: import('@playwright/test').BrowserContext,
  sw: import('@playwright/test').Worker,
  url: string,
  spent: number
) {
  await seed(sw, { ...LIMIT, ...(await today(sw, { [SITE]: spent })) })
  const page = await context.newPage()
  await page.goto(url)
  await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached()
  return page
}

test('fades in over a page that stays usable, then the block screen takes over', async ({
  context,
  serviceWorker,
  site,
}) => {
  // About 8 s from the limit.
  const page = await openAt(context, serviceWorker, site(SITE, '/interactive'), MINUTE - 8000)
  await expect.poll(() => opacity(page)).toBeGreaterThan(0)
  const first = await landing(page)
  expect(first).toMatchObject({ display: 'block', pointerEvents: 'none' })
  expect(first!.opacity).toBeLessThan(1)
  await page.waitForTimeout(1500)
  const later = await opacity(page)
  expect(later).toBeGreaterThan(first!.opacity)
  expect(later).toBeLessThan(1)
  // The page's own button still takes a real click, through the landing.
  await page.click('#page-button')
  expect(await page.evaluate(() => (window as unknown as { pageClicks: number }).pageClicks)).toBe(1)
  await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
  await expect.poll(async () => (await landing(page))?.display).toBe('none')
})

test('shows nothing far from the limit', async ({ context, serviceWorker, site }) => {
  const page = await openAt(context, serviceWorker, site(SITE), 0)
  await page.waitForTimeout(1500)
  expect(await landing(page)).toMatchObject({ display: 'none', opacity: 0 })
})

test('clears when the limit is raised during the fade', async ({ context, serviceWorker, site }) => {
  const page = await openAt(context, serviceWorker, site(SITE), MINUTE - 7000)
  await expect.poll(() => opacity(page)).toBeGreaterThan(0)
  await seed(serviceWorker, { [LIMITS_KEY]: { global: null, perSite: { [SITE]: 30 } } })
  await expect.poll(async () => (await landing(page))?.display).toBe('none')
  await page.waitForTimeout(8000)
  await expect(page.locator(`#${BLOCK_ID}`)).toBeHidden()
  expect(await landing(page)).toMatchObject({ display: 'none' })
})
