import type { Store, StoreChanges } from '../ports'

export type StorageAreaName = 'local' | 'sync' | 'session'

// A Store over one chrome.storage area, using the promise API: a failing call
// rejects. The area is looked up on every call rather than captured, so a
// Store created at module load keeps working if `chrome` is replaced.
export function chromeStore(area: StorageAreaName): Store {
  const storageArea = () => chrome.storage[area]
  return {
    get: <T>(key: string) =>
      storageArea()
        .get(key)
        .then((items) => items[key] as T | undefined),
    getAll: () => storageArea().get(null),
    // getKeys is Chrome 130+; before it, every value is read for its key.
    keys: async () => {
      const a = storageArea()
      return typeof a.getKeys === 'function' ? a.getKeys() : Object.keys(await a.get(null))
    },
    set: (items) => storageArea().set(items),
    remove: (keys) => storageArea().remove(keys),
    clear: () => storageArea().clear(),
    onChanged: (fn) => {
      const listener = (changes: StoreChanges, areaName: string) => {
        if (areaName === area) {
          fn(changes)
        }
      }
      chrome.storage.onChanged.addListener(listener)
      return () => chrome.storage.onChanged.removeListener(listener)
    },
  }
}

// Load a page's state with `load`, then keep it current with `apply` for
// every change. The listener is in place before the read starts: changes
// that arrive while it is in flight are applied after it, in order, so a
// write racing the read is never lost (one the read already saw is applied
// again, which sets the same value).
export async function loadThenPatch(
  store: Store,
  load: () => Promise<void>,
  apply: (changes: StoreChanges) => void
): Promise<void> {
  let queued: StoreChanges[] | null = []
  store.onChanged((changes) => (queued ? queued.push(changes) : apply(changes)))
  try {
    await load()
  } finally {
    const pending = queued
    queued = null
    for (const changes of pending) {
      apply(changes)
    }
  }
}
