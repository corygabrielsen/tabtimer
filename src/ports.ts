// Interfaces between the extension's logic and the browser. Pure code (src/core)
// depends on none of them; the rest reaches chrome.* through these, with the
// chrome-backed implementations in src/chrome.
import type { Contract, MessageType, Response, TabState } from './core/messages'
import type { Presence } from './core/tracker'

export type StoreChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>

// One key-value storage area.
export interface Store {
  // The stored value, or undefined when the key is absent.
  get<T>(key: string): Promise<T | undefined>
  getAll(): Promise<Record<string, unknown>>
  keys(): Promise<string[]>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string[]): Promise<void>
  clear(): Promise<void>
  // Subscribe to changes in this area; returns the unsubscribe function.
  onChanged(fn: (changes: StoreChanges) => void): () => void
}

export interface Clock {
  // Epoch milliseconds.
  now(): number
}

// Request/response messaging to the service worker. Never rejects: a failure
// is a Response with ok: false.
export interface Bus {
  send<K extends MessageType>(type: K, req: Contract[K]['req']): Promise<Response<K>>
  // Whether the extension is still there to answer: false once the page
  // has outlived it (updated, reloaded, disabled or removed).
  alive(): boolean
}

// States the service worker pushes to a page. The handler returns the
// page's presence, which the worker takes as a fresh report if `probe`.
export interface Pushes {
  onState(handle: (state: TabState, probe: boolean) => Presence): () => void
  // The worker telling the page its site is no longer tracked.
  onStop(handle: () => void): () => void
}
