// Pure (no chrome, no DOM). Stored under LIMITS_KEY (core/schema.ts); only
// the service worker writes it, through applyLimit and the snooze.
import { isFiniteNumber, isObject } from './guards'

// Daily time limits, in whole minutes (what the pickers set). null / absent
// means no limit. limitsFor is the one place they become ms, the unit of the
// daily time they are measured against (DayUsage).
export type Limits = {
  global: number | null
  perSite: Record<string, number>
  // Epoch ms; blocking is suppressed until then.
  snoozeUntil: number
}

export const DEFAULT_LIMITS: Limits = { global: null, perSite: {}, snoozeUntil: 0 }

// The range a limit can be set to, in minutes.
export const MIN_LIMIT_MINUTES = 1
export const MAX_LIMIT_MINUTES = 1440

export const SNOOZE_MS = 2 * 60 * 1000

// The snooze's end as of `now` (0: none). One ending more than SNOOZE_MS
// after `now` was set before the clock went back: it is void.
export function snoozeOf(limits: Limits, now: number): number {
  return limits.snoozeUntil - now > SNOOZE_MS ? 0 : limits.snoozeUntil
}

export type BlockScope = 'site' | 'global'
export type BlockReason = { scope: BlockScope; limit: number; elapsed: number }

export function minutesToMs(minutes: number): number {
  return Math.round(minutes * 60000)
}

export function msToMinutes(ms: number): number {
  return Math.round(ms / 60000)
}

// `site`'s own limit, in minutes (null: none).
export function siteLimitOf(limits: Limits, site: string): number | null {
  return limits.perSite[site] ?? null
}

// The limits `site`'s time is measured against, in ms (null: none).
export function limitsFor(limits: Limits, site: string): { site: number | null; global: number | null } {
  const ms = (minutes: number | null) => (minutes === null ? null : minutesToMs(minutes))
  return { site: ms(siteLimitOf(limits, site)), global: ms(limits.global) }
}

// The limit a site's time is measured against, and when it is reached.
export type BlockAt = { at: number; scope: BlockScope; limit: number }

// When this site's page must block, as of `now`: the moment the tighter of
// its own limit and the all-sites cap is reached if it keeps accruing
// (`running`), or `now` if it is already over (null: not before something
// changes). A snooze running past that moment moves it to the snooze's end.
export function blockAt(
  limits: Limits,
  site: string,
  siteToday: number,
  globalToday: number,
  now: number,
  running: boolean
): BlockAt | null {
  const ms = limitsFor(limits, site)
  const candidates: Array<{ scope: BlockScope; limit: number; left: number }> = []
  if (ms.site !== null) {
    candidates.push({ scope: 'site', limit: ms.site, left: Math.max(0, ms.site - siteToday) })
  }
  if (ms.global !== null) {
    candidates.push({ scope: 'global', limit: ms.global, left: Math.max(0, ms.global - globalToday) })
  }
  // Earliest first; the per-site limit wins a tie (it names the cause).
  const first = candidates.sort((a, b) => a.left - b.left)[0]
  if (!first || (first.left > 0 && !running)) {
    return null
  }
  return { at: Math.max(now + first.left, snoozeOf(limits, now)), scope: first.scope, limit: first.limit }
}

const isLimit = (v: unknown): v is number => isFiniteNumber(v) && v > 0

export function normalizeLimits(value: unknown): Limits {
  const l = (value ?? {}) as Partial<Limits>
  const perSite: Record<string, number> = {}
  if (isObject(l.perSite)) {
    for (const [site, minutes] of Object.entries(l.perSite)) {
      if (isLimit(minutes)) {
        perSite[site] = minutes
      }
    }
  }
  return {
    global: isLimit(l.global) ? l.global : null,
    perSite,
    snoozeUntil: isFiniteNumber(l.snoozeUntil) ? l.snoozeUntil : 0,
  }
}

// One limit edit: the all-sites cap, or one site's limit (null = no limit).
export type LimitEdit =
  { scope: 'global'; minutes: number | null } | { scope: 'site'; site: string; minutes: number | null }

// `limits` with one edit applied; every other limit is kept as is.
export function applyLimit(limits: Limits, edit: LimitEdit): Limits {
  if (edit.scope === 'global') {
    return { ...limits, global: edit.minutes }
  }
  const perSite = { ...limits.perSite }
  if (edit.minutes === null) {
    delete perSite[edit.site]
  } else {
    perSite[edit.site] = edit.minutes
  }
  return { ...limits, perSite }
}
