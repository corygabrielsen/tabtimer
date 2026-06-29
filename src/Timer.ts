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

// Timer class encapsulates the timer logic
export default class Timer {
  private timerId: number | null = null
  private startTime: number | null = null
  private pauseTime: number | null = null
  private elapsedPause: number = 0
  public elapsed: number = 0
  public state: TimerState = TimerState.NOT_STARTED

  constructor(
    public type: TimerType,
    private interval: number,
    private callback: TickCallback
  ) {}

  // Update the elapsed time and call the tick callback function
  private updateElapsed(val: number) {
    this.elapsed = val
    this.callback(this.elapsed) // Call the tick callback function with the elapsed time
  }

  // Tick function called by setInterval
  tick() {
    if (this.startTime === null) {
      return
    }
    // const before = this.elapsed
    this.updateElapsed(Date.now() - this.startTime - this.elapsedPause)
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
    this.startTime = Date.now()
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
    this.startTime = null
    this.updateElapsed(0)
    this.pauseTime = null
    this.elapsedPause = 0
    this.state = TimerState.NOT_STARTED
  }

  pause() {
    if (this.state === TimerState.PAUSED) {
      return
    }
    if (this.state !== TimerState.RUNNING) {
      throw new Error(`Cannot pause a timer that is not in the RUNNING state. (state = ${this.state})`)
    }
    this.state = TimerState.PAUSED
    this.pauseTime = Date.now()
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
    if (this.pauseTime === null) {
      throw new Error(`pauseTime is null but state is ${this.state}`)
    }
    this.state = TimerState.RUNNING
    this.elapsedPause += Date.now() - this.pauseTime
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
