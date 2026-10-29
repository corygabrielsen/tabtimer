import type { Bus, Pushes } from '../ports'
import {
  isStopPush,
  parseStatePush,
  type ErrorCode,
  type MessageType,
  type Request,
  type Response,
  type StatePush,
  type StopPush,
} from '../core/messages'

// The sender of a message, as the service worker sees it.
export type Sender = {
  id?: string
  url?: string
  tab?: { id?: number; windowId?: number }
  // The sending document (Chrome 106+).
  documentId?: string
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
  // An orphaned content script's chrome.runtime loses its id.
  alive: () => chrome.runtime?.id !== undefined,
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

// The page side of state pushes (core/messages.ts StatePush): `handle` gets
// each state from this extension's service worker (and whether it is a
// probe) and returns the page's presence, sent back as the reply. onStop
// hears its StopPush. Each returns the unsubscribe function.
export const pushes: Pushes = {
  onState(handle) {
    const listener = (raw: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
      // Only the service worker: not another tab's content script.
      if (sender.id !== chrome.runtime.id || sender.tab) {
        return false
      }
      const push = parseStatePush(raw)
      if (push) {
        sendResponse(handle(push.state, push.probe))
      }
      return false
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  },
  onStop(handle) {
    const listener = (raw: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
      if (sender.id === chrome.runtime.id && !sender.tab && isStopPush(raw)) {
        handle()
        sendResponse(null)
      }
      return false
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  },
}

// The service-worker side: send one page its state. `doc` targets that
// document ('' = the tab's top frame). Resolves with the page's reply.
export function sendState(tabId: number, doc: string, push: StatePush): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, push, doc ? { documentId: doc } : { frameId: 0 })
}

// The service-worker side: tell a tab's page its site is no longer tracked.
export function sendStop(tabId: number): Promise<void> {
  const push: StopPush = { type: 'stop' }
  return chrome.tabs.sendMessage(tabId, push, { frameId: 0 }).then(() => undefined)
}
