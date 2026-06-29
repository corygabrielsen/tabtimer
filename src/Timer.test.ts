import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Timer, { TimerState, TimerType } from './Timer'

const noop = () => {}

describe('Timer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts not-started with zero elapsed', () => {
    const t = new Timer(TimerType.COUNTUP, 1000, noop)
    expect(t.state).toBe(TimerState.NOT_STARTED)
    expect(t.elapsed).toBe(0)
  })

  it('accrues wall-clock time while running', () => {
    const t = new Timer(TimerType.COUNTUP, 1000, noop)
    t.start()
    vi.advanceTimersByTime(3000)
    expect(t.state).toBe(TimerState.RUNNING)
    expect(t.elapsed).toBe(3000)
  })

  it('freezes while paused and does not count the pause on resume', () => {
    const t = new Timer(TimerType.FOCUS, 1000, noop)
    t.start()
    vi.advanceTimersByTime(2000)
    t.pause()
    const atPause = t.elapsed
    vi.advanceTimersByTime(5000) // paused — should not accrue
    expect(t.elapsed).toBe(atPause)
    t.unpause()
    vi.advanceTimersByTime(1000)
    expect(t.elapsed).toBe(atPause + 1000)
  })

  it('preserves the paused state across reset (regression)', () => {
    const t = new Timer(TimerType.FOCUS, 1000, noop)
    t.start()
    vi.advanceTimersByTime(1000)
    t.pause()
    t.reset()
    expect(t.state).toBe(TimerState.PAUSED)
    expect(t.elapsed).toBe(0)
  })

  it('keeps a running timer running across reset, zeroed', () => {
    const t = new Timer(TimerType.FOCUS, 1000, noop)
    t.start()
    vi.advanceTimersByTime(2000)
    t.reset()
    expect(t.state).toBe(TimerState.RUNNING)
    expect(t.elapsed).toBe(0)
  })

  it('stop returns to not-started and zero', () => {
    const t = new Timer(TimerType.COUNTUP, 1000, noop)
    t.start()
    vi.advanceTimersByTime(1000)
    t.stop()
    expect(t.state).toBe(TimerState.NOT_STARTED)
    expect(t.elapsed).toBe(0)
  })
})
