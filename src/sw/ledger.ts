// The service worker's writes to chrome.storage.local. It is the only writer:
// pages and content scripts ask for changes by message (core/messages.ts).
//
// Every operation runs in one serial queue, so read-modify-writes from
// different senders (two tabs reporting time, the popup and the options page
// editing limits) can't interleave and lose an update. The queue is the only
// in-memory state, and it is empty whenever the worker is idle.
import { creditable, normalizeAway, observe, remember, AWAY_KEY, type IdleState } from '../core/away'
import { dayOf, splitByHour } from '../core/day'
import { applyLimit, normalizeLimits, SNOOZE_MS, type LimitEdit, type Limits } from '../core/limits'
import {
  dayKey,
  defaultState,
  emptyBuckets,
  expiredDayKeys,
  normalizeDay,
  normalizePrefs,
  siteTotal,
  IDLE_STATE_KEY,
  LIMITS_KEY,
  PREFS_KEY,
  SCHEMA,
  SCHEMA_KEY,
  SNOOZE_KEY,
  type DayUsage,
  type Prefs,
} from '../core/schema'
import type { Span } from '../core/messages'
import type { Site } from '../core/site'
import type { Clock, Store } from '../ports'

// storage.session key: the day pruning last ran for.
export const PRUNED_DAY_KEY = 'prunedDay'

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

  return {
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

    // Credit spans of active time to `site`, split into local days and
    // hours, less any time away from the computer that pauses them
    // (core/away.ts; `media`: the page is playing audio or video). Returns
    // the site's total for today.
    addElapsed: (site: Site, spans: Span[], media = false): Promise<number> =>
      enqueue(async () => {
        const now = clock.now()
        const away = normalizeAway(await session.get(AWAY_KEY))
        const credited = creditable(spans, away.periods, media)
        const days = new Map<string, DayUsage>()
        await apply(days, site, credited, 1)
        await local.set(Object.fromEntries(days))
        await session.set({ [AWAY_KEY]: remember(away, site, credited, media, now) })
        // The first write of a new day prunes the days that just expired.
        if ((await session.get(PRUNED_DAY_KEY)) !== dayOf(now)) {
          await pruneNow(now)
        }
        const today = dayKey(dayOf(now))
        return siteTotal(days.get(today) ?? normalizeDay(await local.get(today)), site)
      }),

    // Record a change of chrome.idle state (repeats are harmless): take back
    // time credited since a back-dated idle start, and mirror the state to
    // storage.local for content scripts.
    setIdleState: (next: IdleState): Promise<void> =>
      enqueue(async () => {
        const { state, debit } = observe(normalizeAway(await session.get(AWAY_KEY)), next, clock.now())
        const days = new Map<string, DayUsage>()
        for (const c of debit) {
          await apply(days, c.site, [[c.start, c.end]], -1)
        }
        // The period is recorded before content scripts hear of it, so the
        // time they flush in response is already trimmed.
        await session.set({ [AWAY_KEY]: state })
        await local.set({ ...Object.fromEntries(days), [IDLE_STATE_KEY]: next })
      }),

    // Zero one site's time for today.
    resetToday: (site: Site): Promise<null> =>
      enqueue(async () => {
        const key = dayKey(dayOf(clock.now()))
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
        return null
      }),

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
