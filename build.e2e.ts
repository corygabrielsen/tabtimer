// Build-time switch for the end-to-end test variant of the extension.
//
// TABTIMER_E2E=1 builds to dist-e2e/ with host_permissions for the fixture
// hosts, so the content script is registered at install without the runtime
// permission prompt Playwright can't click. Unset, nothing here applies.
export const E2E = process.env.TABTIMER_E2E === '1'

export const OUT_DIR = E2E ? 'dist-e2e' : 'dist'

// Fixture hosts (resolved to the local test server by Chromium's
// --host-resolver-rules). Granted with the same pattern shape as a user grant
// (originsForSite in src/core/site.ts). untracked.test is deliberately absent.
export const E2E_TRACKED_HOSTS = ['site-a.test', 'site-b.test']

export const E2E_HOST_PERMISSIONS = E2E_TRACKED_HOSTS.flatMap((host) => [`*://${host}/*`, `*://*.${host}/*`])
