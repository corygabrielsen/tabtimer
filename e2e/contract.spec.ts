import { cp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Worker } from '@playwright/test'
import {
  test,
  expect,
  extensionWorker,
  launch,
  openPopup,
  EXTENSION_PATH,
  read,
  readToday,
  seed,
  today,
  LIMITS_KEY,
  MINUTE,
  OVERLAY_ID,
} from './fixtures'

// The service worker is the only writer of storage: pages and content scripts
// ask it by message, and it decides what a sender may change.

const SITE_A = 'site-a.test'
const SITE_B = 'site-b.test'

test('concurrent limit edits from the popup and the options page both survive', async ({
  context,
  serviceWorker,
  extensionId,
  site,
}) => {
  const tracked = await context.newPage()
  await tracked.goto(site(SITE_A))
  const popup = await openPopup(context, serviceWorker, extensionId, site(SITE_A))
  const options = await context.newPage()
  await options.goto(`chrome-extension://${extensionId}/options.html`)

  // One tap each, at the same time: this site's limit in the popup, the
  // all-sites cap in the options page.
  const sitePicker = popup.getByRole('radiogroup', { name: `Daily limit for ${SITE_A}` })
  const cap = options.getByRole('radiogroup', { name: 'All sites' })
  await Promise.all([
    sitePicker.getByRole('radio', { name: '15 min' }).click(),
    cap.getByRole('radio', { name: '2 h' }).click(),
  ])
  await expect
    .poll(() => read(serviceWorker, LIMITS_KEY))
    .toEqual({ global: 120 * MINUTE, perSite: { [SITE_A]: 15 * MINUTE } })

  // A burst of edits from both pages at once: none is lost.
  const burst = (page: typeof popup, sites: string[]) =>
    page.evaluate(
      (sites) =>
        Promise.all(
          sites.map((site) => chrome.runtime.sendMessage({ type: 'setLimit', scope: 'site', site, ms: 30 * 60_000 }))
        ),
      sites
    )
  const fromPopup = Array.from({ length: 10 }, (_, i) => `popup-${i}.test`)
  const fromOptions = Array.from({ length: 10 }, (_, i) => `options-${i}.test`)
  await Promise.all([burst(popup, fromPopup), burst(options, fromOptions)])
  const limits = (await read(serviceWorker, LIMITS_KEY)) as { perSite: Record<string, number> }
  expect(Object.keys(limits.perSite).sort()).toEqual([SITE_A, ...fromOptions, ...fromPopup].sort())
})

// Run `message` through chrome.runtime.sendMessage from the content-script
// world of the tab showing `url`: what a compromised or confused page script
// in that world could send.
async function sendFromTab(sw: Worker, url: string, message: unknown): Promise<unknown> {
  return sw.evaluate(
    async ({ url, message }) => {
      const [tab] = await chrome.tabs.query({ url: `${url}*` })
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab!.id! },
        world: 'ISOLATED',
        func: (message) => chrome.runtime.sendMessage(message),
        args: [message],
      })
      return result?.result
    },
    { url, message }
  )
}

test('a forged message naming another site is ignored or refused', async ({ context, serviceWorker, site }) => {
  await seed(serviceWorker, await today(serviceWorker, { [SITE_B]: 7 * MINUTE }))
  const page = await context.newPage()
  await page.goto(site(SITE_A))
  await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached()
  // Stop SITE_A's own accrual so only the forged report moves its total.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await page.waitForTimeout(500)
  const before = await readToday(serviceWorker, SITE_A)

  // A presence report from SITE_A's page that names SITE_B: the site comes
  // from the sender's URL, so the time is SITE_A's.
  const presence = { type: 'presence', visible: true, focused: true, media: false, blocked: false, site: SITE_B }
  const report = await sendFromTab(serviceWorker, site(SITE_A), presence)
  expect(report).toMatchObject({ ok: true, value: { site: SITE_A, running: true } })
  await page.waitForTimeout(1_500)
  await sendFromTab(serviceWorker, site(SITE_A), { ...presence, visible: false })
  expect(await readToday(serviceWorker, SITE_A)).toBeGreaterThanOrEqual(before + 1_500)
  expect(await readToday(serviceWorker, SITE_B)).toBe(7 * MINUTE)
  // The old time report, which carried its own spans, is gone.
  const now = Date.now()
  expect(await sendFromTab(serviceWorker, site(SITE_A), { type: 'addElapsed', spans: [[now - 3_000, now]] })).toEqual({
    ok: false,
    error: 'bad_request',
  })

  // Resetting another site, or changing limits, is for extension pages only.
  for (const forged of [
    { type: 'resetToday', site: SITE_B },
    { type: 'setLimit', scope: 'global', ms: MINUTE },
    { type: 'setLimit', scope: 'site', site: SITE_B, ms: MINUTE },
  ]) {
    expect(await sendFromTab(serviceWorker, site(SITE_A), forged)).toEqual({ ok: false, error: 'forbidden' })
  }
  // The old message that wrote any key it was given is gone.
  expect(await sendFromTab(serviceWorker, site(SITE_A), { type: 'resetKey', key: LIMITS_KEY })).toEqual({
    ok: false,
    error: 'bad_request',
  })
  expect(await readToday(serviceWorker, SITE_B)).toBe(7 * MINUTE)
  expect(await read(serviceWorker, LIMITS_KEY)).toEqual({ global: null, perSite: {} })
})

test('stored data from an older schema is cleared when the upgraded extension starts', async ({}, testInfo) => {
  // A profile that ran an older Tab Timer, then gets a newer build of it.
  const profile = testInfo.outputPath('profile')
  const extension = testInfo.outputPath('extension')
  await cp(EXTENSION_PATH, extension, { recursive: true })

  const before = await launch(profile, extension)
  const old = await extensionWorker(before)
  // What 1.2.x stored: per-site, per-day counters and loose preference keys.
  await old.evaluate(() => chrome.storage.local.clear())
  await seed(old, {
    'focusTimer_elapsed_today_site-a.test_2026-10-28': 5 * MINUTE,
    tabtimer_limits: { global: MINUTE, perSite: {} },
    tabtimer_hidden: true,
  })
  // A marker outside storage.local, which the schema check never touches:
  // it proves the second launch sees this profile's extension storage.
  await old.evaluate(() => chrome.storage.sync.set({ marker: 1 }))
  await before.close()

  // The update: same extension, newer version.
  const manifestPath = path.join(extension, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string }
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: `${manifest.version}.1` }))

  const after = await launch(profile, extension)
  try {
    const sw = await extensionWorker(after)
    expect(await sw.evaluate(() => chrome.runtime.getManifest().version)).toBe(`${manifest.version}.1`)
    expect(await sw.evaluate(() => chrome.storage.sync.get('marker'))).toEqual({ marker: 1 })
    await expect
      .poll(() => sw.evaluate(() => chrome.storage.local.get(null)))
      .toEqual({
        schema: 2,
        limits: { global: null, perSite: {} },
        prefs: { hidden: false, scale: 1 },
        snoozeUntil: 0,
      })
  } finally {
    await after.close()
  }
})
