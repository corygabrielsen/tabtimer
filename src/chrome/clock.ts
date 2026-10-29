import type { Clock } from '../ports'

// The wall clock (Date.now, so fake timers in tests drive it too).
export const systemClock: Clock = {
  now: () => Date.now(),
}
