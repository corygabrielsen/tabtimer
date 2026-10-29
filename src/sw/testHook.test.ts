import { describe, it, expect, vi } from 'vitest'
import { installTestHook, TEST_HOOK, type TestHook } from './testHook'

describe('installTestHook', () => {
  it('exposes idle(state), which reaches the ledger like a chrome.idle event', async () => {
    const ledger = { setIdleState: vi.fn<(state: string) => Promise<void>>(() => Promise.resolve()) }
    const target: Record<string, unknown> = {}
    installTestHook(ledger, target)
    await (target[TEST_HOOK] as TestHook).idle('locked')
    expect(ledger.setIdleState).toHaveBeenCalledWith('locked')
  })

  it('is not installed by the worker outside the e2e build', async () => {
    vi.resetModules()
    await import('./background')
    expect(TEST_HOOK in globalThis).toBe(false)
  })
})
