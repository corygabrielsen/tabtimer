import { describe, it, expect } from 'vitest'
import type { BlockReason } from './limits'
import {
  hoursAt,
  latestTotals,
  overAt,
  parsePresence,
  parseStatePush,
  PROJECT_MS,
  siteOverAt,
  siteTodayAt,
  totalsAt,
  SENDERS,
  type TabState,
  type TodayTotals,
} from './messages'
import { SUSPEND_GAP_MS } from './tracker'

const PRESENT = { visible: true, focused: true, media: false, blocked: false }

describe('parsePresence', () => {
  it('keeps the four flags and nothing else', () => {
    expect(parsePresence({ ...PRESENT, extra: 1 })).toEqual(PRESENT)
    expect(parsePresence(undefined)).toBeNull()
    expect(parsePresence({ ...PRESENT, blocked: 'no' })).toBeNull()
  })
})

describe('a state read at a later moment', () => {
  const NOON = new Date(2026, 5, 10, 12).getTime()
  const MIDNIGHT = new Date(2026, 5, 11).getTime()
  const state: TabState = {
    site: 'a.com',
    day: '2026-06-10',
    seq: 1,
    asOf: NOON,
    today: 50_000,
    globalToday: 80_000,
    running: true,
    blockAt: NOON + 10_000,
    limit: { scope: 'site', ms: 60_000 },
    hours: Array<number>(24).fill(0),
    prefs: { hidden: false, scale: 1 },
    holdMs: 2000,
  }

  it('runs on while running, and starts again at midnight', () => {
    expect(totalsAt(state, NOON + 4000)).toEqual({ siteToday: 54_000, globalToday: 84_000 })
    expect(totalsAt({ ...state, running: false }, NOON + 4000)).toEqual({ siteToday: 50_000, globalToday: 80_000 })
    const late = { ...state, asOf: MIDNIGHT - 1000 }
    expect(totalsAt(late, MIDNIGHT + 3000)).toEqual({ siteToday: 3000, globalToday: 3000 })
    expect(totalsAt({ ...late, running: false }, MIDNIGHT + 3000)).toEqual({ siteToday: 0, globalToday: 0 })
  })

  it('projects a running state no further than PROJECT_MS past asOf', () => {
    // An hour asleep: the worker said nothing since noon.
    expect(totalsAt(state, NOON + 3_600_000)).toEqual({
      siteToday: 50_000 + PROJECT_MS,
      globalToday: 80_000 + PROJECT_MS,
    })
    expect(totalsAt({ ...state, asOf: MIDNIGHT - 1000 }, MIDNIGHT + 3_600_000)).toEqual({
      siteToday: PROJECT_MS - 1000,
      globalToday: PROJECT_MS - 1000,
    })
  })

  it('never blocks on a running state too old to project', () => {
    expect(overAt(state, NOON + PROJECT_MS, 'holds')).not.toBeNull()
    expect(overAt(state, NOON + PROJECT_MS + 1, 'holds')).toBeNull()
    expect(overAt(state, NOON + 3_600_000, 'ignored')).toBeNull()
    // A state not running projects nothing: its blockAt still holds.
    expect(overAt({ ...state, running: false }, NOON + 3_600_000, 'holds')).not.toBeNull()
  })

  it('grows the current hour of the hours by what the totals grew by', () => {
    const hours = Array<number>(24).fill(0)
    hours[9] = 20_000
    hours[12] = 30_000
    const at = { ...state, hours }
    const grown = hoursAt(at, NOON + 4000)
    expect(grown[12]).toBe(34_000)
    expect(grown[9]).toBe(20_000)
    expect(grown.reduce((a, b) => a + b, 0)).toBe(totalsAt(at, NOON + 4000).siteToday)
    expect(hoursAt({ ...at, running: false }, NOON + 4000)).toEqual(hours)
    // Past midnight: only the time since, in the new day's first hour.
    const late = hoursAt({ ...at, asOf: MIDNIGHT - 1000 }, MIDNIGHT + 3000)
    expect(late[0]).toBe(3000)
    expect(late.reduce((a, b) => a + b, 0)).toBe(3000)
  })

  it('matches the worker’s suspension gap', () => {
    expect(PROJECT_MS).toBe(SUSPEND_GAP_MS)
  })

  // The block screen ('holds') and the popup ('ignored') differ only while
  // the worker has moved blockAt past the limit: a snooze.
  const SNOOZED = { ...state, today: 70_000, running: false, blockAt: NOON + 60_000 }
  const GLOBAL = { ...state, limit: { scope: 'global' as const, ms: 90_000 } }
  const site = (elapsed: number): BlockReason => ({ scope: 'site', limit: 60_000, elapsed })
  const global: BlockReason = { scope: 'global', limit: 90_000, elapsed: 90_000 }
  it.each<[string, TabState, number, BlockReason | null, BlockReason | null]>([
    ['under its limit', state, NOON + 9000, null, null],
    ['at its limit', state, NOON + 10_000, site(60_000), site(60_000)],
    ['past its limit', state, NOON + 15_000, site(65_000), site(65_000)],
    ['over, snoozed', SNOOZED, NOON, null, site(70_000)],
    ['over, the snooze over', SNOOZED, NOON + 60_000, site(70_000), site(70_000)],
    ['over, the clock gone back', { ...SNOOZED, blockAt: NOON }, NOON - 1000, null, site(70_000)],
    ['at the all-sites cap', GLOBAL, NOON + 10_000, global, global],
    ['from before midnight', state, MIDNIGHT, null, null],
    ['with no limit', { ...state, limit: null, blockAt: null }, NOON + 10_000, null, null],
  ])('%s: blocks, and is over', (_, s, now, holds, ignored) => {
    expect(overAt(s, now, 'holds')).toEqual(holds)
    expect(overAt(s, now, 'ignored')).toEqual(ignored)
  })
})

describe('every site’s time today, read at a later moment', () => {
  const NOON = new Date(2026, 5, 10, 12).getTime()
  const MIDNIGHT = new Date(2026, 5, 11).getTime()
  const totals: TodayTotals = {
    day: '2026-06-10',
    asOf: NOON,
    seq: 1,
    running: 'a.com',
    sites: { 'a.com': 50_000, 'b.com': 20_000 },
  }

  it('runs on for the running site only, and starts again at midnight', () => {
    expect(siteTodayAt(totals, 'a.com', NOON + 4000)).toBe(54_000)
    expect(siteTodayAt(totals, 'b.com', NOON + 4000)).toBe(20_000)
    expect(siteTodayAt(totals, 'c.com', NOON + 4000)).toBe(0)
    expect(siteTodayAt({ ...totals, running: null }, 'a.com', NOON + 4000)).toBe(50_000)
    expect(siteTodayAt({ ...totals, asOf: MIDNIGHT - 1000 }, 'a.com', MIDNIGHT + 3000)).toBe(3000)
    expect(siteTodayAt({ ...totals, asOf: MIDNIGHT - 1000 }, 'b.com', MIDNIGHT + 3000)).toBe(0)
    expect(siteTodayAt(totals, 'a.com', NOON + 3_600_000)).toBe(50_000 + PROJECT_MS)
  })

  it('is over its own limit as the popup is, the snooze ignored', () => {
    expect(siteOverAt(totals, 'a.com', 60_000, NOON + 9999)).toBe(false)
    expect(siteOverAt(totals, 'a.com', 60_000, NOON + 10_000)).toBe(true)
    expect(siteOverAt(totals, 'b.com', 20_000, NOON)).toBe(true)
    expect(siteOverAt(totals, 'b.com', 20_001, NOON + 60_000)).toBe(false)
    expect(siteOverAt(totals, 'a.com', null, NOON + 60_000)).toBe(false)
    // Past midnight, or running and stale: over nothing, as overAt.
    expect(siteOverAt(totals, 'b.com', 20_000, MIDNIGHT)).toBe(false)
    expect(siteOverAt(totals, 'a.com', 60_000, NOON + PROJECT_MS + 1)).toBe(false)
    // The same answer overAt gives the popup for that site's tab.
    const tab: TabState = {
      site: 'a.com',
      day: totals.day,
      seq: 1,
      asOf: NOON,
      today: 50_000,
      globalToday: 70_000,
      running: true,
      blockAt: NOON + 5 * 60_000,
      limit: { scope: 'site', ms: 60_000 },
      hours: Array<number>(24).fill(0),
      prefs: { hidden: false, scale: 1 },
      holdMs: 2000,
    }
    for (const at of [NOON, NOON + 9999, NOON + 10_000, NOON + 60_000, NOON + PROJECT_MS + 1]) {
      expect(siteOverAt(totals, 'a.com', 60_000, at)).toBe(overAt(tab, at, 'ignored') !== null)
    }
  })
})

describe('latestTotals', () => {
  const totals = (seq: number): TodayTotals => ({
    day: '2026-06-10',
    asOf: 0,
    seq,
    running: null,
    sites: {},
  })

  it('keeps the later transaction’s answer, and none when the worker fails', () => {
    expect(latestTotals(null, { ok: true, value: totals(1) })).toEqual(totals(1))
    expect(latestTotals(totals(2), { ok: true, value: totals(1) })).toEqual(totals(2))
    expect(latestTotals(totals(2), { ok: true, value: totals(2) })).toEqual(totals(2))
    expect(latestTotals(totals(2), { ok: true, value: totals(3) })).toEqual(totals(3))
    expect(latestTotals(totals(2), { ok: false, error: 'unreachable' })).toBeNull()
  })
})

describe('parseStatePush', () => {
  const state: TabState = {
    site: 'reddit.com',
    day: '2026-06-10',
    asOf: 1000,
    seq: 7,
    today: 5000,
    globalToday: 9000,
    running: true,
    blockAt: 61_000,
    limit: { scope: 'site', ms: 60_000 },
    hours: Array<number>(24).fill(0),
    prefs: { hidden: false, scale: 1 },
    holdMs: 2000,
  }

  it('accepts a well-formed push, its state rebuilt from its fields', () => {
    expect(parseStatePush({ type: 'state', state: { ...state, extra: 1 }, probe: true })).toEqual({
      type: 'state',
      state,
      probe: true,
    })
    expect(parseStatePush({ type: 'state', state: { ...state, blockAt: null, limit: null }, probe: false })).toEqual({
      type: 'state',
      state: { ...state, blockAt: null, limit: null },
      probe: false,
    })
  })

  it.each([
    null,
    { type: 'other', state, probe: false },
    { type: 'state', probe: false },
    { type: 'state', state },
    { type: 'state', state, probe: 'yes' },
    { type: 'state', state: { ...state, seq: undefined }, probe: false },
    { type: 'state', state: { ...state, site: 1 }, probe: false },
    { type: 'state', state: { ...state, day: 'today' }, probe: false },
    { type: 'state', state: { ...state, asOf: '1' }, probe: false },
    { type: 'state', state: { ...state, today: NaN }, probe: false },
    { type: 'state', state: { ...state, globalToday: undefined }, probe: false },
    { type: 'state', state: { ...state, running: 1 }, probe: false },
    { type: 'state', state: { ...state, blockAt: 'soon' }, probe: false },
    { type: 'state', state: { ...state, limit: { scope: 'week', ms: 1 } }, probe: false },
    { type: 'state', state: { ...state, limit: { scope: 'site', ms: '1' } }, probe: false },
    { type: 'state', state: { ...state, limit: 5 }, probe: false },
    { type: 'state', state: { ...state, hours: undefined }, probe: false },
    { type: 'state', state: { ...state, hours: [1, 2] }, probe: false },
    { type: 'state', state: { ...state, hours: Array(24).fill('1') }, probe: false },
    { type: 'state', state: { ...state, prefs: undefined }, probe: false },
    { type: 'state', state: { ...state, prefs: { hidden: 'no', scale: 1 } }, probe: false },
    { type: 'state', state: { ...state, prefs: { hidden: false, scale: '1' } }, probe: false },
    { type: 'state', state: { ...state, holdMs: undefined }, probe: false },
    { type: 'state', state: { ...state, holdMs: '2000' }, probe: false },
    { type: 'state', state: { ...state, holdMs: 0 }, probe: false },
  ])('rejects %j', (raw) => {
    expect(parseStatePush(raw)).toBeNull()
  })
})

describe('SENDERS', () => {
  it('lets only content scripts report presence, and only extension pages set limits', () => {
    expect(SENDERS.presence).toEqual(['content'])
    expect(SENDERS.setLimit).toEqual(['extension'])
    expect(SENDERS.todayTotals).toEqual(['extension'])
  })

  it('lets only content scripts snooze and open pages', () => {
    expect(SENDERS.snooze).toEqual(['content'])
    expect(SENDERS.open).toEqual(['content'])
    expect(SENDERS.closeTab).toEqual(['content'])
  })
})
