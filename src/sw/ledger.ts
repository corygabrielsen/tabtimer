// The service worker's writes to chrome.storage.local. It is the only writer:
// pages and content scripts ask for changes by message (core/messages.ts).
//
// Every operation runs in one serial queue, so read-modify-writes from
// different senders (the tracker crediting time, the popup and the options
// page editing limits) can't interleave and lose an update. The queue is the
// only in-memory state, and it is empty whenever the worker is idle.
import {
  creditable,
  normalizeAway,
  observe,
  remember,
  AWAY_KEY,
  MAX_SPAN_AGE_MS,
  type IdleState,
  type Span,
} from '../core/away'
import { dayOf, splitByHour } from '../core/day'
import { applyLimit, normalizeLimits, SNOOZE_MS, type LimitEdit, type Limits } from '../core/limits'
import {
  dayKey,
  defaultState,
  emptyBuckets,
  expiredDayKeys,
  normalizeDay,
  normalizePrefs,
  normalizeSnooze,
  LIMITS_KEY,
  PREFS_KEY,
  SCHEMA,
  SCHEMA_KEY,
  SNOOZE_KEY,
  type DayUsage,
  type Prefs,
} from '../core/schema'
import type { Accrual } from '../core/tracker'
import type { Site } from '../core/site'
import type { Clock, Store } from '../ports'

// storage.session key: the day pruning last ran for.
export const PRUNED_DAY_KEY = 'prunedDay'

// What a transaction (Ledger.transaction) may do: the queued operations'
// bodies, run inside the caller's slot in the queue.
export type Tx = {
  now: number
  // Credit closed intervals, less time away from the computer that
  // pauses them (core/away.ts).
  credit(accruals: Accrual[]): Promise<void>
  // Record a change of chrome.idle state (repeats are harmless): take back
  // time credited since a back-dated idle start.
  observeIdle(next: IdleState): Promise<void>
  idleState(): Promise<IdleState>
  // Today's usage, limits and snooze, as stored.
  today(): Promise<DayUsage>
  limits(): Promise<Limits>
  snoozeUntil(): Promise<number>
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

  // Add (sign 1) or take back (sign -1, never below zero) `spans` of `site`'s
  // time in the day usages in `days`, loading each day on first use.
  async function apply(days: Map<string, DayUsage>, site: Site, spans: Span[], sign: 1 | -1): Promise<void> {
    for (const [start, end] of spans) {
      for (const { day, hour, ms } of splitByHour(start, end)) {
        const key = dayKey(day)
        let usage = days.get(key)
        if (!usage) {
          usage = normalizeDay(await local.get(key))
          days.set(key, usage)
        }
        if (sign === -1 && !usage[site]) {
          continue // reset since: nothing to take back
        }
        const buckets = (usage[site] ??= emptyBuckets())
        buckets[hour] = Math.max(0, (buckets[hour] ?? 0) + sign * ms)
      }
    }
  }

  // Drop day:* keys outside the retention window.
  async function pruneNow(now: number): Promise<void> {
    const stale = expiredDayKeys(Object.keys(await local.getAll()), now)
    if (stale.length > 0) {
      await local.remove(stale)
    }
    await session.set({ [PRUNED_DAY_KEY]: dayOf(now) })
  }

  function tx(now: number): Tx {
    return {
      now,
      credit: async (accruals) => {
        if (accruals.length === 0) {
          return
        }
        let away = normalizeAway(await session.get(AWAY_KEY))
        const days = new Map<string, DayUsage>()
        for (const { site, start, end, media } of accruals) {
          const spans = creditable([[Math.max(start, now - MAX_SPAN_AGE_MS), end]], away.periods, media)
          await apply(days, site, spans, 1)
          away = remember(away, site, spans, media, now)
        }
        await local.set(Object.fromEntries(days))
        await session.set({ [AWAY_KEY]: away })
        // The first write of a new day prunes the days that just expired.
        if ((await session.get(PRUNED_DAY_KEY)) !== dayOf(now)) {
          await pruneNow(now)
        }
      },
      observeIdle: async (next) => {
        const { state, debit } = observe(normalizeAway(await session.get(AWAY_KEY)), next, now)
        const days = new Map<string, DayUsage>()
        for (const c of debit) {
          await apply(days, c.site, [[c.start, c.end]], -1)
        }
        await session.set({ [AWAY_KEY]: state })
        if (days.size > 0) {
          await local.set(Object.fromEntries(days))
        }
      },
      idleState: async () => normalizeAway(await session.get(AWAY_KEY)).state,
      today: async () => normalizeDay(await local.get(dayKey(dayOf(now)))),
      limits: async () => normalizeLimits(await local.get(LIMITS_KEY)),
      snoozeUntil: async () => normalizeSnooze(await local.get(SNOOZE_KEY)),
      resetToday: async (site) => {
        const key = dayKey(dayOf(now))
        const usage = normalizeDay(await local.get(key))
        if (site in usage) {
          delete usage[site]
          await local.set({ [key]: usage })
        }
        // Time already reset can't be taken back again by a later idle.
        const away = normalizeAway(await session.get(AWAY_KEY))
        if (away.recent.some((c) => c.site === site)) {
          await session.set({ [AWAY_KEY]: { ...away, recent: away.recent.filter((c) => c.site !== site) } })
        }
      },
    }
  }

  return {
    // Run `task` in the queue with the operations above (and nothing else
    // in between).
    transaction: <T>(task: (tx: Tx) => Promise<T>): Promise<T> => enqueue(() => task(tx(clock.now()))),

    // If storage is in any layout but this one, clear it and start over.
    // Returns whether it cleared.
    ensureSchema: (): Promise<boolean> =>
      enqueue(async () => {
        if ((await local.get(SCHEMA_KEY)) === SCHEMA) {
          return false
        }
        await local.clear()
        await local.set(defaultState())
        return true
      }),

    prune: (): Promise<void> => enqueue(() => pruneNow(clock.now())),

    setLimit: (edit: LimitEdit): Promise<Limits> =>
      enqueue(async () => {
        const limits = applyLimit(normalizeLimits(await local.get(LIMITS_KEY)), edit)
        await local.set({ [LIMITS_KEY]: limits })
        return limits
      }),

    // Suppress all blocking for SNOOZE_MS of wall-clock time.
    snooze: (): Promise<number> =>
      enqueue(async () => {
        const until = clock.now() + SNOOZE_MS
        await local.set({ [SNOOZE_KEY]: until })
        return until
      }),

    setPrefs: (change: Partial<Prefs>): Promise<Prefs> =>
      enqueue(async () => {
        const prefs = normalizePrefs({ ...normalizePrefs(await local.get(PREFS_KEY)), ...change })
        await local.set({ [PREFS_KEY]: prefs })
        return prefs
      }),
  }
}
