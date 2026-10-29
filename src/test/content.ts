// Shared fixtures for content-script tests: a fake clock, the real background
// single-writer, and teardown for FocusTrackers.
import { vi } from 'vitest'
import FocusTracker from '../content/FocusTracker'
import { dayOf } from '../core/day'
import { DEFAULT_LIMITS, type Limits } from '../core/limits'
import { dayKey, normalizeDay, siteTotal, LIMITS_KEY, type DayUsage } from '../core/schema'
import { siteOf } from '../core/site'
import { fakeChrome } from './chrome'
import { bucketsOf } from './data'
import { resetPageState } from './dom'

// Wire the real background.ts into the fake browser so FocusTracker's reports land
// in storage exactly as in the extension, with `granted` (if given) as the
// grants.
export async function startBackground(granted?: string[]): Promise<void> {
  if (granted) {
    fakeChrome().granted = new Set(granted)
  }
  vi.resetModules()
  await import('../sw/background')
}

export function useClock(now: Date): void {
  vi.useFakeTimers({ now })
  resetPageState()
}

const trackers: FocusTracker[] = []

export function trackTracker(tracker: FocusTracker): FocusTracker {
  trackers.push(tracker)
  return tracker
}

// Stop a FocusTracker's tick and listeners so it can't keep reporting into a later
// test.
export function disposeTrackers(): void {
  for (const tracker of trackers.splice(0)) {
    tracker.destroy()
  }
}

// The grant a page's script runs under in the content tests.
export const EVERY_HOST = ['*://*/*']

// Store limits (in minutes); anything not given is at its default.
export function seedLimits(limits: Partial<Limits>): void {
  fakeChrome().storage.local.seed({ [LIMITS_KEY]: { ...DEFAULT_LIMITS, ...limits } })
}

// Whether the block screen is up.
export const isBlocked = () => document.getElementById('tabtimer-block')?.style.getPropertyValue('display') === 'block'

// The stored day:* key for the local day containing `date`.
export function dayKeyOf(date: Date = new Date()): string {
  return dayKey(dayOf(date.getTime()))
}

// A site's stored time on the day of `date` (default: this page's site today).
export function storedToday(site = siteOf(window.location.hostname), date = new Date()): number {
  return siteTotal(normalizeDay(fakeChrome().storage.local.data[dayKeyOf(date)]), site)
}

// Sites' time, each in the hour of `date`.
function usageOf(sites: Record<string, number>, date: Date): DayUsage {
  return Object.fromEntries(Object.entries(sites).map(([site, ms]) => [site, bucketsOf({ [date.getHours()]: ms })]))
}

// A day:* entry holding sites' time (each in the hour of `date`), for
// seeding storage alongside other keys.
export function dayEntry(sites: Record<string, number>, date = new Date()): Record<string, unknown> {
  return { [dayKeyOf(date)]: usageOf(sites, date) }
}

// Store sites' time for the day of `date` (in that hour's bucket), keeping
// other sites' time that day. Writes like the service worker would.
export function seedToday(sites: Record<string, number>, date = new Date()): void {
  const local = fakeChrome().storage.local
  const key = dayKeyOf(date)
  local.seed({ [key]: { ...normalizeDay(local.data[key]), ...usageOf(sites, date) } })
}

export const minutes = (n: number) => n * 60_000
export const seconds = (n: number) => n * 1000

// Timers the page itself runs: every fake timer but the service worker's
// alarms.
export function pageTimers(): number {
  return vi.getTimerCount() - fakeChrome().alarmTimers.size
}
