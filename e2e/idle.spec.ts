import type { Worker } from '@playwright/test'
import { test, expect, readToday, shadowText, OVERLAY_ID } from './fixtures'

// Time away from the computer isn't counted. Playwright can't make the OS
// idle or lock the screen, so these tests set the state through the e2e
// build's hook (src/sw/testHook.ts), which runs the same tracker event a
// chrome.idle event does. The hook also runs the minute's checkpoint, so
// time is credited without waiting for the alarm.

const SITE_A = 'site-a.test'

type IdleState = 'active' | 'idle' | 'locked'
type Hook = { idle: (s: string) => Promise<void>; checkpoint: () => Promise<void> }

function setIdle(sw: Worker, state: IdleState): Promise<void> {
  return sw.evaluate((state) => (globalThis as unknown as { __tabtimerTest: Hook }).__tabtimerTest.idle(state), state)
}

function checkpoint(sw: Worker): Promise<void> {
  return sw.evaluate(() => (globalThis as unknown as { __tabtimerTest: Hook }).__tabtimerTest.checkpoint())
}

// The overlay pill's time today (its first HH:MM:SS), in seconds.
async function overlaySeconds(page: Parameters<typeof shadowText>[0]): Promise<number> {
  const match = /(\d\d):(\d\d):(\d\d)/.exec(await shadowText(page, OVERLAY_ID))
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN
}

test('headless Chromium reports the user as active, so only the hook moves the state', async ({ serviceWorker }) => {
  expect(await serviceWorker.evaluate(() => chrome.idle.queryState(300))).toBe('active')
  // ...and the worker recorded it (in memory-only session storage).
  await expect
    .poll(() =>
      serviceWorker.evaluate(() =>
        chrome.storage.session.get('away').then(({ away }) => (away as { state?: string } | undefined)?.state)
      )
    )
    .toBe('active')
})

test('locking the screen stops the count, and unlocking resumes it', async ({ context, serviceWorker, site }) => {
  const stored = () => readToday(serviceWorker, SITE_A)
  const page = await context.newPage()
  await page.goto(site(SITE_A))
  await expect.poll(() => overlaySeconds(page)).toBeGreaterThanOrEqual(2)

  await setIdle(serviceWorker, 'locked')
  // Going away reports what has accrued straight away.
  await expect.poll(stored).toBeGreaterThanOrEqual(1_500)
  // Let the overlay's next tick draw the final total.
  await page.waitForTimeout(1_500)
  const lockedAt = await stored()
  const shown = await overlaySeconds(page)
  await page.waitForTimeout(3_000)
  expect(await overlaySeconds(page)).toBe(shown)
  expect(await stored()).toBe(lockedAt)

  await setIdle(serviceWorker, 'active')
  await expect.poll(() => overlaySeconds(page)).toBeGreaterThanOrEqual(shown + 2)
  await page.goto('about:blank')
  await expect.poll(stored).toBeGreaterThanOrEqual(lockedAt + 1_500)
})

test('going idle takes the time since the last input back, and stops the count', async ({
  context,
  serviceWorker,
  site,
}) => {
  const stored = () => readToday(serviceWorker, SITE_A)
  const page = await context.newPage()
  await page.goto(site(SITE_A))
  await expect.poll(() => overlaySeconds(page)).toBeGreaterThanOrEqual(2)
  // Credited at the checkpoint, so there is stored time to take back.
  await checkpoint(serviceWorker)
  await expect.poll(stored).toBeGreaterThan(0)

  // Idle is reported five minutes after the last input; everything here is
  // more recent than that.
  await setIdle(serviceWorker, 'idle')
  await expect.poll(stored).toBe(0)
  await expect.poll(() => overlaySeconds(page)).toBe(0)
  await page.waitForTimeout(3_000)
  expect(await overlaySeconds(page)).toBe(0)
  expect(await stored()).toBe(0)

  await setIdle(serviceWorker, 'active')
  await expect.poll(() => overlaySeconds(page)).toBeGreaterThanOrEqual(2)
})

test('idle time counts while media plays, but not once the screen locks', async ({ context, serviceWorker, site }) => {
  const stored = () => readToday(serviceWorker, SITE_A)
  const page = await context.newPage()
  await page.goto(site(SITE_A, '/interactive'))
  // Silent audio, playing for real.
  await page.evaluate(() => (document.getElementById('media') as HTMLAudioElement).play())
  await expect.poll(() => overlaySeconds(page)).toBeGreaterThanOrEqual(1)
  await checkpoint(serviceWorker)
  await expect.poll(stored).toBeGreaterThan(0)

  await setIdle(serviceWorker, 'idle')
  await page.waitForTimeout(500)
  const idleAt = await overlaySeconds(page)
  expect(idleAt).toBeGreaterThan(0)
  await expect.poll(() => overlaySeconds(page)).toBeGreaterThanOrEqual(idleAt + 2)
  await page.goto('about:blank')
  await expect.poll(stored).toBeGreaterThanOrEqual((idleAt + 1) * 1000)

  // Locked pauses even with media playing.
  await page.goto(site(SITE_A, '/interactive'))
  await page.evaluate(() => (document.getElementById('media') as HTMLAudioElement).play())
  await setIdle(serviceWorker, 'locked')
  await page.waitForTimeout(1_500)
  const lockedAt = await overlaySeconds(page)
  await page.waitForTimeout(2_500)
  expect(await overlaySeconds(page)).toBe(lockedAt)
})
