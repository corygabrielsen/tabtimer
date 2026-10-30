// The service worker's writes to chrome.storage.local. It is the only writer:
// pages and content scripts ask for changes by message (core/messages.ts).
//
// Every operation runs in one serial queue, so read-modify-writes from
// different senders (the tracker crediting time, the popup and the options
// page editing limits) can't interleave and lose an update. The queue is the
// only in-memory state, and it is empty whenever the worker is idle.
import {
  asOf,
  creditable,
  normalizeAway,
  observe,
  remember,
  MAX_SPAN_AGE_MS,
  type IdleState,
  type Span,
} from '../core/away'
import { dayOf, isDayStamp, splitByHour, type DayStamp } from '../core/day'
import { applyLimit, normalizeLimits, snoozeOf, SNOOZE_MS, type LimitEdit, type Limits } from '../core/limits'
import {
  dayKey,
  dayOfKey,
  emptyBuckets,
  expiredDayKeys,
  normalizeDay,
  normalizeClock,
  normalizePrefs,
  settleClock,
  snoozeKey,
  CLOCK_KEY,
  LIMITS_KEY,
  PREFS_KEY,
  SCHEMA,
  SCHEMA_KEY,
  type ClockMark,
  type DayUsage,
  type Prefs,
} from '../core/schema'
import { isFiniteNumber } from '../core/guards'
import { serial } from '../core/serial'
import { normalizeSnoozes, type Snooze } from '../core/snooze'
import { normalizeTracker, type Accrual, type TrackerState } from '../core/tracker'
import type { Site } from '../core/site'
import type { Clock, Store } from '../ports'

// storage.session key: the worker's state between events ({ tracker, away,
// day, seq }), read once at the start of a transaction and written once at
// its end. `day`: the day storage was last pruned for; `seq`: the last
// transaction's number.
export const WORKER_KEY = 'worker'

// What a transaction (Ledger.transaction) may do: the queued operations'
// bodies, run inside the caller's slot in the queue. Nothing is written
// until the transaction's task has finished.
export type Tx = {
  now: number
  // This transaction's number: one more than the last one's.
  seq: number
  // The tracker's state (core/tracker.ts), saved as the transaction ends.
  tracker: TrackerState
  // Credit closed intervals, less time away from the computer that
  // pauses them (core/away.ts).
  credit(accruals: Accrual[]): Promise<void>
  // Record a change of chrome.idle state (repeats are harmless): take back
  // time credited since a back-dated idle start.
  observeIdle(next: IdleState): Promise<void>
  idleState(): IdleState
  // Today's usage, the limits (the snooze included) and the overlay
  // preferences, as of this transaction.
  today(): Promise<DayUsage>
  limits(): Promise<Limits>
  prefs(): Promise<Prefs>
  // Today's snoozes, oldest first.
  snoozes(): Promise<Snooze[]>
  // Suppress all blocking for SNOOZE_MS from now, and record the snooze
  // (`taken`: who took it, and the times when it began).
  snooze(taken: Pick<Snooze, 'site' | 'siteMs' | 'globalMs'>): Promise<void>
}

export type Ledger = ReturnType<typeof createLedger>

export function createLedger(local: Store, session: Store, clock: Clock) {
  const enqueue = serial()

  // The stored clock mark, settled for `now` (settleClock): pruning goes
  // ahead only for a trusted date.
  async function checkClock(now: number): Promise<{ mark: ClockMark; next: ClockMark; trusted: boolean }> {
    let mark = normalizeClock(await local.get(CLOCK_KEY))
    if (mark.day === null && mark.pending === null) {
      // No mark yet: the newest day of usage stands in (today, with none).
      const days = (await local.keys()).map(dayOfKey).filter((day) => day !== null)
      mark = { day: days.sort().at(-1) ?? dayOf(now), pending: null }
    }
    const next = settleClock(mark, now)
    return { mark, next, trusted: next.day === dayOf(now) }
  }

  // Drop day:* keys outside the retention window (`last`: see
  // expiredDayKeys).
  async function pruneNow(now: number, last: DayStamp | null): Promise<void> {
    const stale = expiredDayKeys(await local.keys(), now, last)
    if (stale.length > 0) {
      await local.remove(stale)
    }
  }

  async function run<T>(task: (tx: Tx) => Promise<T>): Promise<T> {
    const now = clock.now()
    const today = dayOf(now)
    const todayKey = dayKey(today)
    const stored = (await session.get<Partial<Record<'tracker' | 'away' | 'day' | 'seq', unknown>>>(WORKER_KEY)) ?? {}
    const seq = (isFiniteNumber(stored.seq) ? stored.seq : 0) + 1
    // The first transaction of another day (the date moved on, or the clock
    // went back), and every one until that date is trusted, checks the clock.
    const pruned = isDayStamp(stored.day) ? stored.day : null
    const clockCheck = pruned === today ? null : await checkClock(now)
    let away = asOf(normalizeAway(stored.away), now)
    // The day usages read so far, and those changed.
    const days = new Map<string, DayUsage>()
    const changed = new Set<string>()
    // The limits to write back: a void snooze cleared, or a new one.
    let newLimits: Limits | null = null
    // Today's snoozes as read, and whether they changed.
    let snoozed: Snooze[] | null = null
    let snoozedChanged = false
    const todaySnoozes = async (): Promise<Snooze[]> =>
      (snoozed ??= normalizeSnoozes(await local.get(snoozeKey(today))))

    async function day(key: string): Promise<DayUsage> {
      let usage = days.get(key)
      if (!usage) {
        usage = normalizeDay(await local.get(key))
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
            continue // no longer stored: nothing to take back
          }
          const buckets = (usage[site] ??= emptyBuckets())
          buckets[hour] = Math.max(0, (buckets[hour] ?? 0) + sign * ms)
          changed.add(key)
        }
      }
    }

    const tx: Tx = {
      now,
      seq,
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
      limits: async () => {
        if (newLimits) {
          return newLimits
        }
        const limits = normalizeLimits(await local.get(LIMITS_KEY))
        if (snoozeOf(limits, now) !== limits.snoozeUntil) {
          newLimits = { ...limits, snoozeUntil: 0 }
          return newLimits
        }
        return limits
      },
      snoozes: todaySnoozes,
      snooze: async (taken) => {
        newLimits = { ...(await tx.limits()), snoozeUntil: now + SNOOZE_MS }
        snoozed = [...(await todaySnoozes()), { ...taken, at: now, ms: SNOOZE_MS }]
        snoozedChanged = true
      },
      prefs: async () => normalizePrefs(await local.get(PREFS_KEY)),
    }

    const result = await task(tx)
    const writes: Record<string, unknown> = Object.fromEntries([...changed].map((key) => [key, days.get(key)]))
    if (newLimits) {
      writes[LIMITS_KEY] = newLimits
    }
    if (snoozedChanged) {
      writes[snoozeKey(today)] = snoozed
    }
    if (clockCheck && clockCheck.next !== clockCheck.mark) {
      writes[CLOCK_KEY] = clockCheck.next
    }
    const trusted = clockCheck?.trusted ? clockCheck : null
    // The worker's state first: it moves the open interval's mark past the
    // time credited. A commit that fails between the two writes loses that
    // time; the other order would credit it again in the next transaction.
    await session.set({ [WORKER_KEY]: { tracker: tx.tracker, away, day: trusted ? today : pruned, seq } })
    if (Object.keys(writes).length > 0) {
      await local.set(writes)
    }
    // Then the days now outside the window go.
    if (trusted) {
      await pruneNow(now, trusted.mark.day)
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

    // Prune for today, if its date is trusted (install and startup).
    prune: (): Promise<void> =>
      enqueue(async () => {
        const now = clock.now()
        const { mark, next, trusted } = await checkClock(now)
        if (next !== mark) {
          await local.set({ [CLOCK_KEY]: next })
        }
        if (trusted) {
          await pruneNow(now, mark.day)
        }
      }),

    setLimit: (edit: LimitEdit): Promise<void> =>
      enqueue(async () => {
        await local.set({ [LIMITS_KEY]: applyLimit(normalizeLimits(await local.get(LIMITS_KEY)), edit) })
      }),

    setPrefs: (change: Partial<Prefs>): Promise<void> =>
      enqueue(async () => {
        await local.set({ [PREFS_KEY]: normalizePrefs({ ...normalizePrefs(await local.get(PREFS_KEY)), ...change }) })
      }),
  }
}
