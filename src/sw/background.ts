import { local } from '../storage'
import { syncContentScripts } from './contentScripts'
import type { Message, MessageResponse } from '../messages'

chrome.runtime.onInstalled.addListener((details) => {
  void syncContentScripts()
  // First run: open the options page so the user can choose sites to track.
  if (details.reason === 'install') {
    void chrome.runtime.openOptionsPage()
  }
})
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
  const stored = (await local.get<number>(key)) ?? 0
  const total = stored + delta
  await local.set({ [key]: total })
  return total
}

async function resetKey(key: string): Promise<number> {
  await local.set({ [key]: 0 })
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
  if (message?.type === 'openOptions') {
    void chrome.runtime.openOptionsPage()
    sendResponse({ ok: true, total: 0 })
    return false
  }
  return false
})
