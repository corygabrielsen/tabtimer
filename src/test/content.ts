// Shared fixtures for content-script tests: a fake clock, the real background
// single-writer, and teardown for FocusTrackers.
import { vi } from 'vitest'
import FocusTracker from '../content/FocusTracker'
import { dayOf } from '../core/day'
import { dayKey, emptyBuckets, normalizeDay, siteTotal } from '../core/schema'
import { siteOf } from '../core/site'
import { fakeChrome } from './chrome'
import { resetPageState } from './dom'

// Wire the real background.ts into the fake browser so FocusTracker's reports land
// in storage exactly as in the extension.
export async function startBackground(): Promise<void> {
  vi.resetModules()
  await import('../sw/background')
}

export function useClock(now: Date): void {
  vi.useFakeTimers({ now })
  resetPageState()
}

const models: FocusTracker[] = []

export function trackTracker(model: FocusTracker): FocusTracker {
  models.push(model)
  return model
}

// Stop a FocusTracker's tick and listeners so it can't keep reporting into a later
// test.
export function disposeTrackers(): void {
  for (const model of models.splice(0)) {
    model.destroy()
  }
}

// The stored day:* key for the local day containing `date`.
export function dayKeyOf(date: Date = new Date()): string {
  return dayKey(dayOf(date.getTime()))
}

// A site's stored time on the day of `date` (default: this page's site today).
export function storedToday(site = siteOf(window.location.hostname), date = new Date()): number {
  return siteTotal(normalizeDay(fakeChrome().storage.local.data[dayKeyOf(date)]), site)
}

// A day:* entry holding sites' time (each in the hour of `date`), for
// seeding storage alongside other keys.
export function dayEntry(sites: Record<string, number>, date = new Date()): Record<string, unknown> {
  const usage: Record<string, number[]> = {}
  for (const [site, ms] of Object.entries(sites)) {
    usage[site] = emptyBuckets()
    usage[site][date.getHours()] = ms
  }
  return { [dayKeyOf(date)]: usage }
}

// Store sites' time for the day of `date` (in that hour's bucket), keeping
// other sites' time that day. Writes like the service worker would.
export function seedToday(sites: Record<string, number>, date = new Date()): void {
  const local = fakeChrome().storage.local
  const key = dayKeyOf(date)
  const usage = normalizeDay(local.data[key])
  for (const [site, ms] of Object.entries(sites)) {
    const buckets = emptyBuckets()
    buckets[date.getHours()] = ms
    usage[site] = buckets
  }
  local.seed({ [key]: usage })
}

export const minutes = (n: number) => n * 60_000
export const seconds = (n: number) => n * 1000

// Timers the page itself runs: every fake timer but the service worker's
// alarms.
export function pageTimers(): number {
  return vi.getTimerCount() - fakeChrome().alarmTimers.size
}
