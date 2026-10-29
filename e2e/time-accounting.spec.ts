import {
  test,
  expect,
  advance,
  openInterval,
  readToday,
  seed,
  today,
  LIMITS_KEY,
  MINUTE,
  OVERLAY_ID,
  BLOCK_ID,
} from './fixtures'

// Time accounting in a real tab: how much focus time reaches storage across
// re-injection and navigation. The worker's clock is moved forward through
// the e2e build's hook, so time accrues without waiting it out.

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

  await expect.poll(() => openInterval(serviceWorker)).not.toBeNull()
  await advance(serviceWorker, 30_000)
  // Leaving the page fires pagehide: every instance reports the page gone.
  await page.goto('about:blank')
  await expect.poll(() => openInterval(serviceWorker)).toBeNull()
  const lifetime = 30_000 + Date.now() - start

  // One tab, focused the whole time: at most its lifetime, counted once.
  const total = await readToday(serviceWorker, SITE_A)
  expect(total).toBeGreaterThanOrEqual(30_000)
  expect(total).toBeLessThanOrEqual(lifetime)
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
  const resumed = Date.now()
  await seed(serviceWorker, { [LIMITS_KEY]: { global: null, perSite: {} } })
  await expect(page.locator(`#${BLOCK_ID}`)).toBeHidden()

  // ...and still counts: time spent after the restore reaches storage when
  // the page is left again.
  await expect.poll(() => openInterval(serviceWorker)).not.toBeNull()
  const before = await stored()
  await advance(serviceWorker, 30_000)
  await page.goto('about:blank')
  await expect.poll(stored).toBeGreaterThanOrEqual(before + 30_000)
  expect(await stored()).toBeLessThanOrEqual(before + 30_000 + Date.now() - resumed)
})
