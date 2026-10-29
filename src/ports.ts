// Interfaces between the extension's logic and the browser. Pure code (src/core)
// depends on none of them; the rest reaches chrome.* through these, with the
// chrome-backed implementations in src/chrome.

export type StoreChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>

// One key-value storage area.
export interface Store {
  // The stored value, or undefined when the key is absent.
  get<T>(key: string): Promise<T | undefined>
  getAll(): Promise<Record<string, unknown>>
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
