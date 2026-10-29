import type { Page } from '@playwright/test'
import { test, expect, seed, read, openPopup, LIMITS_KEY } from './fixtures'

const SITE_A = 'site-a.test'

// Real focus: Playwright keeps every page focused unless told not to, so a
// tab switch would never blur the field. Set after navigating (a new
// renderer starts without it).
async function realFocus(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
}

// U1: a tab switch blurred the custom field with "4" typed on the way to
// "45", and the blur saved it.
test('U1: switching tabs mid-edit saves nothing', async ({ context, serviceWorker, extensionId }) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)
  await realFocus(page)
  await page.bringToFront()
  const cap = page.getByRole('radiogroup', { name: 'All sites' })
  await cap.getByRole('radio', { name: 'Custom' }).click()
  const field = page.locator('#global-limit-custom')
  await expect(field).toBeFocused()
  await field.pressSequentially('4')

  const other = await context.newPage()
  await other.bringToFront()
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false)
  await page.bringToFront()
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)

  expect(await read(serviceWorker, LIMITS_KEY)).toBeUndefined()
  await expect(field).toBeVisible()
  await expect(field).toHaveValue('4')
  await field.pressSequentially('5')
  await field.press('Enter')
  await expect.poll(() => read(serviceWorker, LIMITS_KEY)).toMatchObject({ global: 45 })
})

// U2: pressing a chip blurred the field first, which saved the typed value,
// then the click saved the chip: two writes, the first one abandoned.
test('U2: a chip clicked mid-edit is the one write', async ({ context, serviceWorker, extensionId }) => {
  await seed(serviceWorker, { [LIMITS_KEY]: { global: 30, perSite: {}, snoozeUntil: 0 } })
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)
  const cap = page.getByRole('radiogroup', { name: 'All sites' })
  await expect(cap.getByRole('radio', { name: 'Custom: 30 min' })).toHaveAttribute('aria-checked', 'true')
  await page.evaluate(() => {
    const w = window as unknown as { writes: unknown[] }
    w.writes = []
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.limits) {
        w.writes.push((changes.limits.newValue as { global: unknown }).global)
      }
    })
  })
  await cap.getByRole('radio', { name: 'Custom: 30 min' }).click()
  const field = page.locator('#global-limit-custom')
  await field.fill('5')
  await cap.getByRole('radio', { name: 'Off' }).click()
  await expect.poll(() => read(serviceWorker, LIMITS_KEY)).toMatchObject({ global: null })
  await expect(cap.getByRole('radio', { name: 'Off' })).toBeFocused()
  expect(await page.evaluate(() => (window as unknown as { writes: unknown[] }).writes)).toEqual([null])
})

// U3: closing the popup mid-edit dropped what was typed.
test('U3: closing the popup saves an open edit', async ({ context, serviceWorker, extensionId, site }) => {
  const tab = await context.newPage()
  await tab.goto(site(SITE_A))
  const popup = await openPopup(context, serviceWorker, extensionId, site(SITE_A))
  const picker = popup.getByRole('radiogroup', { name: `Daily limit for ${SITE_A}` })
  await picker.getByRole('radio', { name: 'Custom' }).click()
  await popup.getByRole('textbox', { name: `Custom daily limit for ${SITE_A}, in minutes` }).fill('45')
  await popup.close()
  await expect.poll(() => read(serviceWorker, LIMITS_KEY)).toMatchObject({ perSite: { [SITE_A]: 45 } })
})
