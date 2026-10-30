import { describe, it, expect } from 'vitest'
import { parseRequest } from './requests'

const MIN = 60_000
const parse = (raw: unknown) => parseRequest(raw)

const PRESENT = { visible: true, focused: true, media: false, blocked: false }

describe('parseRequest', () => {
  it.each([
    [{ type: 'snooze' }, { type: 'snooze' }],
    [{ type: 'closeTab' }, { type: 'closeTab' }],
    [
      { type: 'open', page: 'options' },
      { type: 'open', page: 'options' },
    ],
    [
      { type: 'open', page: 'activity', extra: 1 },
      { type: 'open', page: 'activity' },
    ],
    [
      { type: 'presence', ...PRESENT },
      { type: 'presence', ...PRESENT },
    ],
    [
      { type: 'presence', visible: false, focused: false, media: true, blocked: true },
      { type: 'presence', visible: false, focused: false, media: true, blocked: true },
    ],
    [
      { type: 'tabState', tabId: 4, site: 'reddit.com', extra: 1 },
      { type: 'tabState', tabId: 4, site: 'reddit.com' },
    ],
    [{ type: 'todayTotals', site: 'reddit.com' }, { type: 'todayTotals' }],
    [
      { type: 'setLimit', scope: 'global', minutes: 30 },
      { type: 'setLimit', scope: 'global', minutes: 30 },
    ],
    [
      { type: 'setLimit', scope: 'site', site: 'x.com', minutes: null },
      { type: 'setLimit', scope: 'site', site: 'x.com', minutes: null },
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
    { type: 'tabState', site: 'reddit.com' },
    { type: 'tabState', tabId: 1.5, site: 'reddit.com' },
    { type: 'tabState', tabId: '4', site: 'reddit.com' },
    { type: 'tabState', tabId: 4, site: 'www.reddit.com' },
    { type: 'setLimit', scope: 'site', site: '', minutes: 1 },
    { type: 'open' },
    { type: 'open', page: 'usage.html' },
    { type: 'setLimit', scope: 'site', site: 'Reddit.com', minutes: 1 },
    { type: 'setLimit', scope: 'site', site: 'www.reddit.com', minutes: 1 },
    { type: 'setLimit', scope: 'site', site: 'news.bbc.co.uk', minutes: 1 },
    { type: 'setLimit', scope: 'site', site: 'a b', minutes: 1 },
    { type: 'setLimit', scope: 'site', site: 'x'.repeat(254), minutes: 1 },
    { type: 'setLimit', scope: 'site', site: { toString: (): string => 'x.com' }, minutes: 1 },
    { type: 'setLimit', scope: 'global' },
    { type: 'setLimit', scope: 'global', minutes: 0 },
    { type: 'setLimit', scope: 'global', minutes: 1.5 },
    { type: 'setLimit', scope: 'global', minutes: '30' },
    { type: 'setLimit', scope: 'global', minutes: 1441 },
    { type: 'setLimit', scope: 'global', ms: 30 * MIN },
    { type: 'setLimit', scope: 'site', minutes: 1 },
    { type: 'setLimit', scope: 'everything', minutes: 1 },
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
