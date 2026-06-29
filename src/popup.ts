import { storage, todayKeyForHost, HIDDEN_KEY, baseHost } from './storage'
import { sendMessage } from './messages'
import { formatTime } from './format'
import { originsForHost } from './sites'

type ActiveTab = { id: number; hostname: string }
type State = 'tracked' | 'enable' | 'untracked' | 'loading'
const STATES: State[] = ['tracked', 'enable', 'untracked', 'loading']

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function showState(state: State) {
  for (const s of STATES) {
    byId(s)?.toggleAttribute('hidden', s !== state)
  }
}

// activeTab grants access to the current tab while the popup is open, so we can
// read its URL (and inject on enable) without any host permission.
function activeTab(): Promise<ActiveTab | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0]
      if (!tab?.id || !tab.url) {
        resolve(null)
        return
      }
      try {
        resolve({ id: tab.id, hostname: new URL(tab.url).hostname })
      } catch {
        resolve(null)
      }
    })
  })
}

function renderTracked(tab: ActiveTab, base: string) {
  const key = todayKeyForHost(tab.hostname)
  const siteEl = byId('site')
  const todayEl = byId('today')
  if (siteEl) {
    siteEl.textContent = base
  }

  const renderToday = async () => {
    const ms = await storage.get(key, 0, 'local').catch(() => 0)
    if (todayEl) {
      todayEl.textContent = formatTime(ms)
    }
  }

  const toggleBtn = byId('toggle-btn')
  const renderToggle = async () => {
    const hidden = await storage.get(HIDDEN_KEY, false, 'local').catch(() => false)
    if (toggleBtn) {
      toggleBtn.textContent = hidden ? 'Show overlay' : 'Hide overlay'
    }
  }

  const resetBtn = byId('reset-btn')
  resetBtn?.setAttribute('aria-label', `Reset today's time for ${base}`)
  resetBtn?.addEventListener('click', () => {
    if (todayEl) {
      todayEl.textContent = formatTime(0) // optimistic
    }
    void sendMessage({ type: 'resetKey', key }).catch(() => undefined)
  })

  toggleBtn?.addEventListener('click', async () => {
    const hidden = await storage.get(HIDDEN_KEY, false, 'local').catch(() => false)
    await storage.set(HIDDEN_KEY, !hidden, 'local').catch(() => undefined)
    await renderToggle()
  })

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') {
      return
    }
    if (changes[key]) {
      void renderToday()
    }
    if (changes[HIDDEN_KEY]) {
      void renderToggle()
    }
  })

  void Promise.all([renderToday(), renderToggle()]).then(() => showState('tracked'))
}

function renderEnable(tab: ActiveTab, base: string) {
  const origins = originsForHost(base)
  const siteEl = byId('enable-site')
  if (siteEl) {
    siteEl.textContent = base
  }
  showState('enable')

  byId('enable-btn')?.addEventListener('click', () => {
    void chrome.permissions.request({ origins }).then((granted) => {
      if (!granted) {
        return
      }
      // Inject now so tracking starts immediately, without a reload.
      void chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {})
      renderTracked(tab, base)
    })
  })
}

async function init() {
  byId('manage-btn')?.addEventListener('click', () => chrome.runtime.openOptionsPage())

  const tab = await activeTab()
  if (!tab || !tab.hostname.includes('.')) {
    showState('untracked')
    return
  }

  const base = baseHost(tab.hostname)
  const granted = await chrome.permissions.contains({ origins: originsForHost(base) }).catch(() => false)

  if (granted) {
    renderTracked(tab, base)
  } else {
    renderEnable(tab, base)
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void init()
})
