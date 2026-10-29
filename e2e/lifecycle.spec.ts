import type { BrowserContext, Page } from '@playwright/test'
import {
  test,
  expect,
  seed,
  today,
  readToday,
  openInterval,
  LIMITS_KEY,
  OVERLAY_ID,
  BLOCK_ID,
  MINUTE,
} from './fixtures'

// The open tabs follow the grants and the extension itself: a grant starts
// its open tabs, a revoke stops them, and a page that outlives its extension
// (updated, reloaded, disabled) removes itself. Grants and revokes go through
// Chrome's own site access controls (chrome://extensions), the one way to
// change them without a permission prompt.

const SITE_A = 'site-a.test'
const ORIGINS = [`*://${SITE_A}/*`, `*://*.${SITE_A}/*`]

// Run a chrome.developerPrivate or chrome.management call from
// chrome://extensions, as its controls do.
async function extensionsPage(context: BrowserContext) {
  const page = await context.newPage()
  await page.goto('chrome://extensions')
  return (api: string, ...args: unknown[]) =>
    page.evaluate(
      async ([api, args]) => {
        const [ns, fn] = api.split('.') as [string, string]
        const chromeApi = chrome as unknown as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>
        await chromeApi[ns]![fn]!(...args)
      },
      [api, args] as const
    )
}

const overlay = (page: Page) => page.locator(`#${OVERLAY_ID}`)

test('X2/KNOWN-1: revoking stops an open tab, and granting starts it again without a reload', async ({
  context,
  serviceWorker,
  extensionId,
  site,
}) => {
  const page = await context.newPage()
  await page.goto(site(SITE_A))
  await expect(overlay(page)).toBeAttached()
  const call = await extensionsPage(context)

  // "On specific sites": every host grant withheld, as a revoke.
  await call('developerPrivate.updateExtensionConfiguration', { extensionId, hostAccess: 'ON_SPECIFIC_SITES' })
  await expect.poll(() => serviceWorker.evaluate(() => chrome.permissions.getAll().then((p) => p.origins))).toEqual([])
  await expect(overlay(page)).toHaveCount(0)

  for (const origin of ORIGINS) {
    await call('developerPrivate.addHostPermission', extensionId, origin)
  }
  await expect(overlay(page)).toBeAttached()
  await page.bringToFront()
  await expect.poll(() => openInterval(serviceWorker)).not.toBeNull()
  await page.goto('about:blank')
  await expect.poll(() => readToday(serviceWorker, SITE_A)).toBeGreaterThan(0)
})

test('X1/P3: a page that outlives its extension removes itself and never blocks', async ({
  context,
  serviceWorker,
  extensionId,
  site,
}) => {
  // A second from the limit: the page's last state blocks soon.
  await seed(serviceWorker, {
    [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: 1 } },
    ...(await today(serviceWorker, { [SITE_A]: MINUTE - 3_000 })),
  })
  const page = await context.newPage()
  await page.goto(site(SITE_A))
  await expect(overlay(page)).toBeAttached()
  await expect(page.locator(`#${BLOCK_ID}`)).toBeHidden()
  const call = await extensionsPage(context)

  await call('management.setEnabled', extensionId, false)
  await expect(overlay(page)).toHaveCount(0)
  await page.waitForTimeout(5_000)
  await expect(page.locator(`#${BLOCK_ID}`)).toHaveCount(0)
  await expect(overlay(page)).toHaveCount(0)

  // Enabled again: the new worker starts the open tab.
  await call('management.setEnabled', extensionId, true)
  await expect(overlay(page)).toBeAttached()
  await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
})
