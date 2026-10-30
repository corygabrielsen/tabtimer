import { chromeStore } from '../chrome/store'
import { sendState, serveRouter } from '../chrome/bus'
import { systemClock } from '../chrome/clock'
import { LIMITS_KEY, PREFS_KEY } from '../core/schema'
import { trackableSiteOfUrl } from '../core/site'
import { checkpointAlarm, CHECKPOINT_ALARM } from './checkpoint'
import { grantedSites, injectOpenTabs, revokedSites, startTab, syncContentScripts } from './contentScripts'
import { watchGrants } from './grants'
import { syncIdle, watchIdle } from './idle'
import { createLedger } from './ledger'
import { tabMuter } from './mute'
import { createRouter } from './router'
import { installTestHook, offsetClock } from './testHook'
import { createTracker } from './tracker'

const OPTIONS_PAGE = 'options.html'

// Bring a window to the front (a page opened in a window behind seems to do
// nothing).
const focusWindow = (windowId: number | undefined) =>
  windowId === undefined || windowId < 0
    ? Promise.resolve()
    : chrome.windows.update(windowId, { focused: true }).then(() => undefined)

const local = chromeStore('local')
// The e2e build's clock can be moved forward (testHook.ts).
const testClock = __TABTIMER_E2E__ ? offsetClock(systemClock) : null
const ledger = createLedger(local, chromeStore('session'), testClock ?? systemClock)

// First: a grant or revoke is seen here before anything acts on it.
const granted = watchGrants()
const tracker = createTracker({
  ledger,
  send: sendState,
  alarm: checkpointAlarm(),
  granted,
  mute: tabMuter(chrome.runtime.id),
})

// Every listener is registered synchronously at the top level, as MV3
// requires: any of these events can be what starts the worker.
const dispatch = (event: Parameters<typeof tracker.dispatch>[0]) => void tracker.dispatch(event).catch(() => undefined)

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => dispatch({ kind: 'activated', tabId, windowId }))
chrome.tabs.onRemoved.addListener((tabId) => dispatch({ kind: 'removed', tabId }))
chrome.tabs.onAttached.addListener((tabId, { newWindowId }) =>
  dispatch({ kind: 'attached', tabId, windowId: newWindowId })
)
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  // The URL is visible only on granted sites; a load whose URL can't be
  // seen went to a site that isn't tracked.
  if (change.url !== undefined || change.status === 'loading' || change.discarded) {
    const url = change.discarded ? undefined : (change.url ?? tab.url)
    dispatch({ kind: 'navigated', tabId, site: url === undefined ? null : trackableSiteOfUrl(url) })
  }
  // A page shown (a load, or a back/forward cache restore) on a granted
  // site runs the script.
  if (change.status === 'complete' && tab.url !== undefined) {
    const url = tab.url
    void granted()
      .then((origins) => startTab(tabId, url, origins))
      .catch(() => undefined)
  }
  if (change.audible !== undefined) {
    dispatch({ kind: 'audible', tabId, audible: change.audible })
  }
})
// Every window type that can show a tracked page, an installed site's app
// window included (the default filter leaves 'app' out: focus there would
// arrive as WINDOW_ID_NONE).
chrome.windows.onFocusChanged.addListener(
  (windowId) =>
    dispatch({ kind: 'windowFocus', windowId: windowId === chrome.windows.WINDOW_ID_NONE ? null : windowId }),
  { windowTypes: ['normal', 'popup', 'app'] }
)
chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === CHECKPOINT_ALARM) {
    dispatch({ kind: 'checkpoint' })
  }
})
// The limits (the snooze included) decide when pages block, and the prefs
// how their overlay looks: tell them of a change, whoever made it.
local.onChanged((changes) => {
  if (LIMITS_KEY in changes || PREFS_KEY in changes) {
    void tracker.refresh().catch(() => undefined)
  }
})

// Time away from the computer (idle or locked) isn't counted. The state is
// read again on every worker start; changes arrive as events.
watchIdle(tracker)
void syncIdle(tracker).catch(() => undefined)
void tracker.resume().catch(() => undefined)
if (__TABTIMER_E2E__ && testClock) {
  installTestHook(tracker, testClock)
}

// Storage first (a different schema is cleared, expired days pruned), then
// the content script registration for the granted sites.
async function boot(): Promise<void> {
  await ledger.ensureSchema().catch(() => undefined)
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
// Grants from our pages or Chrome's own site access controls alike: the open
// tabs follow the registration.
// The all-sites total covers the tracked sites: every page learns the new one.
chrome.permissions.onAdded.addListener(({ origins }) => {
  void grantedSites(origins ?? [])
  void tracker.refresh().catch(() => undefined)
})
chrome.permissions.onRemoved.addListener(() => {
  void revokedSites()
  void tracker.refresh().catch(() => undefined)
})
// A new extension context (installed, updated, reloaded or enabled) finds
// open tabs running the previous one's orphaned script, or none.
void injectOpenTabs()

// Every message goes through the router; it registers the one onMessage
// listener synchronously, at the top level, as MV3 requires.
serveRouter(
  createRouter({
    ledger,
    tracker,
    granted,
    extensionId: chrome.runtime.id,
    extensionUrl: chrome.runtime.getURL(''),
    // Brought to the front with its window: the options page may be a tab
    // already open in another window.
    open: async () => {
      await chrome.runtime.openOptionsPage()
      const [tab] = await chrome.runtime
        .getContexts({
          contextTypes: ['TAB' as chrome.runtime.ContextType],
          documentUrls: [chrome.runtime.getURL(OPTIONS_PAGE)],
        })
        .catch(() => [])
      await focusWindow(tab?.windowId)
    },
    closeTab: (tabId) => chrome.tabs.remove(tabId),
  })
)
