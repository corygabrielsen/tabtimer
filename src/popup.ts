import { storage, todayKeyForHost, HIDDEN_KEY } from './storage'
import { sendMessage } from './messages'
import { formatTime } from './format'

// The popup runs on chrome-extension://<id>/popup.html, so it resolves the
// active tab's hostname (via host permission) rather than its own location.
function activeTabHostname(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs[0]?.url
      if (!url) {
        resolve(null)
        return
      }
      try {
        resolve(new URL(url).hostname)
      } catch {
        resolve(null)
      }
    })
  })
}

function setHidden(id: string, hidden: boolean) {
  const el = document.getElementById(id)
  if (el) {
    el.toggleAttribute('hidden', hidden)
  }
}

async function init() {
  const host = await activeTabHostname()
  setHidden('loading', true)

  if (!host) {
    // Untracked site, or a page we have no host permission for.
    setHidden('untracked', false)
    return
  }

  const key = todayKeyForHost(host)
  const siteEl = document.getElementById('site')
  const todayEl = document.getElementById('today')
  const resetBtn = document.getElementById('reset-btn')
  const toggleBtn = document.getElementById('toggle-btn')

  if (siteEl) {
    siteEl.textContent = host
  }

  const renderToday = async () => {
    const ms = await storage.get(key, 0, 'local').catch(() => 0)
    if (todayEl) {
      todayEl.textContent = formatTime(ms)
    }
  }

  const renderToggle = async () => {
    const hidden = await storage.get(HIDDEN_KEY, false, 'local').catch(() => false)
    if (toggleBtn) {
      toggleBtn.textContent = hidden ? 'Show overlay' : 'Hide overlay'
    }
  }

  await Promise.all([renderToday(), renderToggle()])
  setHidden('tracked', false)

  resetBtn?.setAttribute('aria-label', `Reset today's time for ${host}`)
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

  // Keep the popup live while it's open.
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
}

document.addEventListener('DOMContentLoaded', () => {
  void init()
})
