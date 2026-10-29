import { describe, it, expect } from 'vitest'
import { overAt, parsePresence, parseStatePush, totalsAt, SENDERS, type TabState } from './messages'

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
    asOf: NOON,
    today: 50_000,
    globalToday: 80_000,
    running: true,
    blockAt: NOON + 10_000,
    limit: { scope: 'site', ms: 60_000 },
    prefs: { hidden: false, scale: 1 },
  }

  it('runs on while running, and starts again at midnight', () => {
    expect(totalsAt(state, NOON + 4000)).toEqual({ siteToday: 54_000, globalToday: 84_000 })
    expect(totalsAt({ ...state, running: false }, NOON + 4000)).toEqual({ siteToday: 50_000, globalToday: 80_000 })
    expect(totalsAt(state, MIDNIGHT + 3000)).toEqual({ siteToday: 3000, globalToday: 3000 })
    expect(totalsAt({ ...state, running: false }, MIDNIGHT + 3000)).toEqual({ siteToday: 0, globalToday: 0 })
  })

  it('is over its limit once it reaches it, but not after midnight', () => {
    expect(overAt(state, NOON + 9000)).toBeNull()
    expect(overAt(state, NOON + 10_000)).toEqual({ scope: 'site', limit: 60_000, elapsed: 60_000 })
    // Snoozed: over, the block later.
    expect(overAt({ ...state, today: 70_000, running: false, blockAt: NOON + 60_000 }, NOON)).toMatchObject({
      elapsed: 70_000,
    })
    expect(overAt(state, MIDNIGHT)).toBeNull()
    expect(overAt({ ...state, limit: null, blockAt: null }, NOON + 10_000)).toBeNull()
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
    prefs: { hidden: false, scale: 1 },
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
    { type: 'state', state: { ...state, prefs: undefined }, probe: false },
    { type: 'state', state: { ...state, prefs: { hidden: 'no', scale: 1 } }, probe: false },
    { type: 'state', state: { ...state, prefs: { hidden: false, scale: '1' } }, probe: false },
  ])('rejects %j', (raw) => {
    expect(parseStatePush(raw)).toBeNull()
  })
})

describe('SENDERS', () => {
  it('lets only content scripts report presence, and only extension pages reset or set limits', () => {
    expect(SENDERS.presence).toEqual(['content'])
    expect(SENDERS.resetToday).toEqual(['extension'])
    expect(SENDERS.setLimit).toEqual(['extension'])
  })

  it('lets only content scripts snooze and open pages', () => {
    expect(SENDERS.snooze).toEqual(['content'])
    expect(SENDERS.open).toEqual(['content'])
  })
})
