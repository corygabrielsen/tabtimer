import { describe, it, expect } from 'vitest'
import type { IdleState } from './away'
import {
  canAccrue,
  initialTracker,
  normalizeTracker,
  step,
  CHECKPOINT_MS,
  SUSPEND_GAP_MS,
  type Accrual,
  type Attest,
  type Presence,
  type TrackerEvent,
  type TrackerState,
} from './tracker'

const T = new Date(2026, 5, 10, 12).getTime()
const S = 1000

const SHOWN: Presence = { visible: true, focused: true, media: false, blocked: false }

// Tab 1 (a.com) and tab 2 (b.com) in window 10; tab 3 (c.com) in window 20.
const PAGES: Record<number, { site: string; windowId: number }> = {
  1: { site: 'a.com', windowId: 10 },
  2: { site: 'b.com', windowId: 10 },
  3: { site: 'c.com', windowId: 20 },
}

function attest(tabId: number, report: Partial<Attest> = {}, doc = `doc-${tabId}`): Attest {
  return { ...PAGES[tabId]!, doc, departing: false, audible: false, at: 0, ...SHOWN, ...report }
}

const presence = (tabId: number, p: Partial<Attest> = {}, doc?: string): TrackerEvent => ({
  kind: 'presence',
  tabId,
  attest: attest(tabId, p, doc),
})

type Timed = [at: number, event: TrackerEvent, idle?: IdleState]

// Run events in order (each at T + its offset), collecting every credit.
function run(events: Timed[], from: TrackerState = initialTracker()) {
  let state = from
  const credits: Accrual[] = []
  const probes: number[][] = []
  const pushes: number[][] = []
  for (const [at, event, idle = 'active'] of events) {
    const out = step(state, event, T + at, idle)
    state = out.state
    credits.push(...out.credits)
    probes.push(out.probe)
    pushes.push(out.push)
  }
  return { state, credits, probes, pushes }
}

const credited = (credits: Accrual[]) => {
  const bySite: Record<string, number> = {}
  for (const c of credits) {
    bySite[c.site] = (bySite[c.site] ?? 0) + c.end - c.start
  }
  return bySite
}

describe('canAccrue', () => {
  it.each<[Partial<Presence>, IdleState, boolean]>([
    [{}, 'active', true],
    [{ visible: false }, 'active', false],
    [{ focused: false }, 'active', false],
    [{ blocked: true }, 'active', false],
    [{}, 'idle', false],
    [{ media: true }, 'idle', true],
    [{ media: true }, 'locked', false],
    [{}, 'locked', false],
  ])('%j while %s: %s', (p, idle, expected) => {
    expect(canAccrue({ ...SHOWN, ...p }, idle)).toBe(expected)
  })
})

describe('event ordering', () => {
  it.each<[string, Timed[], Record<string, number>]>([
    [
      'a page in use accrues until it reports itself hidden',
      [
        [0, presence(1)],
        [5 * S, presence(1, { visible: false })],
      ],
      { 'a.com': 5 * S },
    ],
    [
      'blurring the window stops it',
      [
        [0, presence(1)],
        [4 * S, presence(1, { focused: false })],
      ],
      { 'a.com': 4 * S },
    ],
    [
      'tab switch A→B, the old page reporting first',
      [
        [0, presence(1)],
        [3 * S, presence(1, { visible: false })],
        [3 * S, { kind: 'activated', tabId: 2, windowId: 10 }],
        [3 * S, presence(2)],
        [8 * S, presence(2, { visible: false })],
      ],
      { 'a.com': 3 * S, 'b.com': 5 * S },
    ],
    [
      'tab switch A→B, the browser event first',
      [
        [0, presence(1)],
        [3 * S, { kind: 'activated', tabId: 2, windowId: 10 }],
        [3 * S, presence(1, { visible: false })],
        [3 * S, presence(2)],
        [8 * S, { kind: 'removed', tabId: 2 }],
      ],
      { 'a.com': 3 * S, 'b.com': 5 * S },
    ],
    [
      'tab switch A→B, the new page reporting first',
      [
        [0, presence(1)],
        [3 * S, presence(2)],
        [3 * S, { kind: 'activated', tabId: 2, windowId: 10 }],
        [3 * S, presence(1, { visible: false })],
        [8 * S, presence(2, { visible: false })],
      ],
      { 'a.com': 3 * S, 'b.com': 5 * S },
    ],
    [
      'a tab activated in another window leaves the open one alone',
      [
        [0, presence(1)],
        [2 * S, { kind: 'activated', tabId: 3, windowId: 20 }],
        [6 * S, presence(1, { visible: false })],
      ],
      { 'a.com': 6 * S },
    ],
    [
      'two windows both visible: only the last one to report counts',
      [
        [0, presence(1)],
        [2 * S, presence(3)],
        [7 * S, presence(1)],
        [9 * S, { kind: 'windowFocus', windowId: null }],
      ],
      { 'a.com': 4 * S, 'c.com': 5 * S },
    ],
    [
      'focus leaving Chrome closes; focus to the same window does not',
      [
        [0, presence(1)],
        [2 * S, { kind: 'windowFocus', windowId: 10 }],
        [4 * S, { kind: 'windowFocus', windowId: null }],
        [9 * S, presence(1, { visible: false })],
      ],
      { 'a.com': 4 * S },
    ],
    [
      'focus moving to another window closes',
      [
        [0, presence(1)],
        [3 * S, { kind: 'windowFocus', windowId: 20 }],
        [9 * S, presence(1, { visible: false })],
      ],
      { 'a.com': 3 * S },
    ],
    [
      'Linux: WINDOW_ID_NONE then the next window, which reports',
      [
        [0, presence(1)],
        [3 * S, { kind: 'windowFocus', windowId: null }],
        [3 * S, { kind: 'windowFocus', windowId: 20 }],
        [3 * S, presence(3)],
        [5 * S, { kind: 'removed', tabId: 3 }],
      ],
      { 'a.com': 3 * S, 'c.com': 2 * S },
    ],
    [
      'removing the open tab closes it',
      [
        [0, presence(1)],
        [6 * S, { kind: 'removed', tabId: 1 }],
        [9 * S, { kind: 'removed', tabId: 1 }],
      ],
      { 'a.com': 6 * S },
    ],
    [
      'removing another tab does not',
      [
        [0, presence(1)],
        [2 * S, { kind: 'removed', tabId: 2 }],
        [5 * S, presence(1, { visible: false })],
      ],
      { 'a.com': 5 * S },
    ],
    [
      'navigating away from the site closes; within it does not',
      [
        [0, presence(1)],
        [2 * S, { kind: 'navigated', tabId: 1, site: 'a.com' }],
        [5 * S, { kind: 'navigated', tabId: 1, site: null }],
        [9 * S, presence(1, { visible: false })],
      ],
      { 'a.com': 5 * S },
    ],
    [
      'blocking closes, and unblocking reopens',
      [
        [0, presence(1)],
        [4 * S, presence(1, { blocked: true })],
        [6 * S, presence(1)],
        [7 * S, presence(1, { visible: false })],
      ],
      { 'a.com': 5 * S },
    ],
    [
      'the backstop closes a site over its limit',
      [
        [0, presence(1)],
        [4 * S, { kind: 'overLimit', tabId: 1 }],
        [6 * S, { kind: 'overLimit', tabId: 1 }],
      ],
      { 'a.com': 4 * S },
    ],
    [
      'locking closes at once',
      [
        [0, presence(1)],
        [4 * S, { kind: 'idle', state: 'locked' }, 'locked'],
        [9 * S, presence(1), 'locked'],
      ],
      { 'a.com': 4 * S },
    ],
    [
      'idle closes a page without media (away.ts trims it back to the last input)',
      [
        [0, presence(1)],
        [4 * S, { kind: 'idle', state: 'idle' }, 'idle'],
        [9 * S, presence(1), 'idle'],
      ],
      { 'a.com': 4 * S },
    ],
    [
      'idle keeps a page playing media open, a lock does not',
      [
        [0, presence(1, { media: true })],
        [4 * S, { kind: 'idle', state: 'idle' }, 'idle'],
        [9 * S, { kind: 'idle', state: 'locked' }, 'locked'],
      ],
      { 'a.com': 9 * S },
    ],
    [
      'media stopping while idle closes',
      [
        [0, presence(1, { media: true })],
        [4 * S, { kind: 'idle', state: 'idle' }, 'idle'],
        [7 * S, presence(1), 'idle'],
      ],
      { 'a.com': 7 * S },
    ],
    [
      'checkpoints credit as they go and the total is unchanged',
      [
        [0, presence(1)],
        [CHECKPOINT_MS, { kind: 'checkpoint' }],
        [2 * CHECKPOINT_MS, { kind: 'checkpoint' }],
        [2 * CHECKPOINT_MS + 5 * S, presence(1, { visible: false })],
      ],
      { 'a.com': 2 * CHECKPOINT_MS + 5 * S },
    ],
    [
      'a late alarm (61 s after the last checkpoint) credits in full',
      [
        [0, presence(1)],
        [61 * S, { kind: 'checkpoint' }],
        [61 * S + 5 * S, presence(1, { visible: false })],
      ],
      { 'a.com': 66 * S },
    ],
    [
      'just within SUSPEND_GAP_MS still credits in full',
      [
        [0, presence(1)],
        [SUSPEND_GAP_MS, { kind: 'checkpoint' }],
        [SUSPEND_GAP_MS, { kind: 'removed', tabId: 1 }],
      ],
      { 'a.com': SUSPEND_GAP_MS },
    ],
    [
      'a 10-minute gap (sleep without a lock) credits only up to the last checkpoint',
      [
        [0, presence(1)],
        [CHECKPOINT_MS, { kind: 'checkpoint' }],
        [CHECKPOINT_MS + 10 * 60 * S, { kind: 'checkpoint' }],
      ],
      { 'a.com': CHECKPOINT_MS },
    ],
    [
      'a gap ending in a closing event credits only up to the last checkpoint',
      [
        [0, presence(1)],
        [CHECKPOINT_MS, { kind: 'checkpoint' }],
        [CHECKPOINT_MS + 10 * 60 * S, { kind: 'windowFocus', windowId: null }],
      ],
      { 'a.com': CHECKPOINT_MS },
    ],
    [
      'a page report counts as a checkpoint: the gap is measured from it',
      [
        [0, presence(1)],
        [50 * S, presence(1)],
        [50 * S + 80 * S, { kind: 'checkpoint' }],
        [140 * S, { kind: 'removed', tabId: 1 }],
      ],
      { 'a.com': 140 * S },
    ],
    [
      'waking and carrying on: the sleep is dropped, use after it counts',
      [
        [0, presence(1)],
        [CHECKPOINT_MS, { kind: 'checkpoint' }],
        // Wake after 10 minutes: the page reports first, starting afresh.
        [CHECKPOINT_MS + 600 * S, presence(1)],
        [CHECKPOINT_MS + 600 * S + CHECKPOINT_MS, { kind: 'checkpoint' }],
        [CHECKPOINT_MS + 600 * S + CHECKPOINT_MS + 5 * S, presence(1, { visible: false })],
      ],
      { 'a.com': CHECKPOINT_MS + CHECKPOINT_MS + 5 * S },
    ],
    [
      'a sleep of an hour without a lock counts none of it',
      [
        [0, presence(1)],
        [CHECKPOINT_MS, { kind: 'checkpoint' }],
        [3600 * S, { kind: 'checkpoint' }],
      ],
      { 'a.com': CHECKPOINT_MS },
    ],
    [
      'a clock jumping back credits nothing',
      [
        [0, presence(1)],
        [CHECKPOINT_MS, { kind: 'checkpoint' }],
        [-5 * S, { kind: 'checkpoint' }],
      ],
      { 'a.com': CHECKPOINT_MS },
    ],
    ['a checkpoint with nothing open does nothing', [[0, { kind: 'checkpoint' }]], {}],
    [
      'a late hidden report from a replaced document changes nothing',
      [
        [0, presence(1, {}, 'old')],
        [2 * S, presence(1, {}, 'new')],
        [2 * S, presence(1, { visible: false, departing: true }, 'old')],
        [5 * S, presence(1, { visible: false }, 'new')],
      ],
      { 'a.com': 5 * S },
    ],
    [
      'a departing report never accrues, whatever it says',
      [
        [0, presence(1)],
        [3 * S, presence(1, { departing: true })],
        [5 * S, presence(1, { departing: true })],
      ],
      { 'a.com': 3 * S },
    ],
  ])('%s', (_name, events, expected) => {
    expect(credited(run(events).credits)).toEqual(expected)
  })

  it('never has two intervals open: two windows reporting at once alternate, never overlap', () => {
    const events: Timed[] = []
    for (let t = 0; t < 60; t++) {
      events.push([t * S, presence(t % 2 === 0 ? 1 : 3)])
    }
    events.push([60 * S, { kind: 'windowFocus', windowId: null }])
    const { credits } = run(events)
    const total = credits.reduce((sum, c) => sum + c.end - c.start, 0)
    expect(total).toBe(60 * S)
    const sorted = [...credits].sort((a, b) => a.start - b.start)
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.start).toBeGreaterThanOrEqual(sorted[i - 1]!.end)
    }
  })

  it('splits an interval when media starts or stops, flagged as it accrued', () => {
    const { credits } = run([
      [0, presence(1)],
      [3 * S, presence(1, { media: true })],
      [5 * S, presence(1, { media: true })],
      [8 * S, presence(1, { visible: false, media: true })],
    ])
    expect(credits).toEqual([
      { site: 'a.com', start: T, end: T + 3 * S, media: false },
      { site: 'a.com', start: T + 3 * S, end: T + 8 * S, media: true },
    ])
  })

  it('splits nothing at midnight itself: a checkpoint across it credits one interval, which the ledger splits by hour', () => {
    const midnight = new Date(2026, 5, 11).getTime()
    const { credits } = run([
      [midnight - T - 30 * S, presence(1)],
      [midnight - T + 30 * S, { kind: 'checkpoint' }],
    ])
    expect(credits).toEqual([{ site: 'a.com', start: midnight - 30 * S, end: midnight + 30 * S, media: false }])
  })
})

describe('probes and pushes', () => {
  it('asks the newly active tab, or the tabs of a newly focused window, to report', () => {
    const seen = run([
      [0, presence(1)],
      [0, presence(2, { visible: false })],
      [0, presence(3, { focused: false })],
    ]).state
    expect(step(seen, { kind: 'activated', tabId: 2, windowId: 10 }, T, 'active').probe).toEqual([2])
    expect(step(seen, { kind: 'activated', tabId: 9, windowId: 10 }, T, 'active').probe).toEqual([])
    expect(step(seen, { kind: 'windowFocus', windowId: 20 }, T, 'active').probe).toEqual([3])
    expect(step(seen, { kind: 'windowFocus', windowId: 10 }, T, 'active').probe).toEqual([1, 2])
    expect(step(seen, { kind: 'windowFocus', windowId: null }, T, 'active').probe).toEqual([])
  })

  it('back at the computer, asks the page last seen in use', () => {
    const { state } = run([
      [0, presence(1)],
      [5 * S, presence(3)],
      [6 * S, { kind: 'idle', state: 'locked' }, 'locked'],
    ])
    expect(state.open).toBeNull()
    expect(step(state, { kind: 'idle', state: 'idle' }, T + 7 * S, 'idle').probe).toEqual([3])
    expect(step(state, { kind: 'idle', state: 'active' }, T + 7 * S, 'active').probe).toEqual([3])
    expect(step(state, { kind: 'idle', state: 'locked' }, T + 7 * S, 'locked').probe).toEqual([])
  })

  it('back at the computer after the clock went back, asks the page seen since', () => {
    const { state } = run([
      [3600 * S, presence(3)],
      [3601 * S, { kind: 'idle', state: 'locked' }, 'locked'],
      // The clock goes back an hour.
      [5 * S, presence(1)],
      [6 * S, { kind: 'idle', state: 'locked' }, 'locked'],
    ])
    expect(step(state, { kind: 'idle', state: 'active' }, T + 7 * S, 'active').probe).toEqual([1])
  })

  it('after a sleep gap, closes and asks the page again', () => {
    const { probes, state } = run([
      [0, presence(1)],
      [3600 * S, { kind: 'checkpoint' }],
    ])
    expect(state.open).toBeNull()
    expect(probes.at(-1)).toEqual([1])
  })

  it('tells a page when its interval closes, or at a checkpoint', () => {
    const { pushes } = run([
      [0, presence(1)],
      [CHECKPOINT_MS, { kind: 'checkpoint' }],
      [CHECKPOINT_MS + S, presence(2)],
    ])
    expect(pushes).toEqual([[], [1], [1]])
  })

  it('forgets a removed tab, and a tab that navigated to another site', () => {
    const { state } = run([
      [0, presence(1)],
      [0, presence(2, { visible: false })],
      [S, { kind: 'removed', tabId: 1 }],
      [S, { kind: 'navigated', tabId: 2, site: 'elsewhere.com' }],
    ])
    expect(state.tabs).toEqual({})
  })

  it('keeps a removed tab forgotten when its last page’s hiding arrives late', () => {
    const { state } = run([
      [0, presence(1)],
      [S, { kind: 'removed', tabId: 1 }],
      [S, presence(1, { visible: false, departing: true })],
    ])
    expect(state.tabs).toEqual({})
  })

  it('X1: forgets a tab whose page no grant covers, closing its interval', () => {
    const untracked = (tabId: number, doc: string, departing: boolean): TrackerEvent => ({
      kind: 'untracked',
      tabId,
      doc,
      departing,
    })
    const { state, credits, pushes } = run([
      [0, presence(1)],
      [0, presence(2, { visible: false })],
      [0, presence(3, { visible: false })],
      [3 * S, untracked(1, 'doc-other', false)],
      // A departing page: only the document the tab last heard from.
      [3 * S, untracked(2, 'doc-other', true)],
      [3 * S, untracked(3, 'doc-3', true)],
    ])
    expect(credited(credits)).toEqual({ 'a.com': 3 * S })
    expect(state).toEqual({ tabs: { 2: { ...attest(2, { visible: false }), at: T } }, open: null })
    expect(pushes.slice(3)).toEqual([[], [], []])
  })

  it('keeps the attestation of a tab navigating within its site', () => {
    const { state } = run([
      [0, presence(2, { visible: false })],
      [S, { kind: 'navigated', tabId: 2, site: 'b.com' }],
    ])
    expect(Object.keys(state.tabs)).toEqual(['2'])
  })
})

describe('restart', () => {
  it('resumes from the persisted state as if never stopped', () => {
    const events: Timed[] = [
      [0, presence(1)],
      [CHECKPOINT_MS, { kind: 'checkpoint' }],
      [CHECKPOINT_MS + 20 * S, presence(1, { visible: false })],
    ]
    const straight = run(events)
    // Stopped after the checkpoint: the state goes through storage (JSON)
    // and is read back by a fresh worker.
    const first = run(events.slice(0, 2))
    const stored = normalizeTracker(JSON.parse(JSON.stringify(first.state)))
    const resumed = run(events.slice(2), stored)
    expect([...first.credits, ...resumed.credits]).toEqual(straight.credits)
    expect(resumed.state).toEqual(straight.state)
  })

  it('reads a missing or malformed state as empty, dropping only what is malformed', () => {
    expect(normalizeTracker(undefined)).toEqual(initialTracker())
    expect(normalizeTracker('x')).toEqual(initialTracker())
    const good = attest(1)
    expect(
      normalizeTracker({
        tabs: { 1: good, 2: { ...good, at: 'now' }, 3: null, 4: { ...good, site: 4 }, 5: { ...good, media: 1 } },
        open: { tabId: 1, windowId: 10, doc: 'd', site: 'a.com', media: false, since: 'x', checkpoint: 0 },
      })
    ).toEqual({ tabs: { 1: good }, open: null })
    expect(normalizeTracker({ tabs: [], open: { tabId: 'x' } })).toEqual(initialTracker())
    expect(normalizeTracker({ open: { site: 'a.com', doc: '', tabId: 1, windowId: 1, media: 'no' } })).toEqual(
      initialTracker()
    )
  })
})

describe('the bound on time lost to a crash', () => {
  it('is one checkpoint period: everything before the last checkpoint is credited', () => {
    // An hour of use with checkpoints every minute; the browser dies at a
    // random moment between two of them. Everything credited survives (it
    // is in storage.local); the open interval is lost with storage.session.
    for (const crashAfter of [0, 1, 17 * S, CHECKPOINT_MS - 1]) {
      const events: Timed[] = [[0, presence(1)]]
      for (let m = 1; m <= 60; m++) {
        events.push([m * CHECKPOINT_MS, { kind: 'checkpoint' }])
      }
      const { credits, state } = run(events)
      const crash = 60 * CHECKPOINT_MS + crashAfter
      const used = crash
      const kept = credits.reduce((sum, c) => sum + c.end - c.start, 0)
      expect(used - kept).toBe(crashAfter)
      expect(used - kept).toBeLessThan(CHECKPOINT_MS)
      expect(state.open?.since).toBe(T + 60 * CHECKPOINT_MS)
    }
  })
})

describe('P2: a tab the browser hears', () => {
  const MIN = 60 * S

  it('counts idle time while the tab is audible, media the page sees or not', () => {
    const { state, credits } = run([
      [0, presence(1, { audible: true })],
      [MIN, presence(1, { audible: true }), 'idle'],
      [2 * MIN, { kind: 'checkpoint' }, 'idle'],
    ])
    expect(state.open).toMatchObject({ tabId: 1, media: true })
    expect(credited(credits)).toEqual({ 'a.com': 2 * MIN })
  })

  it('keeps the browser’s word over a probe’s answer, and asks again when it changes', () => {
    const first = run([[0, presence(1)]])
    const heard = step(first.state, { kind: 'audible', tabId: 1, audible: true }, T + S, 'active')
    expect(heard.probe).toEqual([1])
    expect(heard.state.tabs['1']).toMatchObject({ audible: true, media: false })
    // The same news again, or about a tab that never reported: nothing.
    expect(step(heard.state, { kind: 'audible', tabId: 1, audible: true }, T + S, 'active').probe).toEqual([])
    expect(step(heard.state, { kind: 'audible', tabId: 9, audible: true }, T + S, 'active').probe).toEqual([])
    // The page's answer: its media piece starts.
    const answered = step(heard.state, presence(1, { audible: true }), T + 2 * S, 'active')
    expect(answered.state.open).toMatchObject({ media: true, since: T + 2 * S })
    expect(credited(answered.credits)).toEqual({ 'a.com': 2 * S })
  })

  it('reads a stored report without the field as not heard', () => {
    const old: Partial<Attest> = attest(1)
    delete old.audible
    expect(normalizeTracker({ tabs: { '1': old }, open: null }).tabs['1']).toMatchObject({ audible: false })
  })
})
