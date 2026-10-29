import { describe, it, expect, vi } from 'vitest'
import { installTestHook, TEST_HOOK, type TestHook } from './testHook'
import type { TrackerEvent } from '../core/tracker'
import { fakeChrome } from '../test/chrome'

describe('installTestHook', () => {
  it('exposes idle(state) and checkpoint(), which reach the tracker like chrome events', async () => {
    const tracker = { dispatch: vi.fn<(event: TrackerEvent) => Promise<void>>(() => Promise.resolve()) }
    const target: Record<string, unknown> = {}
    installTestHook(tracker, target)
    await (target[TEST_HOOK] as TestHook).idle('locked')
    await (target[TEST_HOOK] as TestHook).checkpoint()
    expect(tracker.dispatch.mock.calls).toEqual([[{ kind: 'idle', state: 'locked' }], [{ kind: 'checkpoint' }]])
  })

  it('exposes focusWindow(id), which focuses the window and then reports the focus change', async () => {
    const tracker = { dispatch: vi.fn<(event: TrackerEvent) => Promise<void>>(() => Promise.resolve()) }
    const focus = vi.fn<(id: number) => Promise<void>>(() => Promise.resolve())
    const target: Record<string, unknown> = {}
    installTestHook(tracker, target, focus)
    await (target[TEST_HOOK] as TestHook).focusWindow(7)
    expect(focus).toHaveBeenCalledWith(7)
    expect(tracker.dispatch).toHaveBeenCalledWith({ kind: 'windowFocus', windowId: 7 })
  })

  it('focuses through chrome.windows by default', async () => {
    const tracker = { dispatch: vi.fn<(event: TrackerEvent) => Promise<void>>(() => Promise.resolve()) }
    const target: Record<string, unknown> = {}
    installTestHook(tracker, target)
    await (target[TEST_HOOK] as TestHook).focusWindow(3)
    expect(fakeChrome().windows.update).toHaveBeenCalledWith(3, { focused: true })
  })

  it('is not installed by the worker outside the e2e build', async () => {
    vi.resetModules()
    await import('./background')
    expect(TEST_HOOK in globalThis).toBe(false)
  })
})
