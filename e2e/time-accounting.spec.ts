import { test, expect, read, todayKey, OVERLAY_ID } from './fixtures'

// Time accounting in a real tab: how much focus time reaches storage across
// re-injection and navigation.

const SITE_A = 'site-a.test'

test('B5: re-enabling a site without a reload counts focus time once', async ({ context, serviceWorker, site }) => {
  const key = await todayKey(serviceWorker, SITE_A)
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
  const total = Number(await read(serviceWorker, key))
  expect(total).toBeGreaterThan(wall / 2)
  expect(total).toBeLessThanOrEqual(wall)
})
