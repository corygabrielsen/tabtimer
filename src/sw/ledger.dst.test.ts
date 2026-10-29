// The ledger's hourly buckets across DST transitions, in a fixed zone. Set
// before any Date is built; each test file runs in its own worker.
;(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = 'America/New_York'

import { describe, it, expect } from 'vitest'
import { createLedger } from './ledger'
import { chromeStore } from '../chrome/store'
import { sumBuckets } from '../core/schema'
import type { Span } from '../core/away'
import { fakeChrome } from '../test/chrome'

const HOUR = 3600_000
const STEP_MS = 10 * 60_000

// A whole local day of active time, credited in 10-minute intervals, each
// when it ends.
async function creditWholeDay(y: number, m: number, d: number): Promise<number[]> {
  const start = new Date(y, m, d).getTime()
  const end = new Date(y, m, d + 1).getTime()
  let now = start
  const ledger = createLedger(chromeStore('local'), chromeStore('session'), { now: () => now })
  for (let t = start; t < end; t += STEP_MS) {
    const span: Span = [t, Math.min(t + STEP_MS, end)]
    now = span[1] - 1
    await ledger.transaction((tx) => tx.credit([{ site: 'a.com', start: span[0], end: span[1], media: false }]))
  }
  const key = `day:${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return (fakeChrome().storage.local.data[key] as Record<string, number[]>)['a.com']!
}

describe('hourly buckets on DST days (America/New_York, 2026)', () => {
  it('fold the repeated hour into one bucket on the 25-hour day', async () => {
    const buckets = await creditWholeDay(2026, 10, 1)
    expect(buckets[1]).toBe(2 * HOUR)
    expect(buckets.filter((ms) => ms === HOUR)).toHaveLength(23)
    expect(sumBuckets(buckets)).toBe(25 * HOUR)
  })

  it('leave the skipped hour empty on the 23-hour day', async () => {
    const buckets = await creditWholeDay(2026, 2, 8)
    expect(buckets[2]).toBe(0)
    expect(buckets.filter((ms) => ms === HOUR)).toHaveLength(23)
    expect(sumBuckets(buckets)).toBe(23 * HOUR)
  })
})
