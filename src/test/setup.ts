// Global test setup: a fresh fake chrome.* per test, and a clean DOM/clock
// afterwards. Installed once at load too, because some modules (Overlay) read
// chrome.i18n at import time.
import { afterEach, beforeEach, vi } from 'vitest'
import { installChrome } from './chrome'

installChrome()

beforeEach(() => {
  installChrome()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (typeof document !== 'undefined') {
    document.body.replaceChildren()
    // The content UI mounts on <html>, beside <body>.
    for (const el of [...document.documentElement.children]) {
      if (el !== document.head && el !== document.body) {
        el.remove()
      }
    }
    document.documentElement.removeAttribute('style')
  }
})
