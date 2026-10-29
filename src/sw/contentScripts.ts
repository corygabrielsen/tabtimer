// The extension ships no static content scripts, so installing it requests no
// host access (no scary permission prompt). When the user grants a site (from
// the popup or options page) the bundled content script is registered for the
// granted origins, and kept in sync as grants are added or removed.
//
// A registration only reaches pages loaded after it, so the open tabs are
// kept in step too: a grant injects the script into its open tabs, a revoke
// tells each page no longer covered to stop, and a new extension context
// (install, update, reload, enable) injects into every tracked tab, whose
// pages still run the previous context's orphaned script. A page restored
// from the back/forward cache runs no registered script: one loaded before
// its grant is started when it is shown.
import { sendStop } from '../chrome/bus'
import { chromeStore } from '../chrome/store'
import { serial } from '../core/serial'
import { isTracked, trackedOrigins } from '../core/site'

const CONTENT_SCRIPT_ID = 'tabtimer-content'
const CONTENT_JS = 'content.js'
// storage.session key: set once this extension context has injected into
// the open tabs. storage.session is cleared on update, reload and disable.
const INJECTED_KEY = 'injected'

// A failed call changes nothing: the next change, or worker start, retries.
const ignore = (): undefined => undefined
const none = (): [] => []

async function grantedOrigins(): Promise<string[]> {
  const perms = await chrome.permissions.getAll()
  return trackedOrigins(perms.origins ?? [])
}

async function sync(): Promise<void> {
  const matches = await grantedOrigins()
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] }).catch(none)

  if (matches.length === 0) {
    if (existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] }).catch(ignore)
    }
    return
  }

  const script: chrome.scripting.RegisteredContentScript = {
    id: CONTENT_SCRIPT_ID,
    js: [CONTENT_JS],
    matches,
    runAt: 'document_idle',
    persistAcrossSessions: true,
  }

  if (existing.length > 0) {
    await chrome.scripting.updateContentScripts([script]).catch(ignore)
  } else {
    await chrome.scripting.registerContentScripts([script]).catch(ignore)
  }
}

// Inject the script into the open tabs `origins` cover, except those
// `running` covers (their pages already run this context's script).
async function inject(origins: string[], running: string[] = []): Promise<void> {
  if (origins.length === 0) {
    return
  }
  const tabs = await chrome.tabs.query({ url: origins }).catch(none)
  await Promise.all(
    tabs.map((tab) =>
      tab.id === undefined || (tab.url !== undefined && isTracked(running, tab.url))
        ? undefined
        : chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [CONTENT_JS] }).catch(ignore)
    )
  )
}

// Tell every tab whose page isn't covered by a grant any more to stop. A
// revoked tab's URL can't be seen: any tab without a tracked URL is told.
async function stopUntracked(): Promise<void> {
  const granted = await grantedOrigins()
  const tabs = await chrome.tabs.query({}).catch(none)
  await Promise.all(
    tabs.map((tab) =>
      tab.id === undefined || (tab.url !== undefined && isTracked(granted, tab.url))
        ? undefined
        : sendStop(tab.id).catch(ignore)
    )
  )
}

// Start the tab's page at `url` if a grant covers it and it runs no script
// (content.ts records its instance in the isolated world this checks).
export async function startTab(tabId: number, url: string, granted: readonly string[]): Promise<void> {
  if (!isTracked(granted, url)) {
    return
  }
  const target = { tabId }
  const [ran] = await chrome.scripting
    .executeScript({ target, func: () => Symbol.for('tabtimer.content') in window })
    .catch(none)
  if (ran?.result === false) {
    await chrome.scripting.executeScript({ target, files: [CONTENT_JS] }).catch(ignore)
  }
}

// One change at a time, each reading the grants and the registration
// afresh: overlapping syncs would both register, and the newer grants lose.
const queue = serial()

export const syncContentScripts = (): Promise<void> => queue(sync).catch(ignore)

// Granted `added`: register, then start the open tabs it covers, but not
// those an earlier grant already runs the script on.
export const grantedSites = (added: readonly string[]): Promise<void> =>
  queue(async () => {
    await sync()
    const before = (await grantedOrigins()).filter((origin) => !added.includes(origin))
    await inject(trackedOrigins(added), before)
  }).catch(ignore)

// Revoked: unregister, then stop the open tabs no longer covered.
export const revokedSites = (): Promise<void> =>
  queue(async () => {
    await sync()
    await stopUntracked()
  }).catch(ignore)

// Once per extension context: start every tracked open tab, and register.
export const injectOpenTabs = (): Promise<void> =>
  queue(async () => {
    const session = chromeStore('session')
    if ((await session.get(INJECTED_KEY).catch(ignore)) !== undefined) {
      return
    }
    // The open tabs first: once registered, new pages load the script
    // themselves.
    await inject(await grantedOrigins())
    await sync()
    await session.set({ [INJECTED_KEY]: true }).catch(ignore)
  }).catch(ignore)
