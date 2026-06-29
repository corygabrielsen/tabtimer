export type StorageArea = 'sync' | 'local' | 'managed'

interface Storage {
  get: <T>(key: string, defaultValue: T, storageArea: StorageArea) => Promise<T>
  set: <T>(key: string, value: T, storageArea: StorageArea) => Promise<void>
  remove: (keys: string | string[], storageArea: StorageArea) => Promise<void>
  keys: (storageArea: StorageArea) => Promise<string[]>
}

export const storage: Storage = {
  get: <T>(key: string, defaultValue: T, storageArea: StorageArea) => {
    return new Promise<T>((resolve, reject) => {
      chrome.storage[storageArea].get({ [key]: defaultValue }, (items: Record<string, unknown>) => {
        const error = chrome.runtime.lastError
        if (error) {
          reject(error)
        } else {
          const value = items[key]
          resolve((value === undefined ? defaultValue : value) as T)
        }
      })
    })
  },
  set: <T>(key: string, value: T, storageArea: StorageArea) => {
    return new Promise<void>((resolve, reject) => {
      chrome.storage[storageArea].set({ [key]: value }, () => {
        const error = chrome.runtime.lastError
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  },
  remove: (keys: string | string[], storageArea: StorageArea) => {
    return new Promise<void>((resolve, reject) => {
      chrome.storage[storageArea].remove(keys, () => {
        const error = chrome.runtime.lastError
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  },
  keys: (storageArea: StorageArea) => {
    return new Promise<string[]>((resolve, reject) => {
      chrome.storage[storageArea].get(null, (items: Record<string, unknown>) => {
        const error = chrome.runtime.lastError
        if (error) {
          reject(error)
        } else {
          resolve(Object.keys(items))
        }
      })
    })
  },
}

export const ELAPSED_KEY_PREFIX = 'focusTimer_elapsed_today'

// Global preference: when true, the on-page overlay is hidden everywhere.
// Toggled from the popup and by the overlay's own close control.
export const HIDDEN_KEY = 'tabtimer_hidden'

// Global preference: overlay zoom factor (1 = default), adjustable from the
// overlay's own size controls.
export const SCALE_KEY = 'tabtimer_scale'

// Collapse a hostname to an approximate registrable domain by keeping the
// last two labels (so old.reddit.com and www.reddit.com share one counter).
// NOTE: this is wrong for multi-label public suffixes such as `foo.co.uk`
// (collapses to `co.uk`); none of the currently tracked hosts hit that.
export function baseHost(hostname: string): string {
  const parts = hostname.split('.')
  while (parts.length > 2) {
    parts.shift()
  }
  return parts.join('.')
}

export function baseKeyForHost(hostname: string): string {
  return `${ELAPSED_KEY_PREFIX}_${baseHost(hostname)}`
}

function dateStamp(date: Date): string {
  // ISO yyyy-mm-dd with zero padding.
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(
    2,
    '0'
  )}`
}

export function todayKeyForHost(hostname: string, date: Date = new Date()): string {
  return `${baseKeyForHost(hostname)}_${dateStamp(date)}`
}

// Sum today's stored focus time across every tracked host (the global daily
// total). Excludes in-flight, not-yet-flushed deltas, so it can lag a live
// counter by up to ~10s — fine for a minute-scale limit.
export function readGlobalElapsedToday(date: Date = new Date()): Promise<number> {
  const suffix = `_${dateStamp(date)}`
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (items: Record<string, unknown>) => {
      if (chrome.runtime.lastError) {
        resolve(0)
        return
      }
      let total = 0
      for (const [key, value] of Object.entries(items)) {
        if (key.startsWith(`${ELAPSED_KEY_PREFIX}_`) && key.endsWith(suffix) && typeof value === 'number') {
          total += value
        }
      }
      resolve(total)
    })
  })
}
