// Pure (no chrome, no DOM); reading and writing limits lives in src/storage.ts.

// Daily time limits (all values in milliseconds, matching the stored "today"
// focus totals). null / absent means no limit.
export type Limits = {
  global: number | null
  perSite: Record<string, number>
}

export const DEFAULT_LIMITS: Limits = { global: null, perSite: {} }

export const LIMITS_KEY = 'tabtimer_limits'
export const BLOCK_SNOOZE_KEY = 'tabtimer_block_snooze_until'
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

export function normalizeLimits(value: unknown): Limits {
  const l = (value ?? {}) as Partial<Limits>
  return {
    global: typeof l.global === 'number' && l.global > 0 ? l.global : null,
    perSite: l.perSite && typeof l.perSite === 'object' ? (l.perSite as Record<string, number>) : {},
  }
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
