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

  it('reports each tick to the callback with the running total', () => {
    const seen: number[] = []
    const t = new Timer(TimerType.FOCUS, 1000, (elapsed) => seen.push(elapsed))
    t.start()
    vi.advanceTimersByTime(3000)
    expect(seen).toEqual([1000, 2000, 3000])
  })

  it('rejects starting a paused timer and pausing a stopped one', () => {
    const t = new Timer(TimerType.FOCUS, 1000, noop)
    expect(() => t.pause()).toThrow()
    expect(() => t.unpause()).toThrow()
    t.start()
    t.pause()
    expect(() => t.start()).toThrow()
  })

  // A suspended machine fires no ticks; on wake the clock has jumped. That
  // gap is not focus time.
  it.fails('B1: does not count a sleep/lid-close gap as elapsed time', () => {
    const t = new Timer(TimerType.FOCUS, 1000, noop)
    t.start()
    vi.advanceTimersByTime(2000)
    vi.setSystemTime(Date.now() + 60 * 60 * 1000) // asleep for an hour
    vi.advanceTimersByTime(1000)
    expect(t.elapsed).toBeLessThanOrEqual(2000 + 2 * 1000)
  })

  it.fails('B1: ignores a backward clock jump instead of losing accrued time', () => {
    const t = new Timer(TimerType.FOCUS, 1000, noop)
    t.start()
    vi.advanceTimersByTime(5000)
    vi.setSystemTime(Date.now() - 60 * 60 * 1000)
    vi.advanceTimersByTime(1000)
    expect(t.elapsed).toBeGreaterThanOrEqual(5000)
  })
})
