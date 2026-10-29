// Global test setup: a fresh fake chrome.* per test, and a clean DOM/clock
// afterwards. Installed once at load too, because some modules (View) read
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
    document.documentElement.removeAttribute('style')
  }
})
