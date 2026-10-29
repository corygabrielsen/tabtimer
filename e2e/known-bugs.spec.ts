import {
  test,
  expect,
  seed,
  read,
  todayKey,
  shadowAttribute,
  LIMITS_KEY,
  OVERLAY_ID,
  BLOCK_ID,
  MINUTE,
} from './fixtures'

// Known bugs, asserted as the CORRECT behaviour and marked test.fail() so the
// suite stays green while they're open. When a fix lands its test starts
// passing, Playwright reports that as a failure, and the test.fail() line
// (with its bug ID) is deleted.
//
// Not covered here — B2 (midnight rollover in one tab zeroes the new day's
// key after other tabs logged post-midnight time): it needs the content
// script's clock moved across midnight, and Playwright's clock only patches
// the page's main world, not the extension's isolated world. Left to unit
// tests.

const SITE_A = 'site-a.test'
const BLOCKING = { [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: MINUTE } } }

// Short polls: a known-failing assertion shouldn't burn the default timeout.
const QUICK = { timeout: 2_000 }

test('B5: re-enabling a site without a reload counts focus time once', async ({ context, serviceWorker, site }) => {
  test.fail(true, 'B5: popup enable re-injects content.js without disposing the running instance')
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

test('B6: block screen takes focus on the snooze button', async ({ context, serviceWorker, site }) => {
  test.fail(true, 'B6: block screen does not move focus')
  await seed(serviceWorker, { ...BLOCKING, [await todayKey(serviceWorker, SITE_A)]: 2 * MINUTE })
  const page = await context.newPage()
  await page.goto(site(SITE_A, '/interactive'))
  const block = page.locator(`#${BLOCK_ID}`)
  await expect(block).toBeVisible()

  // Focus inside a closed shadow root retargets to its host.
  await expect.poll(() => page.evaluate(() => document.activeElement?.id), QUICK).toBe(BLOCK_ID)
  // ...and it's the snooze button: Enter activates it.
  await page.keyboard.press('Enter')
  await expect(block).toBeHidden()
})

test('B6: block screen is modal and traps Tab', async ({ context, serviceWorker, site }) => {
  test.fail(true, 'B6: no aria-modal, and Tab reaches page elements behind the block')
  await seed(serviceWorker, { ...BLOCKING, [await todayKey(serviceWorker, SITE_A)]: 2 * MINUTE })
  const page = await context.newPage()
  await page.goto(site(SITE_A, '/interactive'))
  await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()

  const focused: (string | undefined)[] = []
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab')
    focused.push(await page.evaluate(() => document.activeElement?.id))
  }
  expect(focused).toEqual(Array(4).fill(BLOCK_ID))
  expect(await shadowAttribute(page, BLOCK_ID, '[role="alertdialog"]', 'aria-modal')).toBe('true')
})

test('B6: block screen pauses playing media', async ({ context, serviceWorker, site }) => {
  test.fail(true, 'B6: <audio>/<video> keeps playing behind the block')
  await seed(serviceWorker, { [await todayKey(serviceWorker, SITE_A)]: 2 * MINUTE })
  const page = await context.newPage()
  await page.goto(site(SITE_A, '/interactive'))
  await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached()
  await page.evaluate(() => (document.getElementById('media') as HTMLAudioElement).play())
  const paused = () => page.evaluate(() => (document.getElementById('media') as HTMLAudioElement).paused)
  expect(await paused()).toBe(false)

  // Hit the limit while the media is playing.
  await seed(serviceWorker, BLOCKING)
  await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
  await expect.poll(paused, QUICK).toBe(true)
})
