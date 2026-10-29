import { describe, it, expect } from 'vitest'
import {
  asOf,
  creditable,
  initialAway,
  isIdleState,
  normalizeAway,
  observe,
  remember,
  IDLE_DETECTION_MS,
  IDLE_DETECTION_S,
  MAX_PERIODS,
  MAX_RECENT,
  type AwayPeriod,
  type AwayState,
  type IdleState,
} from './away'
import { MAX_SPAN_AGE_MS, type Span } from './away'

const MIN = 60_000
const T = new Date(2026, 5, 10, 12).getTime()

// Feed a sequence of [state, at] observations from the initial state.
function run(steps: Array<[IdleState, number]>, from: AwayState = initialAway()): AwayState {
  return steps.reduce((s, [state, at]) => observe(s, state, at).state, from)
}

describe('IDLE_DETECTION', () => {
  it('is five minutes without input, within what chrome.idle accepts (at least 15 s)', () => {
    expect(IDLE_DETECTION_S).toBe(300)
    expect(IDLE_DETECTION_MS).toBe(300_000)
  })
})

describe('observe', () => {
  it('dates idle back to the last input, one detection interval before it is reported', () => {
    const s = run([['idle', T]])
    expect(s).toMatchObject({
      state: 'idle',
      since: T,
      periods: [{ kind: 'idle', start: T - IDLE_DETECTION_MS, end: null }],
    })
  })

  it('starts a lock when it is reported', () => {
    expect(run([['locked', T]]).periods).toEqual([{ kind: 'locked', start: T, end: null }])
  })

  it('ends the open period on return, and repeats change nothing', () => {
    const s = run([
      ['idle', T],
      ['idle', T + MIN],
      ['active', T + 2 * MIN],
      ['active', T + 3 * MIN],
    ])
    expect(s.state).toBe('active')
    expect(s.since).toBe(T + 2 * MIN)
    expect(s.periods).toEqual([{ kind: 'idle', start: T - IDLE_DETECTION_MS, end: T + 2 * MIN }])
  })

  it('follows idle into a lock and out again, without dating the later states back', () => {
    const s = run([
      ['idle', T],
      ['locked', T + MIN],
      ['idle', T + 10 * MIN],
      ['active', T + 11 * MIN],
    ])
    expect(s.periods).toEqual<AwayPeriod[]>([
      { kind: 'idle', start: T - IDLE_DETECTION_MS, end: T + MIN },
      { kind: 'locked', start: T + MIN, end: T + 10 * MIN },
      { kind: 'idle', start: T + 10 * MIN, end: T + 11 * MIN },
    ])
  })

  it('never dates idle back before the active state it ends began', () => {
    const s = run([
      ['locked', T],
      ['active', T + 10 * MIN],
      ['idle', T + 12 * MIN],
    ])
    expect(s.periods.at(-1)).toEqual({ kind: 'idle', start: T + 10 * MIN, end: null })
  })

  it('takes back time credited since the back-dated start, except media time', () => {
    let s = remember(initialAway(), 'a.com', [[T - 8 * MIN, T - 2 * MIN]], false, T - 2 * MIN)
    s = remember(s, 'b.com', [[T - 3 * MIN, T - MIN]], true, T - MIN)
    s = remember(s, 'a.com', [[T - MIN, T]], false, T)
    const { state, debit } = observe(s, 'idle', T)
    const start = T - IDLE_DETECTION_MS
    expect(debit).toEqual([
      { site: 'a.com', start, end: T - 2 * MIN, media: false },
      { site: 'a.com', start: T - MIN, end: T, media: false },
    ])
    // What was taken back can't be taken back twice; what is left before
    // the start can't be reached any more.
    expect(state.recent).toEqual([{ site: 'b.com', start: T - 3 * MIN, end: T - MIN, media: true }])
    expect(observe(observe(state, 'active', T + 1).state, 'idle', T + 2).debit).toEqual([])
  })

  it('takes nothing back for a lock (it is reported as it happens)', () => {
    const s = remember(initialAway(), 'a.com', [[T - MIN, T]], true, T)
    expect(observe(s, 'locked', T).debit).toEqual([])
    const late = remember(initialAway(), 'a.com', [[T - MIN, T + 1000]], true, T)
    expect(observe(late, 'locked', T).debit).toEqual([{ site: 'a.com', start: T, end: T + 1000, media: true }])
  })

  it('drops periods older than any span still accepted', () => {
    const s = run([
      ['locked', T],
      ['active', T + MIN],
      ['locked', T + MAX_SPAN_AGE_MS + 2 * MIN],
    ])
    expect(s.periods).toEqual([{ kind: 'locked', start: T + MAX_SPAN_AGE_MS + 2 * MIN, end: null }])
  })

  it('keeps at most MAX_PERIODS periods', () => {
    const steps: Array<[IdleState, number]> = []
    for (let i = 0; i < MAX_PERIODS + 10; i++) {
      steps.push(['locked', T + i * 2], ['active', T + i * 2 + 1])
    }
    const s = run(steps)
    expect(s.periods).toHaveLength(MAX_PERIODS)
    expect(s.periods.at(-1)).toEqual({
      kind: 'locked',
      start: T + (MAX_PERIODS + 9) * 2,
      end: T + (MAX_PERIODS + 9) * 2 + 1,
    })
  })
})

describe('creditable', () => {
  const idle = (start: number, end: number | null): AwayPeriod => ({ kind: 'idle', start, end })
  const locked = (start: number, end: number | null): AwayPeriod => ({ kind: 'locked', start, end })
  const span = (start: number, end: number): Span => [T + start * MIN, T + end * MIN]

  it.each<[string, Span[], AwayPeriod[], boolean, Span[]]>([
    ['no periods', [span(0, 5)], [], false, [span(0, 5)]],
    ['a period elsewhere', [span(0, 5)], [idle(T + 10 * MIN, T + 20 * MIN)], false, [span(0, 5)]],
    ['idle inside', [span(0, 10)], [idle(T + 2 * MIN, T + 4 * MIN)], false, [span(0, 2), span(4, 10)]],
    ['idle covering', [span(2, 4)], [idle(T, T + 10 * MIN)], false, []],
    ['idle still open', [span(0, 10)], [idle(T + 6 * MIN, null)], false, [span(0, 6)]],
    ['idle at the edges', [span(0, 10)], [idle(T - MIN, T + MIN), idle(T + 9 * MIN, null)], false, [span(1, 9)]],
    ['idle with media playing', [span(0, 10)], [idle(T + 2 * MIN, T + 4 * MIN)], true, [span(0, 10)]],
    ['locked with media playing', [span(0, 10)], [locked(T + 2 * MIN, T + 4 * MIN)], true, [span(0, 2), span(4, 10)]],
    [
      'idle then locked, media playing',
      [span(0, 10)],
      [idle(T + MIN, T + 3 * MIN), locked(T + 3 * MIN, T + 5 * MIN)],
      true,
      [span(0, 3), span(5, 10)],
    ],
    ['several spans', [span(0, 2), span(3, 6)], [locked(T + MIN, T + 4 * MIN)], false, [span(0, 1), span(4, 6)]],
    ['an empty span', [[T, T]], [], false, []],
  ])('%s', (_name, spans, periods, media, expected) => {
    expect(creditable(spans, periods, media)).toEqual(expected)
  })
})

describe('remember', () => {
  it('keeps only credits a back-dated idle could still reach, at most MAX_RECENT', () => {
    let s = remember(initialAway(), 'a.com', [[T - 10 * MIN, T - 6 * MIN]], false, T - 6 * MIN)
    s = remember(s, 'a.com', [[T - MIN, T]], false, T)
    expect(s.recent).toEqual([{ site: 'a.com', start: T - MIN, end: T, media: false }])
    const many: Span[] = Array.from({ length: MAX_RECENT + 5 }, (_, i) => [T + i, T + i + 1])
    expect(remember(initialAway(), 'a.com', many, false, T).recent).toHaveLength(MAX_RECENT)
  })
})

describe('normalizeAway', () => {
  it('round-trips a stored state (as after a service worker restart)', () => {
    const s = remember(run([['idle', T]]), 'a.com', [[T - MIN, T]], true, T)
    expect(normalizeAway(structuredClone(s))).toEqual(s)
  })

  it.each([undefined, null, 'idle', [], { state: 'asleep' }])('reads %j as the initial state', (raw) => {
    expect(normalizeAway(raw)).toEqual(initialAway())
  })

  it('drops malformed periods and credits, and an unknown since', () => {
    expect(
      normalizeAway({
        state: 'locked',
        since: 'then',
        periods: [
          { kind: 'locked', start: T, end: null },
          { kind: 'idle', start: T, end: T - 1 },
          { kind: 'away', start: T, end: null },
          { kind: 'idle', start: 'x', end: null },
          null,
        ],
        recent: [
          { site: 'a.com', start: T, end: T + 1, media: false },
          { site: 'a.com', start: T, end: T, media: false },
          { site: 'a.com', start: T, end: T + 1 },
          { site: 1, start: T, end: T + 1, media: false },
          { site: 'a.com', start: null, end: T + 1, media: false },
          7,
        ],
      })
    ).toEqual({
      state: 'locked',
      since: 0,
      periods: [{ kind: 'locked', start: T, end: null }],
      recent: [{ site: 'a.com', start: T, end: T + 1, media: false }],
    })
    expect(normalizeAway({ state: 'idle', periods: 'x' })).toEqual({ ...initialAway(), state: 'idle' })
  })
})

describe('asOf', () => {
  it('drops what was stamped after now (the clock went back), keeping an ongoing period from now at the latest', () => {
    const s: AwayState = {
      state: 'locked',
      since: T + 30 * MIN,
      periods: [
        { kind: 'idle', start: T - 10 * MIN, end: T - 5 * MIN },
        { kind: 'idle', start: T - 2 * MIN, end: T + 10 * MIN },
        { kind: 'locked', start: T + 20 * MIN, end: null },
      ],
      recent: [
        { site: 'a.com', start: T - 3 * MIN, end: T - MIN, media: false },
        { site: 'a.com', start: T - MIN, end: T + MIN, media: false },
      ],
    }
    expect(asOf(s, T)).toEqual({
      state: 'locked',
      since: T,
      periods: [
        { kind: 'idle', start: T - 10 * MIN, end: T - 5 * MIN },
        { kind: 'locked', start: T, end: null },
      ],
      recent: [{ site: 'a.com', start: T - 3 * MIN, end: T - MIN, media: false }],
    })
  })
})

describe('isIdleState', () => {
  it('accepts exactly the chrome.idle states', () => {
    expect(['active', 'idle', 'locked'].every(isIdleState)).toBe(true)
    expect([undefined, 'away', 1].some(isIdleState)).toBe(false)
  })
})
