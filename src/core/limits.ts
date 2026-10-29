// Pure (no chrome, no DOM). Stored under LIMITS_KEY (core/schema.ts); only
// the service worker writes it, through applyLimit.

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

const isLimit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

export function normalizeLimits(value: unknown): Limits {
  const l = (value ?? {}) as Partial<Limits>
  const perSite: Record<string, number> = {}
  if (l.perSite && typeof l.perSite === 'object') {
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
