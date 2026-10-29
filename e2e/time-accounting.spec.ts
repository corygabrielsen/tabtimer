import { test, expect, readToday, seed, today, LIMITS_KEY, MINUTE, OVERLAY_ID, BLOCK_ID } from './fixtures'

// Time accounting in a real tab: how much focus time reaches storage across
// re-injection and navigation.

const SITE_A = 'site-a.test'

test('B5: re-enabling a site without a reload counts focus time once', async ({ context, serviceWorker, site }) => {
  const page = await context.newPage()
  const start = Date.now()
  await page.goto(site(SITE_A))
  await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached()

  // The popup's "Enable on this site" path, on a page whose instance from an
  // earlier grant is still running (disable in options leaves it in place):
  // it injects content.js into the tab again. The fixture hosts are granted
  // at install, so the permission toggling itself (a prompt) is skipped.
  await serviceWorker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url })
    await chrome.scripting.executeScript({ target: { tabId: tab!.id! }, files: ['content.js'] })
  }, `http://${SITE_A}/*`)

  await page.waitForTimeout(4_000)
  // Leaving the page fires pagehide, which flushes every instance's pending
  // focus time to the service worker.
  await page.goto('about:blank')
  const wall = Date.now() - start
  await page.waitForTimeout(500)

  // One tab, focused the whole time: at most its wall-clock lifetime.
  const total = await readToday(serviceWorker, SITE_A)
  expect(total).toBeGreaterThan(wall / 2)
  expect(total).toBeLessThanOrEqual(wall)
})

test('B9: a page restored from the back/forward cache keeps tracking and blocking', async ({
  context,
  serviceWorker,
  site,
}) => {
  const stored = () => readToday(serviceWorker, SITE_A)
  const page = await context.newPage()
  await page.goto(site(SITE_A, '/one'))
  await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached()
  // A main-world marker survives only if the page itself is restored.
  await page.evaluate(() => ((window as unknown as { bfcacheMarker: number }).bfcacheMarker = 1))

  // Same-origin navigation away and back: eligible for the bfcache.
  await page.goto(site(SITE_A, '/two'))
  await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached()
  // A bfcache restore fires no load event, so wait only for the commit.
  await page.goBack({ waitUntil: 'commit' })
  expect(await page.evaluate(() => (window as unknown as { bfcacheMarker?: number }).bfcacheMarker)).toBe(1)
  await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached()

  // The restored instance still enforces limits...
  await seed(serviceWorker, {
    [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: 1 } },
    ...(await today(serviceWorker, { [SITE_A]: 2 * MINUTE })),
  })
  await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
  await seed(serviceWorker, { [LIMITS_KEY]: { global: null, perSite: {} } })
  await expect(page.locator(`#${BLOCK_ID}`)).toBeHidden()

  // ...and still counts: time spent after the restore reaches storage when
  // the page is left again.
  const before = await stored()
  await page.waitForTimeout(3_000)
  await page.goto('about:blank')
  await expect.poll(stored).toBeGreaterThanOrEqual(before + 2_000)
})
