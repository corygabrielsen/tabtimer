// End-to-end test hook, compiled into the e2e build only (TABTIMER_E2E=1,
// see build.e2e.ts; scripts/check-build.ts fails a production build that
// contains it). Playwright can't drive the OS idle state, wait out the
// checkpoint alarm, or get window focus events from headless Chromium, so
// e2e tests run the same tracker events the chrome listeners do. The
// worker's clock runs ahead on advance(), so time accrues without waiting:
//   await serviceWorker.evaluate(() => globalThis.__tabtimerTest.idle('locked'))
//   await serviceWorker.evaluate(() => globalThis.__tabtimerTest.advance(30_000))
//   await serviceWorker.evaluate(() => globalThis.__tabtimerTest.checkpoint())
//   await serviceWorker.evaluate((id) => globalThis.__tabtimerTest.focusWindow(id), windowId)
import type { IdleState } from '../core/away'
import type { Clock } from '../ports'
import type { Tracker } from './tracker'

export const TEST_HOOK = '__tabtimerTest'

export type TestHook = {
  idle: (state: IdleState) => Promise<void>
  checkpoint: () => Promise<void>
  // Move the worker's clock forward by `ms`.
  advance: (ms: number) => void
  // Focus a window (chrome.windows.update), then deliver the
  // windows.onFocusChanged event headless Chromium doesn't send.
  focusWindow: (windowId: number) => Promise<void>
}

// A clock `advance` moves ahead of `base`.
export type TestClock = Clock & { advance: (ms: number) => void }

export function offsetClock(base: Clock): TestClock {
  let offset = 0
  return {
    now: () => base.now() + offset,
    advance: (ms) => {
      offset += ms
    },
  }
}

const focusChromeWindow = (windowId: number) => chrome.windows.update(windowId, { focused: true }).then(() => undefined)

export function installTestHook(
  tracker: Pick<Tracker, 'dispatch'>,
  clock: TestClock,
  target: object = globalThis,
  focus: (windowId: number) => Promise<void> = focusChromeWindow
): void {
  const hook: TestHook = {
    idle: (state) => tracker.dispatch({ kind: 'idle', state }),
    checkpoint: () => tracker.dispatch({ kind: 'checkpoint' }),
    advance: (ms) => clock.advance(ms),
    focusWindow: async (windowId) => {
      await focus(windowId)
      await tracker.dispatch({ kind: 'windowFocus', windowId })
    },
  }
  Object.defineProperty(target, TEST_HOOK, { value: hook, configurable: true })
}
