import { chromeStore } from './chrome/store'
import { dayOf } from './core/day'
import { BLOCK_SNOOZE_KEY, DEFAULT_LIMITS, LIMITS_KEY, SNOOZE_MS, normalizeLimits, type Limits } from './core/limits'

// chrome.storage.local, where every key below lives.
export const local = chromeStore('local')

export const ELAPSED_KEY_PREFIX = 'focusTimer_elapsed_today'

// Global preference: when true, the on-page overlay is hidden everywhere.
// Toggled from the popup and by the overlay's own close control.
export const HIDDEN_KEY = 'tabtimer_hidden'

// Global preference: overlay zoom factor (1 = default), adjustable from the
// overlay's own size controls.
export const SCALE_KEY = 'tabtimer_scale'

// Collapse a hostname to an approximate registrable domain by keeping the
// last two labels (so old.reddit.com and www.reddit.com share one counter).
// NOTE: this is wrong for multi-label public suffixes such as `foo.co.uk`
// (collapses to `co.uk`); none of the currently tracked hosts hit that.
export function baseHost(hostname: string): string {
  const parts = hostname.split('.')
  while (parts.length > 2) {
    parts.shift()
  }
  return parts.join('.')
}

export function baseKeyForHost(hostname: string): string {
  return `${ELAPSED_KEY_PREFIX}_${baseHost(hostname)}`
}

export function todayKeyForHost(hostname: string, date: Date = new Date()): string {
  return `${baseKeyForHost(hostname)}_${dayOf(date.getTime())}`
}

// Is `key` some tracked site's daily focus-time key for `date`? The global
// daily total is the sum of every such key.
export function isElapsedKeyForDay(key: string, date: Date): boolean {
  return key.startsWith(`${ELAPSED_KEY_PREFIX}_`) && key.endsWith(`_${dayOf(date.getTime())}`)
}

// Sum today's stored focus time across every tracked host (the global daily
// total). Excludes in-flight, not-yet-flushed deltas, so it can lag a live
// counter by a few seconds — fine for a minute-scale limit.
export async function readGlobalElapsedToday(date: Date = new Date()): Promise<number> {
  const items = await local.getAll().catch(() => ({}) as Record<string, unknown>)
  let total = 0
  for (const [key, value] of Object.entries(items)) {
    if (isElapsedKeyForDay(key, date) && typeof value === 'number') {
      total += value
    }
  }
  return total
}

export function readLimits(): Promise<Limits> {
  return local
    .get(LIMITS_KEY)
    .then(normalizeLimits)
    .catch(() => DEFAULT_LIMITS)
}

function writeLimits(limits: Limits): Promise<void> {
  return local.set({ [LIMITS_KEY]: limits }).catch(() => undefined)
}

export async function setGlobalLimit(ms: number | null): Promise<void> {
  const limits = await readLimits()
  await writeLimits({ ...limits, global: ms })
}

export async function setPerSiteLimit(host: string, ms: number | null): Promise<void> {
  const limits = await readLimits()
  const perSite = { ...limits.perSite }
  if (ms === null) {
    delete perSite[host]
  } else {
    perSite[host] = ms
  }
  await writeLimits({ ...limits, perSite })
}

export function readSnoozeUntil(): Promise<number> {
  return local
    .get<number>(BLOCK_SNOOZE_KEY)
    .then((v) => v ?? 0)
    .catch(() => 0)
}

// Suppress all blocking for SNOOZE_MS of wall-clock time.
export function snoozeBlocking(): Promise<void> {
  return local.set({ [BLOCK_SNOOZE_KEY]: Date.now() + SNOOZE_MS }).catch(() => undefined)
}
