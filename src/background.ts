import { storage } from './storage'
import type { Message, MessageResponse } from './messages'

// --- Dynamic content-script registration -------------------------------------
// The extension ships no static content scripts, so installing it requests no
// host access (no scary permission prompt). When the user grants a site (from
// the popup or options page) the bundled content script is registered for the
// granted origins, and kept in sync as grants are added or removed.
const CONTENT_SCRIPT_ID = 'tabtimer-content'

async function grantedOrigins(): Promise<string[]> {
  const perms = await chrome.permissions.getAll()
  return perms.origins ?? []
}

async function syncContentScripts(): Promise<void> {
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

chrome.runtime.onInstalled.addListener(() => void syncContentScripts())
chrome.runtime.onStartup.addListener(() => void syncContentScripts())
chrome.permissions.onAdded.addListener(() => void syncContentScripts())
chrome.permissions.onRemoved.addListener(() => void syncContentScripts())

// Single-writer accumulator. Every daily focus-time write funnels through the
// service worker so the read-modify-write happens in one context. Tasks are
// chained so two messages can't interleave their get/set even within a single
// service-worker instance, which eliminates the cross-tab lost-update race.
let writeChain: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = writeChain.then(task, task)
  // Keep the chain alive even if a task rejects; don't propagate that
  // rejection to the next queued task.
  writeChain = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

async function addElapsed(key: string, delta: number): Promise<number> {
  const stored = await storage.get(key, 0, 'local')
  const total = stored + delta
  await storage.set(key, total, 'local')
  return total
}

async function resetKey(key: string): Promise<number> {
  await storage.set(key, 0, 'local')
  return 0
}

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse: (response: MessageResponse) => void) => {
  if (message?.type === 'addElapsed') {
    if (typeof message.key !== 'string' || typeof message.delta !== 'number' || message.delta <= 0) {
      sendResponse({ ok: false, error: 'invalid addElapsed message' })
      return false
    }
    enqueue(() => addElapsed(message.key, message.delta))
      .then((total) => sendResponse({ ok: true, total }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }))
    return true // keep the message channel open for the async sendResponse
  }
  if (message?.type === 'resetKey') {
    if (typeof message.key !== 'string') {
      sendResponse({ ok: false, error: 'invalid resetKey message' })
      return false
    }
    enqueue(() => resetKey(message.key))
      .then((total) => sendResponse({ ok: true, total }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }))
    return true
  }
  return false
})
