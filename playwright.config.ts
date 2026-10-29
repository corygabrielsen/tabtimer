import { defineConfig } from '@playwright/test'

// End-to-end tests drive the built e2e variant (dist-e2e/, see build.e2e.ts)
// as an unpacked extension in Chromium. Build it first: `pnpm test:e2e`.
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  // Assertions retry until they pass, so a longer limit only gives a loaded
  // runner time to render; a real failure still fails.
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
  },
})
