// In-memory fake of the chrome.* surface the extension uses. One instance is
// installed on globalThis before every test (see setup.ts), so content-script,
// popup, options and background code all talk to the same fake "browser":
// a message sent by FocusTracker reaches background.ts's onMessage listener, whose
// storage writes fire storage.onChanged listeners in BlockScreen/Overlay/popup.
//
// Callbacks and events are delivered asynchronously (microtask, or a timer
// when `latency` is set) like the real APIs, with runtime.lastError set only
// for the duration of a failing callback.
import { vi } from 'vitest'
import enMessages from '../../_locales/en/messages.json'

type Listener<A extends unknown[], R> = (...args: A) => R

export class FakeEvent<A extends unknown[], R = unknown> {
  readonly listeners = new Set<Listener<A, R>>()
  addListener = (listener: Listener<A, R>): void => {
    this.listeners.add(listener)
  }
  removeListener = (listener: Listener<A, R>): void => {
    this.listeners.delete(listener)
  }
  hasListener = (listener: Listener<A, R>): boolean => this.listeners.has(listener)
  hasListeners = (): boolean => this.listeners.size > 0
  dispatch(...args: A): R[] {
    return [...this.listeners].map((listener) => listener(...args))
  }
}

type StorageChanges = Record<string, chrome.storage.StorageChange>
type AreaName = 'local' | 'sync' | 'managed' | 'session'
type Callback<T> = (value: T) => void

export class FakeStorageArea {
  data: Record<string, unknown> = {}
  // When set, every operation on this area fails with this lastError message.
  error: string | null = null

  constructor(
    private readonly browser: FakeChrome,
    private readonly name: AreaName
  ) {}

  // Each operation takes an optional callback (callback style: lastError set
  // while it runs) and returns a promise (promise style: rejects on error),
  // as the real API does.
  get = (
    keys: string | string[] | Record<string, unknown> | null,
    callback?: Callback<Record<string, unknown>>
  ): Promise<Record<string, unknown>> => {
    // Snapshot at call time; delivered later (models read/write interleaving).
    const snapshot = this.read(keys)
    return this.complete(this.error, () => snapshot, callback)
  }

  set = (items: Record<string, unknown>, callback?: () => void): Promise<void> => {
    const error = this.error
    return this.complete(
      error,
      () => {
        if (!error) {
          this.write(items)
        }
      },
      callback
    )
  }

  remove = (keys: string | string[], callback?: () => void): Promise<void> => {
    const error = this.error
    return this.complete(
      error,
      () => {
        if (!error) {
          const changes: StorageChanges = {}
          for (const key of typeof keys === 'string' ? [keys] : keys) {
            if (key in this.data) {
              changes[key] = { oldValue: this.data[key] }
              delete this.data[key]
            }
          }
          this.emit(changes)
        }
      },
      callback
    )
  }

  clear = (callback?: () => void): Promise<void> => {
    const error = this.error
    return this.complete(
      error,
      () => {
        if (!error) {
          const changes: StorageChanges = {}
          for (const [key, oldValue] of Object.entries(this.data)) {
            changes[key] = { oldValue }
          }
          this.data = {}
          this.emit(changes)
        }
      },
      callback
    )
  }

  // Apply `effect` asynchronously, then hand its result to the callback (with
  // lastError set) and settle the returned promise.
  private complete<T>(error: string | null, effect: () => T, callback?: Callback<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.browser.deliver(error, () => {
        const value = effect()
        callback?.(value)
        if (error) {
          reject(new Error(error))
        } else {
          resolve(value)
        }
      })
    })
  }

  // Direct, synchronous seeding for tests (still notifies listeners, like a
  // write from another extension context would).
  seed(items: Record<string, unknown>): void {
    this.write(items)
  }

  private read(keys: string | string[] | Record<string, unknown> | null): Record<string, unknown> {
    const clone = <T>(v: T): T => structuredClone(v)
    if (keys === null) {
      return clone(this.data)
    }
    const out: Record<string, unknown> = {}
    if (typeof keys === 'string' || Array.isArray(keys)) {
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        if (key in this.data) {
          out[key] = clone(this.data[key])
        }
      }
      return out
    }
    for (const [key, fallback] of Object.entries(keys)) {
      out[key] = key in this.data ? clone(this.data[key]) : fallback
    }
    return out
  }

  private write(items: Record<string, unknown>): void {
    const changes: StorageChanges = {}
    for (const [key, value] of Object.entries(items)) {
      const oldValue = this.data[key]
      if (JSON.stringify(oldValue) === JSON.stringify(value)) {
        continue // Chrome doesn't fire onChanged for a no-op write.
      }
      this.data[key] = structuredClone(value)
      changes[key] = oldValue === undefined ? { newValue: value } : { oldValue, newValue: value }
    }
    this.emit(changes)
  }

  private emit(changes: StorageChanges): void {
    if (Object.keys(changes).length > 0) {
      this.browser.storage.onChanged.dispatch(changes, this.name)
    }
  }
}

export type MessageSender = { id?: string; tab?: { id: number } }
export type SendResponse = (response: unknown) => void

export type FakeTab = { id?: number; url?: string; active?: boolean }

export class FakeChrome {
  // Delay (ms, via setTimeout) for every async callback; 0 = next microtask.
  latency = 0

  readonly storage = {
    onChanged: new FakeEvent<[StorageChanges, AreaName]>(),
    local: undefined as unknown as FakeStorageArea,
    sync: undefined as unknown as FakeStorageArea,
  }

  readonly runtime = {
    lastError: undefined as { message: string } | undefined,
    id: 'tabtimer-test',
    onMessage: new FakeEvent<[unknown, MessageSender, SendResponse], boolean | void>(),
    onInstalled: new FakeEvent<[{ reason: string }]>(),
    onStartup: new FakeEvent<[]>(),
    openOptionsPage: vi.fn(() => Promise.resolve()),
    sendMessage: (message: unknown, callback?: Callback<unknown>) => this.sendMessage(message, callback),
  }

  readonly i18n = {
    getMessage: (key: string, substitutions?: string | string[]) => getMessage(key, substitutions),
    getUILanguage: () => 'en-US',
  }

  // Origins currently granted, and whether a permission prompt is accepted.
  granted = new Set<string>()
  acceptPermissionPrompts = true

  readonly permissions = {
    onAdded: new FakeEvent<[{ origins?: string[] }]>(),
    onRemoved: new FakeEvent<[{ origins?: string[] }]>(),
    getAll: vi.fn(() => Promise.resolve({ origins: [...this.granted], permissions: [] as string[] })),
    contains: vi.fn(({ origins = [] }: { origins?: string[] }) =>
      Promise.resolve(origins.every((o) => this.granted.has(o)))
    ),
    request: vi.fn(({ origins = [] }: { origins?: string[] }) => {
      if (!this.acceptPermissionPrompts) {
        return Promise.resolve(false)
      }
      this.grant(origins)
      return Promise.resolve(true)
    }),
    remove: vi.fn(({ origins = [] }: { origins?: string[] }) => {
      const removed = origins.filter((o) => this.granted.delete(o))
      if (removed.length > 0) {
        this.permissions.onRemoved.dispatch({ origins: removed })
      }
      return Promise.resolve(removed.length > 0)
    }),
  }

  readonly registered = new Map<string, chrome.scripting.RegisteredContentScript>()

  readonly scripting = {
    getRegisteredContentScripts: vi.fn(({ ids }: { ids?: string[] } = {}) =>
      Promise.resolve([...this.registered.values()].filter((s) => !ids || ids.includes(s.id)))
    ),
    registerContentScripts: vi.fn((scripts: chrome.scripting.RegisteredContentScript[]) => {
      for (const s of scripts) {
        if (this.registered.has(s.id)) {
          return Promise.reject(new Error(`Duplicate script ID '${s.id}'`))
        }
      }
      for (const s of scripts) {
        this.registered.set(s.id, structuredClone(s))
      }
      return Promise.resolve()
    }),
    updateContentScripts: vi.fn((scripts: chrome.scripting.RegisteredContentScript[]) => {
      for (const s of scripts) {
        const existing = this.registered.get(s.id)
        if (!existing) {
          return Promise.reject(new Error(`Nonexistent script ID '${s.id}'`))
        }
        this.registered.set(s.id, { ...existing, ...structuredClone(s) })
      }
      return Promise.resolve()
    }),
    unregisterContentScripts: vi.fn(({ ids }: { ids?: string[] } = {}) => {
      for (const id of ids ?? [...this.registered.keys()]) {
        this.registered.delete(id)
      }
      return Promise.resolve()
    }),
    executeScript: vi.fn<(injection: { target: { tabId: number }; files?: string[] }) => Promise<unknown[]>>(() =>
      Promise.resolve([])
    ),
  }

  openTabs: FakeTab[] = []

  readonly tabs = {
    query: vi.fn((_query: { active?: boolean; currentWindow?: boolean }, callback: Callback<FakeTab[]>) => {
      const result = this.openTabs.filter((t) => t.active !== false)
      this.deliver(null, () => callback(result))
    }),
  }

  constructor() {
    this.storage.local = new FakeStorageArea(this, 'local')
    this.storage.sync = new FakeStorageArea(this, 'sync')
  }

  grant(origins: string[]): void {
    const added = origins.filter((o) => !this.granted.has(o))
    for (const o of added) {
      this.granted.add(o)
    }
    if (added.length > 0) {
      this.permissions.onAdded.dispatch({ origins: added })
    }
  }

  // Run `fn` asynchronously with runtime.lastError set to `error` (if any)
  // only while it runs — the contract callback-style chrome APIs follow.
  deliver(error: string | null, fn: () => void): void {
    const run = () => {
      this.runtime.lastError = error ? { message: error } : undefined
      try {
        fn()
      } finally {
        this.runtime.lastError = undefined
      }
    }
    if (this.latency > 0) {
      setTimeout(run, this.latency)
    } else {
      queueMicrotask(run)
    }
  }

  private sendMessage(message: unknown, callback?: Callback<unknown>): void {
    // Messages are serialized across contexts.
    const payload = structuredClone(message)
    this.deliver(null, () => {
      if (!this.runtime.onMessage.hasListeners()) {
        this.deliver('Could not establish connection. Receiving end does not exist.', () => callback?.(undefined))
        return
      }
      let responded = false
      const sendResponse: SendResponse = (response) => {
        if (responded) {
          return
        }
        responded = true
        const copy = structuredClone(response)
        this.deliver(null, () => callback?.(copy))
      }
      const results = this.runtime.onMessage.dispatch(payload, { id: this.runtime.id }, sendResponse)
      if (!responded && !results.includes(true)) {
        this.deliver('The message port closed before a response was received.', () => callback?.(undefined))
      }
    })
  }
}

type LocaleEntry = { message: string; placeholders?: Record<string, { content: string }> }
const MESSAGES = enMessages as Record<string, LocaleEntry>

// chrome.i18n.getMessage against the real en locale: named $placeholder$s map
// to their "$n" content, which takes the nth substitution. Unknown key → ''.
function getMessage(key: string, substitutions?: string | string[]): string {
  const entry = MESSAGES[key]
  if (!entry) {
    return ''
  }
  const subs = substitutions === undefined ? [] : typeof substitutions === 'string' ? [substitutions] : substitutions
  const positional = (text: string) => text.replace(/\$(\d)/g, (_m, n: string) => subs[Number(n) - 1] ?? '')
  return entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (match, name: string) => {
    const placeholder = entry.placeholders?.[name.toLowerCase()]
    return placeholder ? positional(placeholder.content) : match
  })
}

let current: FakeChrome | null = null

export function installChrome(): FakeChrome {
  current = new FakeChrome()
  ;(globalThis as unknown as { chrome: unknown }).chrome = current
  return current
}

export function fakeChrome(): FakeChrome {
  if (!current) {
    throw new Error('fake chrome not installed')
  }
  return current
}
