import {
  test,
  expect,
  seed,
  read,
  todayKey,
  shadowText,
  clickInShadow,
  LIMITS_KEY,
  SNOOZE_KEY,
  OVERLAY_ID,
  BLOCK_ID,
  MINUTE,
} from './fixtures'

const SITE_A = 'site-a.test'
const SITE_B = 'site-b.test'
const UNTRACKED = 'untracked.test'

// HH:MM:SS from the overlay pill, as seconds.
function seconds(text: string): number {
  const match = /(\d\d):(\d\d):(\d\d)/.exec(text)
  if (!match) {
    return NaN
  }
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

test('loads: service worker alive and options page renders', async ({ context, serviceWorker, extensionId }) => {
  expect(serviceWorker.url()).toBe(`chrome-extension://${extensionId}/service-worker-loader.js`)
  expect(await serviceWorker.evaluate(() => chrome.runtime.getManifest().name)).toBe('Tab Timer')

  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('radiogroup', { name: 'All tracked sites combined' })).toBeVisible()
  // The fixture hosts are granted, so they list as tracked sites.
  await expect(page.locator('#tracked-sites')).toContainText(SITE_A)
})

test('limits set from the options page: a preset chip and a custom value', async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)

  // All-sites cap: one tap on a preset saves it.
  const cap = page.getByRole('radiogroup', { name: 'All tracked sites combined' })
  await cap.getByRole('radio', { name: '2 h' }).click()
  await expect(cap.getByRole('radio', { name: '2 h' })).toHaveAttribute('aria-checked', 'true')
  await expect.poll(() => read(serviceWorker, LIMITS_KEY)).toEqual({ global: 120 * MINUTE, perSite: {} })

  // Per-site: expand the row, pick Custom, type minutes, Enter.
  await page.getByRole('button', { name: `Daily limit for ${SITE_A}: Off` }).click()
  const picker = page.getByRole('radiogroup', { name: `Daily limit for ${SITE_A}` })
  await picker.getByRole('radio', { name: 'Custom' }).click()
  await page.getByRole('textbox', { name: `Custom daily limit for ${SITE_A}, in minutes` }).fill('50')
  await page.keyboard.press('Enter')
  await expect(picker.getByRole('radio', { name: 'Custom: 50 min' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('button', { name: `Daily limit for ${SITE_A}: 50 min` })).toHaveText('50m')
  await expect
    .poll(() => read(serviceWorker, LIMITS_KEY))
    .toEqual({ global: 120 * MINUTE, perSite: { [SITE_A]: 50 * MINUTE } })

  // Arrow keys move and select; the value saves once the keys settle.
  await picker.getByRole('radio', { name: 'Custom: 50 min' }).focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await expect(picker.getByRole('radio', { name: '15 min' })).toBeFocused()
  await expect
    .poll(() => read(serviceWorker, LIMITS_KEY))
    .toEqual({ global: 120 * MINUTE, perSite: { [SITE_A]: 15 * MINUTE } })
})

test('tracked site shows the overlay and its time increases', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, { [await todayKey(serviceWorker, SITE_A)]: 65_000 })
  const page = await context.newPage()
  await page.goto(site(SITE_A))

  await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached()
  await expect.poll(async () => seconds(await shadowText(page, OVERLAY_ID))).toBeGreaterThanOrEqual(65)
  const first = seconds(await shadowText(page, OVERLAY_ID))
  await expect.poll(async () => seconds(await shadowText(page, OVERLAY_ID))).toBeGreaterThan(first)
  await expect(page.locator(`#${BLOCK_ID}`)).toBeHidden()
})

test('per-site limit blocks and names the site', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, {
    [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: 10 * MINUTE } },
    [await todayKey(serviceWorker, SITE_A)]: 10 * MINUTE + 1_000,
  })
  const page = await context.newPage()
  await page.goto(site(SITE_A))

  await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
  const text = await shadowText(page, BLOCK_ID)
  expect(text).toContain("Time's up")
  expect(text).toContain(SITE_A)
  expect(text).not.toContain('all tracked sites')
  expect(text).toContain('00:10:00 limit')
})

test('global cap across two tracked sites blocks', async ({ context, serviceWorker, site }) => {
  // Neither site alone reaches the 10-minute cap; together they exceed it.
  await seed(serviceWorker, {
    [LIMITS_KEY]: { global: 10 * MINUTE, perSite: {} },
    [await todayKey(serviceWorker, SITE_A)]: 6 * MINUTE,
    [await todayKey(serviceWorker, SITE_B)]: 5 * MINUTE,
  })
  for (const host of [SITE_A, SITE_B]) {
    const page = await context.newPage()
    await page.goto(site(host))
    await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
    const text = await shadowText(page, BLOCK_ID)
    expect(text).toContain('all tracked sites')
    expect(text).toContain('00:10:00 limit')
  }
})

test('"5 more minutes" lifts the block until the snooze expires', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, {
    [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: MINUTE } },
    [await todayKey(serviceWorker, SITE_A)]: 2 * MINUTE,
  })
  const page = await context.newPage()
  await page.goto(site(SITE_A))
  const block = page.locator(`#${BLOCK_ID}`)
  await expect(block).toBeVisible()

  await clickInShadow(page, BLOCK_ID, 'button.snooze')
  await expect(block).toBeHidden()
  const until = Number(await read(serviceWorker, SNOOZE_KEY))
  expect(until).toBeGreaterThan(Date.now() + 4 * MINUTE)

  // Fast-forward: expire the snooze in storage instead of waiting 5 minutes.
  await seed(serviceWorker, { [SNOOZE_KEY]: Date.now() - 1_000 })
  await expect(block).toBeVisible()
})

test('changing the limit lifts or restores the block live', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, {
    [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: MINUTE } },
    [await todayKey(serviceWorker, SITE_A)]: 2 * MINUTE,
  })
  const page = await context.newPage()
  await page.goto(site(SITE_A))
  const block = page.locator(`#${BLOCK_ID}`)
  await expect(block).toBeVisible()

  // Raise it above today's time: lifts without a reload.
  await seed(serviceWorker, { [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: 60 * MINUTE } } })
  await expect(block).toBeHidden()

  // Lower it again: blocks again.
  await seed(serviceWorker, { [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: MINUTE } } })
  await expect(block).toBeVisible()

  // Clear it: lifts.
  await seed(serviceWorker, { [LIMITS_KEY]: { global: null, perSite: {} } })
  await expect(block).toBeHidden()
})

test('untracked site gets no overlay', async ({ context, serviceWorker, site }) => {
  // Same profile and limits that would block any tracked site.
  await seed(serviceWorker, { [LIMITS_KEY]: { global: MINUTE, perSite: {} } })
  await seed(serviceWorker, { [await todayKey(serviceWorker, SITE_A)]: 2 * MINUTE })

  const untracked = await context.newPage()
  await untracked.goto(site(UNTRACKED))
  await expect(untracked.locator('h1')).toHaveText(`fixture ${UNTRACKED}:${new URL(site(UNTRACKED)).port}`)

  // Control: a tracked page in the same browser does get injected.
  const tracked = await context.newPage()
  await tracked.goto(site(SITE_A))
  await expect(tracked.locator(`#${OVERLAY_ID}`)).toBeAttached()
  await expect(tracked.locator(`#${BLOCK_ID}`)).toBeVisible()

  // By now any injection into the earlier-loaded untracked page would have run.
  await expect(untracked.locator(`#${OVERLAY_ID}`)).toHaveCount(0)
  await expect(untracked.locator(`#${BLOCK_ID}`)).toHaveCount(0)
  expect(await untracked.evaluate(() => document.documentElement.style.overflow)).toBe('')
})

test('a limit exactly equal to today’s time blocks; popup reset clears it', async ({
  context,
  serviceWorker,
  extensionId,
  site,
}) => {
  const key = await todayKey(serviceWorker, SITE_A)
  await seed(serviceWorker, { [key]: 3 * MINUTE })
  const page = await context.newPage()
  await page.goto(site(SITE_A))
  await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached()

  // Take window focus away so SITE_A stops accruing, then let the last
  // report (every 5 s) land: the stored total is what the limit compares.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await page.waitForTimeout(6_000)
  const today = Number(await read(serviceWorker, key))
  expect(today).toBeGreaterThanOrEqual(3 * MINUTE)
  const block = page.locator(`#${BLOCK_ID}`)

  // One second under: no block. Exactly equal: blocked.
  await seed(serviceWorker, { [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: today + 1_000 } } })
  await page.waitForTimeout(500)
  await expect(block).toBeHidden()
  await seed(serviceWorker, { [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: today } } })
  await expect.poll(() => shadowText(page, BLOCK_ID)).toContain("Time's up")
  await expect(block).toBeVisible()

  // The popup acts on the active tab; opened as a page, point it at SITE_A.
  const [tab] = await serviceWorker.evaluate((url) => chrome.tabs.query({ url }), `${site(SITE_A)}*`)
  const popup = await context.newPage()
  await popup.addInitScript(
    ({ id, url }) => {
      const query = chrome.tabs.query.bind(chrome.tabs)
      chrome.tabs.query = ((info: chrome.tabs.QueryInfo, callback?: (tabs: chrome.tabs.Tab[]) => void) => {
        if (info.active && callback) {
          callback([{ id, url } as chrome.tabs.Tab])
          return
        }
        return query(info, callback as never)
      }) as typeof chrome.tabs.query
    },
    { id: tab!.id!, url: tab!.url! }
  )
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)

  // Two clicks: arm, then confirm.
  await popup.getByRole('button', { name: `Reset today's time for ${SITE_A}` }).click()
  await popup.getByRole('button', { name: `Confirm: reset today's time for ${SITE_A}` }).click()
  await expect.poll(() => read(serviceWorker, key)).toBe(0)

  // Back on the site: unblocked, and the overlay starts again from zero.
  await page.bringToFront()
  await expect(block).toBeHidden()
  await expect.poll(async () => seconds(await shadowText(page, OVERLAY_ID))).toBeLessThan(10)
})
