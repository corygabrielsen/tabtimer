import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Timer, { TimerState, TimerType } from './Timer'

const SECOND = 1000

// Advance the clock `ms` in 1s steps, ticking the timer after each, as the
// FocusTracker's per-second interval does.
function run(t: Timer, ms: number): void {
  for (let left = ms; left > 0; left -= SECOND) {
    vi.advanceTimersByTime(Math.min(SECOND, left))
    t.tick()
  }
}

// Move the wall clock without any tick, as across a system suspend.
function jump(ms: number): void {
  vi.setSystemTime(Date.now() + ms)
}

describe('Timer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts not-started with zero elapsed', () => {
    const t = new Timer(TimerType.COUNTUP, 2 * SECOND)
    expect(t.state).toBe(TimerState.NOT_STARTED)
    expect(t.elapsed).toBe(0)
    expect(t.tick()).toBe(0)
  })

  it('accrues the time between ticks while running', () => {
    const t = new Timer(TimerType.COUNTUP, 2 * SECOND)
    t.start()
    run(t, 3 * SECOND)
    expect(t.state).toBe(TimerState.RUNNING)
    expect(t.elapsed).toBe(3 * SECOND)
  })

  it('returns what each tick credited', () => {
    const t = new Timer(TimerType.FOCUS, 2 * SECOND)
    t.start()
    vi.advanceTimersByTime(700)
    expect(t.tick()).toBe(700)
    vi.advanceTimersByTime(SECOND)
    expect(t.tick()).toBe(SECOND)
  })

  it('freezes while paused and does not count the pause on resume', () => {
    const t = new Timer(TimerType.FOCUS, 2 * SECOND)
    t.start()
    run(t, 2 * SECOND)
    t.pause()
    const atPause = t.elapsed
    run(t, 5 * SECOND) // paused — should not accrue
    expect(t.elapsed).toBe(atPause)
    t.unpause()
    run(t, SECOND)
    expect(t.elapsed).toBe(atPause + SECOND)
  })

  it('keeps the partial interval since the last tick when paused', () => {
    const t = new Timer(TimerType.FOCUS, 2 * SECOND)
    t.start()
    run(t, SECOND)
    vi.advanceTimersByTime(400)
    expect(t.pause()).toBe(400)
    expect(t.elapsed).toBe(1400)
    expect(t.pause()).toBe(0) // already paused
  })

  it('excludes both gaps across two pause/resume cycles', () => {
    const t = new Timer(TimerType.FOCUS, 2 * SECOND)
    t.start()
    run(t, 3 * SECOND)
    t.pause()
    run(t, 20 * SECOND)
    t.unpause()
    run(t, 4 * SECOND)
    t.pause()
    run(t, 70 * SECOND)
    t.unpause()
    run(t, 5 * SECOND)
    expect(t.elapsed).toBe(12 * SECOND)
  })

  it('preserves the paused state across reset (regression)', () => {
    const t = new Timer(TimerType.FOCUS, 2 * SECOND)
    t.start()
    run(t, SECOND)
    t.pause()
    t.reset()
    expect(t.state).toBe(TimerState.PAUSED)
    expect(t.elapsed).toBe(0)
    run(t, SECOND)
    expect(t.elapsed).toBe(0)
  })

  it('keeps a running timer running across reset, zeroed', () => {
    const t = new Timer(TimerType.FOCUS, 2 * SECOND)
    t.start()
    run(t, 2 * SECOND)
    vi.advanceTimersByTime(500)
    t.reset()
    expect(t.state).toBe(TimerState.RUNNING)
    expect(t.elapsed).toBe(0)
    // Measures from the reset, not from the last tick before it.
    run(t, SECOND)
    expect(t.elapsed).toBe(SECOND)
  })

  it('stop returns to not-started and zero', () => {
    const t = new Timer(TimerType.COUNTUP, 2 * SECOND)
    t.start()
    run(t, SECOND)
    t.stop()
    expect(t.state).toBe(TimerState.NOT_STARTED)
    expect(t.elapsed).toBe(0)
    run(t, SECOND)
    expect(t.elapsed).toBe(0)
  })

  it('rejects starting a paused timer and pausing a stopped one', () => {
    const t = new Timer(TimerType.FOCUS, 2 * SECOND)
    expect(() => t.pause()).toThrow()
    expect(() => t.unpause()).toThrow()
    t.start()
    t.start() // already running: no-op
    t.pause()
    expect(() => t.start()).toThrow()
    t.unpause()
    t.unpause() // already running: no-op
    expect(t.state).toBe(TimerState.RUNNING)
  })

  // A suspended machine fires no ticks; on wake the clock has jumped. That
  // gap is not focus time.
  it('B1: does not count a sleep/lid-close gap as elapsed time', () => {
    const t = new Timer(TimerType.FOCUS, 2 * SECOND)
    t.start()
    run(t, 2 * SECOND)
    jump(60 * 60 * SECOND) // asleep for an hour
    run(t, SECOND)
    expect(t.elapsed).toBeLessThanOrEqual(2 * SECOND + 2 * SECOND)
  })

  it('B1: ignores a backward clock jump instead of losing accrued time', () => {
    const t = new Timer(TimerType.FOCUS, 2 * SECOND)
    t.start()
    run(t, 5 * SECOND)
    jump(-60 * 60 * SECOND)
    run(t, SECOND)
    expect(t.elapsed).toBeGreaterThanOrEqual(5 * SECOND)
    // ...and keeps counting normally from the new clock.
    run(t, 2 * SECOND)
    expect(t.elapsed).toBe(7 * SECOND)
  })

  it('can be configured to credit long gaps in full (wall time)', () => {
    const t = new Timer(TimerType.COUNTUP, Infinity)
    t.start()
    jump(60 * SECOND)
    run(t, SECOND)
    expect(t.elapsed).toBe(61 * SECOND)
  })
})
