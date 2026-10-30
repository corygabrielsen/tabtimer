// The snoozes taken on one day, and the one rule for what they mean to a
// limit. Pure: no chrome, no DOM. Stored under snoozes:<date>
// (core/schema.ts); only the service worker writes it.
import { isFiniteNumber, isObject } from './guards'
import type { BlockScope } from './limits'
import type { Site } from './site'

// One snooze: the site whose block screen took it, when (epoch ms) and for
// how long (ms), and that site's time and every tracked site's combined
// time today when it began.
export type Snooze = { site: Site; at: number; ms: number; siteMs: number; globalMs: number }

export function normalizeSnoozes(value: unknown): Snooze[] {
  if (!Array.isArray(value)) {
    return []
  }
  const snoozes: Snooze[] = []
  for (const v of value as unknown[]) {
    if (!isObject(v) || typeof v.site !== 'string' || v.site === '') {
      continue
    }
    const { at, ms, siteMs, globalMs } = v
    if (isFiniteNumber(at) && isFiniteNumber(ms) && isFiniteNumber(siteMs) && isFiniteNumber(globalMs)) {
      snoozes.push({
        site: v.site,
        at,
        ms: Math.max(0, ms),
        siteMs: Math.max(0, siteMs),
        globalMs: Math.max(0, globalMs),
      })
    }
  }
  return snoozes.sort((a, b) => a.at - b.at)
}

// The snoozes that count against a limit of `scope` on `site`: for its own
// limit, those its block screen took; for the all-sites limit, every one.
// Each is given as the time it began at, in that limit's measure, oldest
// first.
export function snoozeMarks(snoozes: readonly Snooze[], site: Site, scope: BlockScope): number[] {
  return scope === 'site' ? snoozes.filter((s) => s.site === site).map((s) => s.siteMs) : snoozes.map((s) => s.globalMs)
}

// How many snoozes each site took.
export function snoozeCounts(snoozes: readonly Snooze[]): Record<Site, number> {
  const counts: Record<Site, number> = {}
  for (const { site } of snoozes) {
    counts[site] = (counts[site] ?? 0) + 1
  }
  return counts
}

// The time past `limit` (ms) of `elapsed`, cut where each snooze began
// (`marks`, snoozeMarks): one stretch per snooze, plus any time over before
// the first. Empty stretches are left out; the stretches add up to the time
// over.
export function overSegments(limit: number, elapsed: number, marks: readonly number[]): number[] {
  if (elapsed <= limit) {
    return []
  }
  const cuts = marks.map((m) => Math.min(elapsed, Math.max(limit, m))).sort((a, b) => a - b)
  const points = [limit, ...cuts, elapsed]
  const segments: number[] = []
  for (let i = 1; i < points.length; i++) {
    const ms = points[i]! - points[i - 1]!
    if (ms > 0) {
      segments.push(ms)
    }
  }
  return segments
}
