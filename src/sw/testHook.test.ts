import { describe, it, expect, vi } from 'vitest'
import { installTestHook, offsetClock, TEST_HOOK, type TestHook } from './testHook'
import type { TrackerEvent } from '../core/tracker'
import { fakeChrome } from '../test/chrome'

describe('installTestHook', () => {
  it('exposes idle(state) and checkpoint(), which reach the tracker like chrome events', async () => {
    const tracker = { dispatch: vi.fn<(event: TrackerEvent) => Promise<void>>(() => Promise.resolve()) }
    const target: Record<string, unknown> = {}
    installTestHook(tracker, offsetClock({ now: () => 0 }), target)
    await (target[TEST_HOOK] as TestHook).idle('locked')
    await (target[TEST_HOOK] as TestHook).checkpoint()
    expect(tracker.dispatch.mock.calls).toEqual([[{ kind: 'idle', state: 'locked' }], [{ kind: 'checkpoint' }]])
  })

  it('exposes advance(ms), which moves the clock ahead of its base', () => {
    let base = 1_000
    const clock = offsetClock({ now: () => base })
    const target: Record<string, unknown> = {}
    installTestHook({ dispatch: () => Promise.resolve() }, clock, target)
    ;(target[TEST_HOOK] as TestHook).advance(30_000)
    expect(clock.now()).toBe(31_000)
    base = 2_000
    expect(clock.now()).toBe(32_000)
  })

  it('exposes focusWindow(id), which focuses the window and then reports the focus change', async () => {
    const tracker = { dispatch: vi.fn<(event: TrackerEvent) => Promise<void>>(() => Promise.resolve()) }
    const focus = vi.fn<(id: number) => Promise<void>>(() => Promise.resolve())
    const target: Record<string, unknown> = {}
    installTestHook(tracker, offsetClock({ now: () => 0 }), target, focus)
    await (target[TEST_HOOK] as TestHook).focusWindow(7)
    expect(focus).toHaveBeenCalledWith(7)
    expect(tracker.dispatch).toHaveBeenCalledWith({ kind: 'windowFocus', windowId: 7 })
  })

  it('focuses through chrome.windows by default', async () => {
    const tracker = { dispatch: vi.fn<(event: TrackerEvent) => Promise<void>>(() => Promise.resolve()) }
    const target: Record<string, unknown> = {}
    installTestHook(tracker, offsetClock({ now: () => 0 }), target)
    await (target[TEST_HOOK] as TestHook).focusWindow(3)
    expect(fakeChrome().windows.update).toHaveBeenCalledWith(3, { focused: true })
  })

  it('is not installed by the worker outside the e2e build', async () => {
    vi.resetModules()
    await import('./background')
    expect(TEST_HOOK in globalThis).toBe(false)
  })
})
