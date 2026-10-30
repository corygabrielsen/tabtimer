import {
  test,
  expect,
  seed,
  read,
  today,
  readToday,
  setPageFocus,
  openInterval,
  checkpoint,
  shadowText,
  snoozeBlock,
  LIMITS_KEY,
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
  expect(await serviceWorker.evaluate(() => chrome.runtime.getManifest().incognito)).toBe('not_allowed')

  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('radiogroup', { name: 'All sites' })).toBeVisible()
  // The fixture hosts are granted, so they list as tracked sites.
  await expect(page.locator('#tracked-sites')).toContainText(SITE_A)
})

// The unit fake (src/test/chrome.ts) models these semantics.
test('a grant covers narrower patterns, and getAll lists it as granted', async ({ serviceWorker }) => {
  const holds = (origins: string[]) =>
    serviceWorker.evaluate((origins) => chrome.permissions.contains({ origins }), origins)
  expect(await holds([`https://www.${SITE_A}/*`, `http://${SITE_A}/*`, `*://*.x.${SITE_A}/*`])).toBe(true)
  expect(await holds([`*://${UNTRACKED}/*`])).toBe(false)
  expect(await holds(['*://*/*'])).toBe(false)
  const origins = await serviceWorker.evaluate(() => chrome.permissions.getAll().then((p) => p.origins))
  expect(origins).toEqual(expect.arrayContaining([`*://${SITE_A}/*`, `*://*.${SITE_A}/*`]))
})

test('the tracking table’s headers sit over their columns', async ({ context, serviceWorker, extensionId }) => {
  // A long today value and an expanded limit, the cases that once pushed
  // the header off its columns.
  await seed(serviceWorker, {
    [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: 30 } },
    ...(await today(serviceWorker, { [SITE_A]: 125 * MINUTE })),
  })
  const page = await context.newPage()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`chrome-extension://${extensionId}/options.html`)
  const row = page.locator(`#tracked-sites li[data-host="${SITE_A}"]`)
  await expect(row.locator('[data-today-host]')).toContainText('over')

  const headers = await page.locator('.cols > span').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right }
    })
  )
  const cells = await row.evaluate((li) =>
    ['.site-name', '[data-today-host]', '.limit-toggle', '.stop'].map((sel) => {
      const r = li.querySelector(sel)!.getBoundingClientRect()
      return { left: r.left, right: r.right }
    })
  )
  expect(headers).toHaveLength(4)
  // Each cell lies within its header's column, give or take the stop
  // button's bleed into the gutter.
  cells.forEach((cell, i) => {
    const header = headers[i]!
    expect(header.right - header.left, `header ${i} width`).toBeGreaterThan(0)
    const center = (cell.left + cell.right) / 2
    expect(center, `cell ${i} centre`).toBeGreaterThan(header.left)
    expect(center, `cell ${i} centre`).toBeLessThan(header.right)
    expect(cell.left, `cell ${i} left`).toBeGreaterThanOrEqual(header.left - 1)
    expect(cell.right, `cell ${i} right`).toBeLessThanOrEqual(header.right + 9)
  })
  // Numbers and the limit sit flush right under their right-aligned headers.
  expect(Math.abs(cells[1]!.right - headers[1]!.right)).toBeLessThan(1)
  expect(Math.abs(cells[2]!.right - headers[2]!.right)).toBeLessThan(1)
})

test('limits set from the options page: a preset chip and a custom value', async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)

  // All-sites cap: one tap on a preset saves it.
  const cap = page.getByRole('radiogroup', { name: 'All sites' })
  await cap.getByRole('radio', { name: '2 h' }).click()
  await expect(cap.getByRole('radio', { name: '2 h' })).toHaveAttribute('aria-checked', 'true')
  await expect.poll(() => read(serviceWorker, LIMITS_KEY)).toEqual({ global: 120, perSite: {}, snoozeUntil: 0 })

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
    .toEqual({ global: 120, perSite: { [SITE_A]: 50 }, snoozeUntil: 0 })

  // Arrow keys move and select; the value saves once the keys settle.
  await picker.getByRole('radio', { name: 'Custom: 50 min' }).focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await expect(picker.getByRole('radio', { name: '15 min' })).toBeFocused()
  await expect
    .poll(() => read(serviceWorker, LIMITS_KEY))
    .toEqual({ global: 120, perSite: { [SITE_A]: 15 }, snoozeUntil: 0 })
})

test('tracked site shows the overlay and its time increases', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, await today(serviceWorker, { [SITE_A]: 65_000 }))
  const page = await context.newPage()
  await page.goto(site(SITE_A))

  await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached()
  await expect.poll(async () => seconds(await shadowText(page, OVERLAY_ID))).toBeGreaterThanOrEqual(65)
  const first = seconds(await shadowText(page, OVERLAY_ID))
  await expect.poll(async () => seconds(await shadowText(page, OVERLAY_ID))).toBeGreaterThan(first)
  await expect(page.locator(`#${BLOCK_ID}`)).toBeHidden()
})

test('the overlay stays pinned to the top of the viewport under a page transform', async ({
  context,
  serviceWorker,
  site,
}) => {
  await seed(serviceWorker, await today(serviceWorker, { [SITE_A]: 65_000 }))
  const page = await context.newPage()
  await page.goto(site(SITE_A, '/scroll-document'))
  await expect.poll(async () => seconds(await shadowText(page, OVERLAY_ID))).toBeGreaterThanOrEqual(65)

  // As smooth-scroll libraries and filter-based dark modes do.
  await page.evaluate(() => {
    document.documentElement.style.transform = 'translateZ(0)'
    document.body.style.filter = 'invert(1)'
    window.scrollTo(0, 2000)
  })
  const { width } = page.viewportSize()!
  await expect
    .poll(() =>
      page.evaluate(
        ([id, x]) => [document.getElementById(id)!.getBoundingClientRect().top, document.elementFromPoint(x, 2)?.id],
        [OVERLAY_ID, width / 2] as const
      )
    )
    .toEqual([0, OVERLAY_ID])
})

test('per-site limit blocks and names the site', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, {
    [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: 10 } },
    ...(await today(serviceWorker, { [SITE_A]: 10 * MINUTE + 1_000 })),
  })
  const page = await context.newPage()
  await page.goto(site(SITE_A))

  await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
  const text = await shadowText(page, BLOCK_ID)
  expect(text).toContain('Take a break')
  expect(text).toContain(SITE_A)
  // Split at its own limit, named at the tick, and the second over it.
  expect(await shadowText(page, BLOCK_ID, '[data-now] .tick-label')).toBe('10 min')
})

test('global cap across two tracked sites blocks', async ({ context, serviceWorker, site }) => {
  // Neither site alone reaches the 10-minute cap; together they exceed it.
  await seed(serviceWorker, {
    [LIMITS_KEY]: { global: 10, perSite: {} },
    ...(await today(serviceWorker, { [SITE_A]: 6 * MINUTE, [SITE_B]: 5 * MINUTE })),
  })
  for (const host of [SITE_A, SITE_B]) {
    const page = await context.newPage()
    await page.goto(site(host))
    await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
    // The all-sites limit: this site's hours aren't split, nor named over.
    expect(await shadowText(page, BLOCK_ID, '.tick-label')).toBe('')
    expect(await shadowText(page, BLOCK_ID, '.val.over')).toBe('')
  }
})

test('"2 more minutes" lifts the block until the snooze expires', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, {
    [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: 1 } },
    ...(await today(serviceWorker, { [SITE_A]: 2 * MINUTE })),
  })
  const page = await context.newPage()
  await page.goto(site(SITE_A))
  const block = page.locator(`#${BLOCK_ID}`)
  await expect(block).toBeVisible()

  await snoozeBlock(page)
  await expect(block).toBeHidden()
  // The page lifts the block once held; the worker stores the snooze after.
  await expect
    .poll(async () => ((await read(serviceWorker, LIMITS_KEY)) as { snoozeUntil?: number }).snoozeUntil)
    .toBeGreaterThan(Date.now() + MINUTE)

  // Fast-forward: expire the snooze in storage instead of waiting 2 minutes.
  await seed(serviceWorker, {
    [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: 1 }, snoozeUntil: Date.now() - 1_000 },
  })
  await expect(block).toBeVisible()
})

test('changing the limit lifts or restores the block live', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, {
    [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: 1 } },
    ...(await today(serviceWorker, { [SITE_A]: 2 * MINUTE })),
  })
  const page = await context.newPage()
  await page.goto(site(SITE_A))
  const block = page.locator(`#${BLOCK_ID}`)
  await expect(block).toBeVisible()

  // Raise it above today's time: lifts without a reload.
  await seed(serviceWorker, { [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: 60 } } })
  await expect(block).toBeHidden()

  // Lower it again: blocks again.
  await seed(serviceWorker, { [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: 1 } } })
  await expect(block).toBeVisible()

  // Clear it: lifts.
  await seed(serviceWorker, { [LIMITS_KEY]: { global: null, perSite: {} } })
  await expect(block).toBeHidden()
})

test('untracked site gets no overlay', async ({ context, serviceWorker, site }) => {
  // Same profile and limits that would block any tracked site.
  await seed(serviceWorker, { [LIMITS_KEY]: { global: 1, perSite: {} } })
  await seed(serviceWorker, await today(serviceWorker, { [SITE_A]: 2 * MINUTE }))

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

test('a limit exactly equal to today’s time blocks', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, await today(serviceWorker, { [SITE_A]: 3 * MINUTE }))
  const page = await context.newPage()
  await page.goto(site(SITE_A))
  await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached()
  await expect.poll(() => openInterval(serviceWorker)).not.toBeNull()

  // Take window focus away so SITE_A stops accruing, wait for the worker to
  // close its interval (a transaction queued after it: credited too), then
  // put the stored total back on a whole minute: the stored total is what
  // the limit compares.
  await setPageFocus(page, false)
  await expect.poll(() => openInterval(serviceWorker)).toBeNull()
  await checkpoint(serviceWorker)
  await seed(serviceWorker, await today(serviceWorker, { [SITE_A]: 3 * MINUTE }))
  expect(await readToday(serviceWorker, SITE_A)).toBe(3 * MINUTE)
  const block = page.locator(`#${BLOCK_ID}`)

  // A minute under: no block. Exactly equal: blocked.
  await seed(serviceWorker, { [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: 4 } } })
  await page.waitForTimeout(500)
  await expect(block).toBeHidden()
  await seed(serviceWorker, { [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: 3 } } })
  await expect.poll(() => shadowText(page, BLOCK_ID)).toContain('Take a break')
  await expect(block).toBeVisible()
})
