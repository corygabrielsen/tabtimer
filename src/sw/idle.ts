// chrome.idle into the tracker: the detection interval, state changes, and a
// fresh reading whenever the worker starts (the browser may just have
// started, with nothing recorded yet).
import { IDLE_DETECTION_S, isIdleState } from '../core/away'
import type { Tracker } from './tracker'

type Idle = Pick<typeof chrome.idle, 'setDetectionInterval' | 'queryState' | 'onStateChanged'>

// State changes seen so far: a reading a change overtook is stale.
let changes = 0

// Register the listener; call synchronously at the worker's top level.
export function watchIdle(tracker: Pick<Tracker, 'dispatch'>, idle: Idle = chrome.idle): void {
  idle.setDetectionInterval(IDLE_DETECTION_S)
  idle.onStateChanged.addListener((state) => {
    changes++
    if (isIdleState(state)) {
      void tracker.dispatch({ kind: 'idle', state }).catch(() => undefined)
    }
  })
}

// Record the current state (on worker start, and after storage is reset),
// unless a change arrived while it was read.
export async function syncIdle(tracker: Pick<Tracker, 'dispatch'>, idle: Idle = chrome.idle): Promise<void> {
  const seen = changes
  const state: unknown = await idle.queryState(IDLE_DETECTION_S)
  if (isIdleState(state) && changes === seen) {
    await tracker.dispatch({ kind: 'idle', state })
  }
}
