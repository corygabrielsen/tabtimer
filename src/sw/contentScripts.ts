// The extension ships no static content scripts, so installing it requests no
// host access (no scary permission prompt). When the user grants a site (from
// the popup or options page) the bundled content script is registered for the
// granted origins, and kept in sync as grants are added or removed.
import { serial } from '../core/serial'
import { trackedOrigins } from '../core/site'

const CONTENT_SCRIPT_ID = 'tabtimer-content'

async function grantedOrigins(): Promise<string[]> {
  const perms = await chrome.permissions.getAll()
  return trackedOrigins(perms.origins ?? [])
}

async function sync(): Promise<void> {
  const matches = await grantedOrigins()
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] }).catch(() => [])

  if (matches.length === 0) {
    if (existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] }).catch(() => {})
    }
    return
  }

  const script: chrome.scripting.RegisteredContentScript = {
    id: CONTENT_SCRIPT_ID,
    js: ['content.js'],
    matches,
    runAt: 'document_idle',
    persistAcrossSessions: true,
  }

  if (existing.length > 0) {
    await chrome.scripting.updateContentScripts([script]).catch(() => {})
  } else {
    await chrome.scripting.registerContentScripts([script]).catch(() => {})
  }
}

// One sync at a time, each reading the grants and the registration afresh:
// overlapping syncs would both register, and the newer grants lose.
const queue = serial()

export const syncContentScripts = (): Promise<void> => queue(sync)
