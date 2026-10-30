import type { BrowserContext, Page } from '@playwright/test'
import {
  test,
  expect,
  advance,
  checkpoint,
  focusWindow,
  openInterval,
  readToday,
  setPageFocus,
  shadowText,
  OVERLAY_ID,
} from './fixtures'

// The service worker owns active time: one open interval, kept in
// storage.session, so it survives the worker being stopped and can never
// count two windows at once.

const SITE_A = 'site-a.test'
const SITE_B = 'site-b.test'

// The overlay pill's time today, in seconds.
async function overlaySeconds(page: Page): Promise<number> {
  const match = /(\d\d):(\d\d):(\d\d)/.exec(await shadowText(page, OVERLAY_ID))
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN
}

// Stop the extension's service worker, as Chrome does to an idle one, and
// wait until it has stopped. Resolves with a function that waits for it to
// run again.
async function stopWorker(context: BrowserContext, page: Page): Promise<() => Promise<void>> {
  const cdp = await context.newCDPSession(page)
  let status = ''
  const changed: Array<() => void> = []
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
    status = versions.at(-1)?.runningStatus ?? status
    changed.splice(0).forEach((fn) => fn())
  })
  const until = (want: string) =>
    new Promise<void>((resolve) => {
      const check = () => (status === want ? resolve() : changed.push(check))
      check()
    })
  await cdp.send('ServiceWorker.enable')
  await until('running')
  await cdp.send('ServiceWorker.stopAllWorkers')
  await until('stopped')
  return async () => {
    await until('running')
    await cdp.detach()
  }
}

test('time continues correctly after the service worker is stopped mid-session', async ({
  context,
  serviceWorker,
  site,
}) => {
  const page = await context.newPage()
  const start = Date.now()
  await page.goto(site(SITE_A))
  await expect.poll(() => overlaySeconds(page)).toBeGreaterThanOrEqual(2)

  const running = await stopWorker(context, page)

  // The page keeps showing time while no worker runs, and never goes back.
  let last = 0
  for (let i = 0; i < 6; i++) {
    const shown = await overlaySeconds(page)
    expect(shown).toBeGreaterThanOrEqual(last)
    last = shown
    await page.waitForTimeout(500)
  }

  // Taking focus away is the next event: it starts a fresh worker, which
  // reads the open interval back from storage.session and credits it.
  await setPageFocus(page, false)
  await running()
  const sw = serviceWorker
  await expect.poll(() => readToday(sw, SITE_A)).toBeGreaterThan(0)
  const left = Date.now()
  const credited = await readToday(sw, SITE_A)
  expect(credited).toBeLessThanOrEqual(left - start)
  expect(credited).toBeGreaterThanOrEqual(last * 1000 - 2_000)
  expect(await overlaySeconds(page)).toBeGreaterThanOrEqual(last)

  // And it keeps counting from there (on the new worker's clock, moved
  // forward through the e2e build's hook).
  const resumed = Date.now()
  await setPageFocus(page, true)
  await expect.poll(() => openInterval(sw)).not.toBeNull()
  await advance(sw, 30_000)
  await setPageFocus(page, false)
  await expect.poll(() => readToday(sw, SITE_A)).toBeGreaterThanOrEqual(credited + 30_000)
  expect(await readToday(sw, SITE_A)).toBeLessThanOrEqual(credited + 30_000 + Date.now() - resumed)
})

test('two visible windows never count at once: only the focused one does', async ({ context, serviceWorker, site }) => {
  const pageA = await context.newPage()
  await pageA.goto(site(SITE_A))
  const opened = context.waitForEvent('page')
  const windowB = await serviceWorker.evaluate(
    (url) => chrome.windows.create({ url, focused: false }).then((w) => w!.id!),
    site(SITE_B)
  )
  const pageB = await opened
  await pageB.waitForLoadState()
  await expect.poll(() => overlaySeconds(pageA)).toBeGreaterThanOrEqual(0)
  await expect.poll(() => overlaySeconds(pageB)).toBeGreaterThanOrEqual(0)
  const windowA = await serviceWorker.evaluate(
    (url) => chrome.tabs.query({ url: `${url}*` }).then(([tab]) => tab!.windowId),
    site(SITE_A)
  )
  expect(windowA).not.toBe(windowB)

  const totals = async () => {
    await checkpoint(serviceWorker)
    return { a: await readToday(serviceWorker, SITE_A), b: await readToday(serviceWorker, SITE_B) }
  }
  // The focused window's page is asked, and reports itself in use.
  const focus = async (windowId: number) => {
    await focusWindow(serviceWorker, windowId)
    await expect.poll(() => openInterval(serviceWorker).then((open) => open?.windowId ?? null)).toBe(windowId)
  }

  for (const [focused, other] of [
    ['a', 'b'],
    ['b', 'a'],
  ] as const) {
    await focus(focused === 'a' ? windowA : windowB)
    const t0 = Date.now()
    const before = await totals()
    await advance(serviceWorker, 30_000)
    const after = await totals()
    const elapsed = 30_000 + Date.now() - t0
    // The focused window's site gained the time; the other, visible all
    // along, gained nothing; together, no more than the time that passed.
    expect(after[focused] - before[focused]).toBeGreaterThanOrEqual(30_000)
    expect(after[other] - before[other]).toBe(0)
    expect(after.a - before.a + (after.b - before.b)).toBeLessThanOrEqual(elapsed)
  }
})
