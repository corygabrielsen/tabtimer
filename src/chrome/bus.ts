import type { Bus } from '../ports'
import type { ErrorCode, MessageType, Request, Response } from '../core/messages'

// The sender of a message, as the service worker sees it.
export type Sender = {
  id?: string
  url?: string
  tab?: { id?: number }
  frameId?: number
  // 'active', 'prerender', 'cached' (in the back/forward cache) or
  // 'pending_deletion' (unloading).
  documentLifecycle?: string
}

export type Handler = (raw: unknown, sender: Sender) => Promise<Response<MessageType>>

function isResponse(v: unknown): boolean {
  return typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean'
}

// The client side: chrome.runtime.sendMessage to the service worker. A
// missing worker or a reloaded extension maps to 'unreachable'; a reply that
// isn't a Response maps to 'internal'.
export const bus: Bus = {
  send(type, req) {
    return new Promise((resolve) => {
      const fail = (error: ErrorCode) => resolve({ ok: false, error })
      try {
        chrome.runtime.sendMessage({ ...req, type } as Request, (response: unknown) => {
          if (chrome.runtime.lastError) {
            fail('unreachable')
          } else if (isResponse(response)) {
            resolve(response as never)
          } else {
            fail('internal')
          }
        })
      } catch {
        // "Extension context invalidated": this page outlived its extension.
        fail('unreachable')
      }
    })
  },
}

// The service-worker side: one onMessage listener that hands every message to
// `handle` and replies asynchronously (hence `return true`).
export function serveRouter(handle: Handler): void {
  chrome.runtime.onMessage.addListener((raw: unknown, sender: chrome.runtime.MessageSender, sendResponse) => {
    handle(raw, sender).then(sendResponse, () => sendResponse({ ok: false, error: 'internal' }))
    return true
  })
}
