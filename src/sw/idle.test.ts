import { describe, it, expect, vi } from 'vitest'
import { syncIdle, watchIdle } from './idle'
import { IDLE_DETECTION_S } from '../core/away'
import type { TrackerEvent } from '../core/tracker'
import { fakeChrome } from '../test/chrome'

const fakeTracker = () => ({ dispatch: vi.fn<(event: TrackerEvent) => Promise<void>>(() => Promise.resolve()) })

describe('watchIdle', () => {
  it('sets the detection interval and passes every known state change on', () => {
    const browser = fakeChrome()
    const tracker = fakeTracker()
    watchIdle(tracker)
    expect(browser.idle.setDetectionInterval).toHaveBeenCalledWith(IDLE_DETECTION_S)
    browser.setIdleState('idle')
    browser.setIdleState('locked')
    browser.idle.onStateChanged.dispatch('asleep')
    expect(tracker.dispatch.mock.calls).toEqual([
      [{ kind: 'idle', state: 'idle' }],
      [{ kind: 'idle', state: 'locked' }],
    ])
  })

  it('keeps listening after the tracker fails', async () => {
    const browser = fakeChrome()
    const tracker = { dispatch: vi.fn(() => Promise.reject(new Error('quota'))) }
    watchIdle(tracker)
    browser.setIdleState('idle')
    browser.setIdleState('active')
    await Promise.resolve()
    expect(tracker.dispatch).toHaveBeenCalledTimes(2)
  })
})

describe('syncIdle', () => {
  it('records the state chrome.idle reports now, over the same interval', async () => {
    const browser = fakeChrome()
    browser.idleState = 'locked'
    const tracker = fakeTracker()
    await syncIdle(tracker)
    expect(browser.idle.queryState).toHaveBeenCalledWith(IDLE_DETECTION_S)
    expect(tracker.dispatch).toHaveBeenCalledWith({ kind: 'idle', state: 'locked' })
  })

  it('ignores a state it does not know', async () => {
    const browser = fakeChrome()
    browser.idle.queryState.mockResolvedValueOnce('asleep' as never)
    const tracker = fakeTracker()
    await syncIdle(tracker)
    expect(tracker.dispatch).not.toHaveBeenCalled()
  })
})
