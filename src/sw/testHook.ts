// End-to-end test hook, compiled into the e2e build only (TABTIMER_E2E=1,
// see build.e2e.ts; scripts/check-build.mjs fails a production build that
// contains it). Playwright can't drive the OS idle state, so e2e tests set it
// through the same ledger call chrome.idle events reach:
//   await serviceWorker.evaluate(() => globalThis.__tabtimerTest.idle('locked'))
import type { IdleState } from '../core/away'
import type { Ledger } from './ledger'

export const TEST_HOOK = '__tabtimerTest'

export type TestHook = { idle: (state: IdleState) => Promise<void> }

export function installTestHook(ledger: Pick<Ledger, 'setIdleState'>, target: object = globalThis): void {
  const hook: TestHook = { idle: (state) => ledger.setIdleState(state) }
  Object.defineProperty(target, TEST_HOOK, { value: hook, configurable: true })
}
