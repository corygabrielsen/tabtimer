// The service worker's writes to chrome.storage.local. It is the only writer:
// pages and content scripts ask for changes by message (core/messages.ts).
//
// Every operation runs in one serial queue, so read-modify-writes from
// different senders (the tracker crediting time, the popup and the options
// page editing limits) can't interleave and lose an update. The queue is the
// only in-memory state, and it is empty whenever the worker is idle.
import { creditable, normalizeAway, observe, remember, MAX_SPAN_AGE_MS, type IdleState, type Span } from '../core/away'
import { dayOf, splitByHour } from '../core/day'
import { applyLimit, normalizeLimits, SNOOZE_MS, type LimitEdit, type Limits } from '../core/limits'
import {
  dayKey,
  emptyBuckets,
  expiredDayKeys,
  normalizeDay,
  normalizePrefs,
  LIMITS_KEY,
  PREFS_KEY,
  SCHEMA,
  SCHEMA_KEY,
  type DayUsage,
  type Prefs,
} from '../core/schema'
import { normalizeTracker, type Accrual, type TrackerState } from '../core/tracker'
import type { Site } from '../core/site'
import type { Clock, Store } from '../ports'

// storage.session key: the worker's state between events ({ tracker, away }),
// read once at the start of a transaction and written once at its end.
export const WORKER_KEY = 'worker'

// What a transaction (Ledger.transaction) may do: the queued operations'
// bodies, run inside the caller's slot in the queue. Nothing is written
// until the transaction's task has finished.
export type Tx = {
  now: number
  // The tracker's state (core/tracker.ts), saved as the transaction ends.
  tracker: TrackerState
  // Credit closed intervals, less time away from the computer that
  // pauses them (core/away.ts).
  credit(accruals: Accrual[]): Promise<void>
  // Record a change of chrome.idle state (repeats are harmless): take back
  // time credited since a back-dated idle start.
  observeIdle(next: IdleState): Promise<void>
  idleState(): IdleState
  // Today's usage, and the limits (the snooze included), as of this
  // transaction.
  today(): Promise<DayUsage>
  limits(): Promise<Limits>
  // Zero one site's time for today.
  resetToday(site: Site): Promise<void>
}

export type Ledger = ReturnType<typeof createLedger>

export function createLedger(local: Store, session: Store, clock: Clock) {
  let chain: Promise<unknown> = Promise.resolve()

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = chain.then(task, task)
    // A failed task must not wedge the queue or fail the next one.
    chain = result.catch(() => undefined)
    return result
  }

  // Drop day:* keys outside the retention window.
  async function pruneNow(now: number): Promise<void> {
    const stale = expiredDayKeys(await local.keys(), now)
    if (stale.length > 0) {
      await local.remove(stale)
    }
  }

  async function run<T>(task: (tx: Tx) => Promise<T>): Promise<T> {
    const now = clock.now()
    const todayKey = dayKey(dayOf(now))
    const stored = (await session.get<Partial<Record<'tracker' | 'away', unknown>>>(WORKER_KEY)) ?? {}
    let away = normalizeAway(stored.away)
    // The day usages read so far, and those changed; whether today's is new.
    const days = new Map<string, DayUsage>()
    const changed = new Set<string>()
    let created = false

    async function day(key: string): Promise<DayUsage> {
      let usage = days.get(key)
      if (!usage) {
        const value = await local.get(key)
        created ||= key === todayKey && value === undefined
        usage = normalizeDay(value)
        days.set(key, usage)
      }
      return usage
    }

    // Add (sign 1) or take back (sign -1, never below zero) `spans` of
    // `site`'s time.
    async function apply(site: Site, spans: Span[], sign: 1 | -1): Promise<void> {
      for (const [start, end] of spans) {
        for (const { day: stamp, hour, ms } of splitByHour(start, end)) {
          const key = dayKey(stamp)
          const usage = await day(key)
          if (sign === -1 && !usage[site]) {
            continue // reset since: nothing to take back
          }
          const buckets = (usage[site] ??= emptyBuckets())
          buckets[hour] = Math.max(0, (buckets[hour] ?? 0) + sign * ms)
          changed.add(key)
        }
      }
    }

    const tx: Tx = {
      now,
      tracker: normalizeTracker(stored.tracker),
      credit: async (accruals) => {
        for (const { site, start, end, media } of accruals) {
          const spans = creditable([[Math.max(start, now - MAX_SPAN_AGE_MS), end]], away.periods, media)
          await apply(site, spans, 1)
          away = remember(away, site, spans, media, now)
        }
      },
      observeIdle: async (next) => {
        const { state, debit } = observe(away, next, now)
        for (const c of debit) {
          await apply(c.site, [[c.start, c.end]], -1)
        }
        away = state
      },
      idleState: () => away.state,
      today: () => day(todayKey),
      limits: async () => normalizeLimits(await local.get(LIMITS_KEY)),
      resetToday: async (site) => {
        const usage = await day(todayKey)
        if (site in usage) {
          delete usage[site]
          changed.add(todayKey)
        }
        // Time already reset can't be taken back again by a later idle.
        away = { ...away, recent: away.recent.filter((c) => c.site !== site) }
      },
    }

    const result = await task(tx)
    await Promise.all([
      session.set({ [WORKER_KEY]: { tracker: tx.tracker, away } }),
      changed.size > 0 ? local.set(Object.fromEntries([...changed].map((key) => [key, days.get(key)]))) : null,
    ])
    // The first write of a new day prunes the days that just expired.
    if (created && changed.has(todayKey)) {
      await pruneNow(now)
    }
    return result
  }

  return {
    // Run `task` in the queue with the operations above (and nothing else
    // in between).
    transaction: <T>(task: (tx: Tx) => Promise<T>): Promise<T> => enqueue(() => run(task)),

    // If storage is in any layout but this one, clear it and start over
    // (every reader falls back to the defaults).
    ensureSchema: (): Promise<void> =>
      enqueue(async () => {
        if ((await local.get(SCHEMA_KEY)) !== SCHEMA) {
          await local.clear()
          await local.set({ [SCHEMA_KEY]: SCHEMA })
        }
      }),

    prune: (): Promise<void> => enqueue(() => pruneNow(clock.now())),

    setLimit: (edit: LimitEdit): Promise<void> =>
      enqueue(async () => {
        await local.set({ [LIMITS_KEY]: applyLimit(normalizeLimits(await local.get(LIMITS_KEY)), edit) })
      }),

    // Suppress all blocking for SNOOZE_MS of wall-clock time.
    snooze: (): Promise<void> =>
      enqueue(async () => {
        const snoozeUntil = clock.now() + SNOOZE_MS
        await local.set({ [LIMITS_KEY]: { ...normalizeLimits(await local.get(LIMITS_KEY)), snoozeUntil } })
      }),

    setPrefs: (change: Partial<Prefs>): Promise<void> =>
      enqueue(async () => {
        await local.set({ [PREFS_KEY]: normalizePrefs({ ...normalizePrefs(await local.get(PREFS_KEY)), ...change }) })
      }),
  }
}
