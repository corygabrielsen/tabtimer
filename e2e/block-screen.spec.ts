import type { Page } from '@playwright/test'
import {
  test,
  expect,
  seed,
  todayKey,
  shadowAttribute,
  clickInShadow,
  LIMITS_KEY,
  OVERLAY_ID,
  BLOCK_ID,
  MINUTE,
} from './fixtures'

// The block screen has to actually block: modal, focus kept inside it, the
// page behind it unreachable (keyboard, mouse, accessibility tree), media
// paused, and no way around it through fullscreen.

const SITE_A = 'site-a.test'
const BLOCKING = { [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: MINUTE } } }

const activeId = (page: Page) => page.evaluate(() => document.activeElement?.id)
const fullscreen = (page: Page) => page.evaluate(() => document.fullscreenElement !== null)

async function blockedPage(context: import('@playwright/test').BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(url)
  await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
  return page
}

test('takes focus on the snooze button, and gives it back on dismissal', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, { ...BLOCKING, [await todayKey(serviceWorker, SITE_A)]: 2 * MINUTE })
  const page = await blockedPage(context, site(SITE_A, '/interactive'))
  const block = page.locator(`#${BLOCK_ID}`)

  // Focus inside a closed shadow root retargets to its host.
  await expect.poll(() => activeId(page)).toBe(BLOCK_ID)
  // ...and it's the snooze button: Enter activates it.
  await page.keyboard.press('Enter')
  await expect(block).toBeHidden()
  expect(await activeId(page)).not.toBe(BLOCK_ID)
})

test('restores focus to the page control that had it', async ({ context, serviceWorker, site }) => {
  const page = await context.newPage()
  await page.goto(site(SITE_A, '/interactive'))
  await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached()
  await page.focus('#page-button')

  await seed(serviceWorker, { ...BLOCKING, [await todayKey(serviceWorker, SITE_A)]: 2 * MINUTE })
  await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
  await expect.poll(() => activeId(page)).toBe(BLOCK_ID)

  await clickInShadow(page, BLOCK_ID, 'button.snooze')
  await expect(page.locator(`#${BLOCK_ID}`)).toBeHidden()
  expect(await activeId(page)).toBe('page-button')
})

test('is modal and traps Tab', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, { ...BLOCKING, [await todayKey(serviceWorker, SITE_A)]: 2 * MINUTE })
  const page = await blockedPage(context, site(SITE_A, '/interactive'))

  const focused: (string | undefined)[] = []
  for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Tab', 'Tab']) {
    await page.keyboard.press(key)
    focused.push(await activeId(page))
  }
  expect(focused).toEqual(Array(5).fill(BLOCK_ID))
  expect(await shadowAttribute(page, BLOCK_ID, 'dialog[role="alertdialog"]', 'aria-modal')).toBe('true')
})

test('keeps the page out of reach of clicks and assistive tech', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, { ...BLOCKING, [await todayKey(serviceWorker, SITE_A)]: 2 * MINUTE })
  const page = await blockedPage(context, site(SITE_A, '/interactive'))

  // A real click where the page's button is lands on the block screen.
  const box = await page.evaluate(() => {
    const r = document.getElementById('page-button')!.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await page.mouse.click(box.x, box.y)
  expect(await page.evaluate(() => (window as unknown as { pageClicks: number }).pageClicks)).toBe(0)
  // Programmatic focus can't reach an inert page either.
  await page.evaluate(() => document.getElementById('page-link')!.focus())
  expect(await activeId(page)).toBe(BLOCK_ID)

  // The page's controls drop out of the accessibility tree; the dialog stays.
  const cdp = await context.newCDPSession(page)
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as {
    nodes: { ignored: boolean; role?: { value: string }; name?: { value: string } }[]
  }
  await cdp.detach()
  const exposed = nodes.filter((n) => !n.ignored)
  expect(exposed.some((n) => n.name?.value === 'page button')).toBe(false)
  expect(exposed.some((n) => n.role?.value === 'alertdialog' && n.name?.value === "Time's up")).toBe(true)
})

test('Escape does not dismiss it', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, { ...BLOCKING, [await todayKey(serviceWorker, SITE_A)]: 2 * MINUTE })
  const page = await blockedPage(context, site(SITE_A, '/interactive'))
  // Twice: Chromium lets a second, unactivated close request through.
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
  expect(await activeId(page)).toBe(BLOCK_ID)
  expect(await page.evaluate(() => document.elementFromPoint(5, 5)?.id)).toBe(BLOCK_ID)
})

test('pauses playing media and keeps it paused', async ({ context, serviceWorker, site }) => {
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
  await expect.poll(paused).toBe(true)

  // The page's own script tries to resume it.
  await page.evaluate(() => (document.getElementById('media') as HTMLAudioElement).play().catch(() => {}))
  await expect.poll(paused).toBe(true)

  // Dismissing doesn't resume it either.
  await clickInShadow(page, BLOCK_ID, 'button.snooze')
  await expect(page.locator(`#${BLOCK_ID}`)).toBeHidden()
  await page.waitForTimeout(300)
  expect(await paused()).toBe(true)
})

test('leaves fullscreen when the limit is hit, and stays out of it', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, { [await todayKey(serviceWorker, SITE_A)]: 2 * MINUTE })
  const page = await context.newPage()
  await page.goto(site(SITE_A, '/interactive'))
  await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached()

  // A real click is the user gesture fullscreen needs.
  await page.click('#fullscreen-button')
  await expect.poll(() => fullscreen(page)).toBe(true)

  await seed(serviceWorker, BLOCKING)
  await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
  await expect.poll(() => fullscreen(page)).toBe(false)

  // The page's own shortcut (a keypress is a user gesture) can't take it
  // back into fullscreen while blocked.
  await page.keyboard.press('f')
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { fullscreenEntries: number }).fullscreenEntries))
    .toBe(2)
  await expect.poll(() => fullscreen(page)).toBe(false)
  await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
  expect(await page.evaluate(() => document.elementFromPoint(5, 5)?.id)).toBe(BLOCK_ID)
})
