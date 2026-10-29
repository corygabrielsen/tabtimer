export enum TimerType {
  COUNTUP = 'countup',
  FOCUS = 'focus',
}

export enum TimerState {
  NOT_STARTED = 'not_started',
  RUNNING = 'running',
  PAUSED = 'paused',
}

// A passive stopwatch: it owns no interval of its own. Its owner calls tick()
// on a shared tick source (one per tab, see FocusTracker), and elapsed time is the
// sum of the deltas between successive measurements rather than
// `now - start`. Each delta is clamped to [0, maxStep]: a tick that arrives
// after a long gap (system sleep, lid closed, a frozen tab) or after the wall
// clock jumped forward contributes at most maxStep, and a backward clock jump
// contributes nothing instead of erasing time already accrued.
export default class Timer {
  // Wall-clock time the last delta was measured up to; null unless running.
  private lastTick: number | null = null
  public elapsed: number = 0
  public state: TimerState = TimerState.NOT_STARTED

  constructor(
    public type: TimerType,
    // Largest single delta credited.
    private maxStep: number
  ) {}

  // Credit the time since the previous measurement, clamped to [0, maxStep].
  // Returns the amount credited (0 unless running).
  tick(now: number = Date.now()): number {
    if (this.lastTick === null) {
      return 0
    }
    const delta = now - this.lastTick
    this.lastTick = now
    if (delta <= 0) {
      return 0
    }
    const credited = Math.min(delta, this.maxStep)
    this.elapsed += credited
    return credited
  }

  start() {
    if (this.state === TimerState.RUNNING) {
      return
    }
    if (this.state === TimerState.PAUSED) {
      throw new Error('Cannot start a paused timer, must resume')
    }
    this.state = TimerState.RUNNING
    this.lastTick = Date.now()
  }

  // Stop the timer and reset the elapsed time.
  stop() {
    this.lastTick = null
    this.elapsed = 0
    this.state = TimerState.NOT_STARTED
  }

  // Pause, keeping the partial interval since the last tick. Returns the
  // amount credited by that final measurement.
  pause(): number {
    if (this.state === TimerState.PAUSED) {
      return 0
    }
    if (this.state !== TimerState.RUNNING) {
      throw new Error(`Cannot pause a timer that is not in the RUNNING state. (state = ${this.state})`)
    }
    const credited = this.tick()
    this.lastTick = null
    this.state = TimerState.PAUSED
    return credited
  }

  unpause() {
    if (this.state === TimerState.RUNNING) {
      return
    }
    if (this.state !== TimerState.PAUSED) {
      throw new Error(`Cannot unpause a timer that is not in the PAUSED state. (state = ${this.state})`)
    }
    this.state = TimerState.RUNNING
    this.lastTick = Date.now()
  }

  // Zero the elapsed time while preserving the running/paused state. A paused
  // timer (e.g. the focus timer on a blurred tab at midnight) must stay
  // paused, otherwise it would silently resume and count non-focus time.
  reset() {
    this.elapsed = 0
    if (this.state === TimerState.RUNNING) {
      this.lastTick = Date.now()
    }
  }
}
