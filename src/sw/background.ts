import { chromeStore } from '../chrome/store'
import { serveRouter } from '../chrome/bus'
import { systemClock } from '../chrome/clock'
import { syncContentScripts } from './contentScripts'
import { createLedger } from './ledger'
import { createRouter } from './router'

const ledger = createLedger(chromeStore('local'), chromeStore('session'), systemClock)

// Storage first (a different schema is cleared, expired days pruned), then
// the content script registration for the granted sites.
async function boot(): Promise<void> {
  await ledger.ensureSchema().catch(() => false)
  await ledger.prune().catch(() => undefined)
  await syncContentScripts()
}

chrome.runtime.onInstalled.addListener((details) => {
  void boot()
  // First run: open the options page so the user can choose sites to track.
  if (details.reason === 'install') {
    void chrome.runtime.openOptionsPage()
  }
})
chrome.runtime.onStartup.addListener(() => void boot())
chrome.permissions.onAdded.addListener(() => void syncContentScripts())
chrome.permissions.onRemoved.addListener(() => void syncContentScripts())

// Every message goes through the router; it registers the one onMessage
// listener synchronously, at the top level, as MV3 requires.
serveRouter(
  createRouter({
    ledger,
    extensionId: chrome.runtime.id,
    extensionUrl: chrome.runtime.getURL(''),
    now: () => systemClock.now(),
    openOptions: () => chrome.runtime.openOptionsPage(),
  })
)
