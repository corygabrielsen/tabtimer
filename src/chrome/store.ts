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
