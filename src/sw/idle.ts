// chrome.idle into the ledger: the detection interval, state changes, and a
// fresh reading whenever the worker starts (the browser may just have
// started, with nothing recorded yet).
import { IDLE_DETECTION_S, isIdleState } from '../core/away'
import type { Ledger } from './ledger'

type Idle = Pick<typeof chrome.idle, 'setDetectionInterval' | 'queryState' | 'onStateChanged'>

// Register the listener; call synchronously at the worker's top level.
export function watchIdle(ledger: Pick<Ledger, 'setIdleState'>, idle: Idle = chrome.idle): void {
  idle.setDetectionInterval(IDLE_DETECTION_S)
  idle.onStateChanged.addListener((state) => {
    if (isIdleState(state)) {
      void ledger.setIdleState(state).catch(() => undefined)
    }
  })
}

// Record the current state (on worker start, and after storage is reset).
export async function syncIdle(ledger: Pick<Ledger, 'setIdleState'>, idle: Idle = chrome.idle): Promise<void> {
  const state: unknown = await idle.queryState(IDLE_DETECTION_S)
  if (isIdleState(state)) {
    await ledger.setIdleState(state)
  }
}
