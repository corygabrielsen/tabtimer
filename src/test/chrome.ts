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

// windows.onFocusChanged: each listener hears focus move to a window of a
// type outside its filter (by default 'normal' and 'popup', as in Chrome) as
// WINDOW_ID_NONE.
type WindowType = 'normal' | 'popup' | 'panel' | 'app' | 'devtools'
const DEFAULT_WINDOW_TYPES: WindowType[] = ['normal', 'popup']

export class FakeFocusEvent extends FakeEvent<[number]> {
  readonly filters = new Map<Listener<[number], unknown>, WindowType[]>()
  override addListener = (listener: Listener<[number], unknown>, filter?: { windowTypes: WindowType[] }): void => {
    this.listeners.add(listener)
    this.filters.set(listener, filter?.windowTypes ?? DEFAULT_WINDOW_TYPES)
  }
  // Focus moves to window `windowId` of type `type`.
  focus(windowId: number, type: WindowType): void {
    for (const listener of this.listeners) {
      void listener(windowId === -1 || this.filters.get(listener)?.includes(type) ? windowId : -1)
    }
  }
}

type StorageChanges = Record<string, chrome.storage.StorageChange>
type AreaName = 'local' | 'sync' | 'managed' | 'session'
type Callback<T> = (value: T) => void

// Does granted match pattern `g` cover requested pattern `r`? Schemes and
// hosts as Chrome compares them; ports and paths are ignored (host
// permissions don't scope by path). Written apart from core/site.ts, so the
// fake doesn't share the parser it tests.
function patternCovers(g: string, r: string): boolean {
  const split = (p: string) => (p === '<all_urls>' ? ['*', '*'] : /^([^:]+):\/\/([^/:]+)/.exec(p)?.slice(1))
  const [gs, gh] = split(g) ?? []
  const [rs, rh] = split(r) ?? []
  if (!gs || !gh || !rs || !rh || (gs !== '*' && gs !== rs)) {
    return false
  }
  if (gh === '*') {
    return true
  }
  if (!gh.startsWith('*.')) {
    return gh === rh
  }
  const base = gh.slice(2)
  const host = rh.replace(/^\*\./, '')
  return host === base || host.endsWith(`.${base}`)
}

// A page's URL as a pattern for patternCovers: its scheme and host.
function pageOf(url: string): string {
  const u = new URL(url)
  return `${u.protocol.slice(0, -1)}://${u.hostname}/*`
}

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
    const racing = this.racing
    if (racing) {
      this.racing = null
      this.write(racing)
    }
    return this.complete(this.error, () => snapshot, callback)
  }

  getKeys = (): Promise<string[]> => this.complete(this.error, () => Object.keys(this.data))

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

  // Write `items` just after the next read takes its snapshot: a write that
  // lands while that read is in flight.
  writeDuringNextRead(items: Record<string, unknown>): void {
    this.racing = items
  }
  private racing: Record<string, unknown> | null = null

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

export type MessageSender = {
  id?: string
  url?: string
  tab?: { id: number; windowId?: number }
  frameId?: number
  documentId?: string
  documentLifecycle?: string
}
export type SendResponse = (response: unknown) => void

export type FakeTab = { id?: number; url?: string; active?: boolean }

export class FakeChrome {
  // Delay (ms, via setTimeout) for every async callback; 0 = next microtask.
  latency = 0

  readonly storage = {
    onChanged: new FakeEvent<[StorageChanges, AreaName]>(),
    local: undefined as unknown as FakeStorageArea,
    sync: undefined as unknown as FakeStorageArea,
    session: undefined as unknown as FakeStorageArea,
  }

  // The sender the service worker sees for runtime.sendMessage. By default
  // it follows the test page's URL: an http(s) page is a content script in
  // a tab's top frame, anything else an extension page. Set it to override.
  sender: MessageSender | null = null

  readonly runtime = {
    lastError: undefined as { message: string } | undefined,
    id: 'tabtimer-test',
    getURL: (path: string) => `chrome-extension://tabtimer-test/${path}`,
    onMessage: new FakeEvent<[unknown, MessageSender, SendResponse], boolean | void>(),
    onInstalled: new FakeEvent<[{ reason: string }]>(),
    onStartup: new FakeEvent<[]>(),
    openOptionsPage: vi.fn(() => Promise.resolve()),
    // The extension's open documents (none unless a test adds them).
    getContexts: vi.fn<(filter: object) => Promise<Array<{ windowId: number; tabId: number }>>>(() =>
      Promise.resolve([])
    ),
    sendMessage: (message: unknown, callback?: Callback<unknown>) => this.sendMessage(message, callback),
  }

  // Content scripts reach closed shadow roots through chrome.dom; this one
  // sees open ones only, unless a test says otherwise.
  readonly dom = {
    openOrClosedShadowRoot: vi.fn((el: HTMLElement): ShadowRoot | null => el.shadowRoot),
  }

  readonly i18n = {
    getMessage: (key: string, substitutions?: string | string[]) => getMessage(key, substitutions),
    getUILanguage: () => 'en-US',
  }

  // Origins currently granted, as getAll reports them (the strings granted,
  // whoever granted them), and whether a permission prompt is accepted.
  granted = new Set<string>()
  acceptPermissionPrompts = true

  // Chrome's host-permission semantics: an origin is held when some granted
  // pattern covers it, and a request for held origins succeeds without a
  // prompt or a change. remove() takes exact granted strings.
  private holds(origin: string): boolean {
    return [...this.granted].some((g) => patternCovers(g, origin))
  }

  readonly permissions = {
    onAdded: new FakeEvent<[{ origins?: string[] }]>(),
    onRemoved: new FakeEvent<[{ origins?: string[] }]>(),
    getAll: vi.fn(() => Promise.resolve({ origins: [...this.granted], permissions: [] as string[] })),
    contains: vi.fn(({ origins = [] }: { origins?: string[] }) => Promise.resolve(origins.every((o) => this.holds(o)))),
    request: vi.fn(({ origins = [] }: { origins?: string[] }) => {
      if (origins.every((o) => this.holds(o))) {
        return Promise.resolve(true)
      }
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

  // The OS idle state chrome.idle reports; setIdleState also fires
  // onStateChanged, as a real change would.
  idleState: 'active' | 'idle' | 'locked' = 'active'

  readonly idle = {
    setDetectionInterval: vi.fn<(seconds: number) => void>(),
    queryState: vi.fn<(seconds: number) => Promise<string>>(() => Promise.resolve(this.idleState)),
    onStateChanged: new FakeEvent<[string]>(),
  }

  setIdleState(state: 'active' | 'idle' | 'locked'): void {
    this.idleState = state
    this.idle.onStateChanged.dispatch(state)
  }

  openTabs: FakeTab[] = []
  mutedInfo = new Map<number, chrome.tabs.MutedInfo>()

  readonly tabs = {
    // Every open tab, or the active ones, or those a URL pattern covers. A
    // tab whose URL the extension can't see has none.
    query: vi.fn(
      (
        query: { active?: boolean; currentWindow?: boolean; url?: string | string[] },
        callback?: Callback<FakeTab[]>
      ) => {
        const patterns = query.url === undefined ? null : [query.url].flat()
        const result = this.openTabs.filter(
          (t) =>
            (query.active === undefined || t.active !== false) &&
            (patterns === null || (t.url !== undefined && patterns.some((p) => patternCovers(p, pageOf(t.url!)))))
        )
        if (!callback) {
          return Promise.resolve(result)
        }
        this.deliver(null, () => callback(result))
        return undefined
      }
    ),
    // A message to a tab's content script, as the service worker sends it.
    // Every onMessage listener hears it (the router answers 'bad_request',
    // asynchronously); the page's listener answers first, synchronously.
    // The options (documentId or frameId) only pick the frame; this fake
    // has one page.
    sendMessage: vi.fn((...[tabId, message]: [number, unknown, { documentId?: string; frameId?: number }?]) =>
      this.sendToTab(tabId, message)
    ),
    create: vi.fn((props: { url?: string }) => Promise.resolve({ id: 99, windowId: 1, ...props })),
    // Each tab's mute, as tabs.get reports it; an unknown tab is unmuted.
    get: vi.fn((tabId: number) =>
      Promise.resolve({ id: tabId, mutedInfo: this.mutedInfo.get(tabId) ?? { muted: false } })
    ),
    update: vi.fn((tabId: number, props: { muted?: boolean }) => {
      if (props.muted !== undefined) {
        this.mutedInfo.set(
          tabId,
          props.muted ? { muted: true, reason: 'extension', extensionId: this.runtime.id } : { muted: false }
        )
      }
      return Promise.resolve({ id: tabId })
    }),
    onActivated: new FakeEvent<[{ tabId: number; windowId: number }]>(),
    onRemoved: new FakeEvent<[number]>(),
    onAttached: new FakeEvent<[number, { newWindowId: number; newPosition: number }]>(),
    onUpdated: new FakeEvent<
      [number, { url?: string; status?: string; discarded?: boolean; audible?: boolean }, { url?: string }]
    >(),
  }

  // Tabs whose content script is gone: messages to them fail.
  readonly closedTabs = new Set<number>()

  readonly windows = {
    WINDOW_ID_NONE: -1,
    onFocusChanged: new FakeFocusEvent(),
    update: vi.fn((...[windowId]: [number, { focused?: boolean }]) => Promise.resolve({ id: windowId })),
  }

  // Alarms run on (fake) timers, as chrome.alarms would fire them.
  readonly alarmTimers = new Map<string, { alarm: chrome.alarms.Alarm; timer: ReturnType<typeof setInterval> }>()

  readonly alarms = {
    onAlarm: new FakeEvent<[chrome.alarms.Alarm]>(),
    create: vi.fn((name: string, info: { periodInMinutes: number }) => {
      clearInterval(this.alarmTimers.get(name)?.timer)
      const period = info.periodInMinutes * 60_000
      const alarm: chrome.alarms.Alarm = {
        name,
        periodInMinutes: info.periodInMinutes,
        scheduledTime: Date.now() + period,
        persistAcrossSessions: true,
      }
      const timer = setInterval(() => {
        alarm.scheduledTime = Date.now() + period
        this.alarms.onAlarm.dispatch({ ...alarm })
      }, period)
      this.alarmTimers.set(name, { alarm, timer })
      return Promise.resolve()
    }),
    get: vi.fn((name: string) => Promise.resolve(this.alarmTimers.get(name)?.alarm)),
    clear: vi.fn((name: string) => {
      const entry = this.alarmTimers.get(name)
      if (entry) {
        clearInterval(entry.timer)
        this.alarmTimers.delete(name)
      }
      return Promise.resolve(entry !== undefined)
    }),
  }

  private sendToTab(tabId: number, message: unknown): Promise<unknown> {
    const payload = structuredClone(message)
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        if (this.closedTabs.has(tabId)) {
          reject(new Error('Could not establish connection. Receiving end does not exist.'))
          return
        }
        let responded = false
        const sendResponse: SendResponse = (response) => {
          if (!responded) {
            responded = true
            resolve(structuredClone(response))
          }
        }
        const results = this.runtime.onMessage.dispatch(payload, { id: this.runtime.id }, sendResponse)
        if (!responded && !results.includes(true)) {
          reject(new Error('The message port closed before a response was received.'))
        }
      })
    })
  }

  constructor() {
    this.storage.local = new FakeStorageArea(this, 'local')
    this.storage.sync = new FakeStorageArea(this, 'sync')
    this.storage.session = new FakeStorageArea(this, 'session')
  }

  currentSender(): MessageSender {
    if (this.sender) {
      return this.sender
    }
    const url = (globalThis as { location?: { href: string } }).location?.href ?? ''
    return /^https?:/.test(url)
      ? { id: this.runtime.id, url, tab: { id: 1, windowId: 1 }, frameId: 0, documentLifecycle: 'active' }
      : { id: this.runtime.id, url: this.runtime.getURL('popup.html') }
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

  // The page outlives its extension (updated, reloaded, disabled, removed):
  // chrome.runtime loses its id and sendMessage throws, as in an orphaned
  // content script.
  orphaned = false

  orphan(): void {
    this.orphaned = true
    Object.assign(this.runtime, { id: undefined })
  }

  private sendMessage(message: unknown, callback?: Callback<unknown>): void {
    if (this.orphaned) {
      throw new Error('Extension context invalidated.')
    }
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
      const results = this.runtime.onMessage.dispatch(payload, this.currentSender(), sendResponse)
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
