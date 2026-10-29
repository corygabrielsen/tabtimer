// The service worker's side of active time: runs every event through the
// pure reducer (core/tracker.ts) inside the ledger's queue, credits what it
// closes, and tells pages their new state.
//
// No globals: the tracker state lives in storage.session (sw/ledger.ts), so
// a worker stopped at any moment resumes where it was on the next event.
// Pages are told their state by message; a page's reply is its presence,
// which is how the worker asks a page to report again (`probe`).
import { dayOf, startOfDay } from '../core/day'
import { blockAt, type Limits } from '../core/limits'
import { parsePresence, type StatePush, type TabState } from '../core/messages'
import { dayTotal, siteTotal, type DayUsage, type Prefs } from '../core/schema'
import type { Site } from '../core/site'
import { creditEnd, step, type Attest, type TrackerEvent, type TrackerState } from '../core/tracker'
import type { Ledger, Tx } from './ledger'

export type TrackerDeps = {
  ledger: Pick<Ledger, 'transaction'>
  // Send a page its state; resolves with its reply (undefined if none).
  // `doc` targets that document ('' = the tab's top frame).
  send: (tabId: number, doc: string, push: StatePush) => Promise<unknown>
  // Keep the checkpoint alarm running (true) or not.
  alarm: (on: boolean) => Promise<void>
}

export type Tracker = ReturnType<typeof createTracker>

// `toggled`: an interval opened where none was, or the reverse.
type Outcome = { state: TrackerState; states: Map<number, TabState>; probe: number[]; toggled: boolean }

export function createTracker(deps: TrackerDeps) {
  const { ledger } = deps

  // Builds tab states from one reading of storage per transaction.
  function stater(tx: Tx) {
    let ctx: Promise<[DayUsage, Limits, Prefs]> | null = null
    return async (tabId: number, attest: Attest, s: TrackerState): Promise<TabState> => {
      ctx ??= Promise.all([tx.today(), tx.limits(), tx.prefs()])
      const [usage, limits, prefs] = await ctx
      const open = s.open?.tabId === tabId ? s.open : null
      // The open interval's uncredited part, today's share of it.
      const end = open ? creditEnd(open, tx.now) : 0
      const extra = open ? Math.max(0, end - Math.max(open.since, startOfDay(tx.now))) : 0
      const today = siteTotal(usage, attest.site) + extra
      const globalToday = dayTotal(usage) + extra
      const block = blockAt(limits, attest.site, today, globalToday, tx.now, open !== null)
      return {
        site: attest.site,
        day: dayOf(tx.now),
        asOf: tx.now,
        today,
        globalToday,
        running: open !== null,
        blockAt: block?.at ?? null,
        limit: block ? { scope: block.scope, ms: block.limit } : null,
        prefs,
      }
    }
  }

  // One event (or none: just re-check), in the queue. `tell` lists tabs to
  // build a state for besides those the step changed.
  function run(event: TrackerEvent | null, tell: (s: TrackerState) => number[] = () => []): Promise<Outcome> {
    return ledger.transaction(async (tx) => {
      let state = tx.tracker
      const wasOpen = state.open !== null
      if (event?.kind === 'idle') {
        await tx.observeIdle(event.state)
      } else if (event?.kind === 'reset') {
        await tx.resetToday(event.site)
      }
      const idle = tx.idleState()
      const push = new Set<number>()
      const apply = async (e: TrackerEvent) => {
        const result = step(state, e, tx.now, idle)
        await tx.credit(result.credits)
        state = result.state
        result.push.forEach((id) => push.add(id))
        return result.probe
      }
      const probe = event ? await apply(event) : []
      const stateOf = stater(tx)
      // The backstop: an open interval on a site already over its limit
      // closes, whatever the page says.
      const open = state.open
      const openAttest = open ? state.tabs[String(open.tabId)] : undefined
      if (open && openAttest) {
        const s = await stateOf(open.tabId, openAttest, state)
        if (s.blockAt !== null && s.blockAt <= tx.now) {
          await apply({ kind: 'overLimit', tabId: open.tabId })
        }
      }
      tx.tracker = state
      const states = new Map<number, TabState>()
      for (const id of new Set([...push, ...probe, ...tell(state)])) {
        const attest = state.tabs[String(id)]
        if (attest) {
          states.set(id, await stateOf(id, attest, state))
        }
      }
      return { state, states, probe, toggled: wasOpen !== (state.open !== null) }
    })
  }

  // Apply an outcome outside the queue: the alarm (only when the interval
  // opened or closed; resume() puts it right on every worker start), then
  // the messages. Probed pages that reply report their presence, which runs
  // as an event of its own (and is then told its state).
  async function settle(outcome: Outcome, skip: number | null = null): Promise<void> {
    if (outcome.toggled) {
      await deps.alarm(outcome.state.open !== null).catch(() => undefined)
    }
    const probes = new Set(outcome.probe)
    await Promise.all(
      [...outcome.states].map(async ([tabId, state]) => {
        if (tabId === skip) {
          return
        }
        const attest = outcome.state.tabs[String(tabId)]!
        const reply = await deps.send(tabId, attest.doc, { type: 'state', state }).catch(() => undefined)
        const presence = probes.has(tabId) ? parsePresence(reply) : null
        if (presence) {
          await report(tabId, { ...attest, ...presence }, true)
        }
      })
    )
  }

  // A page's report: from a message (the reply carries its state) or a
  // probe's answer (told by push).
  async function report(tabId: number, attest: Omit<Attest, 'at'>, pushed: boolean): Promise<TabState> {
    const outcome = await run({ kind: 'presence', tabId, attest: { ...attest, at: 0 } }, () => [tabId])
    await settle({ ...outcome, probe: outcome.probe.filter((id) => id !== tabId) }, pushed ? null : tabId)
    return outcome.states.get(tabId)!
  }

  // Every page that reported.
  const allTabs = (s: TrackerState) => Object.keys(s.tabs).map(Number)

  return {
    // A content script's presence message; replies with the tab's state.
    presence: (tabId: number, attest: Omit<Attest, 'at'>): Promise<TabState> => report(tabId, attest, false),

    // A browser event (tab, window, idle, alarm).
    dispatch: async (event: TrackerEvent): Promise<void> => settle(await run(event)),

    // Limits, the snooze or the prefs changed: every page that reported
    // learns its new state (and an open interval now over its limit closes).
    refresh: async (): Promise<void> => settle(await run(null, allTabs)),

    // Zero one site's time today, including the open interval's uncredited
    // part, and tell every page (the total across sites changed too).
    resetToday: async (site: Site): Promise<void> => settle(await run({ kind: 'reset', site }, allTabs)),

    // The worker started: put the checkpoint alarm in line with the state.
    resume: async (): Promise<void> => {
      const { open } = await ledger.transaction(async (tx) => tx.tracker)
      await deps.alarm(open !== null).catch(() => undefined)
    },
  }
}
