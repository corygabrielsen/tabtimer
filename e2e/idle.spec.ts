import { test, expect, advance, checkpoint, openInterval, readToday, setIdle, shadowText, OVERLAY_ID } from './fixtures'

// Time away from the computer isn't counted. Playwright can't make the OS
// idle or lock the screen, so these tests set the state through the e2e
// build's hook (src/sw/testHook.ts), which runs the same tracker event a
// chrome.idle event does. The hook also moves the worker's clock forward and
// runs the minute's checkpoint, so time accrues without waiting it out.

const SITE_A = 'site-a.test'

// The overlay pill's time today (its first HH:MM:SS), in seconds.
async function overlaySeconds(page: Parameters<typeof shadowText>[0]): Promise<number> {
  const match = /(\d+):(\d\d):(\d\d)/.exec(await shadowText(page, OVERLAY_ID))
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN
}

test('headless Chromium reports the user as active, so only the hook moves the state', async ({ serviceWorker }) => {
  expect(await serviceWorker.evaluate(() => chrome.idle.queryState(300))).toBe('active')
  // ...and the worker recorded it (in memory-only session storage).
  await expect
    .poll(() =>
      serviceWorker.evaluate(() =>
        chrome.storage.session
          .get('worker')
          .then(({ worker }) => (worker as { away?: { state?: string } } | undefined)?.away?.state)
      )
    )
    .toBe('active')
})

test('locking the screen stops the count, and unlocking resumes it', async ({ context, serviceWorker, site }) => {
  const stored = () => readToday(serviceWorker, SITE_A)
  const page = await context.newPage()
  const start = Date.now()
  await page.goto(site(SITE_A))
  await expect.poll(() => openInterval(serviceWorker)).not.toBeNull()
  await advance(serviceWorker, 30_000)

  await setIdle(serviceWorker, 'locked')
  // Going away reports what has accrued straight away.
  await expect.poll(stored).toBeGreaterThanOrEqual(30_000)
  const lockedAt = await stored()
  expect(lockedAt).toBeLessThanOrEqual(30_000 + Date.now() - start)
  // Nothing accrues while locked, on the worker's clock or the page's.
  await advance(serviceWorker, 30_000)
  await checkpoint(serviceWorker)
  expect(await stored()).toBe(lockedAt)
  // Let the overlay's next tick draw the final total.
  await page.waitForTimeout(1_500)
  const shown = await overlaySeconds(page)
  expect(shown).toBe(Math.floor(lockedAt / 1000))
  await page.waitForTimeout(3_000)
  expect(await overlaySeconds(page)).toBe(shown)
  expect(await stored()).toBe(lockedAt)

  const resumed = Date.now()
  await setIdle(serviceWorker, 'active')
  await expect.poll(() => openInterval(serviceWorker)).not.toBeNull()
  await advance(serviceWorker, 20_000)
  await page.goto('about:blank')
  await expect.poll(stored).toBeGreaterThanOrEqual(lockedAt + 20_000)
  expect(await stored()).toBeLessThanOrEqual(lockedAt + 20_000 + Date.now() - resumed)
})

test('going idle takes the time since the last input back, and stops the count', async ({
  context,
  serviceWorker,
  site,
}) => {
  const stored = () => readToday(serviceWorker, SITE_A)
  const page = await context.newPage()
  await page.goto(site(SITE_A))
  await expect.poll(() => openInterval(serviceWorker)).not.toBeNull()
  // Credited at the checkpoint, so there is stored time to take back.
  await advance(serviceWorker, 30_000)
  await checkpoint(serviceWorker)
  expect(await stored()).toBeGreaterThanOrEqual(30_000)

  // Idle is reported five minutes after the last input; everything here is
  // more recent than that.
  await setIdle(serviceWorker, 'idle')
  await expect.poll(stored).toBe(0)
  await expect.poll(() => overlaySeconds(page)).toBe(0)
  await advance(serviceWorker, 30_000)
  await checkpoint(serviceWorker)
  await page.waitForTimeout(3_000)
  expect(await overlaySeconds(page)).toBe(0)
  expect(await stored()).toBe(0)

  await setIdle(serviceWorker, 'active')
  await expect.poll(() => openInterval(serviceWorker)).not.toBeNull()
  await advance(serviceWorker, 20_000)
  await checkpoint(serviceWorker)
  expect(await stored()).toBeGreaterThanOrEqual(20_000)
})

test('idle time counts while media plays, but not once the screen locks', async ({ context, serviceWorker, site }) => {
  const stored = () => readToday(serviceWorker, SITE_A)
  const page = await context.newPage()
  const start = Date.now()
  await page.goto(site(SITE_A, '/interactive'))
  // Silent audio, playing for real.
  await page.evaluate(() => (document.getElementById('media') as HTMLAudioElement).play())
  await expect.poll(() => openInterval(serviceWorker).then((open) => open?.media)).toBe(true)
  await advance(serviceWorker, 20_000)
  await checkpoint(serviceWorker)
  expect(await stored()).toBeGreaterThanOrEqual(20_000)

  await setIdle(serviceWorker, 'idle')
  await advance(serviceWorker, 20_000)
  await page.goto('about:blank')
  await expect.poll(stored).toBeGreaterThanOrEqual(40_000)
  const idleTotal = await stored()
  expect(idleTotal).toBeLessThanOrEqual(40_000 + Date.now() - start)

  // Locked pauses even with media playing.
  await page.goto(site(SITE_A, '/interactive'))
  await page.evaluate(() => (document.getElementById('media') as HTMLAudioElement).play())
  await setIdle(serviceWorker, 'locked')
  const lockedTotal = await stored()
  await advance(serviceWorker, 20_000)
  await checkpoint(serviceWorker)
  expect(await stored()).toBe(lockedTotal)
  await page.waitForTimeout(1_500)
  const lockedAt = await overlaySeconds(page)
  await page.waitForTimeout(2_500)
  expect(await overlaySeconds(page)).toBe(lockedAt)
})
