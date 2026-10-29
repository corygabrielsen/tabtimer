import { describe, it, expect } from 'vitest'
import {
  appendSpan,
  batchSpans,
  parseRequest,
  spanTimeSince,
  MAX_CLOCK_SKEW_MS,
  MAX_REPORT_MS,
  MAX_SPANS,
  MAX_SPAN_AGE_MS,
  SENDERS,
  type Span,
} from './messages'

const NOW = new Date(2026, 5, 10, 12).getTime()
const MIN = 60_000
const parse = (raw: unknown) => parseRequest(raw, NOW)

describe('parseRequest', () => {
  it.each([
    [{ type: 'hello' }, { type: 'hello' }],
    [{ type: 'snooze' }, { type: 'snooze' }],
    [{ type: 'openOptions' }, { type: 'openOptions' }],
    [
      { type: 'addElapsed', spans: [[NOW - 5000, NOW - 1000]] },
      { type: 'addElapsed', spans: [[NOW - 5000, NOW - 1000]] },
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
    'hello',
    [],
    { type: 'mystery' },
    { type: 'resetKey', key: 'limits' },
    { spans: [[1, 2]] },
    { type: 'addElapsed' },
    { type: 'addElapsed', spans: [] },
    { type: 'addElapsed', spans: [[NOW - 1000]] },
    { type: 'addElapsed', spans: [[NOW - 1000, NOW - 1000]] },
    { type: 'addElapsed', spans: [[NOW, NOW - 1000]] },
    { type: 'addElapsed', spans: [['1', NOW]] },
    { type: 'addElapsed', spans: [[NOW - 1000, Infinity]] },
    { type: 'addElapsed', spans: [[NOW - MAX_REPORT_MS - 1, NOW]] },
    { type: 'addElapsed', spans: [[NOW - MAX_SPAN_AGE_MS - 1, NOW - MAX_SPAN_AGE_MS + 1000]] },
    { type: 'addElapsed', spans: [[NOW, NOW + MAX_CLOCK_SKEW_MS + 1]] },
    {
      type: 'addElapsed',
      spans: Array.from({ length: MAX_SPANS + 1 }, (_, i) => [NOW - 1000 * (i + 1), NOW - 1000 * i]),
    },
    { type: 'addElapsed', delta: 1000 },
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
    expect(parse({ type: 'addElapsed', spans: [[NOW - 1000, NOW]], site: 'other.com', key: 'limits' })).toEqual({
      type: 'addElapsed',
      spans: [[NOW - 1000, NOW]],
    })
    expect(parse({ type: 'hello', site: 'other.com' })).toEqual({ type: 'hello' })
    expect(parse({ type: 'setPrefs', hidden: false, limits: {} })).toEqual({ type: 'setPrefs', hidden: false })
  })

  it('accepts a report at the bounds', () => {
    expect(parse({ type: 'addElapsed', spans: [[NOW - MAX_REPORT_MS, NOW]] })).not.toBeNull()
    expect(parse({ type: 'addElapsed', spans: [[NOW, NOW + MAX_CLOCK_SKEW_MS]] })).not.toBeNull()
  })
})

describe('SENDERS', () => {
  it('lets only content scripts report time, and only extension pages reset or set limits', () => {
    expect(SENDERS.addElapsed).toEqual(['content'])
    expect(SENDERS.hello).toEqual(['content'])
    expect(SENDERS.resetToday).toEqual(['extension'])
    expect(SENDERS.setLimit).toEqual(['extension'])
  })
})

describe('appendSpan', () => {
  it('extends the last span when the new time continues it', () => {
    const spans: Span[] = []
    appendSpan(spans, 2000, 1000)
    appendSpan(spans, 3000, 1000)
    appendSpan(spans, 3500, 500)
    expect(spans).toEqual([[1000, 3500]])
  })

  it('starts a new span after a gap, and ignores nothing-credited', () => {
    const spans: Span[] = []
    appendSpan(spans, 2000, 1000)
    appendSpan(spans, 9000, 1000)
    appendSpan(spans, 9500, 0)
    expect(spans).toEqual([
      [1000, 2000],
      [8000, 9000],
    ])
  })
})

describe('spanTimeSince', () => {
  it('counts only the part of each span at or after the cut', () => {
    expect(
      spanTimeSince(
        [
          [0, 100],
          [150, 300],
          [400, 500],
        ],
        200
      )
    ).toBe(200)
  })
})

describe('batchSpans', () => {
  it('sends a few spans as one request', () => {
    const spans: Span[] = [
      [NOW - 5000, NOW - 4000],
      [NOW - 2000, NOW],
    ]
    expect(batchSpans(spans, NOW)).toEqual([spans])
  })

  it('splits long or many spans into requests parseRequest accepts', () => {
    const long: Span = [NOW - 25 * MIN, NOW]
    const many: Span[] = Array.from({ length: 100 }, (_, i) => [
      NOW - 30 * MIN - 2000 * (i + 1),
      NOW - 30 * MIN - 2000 * i - 1000,
    ])
    const batches = batchSpans([...many.reverse(), long], NOW)
    for (const spans of batches) {
      expect(parseRequest({ type: 'addElapsed', spans }, NOW)).not.toBeNull()
    }
    const total = (s: Span[]) => s.reduce((t, [a, b]) => t + b - a, 0)
    expect(batches.reduce((t, b) => t + total(b), 0)).toBe(25 * MIN + 100 * 1000)
  })

  it('drops time too old to be accepted', () => {
    const spans: Span[] = [
      [NOW - MAX_SPAN_AGE_MS - 5000, NOW - MAX_SPAN_AGE_MS + 1000],
      [NOW - MAX_SPAN_AGE_MS - 9000, NOW - MAX_SPAN_AGE_MS - 8000],
    ]
    expect(batchSpans(spans, NOW)).toEqual([[[NOW - MAX_SPAN_AGE_MS, NOW - MAX_SPAN_AGE_MS + 1000]]])
  })

  it('sends nothing for no spans', () => {
    expect(batchSpans([], NOW)).toEqual([])
  })
})
