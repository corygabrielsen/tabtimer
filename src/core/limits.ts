// Pure (no chrome, no DOM). Stored under LIMITS_KEY (core/schema.ts); only
// the service worker writes it, through applyLimit.
import { isFiniteNumber, isObject } from './guards'

// Daily time limits (all values in milliseconds, matching the stored "today"
// focus totals). null / absent means no limit.
export type Limits = {
  global: number | null
  perSite: Record<string, number>
}

export const DEFAULT_LIMITS: Limits = { global: null, perSite: {} }

export const SNOOZE_MS = 5 * 60 * 1000

export type BlockScope = 'site' | 'global'
export type BlockReason = { scope: BlockScope; limit: number; elapsed: number }

// Pure: is this site over an applicable limit right now? Per-site wins over
// global when both trip, so the message names the tighter cause.
export function evaluateLimits(
  limits: Limits,
  host: string,
  siteToday: number,
  globalToday: number
): BlockReason | null {
  const site = limits.perSite[host]
  if (typeof site === 'number' && site > 0 && siteToday >= site) {
    return { scope: 'site', limit: site, elapsed: siteToday }
  }
  if (typeof limits.global === 'number' && limits.global > 0 && globalToday >= limits.global) {
    return { scope: 'global', limit: limits.global, elapsed: globalToday }
  }
  return null
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
  running: boolean,
  snoozeUntil: number
): BlockAt | null {
  const candidates: Array<{ scope: BlockScope; limit: number; left: number }> = []
  const siteLimit = limits.perSite[site]
  if (typeof siteLimit === 'number' && siteLimit > 0) {
    candidates.push({ scope: 'site', limit: siteLimit, left: Math.max(0, siteLimit - siteToday) })
  }
  if (typeof limits.global === 'number' && limits.global > 0) {
    candidates.push({ scope: 'global', limit: limits.global, left: Math.max(0, limits.global - globalToday) })
  }
  // Earliest first; the per-site limit wins a tie (it names the cause).
  const first = candidates.sort((a, b) => a.left - b.left)[0]
  if (!first || (first.left > 0 && !running)) {
    return null
  }
  return { at: Math.max(now + first.left, snoozeUntil), scope: first.scope, limit: first.limit }
}

const isLimit = (v: unknown): v is number => isFiniteNumber(v) && v > 0

export function normalizeLimits(value: unknown): Limits {
  const l = (value ?? {}) as Partial<Limits>
  const perSite: Record<string, number> = {}
  if (isObject(l.perSite)) {
    for (const [site, ms] of Object.entries(l.perSite)) {
      if (isLimit(ms)) {
        perSite[site] = ms
      }
    }
  }
  return { global: isLimit(l.global) ? l.global : null, perSite }
}

// One limit edit: the all-sites cap, or one site's limit (null = no limit).
export type LimitEdit = { scope: 'global'; ms: number | null } | { scope: 'site'; site: string; ms: number | null }

// `limits` with one edit applied; every other limit is kept as is.
export function applyLimit(limits: Limits, edit: LimitEdit): Limits {
  if (edit.scope === 'global') {
    return { ...limits, global: edit.ms }
  }
  const perSite = { ...limits.perSite }
  if (edit.ms === null) {
    delete perSite[edit.site]
  } else {
    perSite[edit.site] = edit.ms
  }
  return { ...limits, perSite }
}

export function minutesToMs(minutes: number): number {
  return Math.round(minutes * 60000)
}

export function msToMinutes(ms: number): number {
  return Math.round(ms / 60000)
}

// Parse a minutes field into ms, or null for blank/invalid (= no limit).
export function parseLimitMinutes(value: string): number | null {
  const n = Number(value.trim())
  return Number.isFinite(n) && n > 0 ? minutesToMs(Math.floor(n)) : null
}
