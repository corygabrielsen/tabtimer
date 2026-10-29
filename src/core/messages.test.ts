import { describe, it, expect } from 'vitest'
import { parsePresence, parseStatePush, SENDERS, type TabState } from './messages'

const PRESENT = { visible: true, focused: true, media: false, blocked: false }

describe('parsePresence', () => {
  it('keeps the four flags and nothing else', () => {
    expect(parsePresence({ ...PRESENT, extra: 1 })).toEqual(PRESENT)
    expect(parsePresence(undefined)).toBeNull()
    expect(parsePresence({ ...PRESENT, blocked: 'no' })).toBeNull()
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
