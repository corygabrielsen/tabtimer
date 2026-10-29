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
    today: 5000,
    globalToday: 9000,
    running: true,
    blockAt: 61_000,
    limit: { scope: 'site', ms: 60_000 },
    prefs: { hidden: false, scale: 1 },
  }

  it('accepts a well-formed state, rebuilt from its fields', () => {
    expect(parseStatePush({ type: 'state', state: { ...state, extra: 1 } })).toEqual(state)
    expect(parseStatePush({ type: 'state', state: { ...state, blockAt: null, limit: null } })).toEqual({
      ...state,
      blockAt: null,
      limit: null,
    })
  })

  it.each([
    null,
    { type: 'other', state },
    { type: 'state' },
    { type: 'state', state: { ...state, site: 1 } },
    { type: 'state', state: { ...state, day: 'today' } },
    { type: 'state', state: { ...state, asOf: '1' } },
    { type: 'state', state: { ...state, today: NaN } },
    { type: 'state', state: { ...state, globalToday: undefined } },
    { type: 'state', state: { ...state, running: 1 } },
    { type: 'state', state: { ...state, blockAt: 'soon' } },
    { type: 'state', state: { ...state, limit: { scope: 'week', ms: 1 } } },
    { type: 'state', state: { ...state, limit: { scope: 'site', ms: '1' } } },
    { type: 'state', state: { ...state, limit: 5 } },
    { type: 'state', state: { ...state, prefs: undefined } },
    { type: 'state', state: { ...state, prefs: { hidden: 'no', scale: 1 } } },
    { type: 'state', state: { ...state, prefs: { hidden: false, scale: '1' } } },
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
