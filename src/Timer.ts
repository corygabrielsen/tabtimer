export enum TimerType {
  COUNTUP = 'countup',
  FOCUS = 'focus',
}

export enum TimerState {
  NOT_STARTED = 'not_started',
  RUNNING = 'running',
  PAUSED = 'paused',
}

type TickCallback = (elapsed: number) => void

// Timer accumulates elapsed time as a sum of per-tick deltas rather than as
// `now - start`. Each delta is clamped to [0, maxStep]: a tick that arrives
// after a long gap (system sleep, lid closed, a frozen tab) or after the wall
// clock jumped forward contributes at most maxStep, and a backward clock jump
// contributes nothing instead of erasing time already accrued.
export default class Timer {
  private timerId: ReturnType<typeof setInterval> | null = null
  // Wall-clock time the last delta was measured up to; null unless running.
  private lastTick: number | null = null
  private maxStep: number
  public elapsed: number = 0
  public state: TimerState = TimerState.NOT_STARTED

  constructor(
    public type: TimerType,
    private interval: number,
    private callback: TickCallback,
    // Largest single delta credited; defaults to two tick intervals.
    maxStep?: number
  ) {
    this.maxStep = maxStep ?? 2 * interval
  }

  // Credit the time since the previous measurement, clamped to [0, maxStep].
  private accrue(): void {
    if (this.lastTick === null) {
      return
    }
    const now = Date.now()
    const delta = now - this.lastTick
    this.lastTick = now
    if (delta > 0) {
      this.elapsed += Math.min(delta, this.maxStep)
    }
  }

  // Update the elapsed time and call the tick callback function
  private updateElapsed(val: number) {
    this.elapsed = val
    this.callback(this.elapsed) // Call the tick callback function with the elapsed time
  }

  // Tick function called by setInterval
  tick() {
    if (this.lastTick === null) {
      return
    }
    this.accrue()
    this.updateElapsed(this.elapsed)
  }

  // Start the timer
  start() {
    if (this.state === TimerState.RUNNING) {
      return
    }
    if (this.state === TimerState.PAUSED) {
      // error condition unexpected
      throw new Error('Cannot start a paused timer, must resume')
    }
    if (this.state !== TimerState.NOT_STARTED) {
      // error condition unexpected
      throw new Error('Cannot start a timer that is not in the NOT_STARTED state')
    }
    this.state = TimerState.RUNNING
    this.lastTick = Date.now()
    this.timerId = setInterval(this.tick.bind(this), this.interval)
  }

  // Stop the timer and reset the elapsed time
  stop() {
    if (this.state === TimerState.NOT_STARTED) {
      return
    }
    if (this.timerId) {
      // Stop the timer
      clearInterval(this.timerId)
    }
    this.timerId = null
    this.lastTick = null
    this.updateElapsed(0)
    this.state = TimerState.NOT_STARTED
  }

  pause() {
    if (this.state === TimerState.PAUSED) {
      return
    }
    if (this.state !== TimerState.RUNNING) {
      throw new Error(`Cannot pause a timer that is not in the RUNNING state. (state = ${this.state})`)
    }
    // Keep the partial interval since the last tick.
    this.accrue()
    this.lastTick = null
    this.state = TimerState.PAUSED
    if (this.timerId === null) {
      throw new Error(`timerId is null but state is ${this.state}`)
    }
    // Stop the timer
    clearInterval(this.timerId)
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
    this.timerId = setInterval(this.tick.bind(this), this.interval)
  }

  // Reset the elapsed time while preserving the running/paused state.
  // A paused timer (e.g. the focus timer on a blurred tab at midnight)
  // must stay paused, otherwise it would silently resume and count
  // non-focus time after the daily reset.
  reset() {
    if (this.state === TimerState.NOT_STARTED) {
      return
    }
    const wasPaused = this.state === TimerState.PAUSED
    this.stop()
    this.start()
    if (wasPaused) {
      this.pause()
    }
  }
}
