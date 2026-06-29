import { todayKeyForHost } from './storage'
import { sendMessage } from './messages'

// The popup runs on chrome-extension://<id>/popup.html, so it cannot build a
// site key from its own location. Resolve the active tab's hostname instead
// and reset that site's counter through the background single-writer; open
// content scripts pick up the change via chrome.storage.onChanged.
function activeTabHostname(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs[0]?.url
      if (!url) {
        // No url means we lack host permission for this tab (untracked site);
        // there is nothing for us to reset.
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

async function resetActiveTab(): Promise<void> {
  const hostname = await activeTabHostname()
  if (!hostname) {
    return
  }
  await sendMessage({ type: 'resetKey', key: todayKeyForHost(hostname) }).catch(() => undefined)
}

document.addEventListener('DOMContentLoaded', () => {
  const reloadBtn = document.getElementById('reload-btn')
  const resetBtn = document.getElementById('reset-btn')

  resetBtn?.addEventListener('click', () => {
    void resetActiveTab()
  })

  reloadBtn?.addEventListener('click', () => {
    // Reload the active page (not the whole extension, which would invalidate
    // every open content script) so it re-reads the zeroed counter.
    void resetActiveTab().then(() => chrome.tabs.reload())
  })
})
