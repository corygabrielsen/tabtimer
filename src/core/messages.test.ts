import { describe, it, expect } from 'vitest'
import { parsePresence, parseRequest, parseStatePush, SENDERS, type TabState } from './messages'

const MIN = 60_000
const parse = (raw: unknown) => parseRequest(raw)

const PRESENT = { visible: true, focused: true, media: false, blocked: false }

describe('parseRequest', () => {
  it.each([
    [{ type: 'snooze' }, { type: 'snooze' }],
    [{ type: 'openOptions' }, { type: 'openOptions' }],
    [{ type: 'openActivity', extra: 1 }, { type: 'openActivity' }],
    [
      { type: 'presence', ...PRESENT },
      { type: 'presence', ...PRESENT },
    ],
    [
      { type: 'presence', visible: false, focused: false, media: true, blocked: true },
      { type: 'presence', visible: false, focused: false, media: true, blocked: true },
    ],
    [
      { type: 'resetToday', site: 'reddit.com' },
      { type: 'resetToday', site: 'reddit.com' },
    ],
    [
      { type: 'setLimit', scope: 'global', ms: 30 * MIN },
      { type: 'setLimit', scope: 'global', ms: 30 * MIN },
    ],
    [
      { type: 'setLimit', scope: 'site', site: 'x.com', ms: null },
      { type: 'setLimit', scope: 'site', site: 'x.com', ms: null },
    ],
    [
      { type: 'setPrefs', hidden: true },
      { type: 'setPrefs', hidden: true },
    ],
    [
      { type: 'setPrefs', scale: 0.75 },
      { type: 'setPrefs', scale: 0.75 },
    ],
  ])('accepts %j', (raw, expected) => {
    expect(parse(raw)).toEqual(expected)
  })

  it.each([
    null,
    'presence',
    [],
    { type: 'mystery' },
    { type: 'resetKey', key: 'limits' },
    { type: 'hello' },
    { type: 'addElapsed', spans: [[1, 2]] },
    { type: 'presence' },
    { type: 'presence', ...PRESENT, visible: 'yes' },
    { type: 'presence', ...PRESENT, focused: 1 },
    { type: 'presence', ...PRESENT, media: null },
    { type: 'presence', visible: true, focused: true, media: false },
    { type: 'resetToday' },
    { type: 'resetToday', site: '' },
    { type: 'resetToday', site: 'Reddit.com' },
    { type: 'resetToday', site: 'a b' },
    { type: 'resetToday', site: 'x'.repeat(254) },
    { type: 'resetToday', site: { toString: (): string => 'x.com' } },
    { type: 'setLimit', scope: 'global' },
    { type: 'setLimit', scope: 'global', ms: 0 },
    { type: 'setLimit', scope: 'global', ms: 59_999 },
    { type: 'setLimit', scope: 'global', ms: 1441 * MIN },
    { type: 'setLimit', scope: 'site', ms: MIN },
    { type: 'setLimit', scope: 'everything', ms: MIN },
    { type: 'setPrefs' },
    { type: 'setPrefs', hidden: 'yes' },
    { type: 'setPrefs', scale: 0.4 },
    { type: 'setPrefs', scale: 1.5 },
  ])('rejects %j', (raw) => {
    expect(parse(raw)).toBeNull()
  })

  it('drops fields the contract does not define, such as a site on a content report', () => {
    expect(parse({ type: 'presence', ...PRESENT, site: 'other.com', tabId: 9, key: 'limits' })).toEqual({
      type: 'presence',
      ...PRESENT,
    })
    expect(parse({ type: 'snooze', site: 'other.com' })).toEqual({ type: 'snooze' })
    expect(parse({ type: 'setPrefs', hidden: false, limits: {} })).toEqual({ type: 'setPrefs', hidden: false })
  })
})

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
})
