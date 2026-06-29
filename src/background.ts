import { storage } from './storage'
import type { Message, MessageResponse } from './messages'

chrome.runtime.onInstalled.addListener(() => {
  console.log('Extension installed!')
})

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
