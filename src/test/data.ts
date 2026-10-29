// Pure fixtures shared by the tests: local times and stored hour buckets.
import { emptyBuckets, type HourBuckets } from '../core/schema'

// A local time as epoch ms (Date's month is 0-based).
export const at = (...args: [number, number, number, number?, number?, number?]) => new Date(...args).getTime()

// A day's hour buckets: `byHour` maps an hour to its ms, the rest are 0.
export function bucketsOf(byHour: Record<number, number>): HourBuckets {
  const buckets = emptyBuckets()
  for (const [hour, ms] of Object.entries(byHour)) {
    buckets[Number(hour)] = ms
  }
  return buckets
}
