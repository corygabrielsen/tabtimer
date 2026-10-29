import type { Page } from '@playwright/test'
import {
  test,
  expect,
  seed,
  today,
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
const BLOCKING = { [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: 1 } } }

const activeId = (page: Page) => page.evaluate(() => document.activeElement?.id)
const fullscreen = (page: Page) => page.evaluate(() => document.fullscreenElement !== null)

async function blockedPage(context: import('@playwright/test').BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(url)
  await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
  return page
}

test('takes focus on the snooze button, and gives it back on dismissal', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, { ...BLOCKING, ...(await today(serviceWorker, { [SITE_A]: 2 * MINUTE })) })
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

  await seed(serviceWorker, { ...BLOCKING, ...(await today(serviceWorker, { [SITE_A]: 2 * MINUTE })) })
  await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
  await expect.poll(() => activeId(page)).toBe(BLOCK_ID)

  await clickInShadow(page, BLOCK_ID, 'button.snooze')
  await expect(page.locator(`#${BLOCK_ID}`)).toBeHidden()
  expect(await activeId(page)).toBe('page-button')
})

test('is modal and traps Tab', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, { ...BLOCKING, ...(await today(serviceWorker, { [SITE_A]: 2 * MINUTE })) })
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
  await seed(serviceWorker, { ...BLOCKING, ...(await today(serviceWorker, { [SITE_A]: 2 * MINUTE })) })
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
  await seed(serviceWorker, { ...BLOCKING, ...(await today(serviceWorker, { [SITE_A]: 2 * MINUTE })) })
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
  await seed(serviceWorker, await today(serviceWorker, { [SITE_A]: 2 * MINUTE }))
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
  await seed(serviceWorker, await today(serviceWorker, { [SITE_A]: 2 * MINUTE }))
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
  // back into fullscreen while blocked. Whether Chromium grants that request
  // for a moment is timing-dependent, so assert the attempt happened and that
  // the page stays out of fullscreen with the block screen on top, not that
  // the request succeeded.
  await page.keyboard.press('f')
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { fullscreenAttempts: number }).fullscreenAttempts))
    .toBeGreaterThanOrEqual(2)
  await expect(async () => {
    expect(await fullscreen(page)).toBe(false)
    await page.waitForTimeout(500)
    expect(await fullscreen(page)).toBe(false)
  }).toPass()
  await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
  expect(await page.evaluate(() => document.elementFromPoint(5, 5)?.id)).toBe(BLOCK_ID)
})

// Scroll positions of every scroller the fixture pages use, and the inline
// styles the block screen overrides.
const scrollState = (page: Page) =>
  page.evaluate(() => {
    const shell = document.getElementById('shell')
    return {
      window: [window.scrollX, window.scrollY],
      body: [document.body.scrollLeft, document.body.scrollTop],
      shell: shell ? [shell.scrollLeft, shell.scrollTop] : null,
      style: [document.documentElement.style.cssText, document.body.style.cssText],
    }
  })

// Everything a user can do to scroll: wheel and trackpad both ways, the
// scroll keys, and a touch drag.
async function tryToScroll(page: Page) {
  const { width, height } = page.viewportSize()!
  await page.mouse.move(width / 2, height / 2)
  await page.mouse.wheel(0, 900)
  await page.mouse.wheel(700, 0)
  await page.mouse.wheel(0, -300)
  for (const key of ['PageDown', 'End', 'ArrowDown', 'ArrowRight', 'Home', 'PageUp']) {
    await page.keyboard.press(key)
  }
  // Space and arrows with focus off the snooze button (where Space presses
  // it): the page's own default.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  for (const key of ['Space', 'Shift+Space', 'ArrowDown', 'End']) {
    await page.keyboard.press(key)
  }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.synthesizeScrollGesture', {
    x: width / 2,
    y: height / 2,
    yDistance: -600,
    xDistance: -300,
    gestureSourceType: 'touch',
    speed: 2000,
  })
  await cdp.detach()
  await page.waitForTimeout(300)
}

for (const [layout, path] of [
  ['the document', '/scroll-document'],
  ['<body>', '/scroll-body'],
  ['an inner app-shell element', '/scroll-inner'],
] as const) {
  test(`keeps a page that scrolls ${layout} from scrolling while blocked`, async ({ context, serviceWorker, site }) => {
    await seed(serviceWorker, await today(serviceWorker, { [SITE_A]: 2 * MINUTE }))
    const page = await context.newPage()
    await page.goto(site(SITE_A, path))
    await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached()
    const { width, height } = page.viewportSize()!
    await page.mouse.move(width / 2, height / 2)

    // The fixture really scrolls; leave it partway down so Home/Up count too.
    const initial = await scrollState(page)
    await page.mouse.wheel(0, 400)
    await expect.poll(() => scrollState(page)).not.toEqual(initial)
    // Let a smooth scroll finish.
    await page.waitForTimeout(500)
    const scrolled = await scrollState(page)

    await seed(serviceWorker, BLOCKING)
    await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
    const blocked = await scrollState(page)

    await tryToScroll(page)
    const after = await scrollState(page)
    expect(after.window).toEqual(blocked.window)
    expect(after.body).toEqual(blocked.body)
    expect(after.shell).toEqual(blocked.shell)
    await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()

    // Dismissed: the page's own overflow is back, it's where it was before
    // blocking (hiding overflow can clamp a body-sized viewport while
    // blocked), and it scrolls again.
    await clickInShadow(page, BLOCK_ID, 'button.snooze')
    await expect(page.locator(`#${BLOCK_ID}`)).toBeHidden()
    const dismissed = await scrollState(page)
    expect(dismissed.style).toEqual(initial.style)
    expect({ ...dismissed, style: null }).toEqual({ ...scrolled, style: null })
    await page.mouse.move(width / 2, height / 2)
    await page.mouse.wheel(0, 400)
    await expect.poll(() => scrollState(page)).not.toEqual(dismissed)
  })
}

// Middle-click, then move down: autoscroll (see launch() in fixtures.ts).
async function autoscroll(page: Page) {
  const { width, height } = page.viewportSize()!
  await page.mouse.click(width / 2, height / 2, { button: 'middle' })
  await page.mouse.move(width / 2, height - 5, { steps: 5 })
  await page.waitForTimeout(500)
  await page.mouse.click(width / 2, height / 2, { button: 'middle' })
}

for (const path of ['/scroll-document', '/scroll-inner']) {
  test(`middle-click autoscroll doesn't reach the page behind it (${path})`, async ({
    context,
    serviceWorker,
    site,
  }) => {
    await seed(serviceWorker, await today(serviceWorker, { [SITE_A]: 2 * MINUTE }))
    const page = await context.newPage()
    await page.goto(site(SITE_A, path))
    await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached()
    // It scrolls the page while not blocked.
    const initial = await scrollState(page)
    await autoscroll(page)
    expect(await scrollState(page)).not.toEqual(initial)

    await page.evaluate(() => (document.getElementById('shell') ?? window).scrollTo(0, 1000))
    await seed(serviceWorker, BLOCKING)
    await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
    const blocked = await scrollState(page)
    await autoscroll(page)
    expect(await scrollState(page)).toEqual(blocked)
  })
}

test('is fully opaque over a bright page, in light and dark', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, { ...BLOCKING, ...(await today(serviceWorker, { [SITE_A]: 2 * MINUTE })) })
  const page = await blockedPage(context, site(SITE_A, '/scroll-document'))
  expect(await page.evaluate((id) => getComputedStyle(document.getElementById(id)!).backgroundColor, BLOCK_ID)).toBe(
    'rgb(0, 0, 0)'
  )

  // Brightest channel anywhere in a strip across the top of the viewport,
  // clear of the block screen's text.
  const decoder = await context.newPage()
  const brightest = async () => {
    const { width } = page.viewportSize()!
    const png = await page.screenshot({ clip: { x: 0, y: 0, width, height: 120 } })
    return decoder.evaluate(async (b64) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const { data } = ctx.getImageData(0, 0, img.width, img.height)
      let max = 0
      for (let i = 0; i < data.length; i += 4) {
        max = Math.max(max, data[i]!, data[i + 1]!, data[i + 2]!)
      }
      return max
    }, png.toString('base64'))
  }
  expect(await brightest()).toBe(0)
  await page.emulateMedia({ colorScheme: 'dark' })
  expect(await brightest()).toBe(0)
})

// The id of the element on top at (x, y): a host's, for anything in its
// closed shadow root.
const topId = (page: Page, x = 5, y = 5) =>
  page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [x, y] as const)

test('survives the page replacing <body> or removing it', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, { ...BLOCKING, ...(await today(serviceWorker, { [SITE_A]: 2 * MINUTE })) })
  const page = await blockedPage(context, site(SITE_A, '/interactive'))

  // A Turbo-style navigation: a whole new <body>.
  await page.evaluate(() => document.body.replaceWith(document.createElement('body')))
  await expect.poll(() => topId(page)).toBe(BLOCK_ID)
  await expect.poll(() => activeId(page)).toBe(BLOCK_ID)
  await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached()

  // The page removes the block screen itself: back, on top, within a tick.
  await page.evaluate((id) => document.getElementById(id)!.remove(), BLOCK_ID)
  await expect.poll(() => topId(page)).toBe(BLOCK_ID)
  await expect.poll(() => activeId(page)).toBe(BLOCK_ID)

  await clickInShadow(page, BLOCK_ID, 'button.snooze')
  await expect(page.locator(`#${BLOCK_ID}`)).toBeHidden()
})

test('keeps a <body> the page swaps in from scrolling', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, { ...BLOCKING, ...(await today(serviceWorker, { [SITE_A]: 2 * MINUTE })) })
  const page = await blockedPage(context, site(SITE_A, '/scroll-body'))
  await page.evaluate(() => {
    const body = document.createElement('body')
    body.innerHTML = document.body.innerHTML
    document.body.replaceWith(body)
  })
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden')
  const blocked = await scrollState(page)
  await tryToScroll(page)
  expect((await scrollState(page)).body).toEqual(blocked.body)

  await clickInShadow(page, BLOCK_ID, 'button.snooze')
  await expect(page.locator(`#${BLOCK_ID}`)).toBeHidden()
  expect(await page.evaluate(() => document.body.getAttribute('style') ?? '')).toBe('')
})

test('stays on top of a dialog or popover the page opens over it', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, { ...BLOCKING, ...(await today(serviceWorker, { [SITE_A]: 2 * MINUTE })) })
  const page = await blockedPage(context, site(SITE_A, '/interactive'))
  const { width, height } = page.viewportSize()!

  // A timed sign-up modal.
  const button = await page.evaluate(() => {
    const dialog = document.createElement('dialog')
    const button = dialog.appendChild(document.createElement('button'))
    button.textContent = 'page dialog'
    button.addEventListener('click', () => (window as unknown as { pageClicks: number }).pageClicks++)
    document.body.append(dialog)
    dialog.showModal()
    const r = button.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await expect.poll(() => topId(page, button.x, button.y)).toBe(BLOCK_ID)
  await expect.poll(() => activeId(page)).toBe(BLOCK_ID)
  await page.mouse.click(button.x, button.y)
  expect(await page.evaluate(() => (window as unknown as { pageClicks: number }).pageClicks)).toBe(0)

  // Popovers, in the document and in a shadow root (no toggle event reaches
  // the document from there).
  for (const inShadow of [false, true]) {
    await page.evaluate((inShadow) => {
      const popover = document.createElement('div')
      popover.popover = 'manual'
      popover.style.cssText = 'inset:0;width:100vw;height:100vh;margin:0;background:#fff'
      const parent = inShadow
        ? document.body.appendChild(document.createElement('div')).attachShadow({ mode: 'open' })
        : document.body
      parent.append(popover)
      popover.showPopover()
    }, inShadow)
    await expect.poll(() => topId(page, width / 2, height - 5)).toBe(BLOCK_ID)
  }

  await clickInShadow(page, BLOCK_ID, 'button.snooze')
  await expect(page.locator(`#${BLOCK_ID}`)).toBeHidden()
})

test('pauses media in shadow roots and same-origin frames', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, await today(serviceWorker, { [SITE_A]: 2 * MINUTE }))
  const page = await context.newPage()
  await page.goto(site(SITE_A, '/interactive'))
  await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached()
  type Players = { players: HTMLAudioElement[] }
  await page.evaluate(async () => {
    const player = (parent: ParentNode) => {
      const audio = document.createElement('audio')
      audio.src = `${location.origin}/silence.wav`
      audio.loop = true
      parent.append(audio)
      return audio
    }
    const shadow = (mode: ShadowRootMode) =>
      document.body.appendChild(document.createElement('div')).attachShadow({ mode })
    const frame = document.body.appendChild(document.createElement('iframe'))
    const players = [player(shadow('open')), player(shadow('closed')), player(frame.contentDocument!.body)]
    ;(window as unknown as Players).players = players
    await Promise.all(players.map((p) => p.play()))
  })
  const paused = () => page.evaluate(() => (window as unknown as Players).players.map((p) => p.paused))
  expect(await paused()).toEqual([false, false, false])

  await seed(serviceWorker, BLOCKING)
  await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
  await expect.poll(paused).toEqual([true, true, true])

  // The page's own script tries to resume them.
  await page.evaluate(() => (window as unknown as Players).players.forEach((p) => void p.play().catch(() => {})))
  await page.waitForTimeout(300)
  expect(await paused()).toEqual([true, true, true])
})
