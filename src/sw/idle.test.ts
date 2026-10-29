import { describe, it, expect, vi } from 'vitest'
import { syncIdle, watchIdle } from './idle'
import { IDLE_DETECTION_S } from '../core/away'
import { fakeChrome } from '../test/chrome'

const fakeLedger = () => ({ setIdleState: vi.fn<(state: string) => Promise<void>>(() => Promise.resolve()) })

describe('watchIdle', () => {
  it('sets the detection interval and passes every known state change on', () => {
    const browser = fakeChrome()
    const ledger = fakeLedger()
    watchIdle(ledger)
    expect(browser.idle.setDetectionInterval).toHaveBeenCalledWith(IDLE_DETECTION_S)
    browser.setIdleState('idle')
    browser.setIdleState('locked')
    browser.idle.onStateChanged.dispatch('asleep')
    expect(ledger.setIdleState.mock.calls).toEqual([['idle'], ['locked']])
  })

  it('keeps listening after the ledger fails', async () => {
    const browser = fakeChrome()
    const ledger = { setIdleState: vi.fn(() => Promise.reject(new Error('quota'))) }
    watchIdle(ledger)
    browser.setIdleState('idle')
    browser.setIdleState('active')
    await Promise.resolve()
    expect(ledger.setIdleState).toHaveBeenCalledTimes(2)
  })
})

describe('syncIdle', () => {
  it('records the state chrome.idle reports now, over the same interval', async () => {
    const browser = fakeChrome()
    browser.idleState = 'locked'
    const ledger = fakeLedger()
    await syncIdle(ledger)
    expect(browser.idle.queryState).toHaveBeenCalledWith(IDLE_DETECTION_S)
    expect(ledger.setIdleState).toHaveBeenCalledWith('locked')
  })

  it('ignores a state it does not know', async () => {
    const browser = fakeChrome()
    browser.idle.queryState.mockResolvedValueOnce('asleep' as never)
    const ledger = fakeLedger()
    await syncIdle(ledger)
    expect(ledger.setIdleState).not.toHaveBeenCalled()
  })
})
