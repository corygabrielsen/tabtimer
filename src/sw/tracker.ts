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
import { overAt, parsePresence, type StatePush, type TabState, type TodayTotals } from '../core/messages'
import { dayTotal, siteTotal, withTimeAt, type DayUsage, type Prefs } from '../core/schema'
import { trackedSite, type Site } from '../core/site'
import { creditEnd, step, type Attest, type Open, type TrackerEvent, type TrackerState } from '../core/tracker'
import type { Ledger, Tx } from './ledger'

export type TrackerDeps = {
  ledger: Pick<Ledger, 'transaction'>
  // Send a page its state; resolves with its reply (undefined if none).
  // `doc` targets that document ('' = the tab's top frame).
  send: (tabId: number, doc: string, push: StatePush) => Promise<unknown>
  // Keep the checkpoint alarm running (true) or not. Called in the queue,
  // so the alarm follows the state each transaction leaves.
  alarm: (on: boolean) => Promise<void>
  // The tracked grants (sw/grants.ts): the all-sites total is theirs.
  granted: () => Promise<readonly string[]>
  // Mute a tab while its page is blocked (on), so media the page can't
  // reach stops too, and undo that once it isn't. Called in the queue.
  mute: (tabId: number, on: boolean) => Promise<void>
}

export type Tracker = ReturnType<typeof createTracker>

// `reply`: the reporting page's own state, if one reported.
type Outcome = { state: TrackerState; states: Map<number, TabState>; probe: number[]; reply: TabState | null }

// A page the transaction answers: its tab, site and document.
type Reporter = { tabId: number; site: Site; doc: string }

const everySite = () => true

// A failure that changes nothing here (a tab gone, an alarm not set).
const ignore = () => undefined

// The open interval's uncredited part, today's share of it.
function uncredited(open: Open, now: number): number {
  return Math.max(0, creditEnd(open, now) - Math.max(open.since, startOfDay(now)))
}

export function createTracker(deps: TrackerDeps) {
  const { ledger } = deps

  // Which sites count toward the all-sites total. Grants that can't be read
  // count every site.
  const counted = () => deps.granted().then(trackedSite, () => everySite)

  // Builds tab states from one reading of storage per transaction.
  function stater(tx: Tx) {
    let ctx: Promise<[DayUsage, Limits, Prefs, (site: Site) => boolean]> | null = null
    return async (tabId: number, attest: Pick<Attest, 'site'>, s: TrackerState): Promise<TabState> => {
      // Grants that can't be read count every site.
      ctx ??= Promise.all([tx.today(), tx.limits(), tx.prefs(), counted()])
      const [usage, limits, prefs, counts] = await ctx
      const open = s.open?.tabId === tabId ? s.open : null
      const extra = open ? uncredited(open, tx.now) : 0
      const today = siteTotal(usage, attest.site) + extra
      // Sites no longer tracked don't count toward the all-sites limit.
      const globalToday = dayTotal(usage, counts) + extra
      const block = blockAt(limits, attest.site, today, globalToday, tx.now, open !== null)
      return {
        site: attest.site,
        day: dayOf(tx.now),
        asOf: tx.now,
        seq: tx.seq,
        today,
        globalToday,
        running: open !== null,
        blockAt: block?.at ?? null,
        limit: block ? { scope: block.scope, ms: block.limit } : null,
        hours: withTimeAt(usage[attest.site], tx.now, extra),
        prefs,
      }
    }
  }

  // One event (or none: just re-check), in the queue. `tell` lists tabs to
  // build a state for besides those the step changed.
  function run(
    event: TrackerEvent | null,
    tell: (s: TrackerState) => number[] = () => [],
    reporter: Reporter | null = null
  ): Promise<Outcome> {
    return ledger.transaction(async (tx) => {
      const before = tx.tracker
      let state = before
      const wasOpen = state.open !== null
      if (event?.kind === 'idle') {
        await tx.observeIdle(event.state)
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
        if (overAt(s, tx.now, 'holds')) {
          await apply({ kind: 'overLimit', tabId: open.tabId })
        }
      }
      tx.tracker = state
      // The alarm only when the interval opened or closed (resume() puts it
      // right on every worker start).
      if (wasOpen !== (state.open !== null)) {
        await deps.alarm(state.open !== null).catch(ignore)
      }
      // A tab is muted while its page reports blocked, and no longer once it
      // doesn't (or is gone).
      for (const id of new Set([...Object.keys(before.tabs), ...Object.keys(state.tabs)])) {
        const blocked = state.tabs[id]?.blocked === true
        if ((before.tabs[id]?.blocked === true) !== blocked) {
          await deps.mute(Number(id), blocked).catch(ignore)
        }
      }
      const states = new Map<number, TabState>()
      for (const id of new Set([...push, ...probe, ...tell(state)])) {
        const attest = state.tabs[String(id)]
        if (attest) {
          states.set(id, await stateOf(id, attest, state))
        }
      }
      // The reporter's answer, whatever the step made of its report (a
      // departing document's is dropped, its tab perhaps gone): its site's
      // state, running only if the open interval is its document's.
      let reply: TabState | null = null
      if (reporter) {
        const open = state.open
        const mine = open?.tabId === reporter.tabId && open.doc === reporter.doc && open.site === reporter.site
        reply = await stateOf(reporter.tabId, reporter, mine ? state : { ...state, open: null })
      }
      return { state, states, probe, reply }
    })
  }

  // Send an outcome's messages, outside the queue. Probed pages that reply
  // report their presence, which runs as an event of its own (and is then
  // told its state).
  async function settle(outcome: Outcome, skip: number | null = null): Promise<void> {
    const probes = new Set(outcome.probe)
    await Promise.all(
      [...outcome.states].map(async ([tabId, state]) => {
        if (tabId === skip) {
          return
        }
        const attest = outcome.state.tabs[String(tabId)]!
        const probe = probes.has(tabId)
        const reply = await deps.send(tabId, attest.doc, { type: 'state', state, probe }).catch(ignore)
        const presence = probe ? parsePresence(reply) : null
        if (presence) {
          await report(tabId, { ...attest, ...presence }, true)
        }
      })
    )
  }

  // A page's report: from a message (the reply carries its state, and
  // never waits on telling the other tabs theirs) or a probe's answer
  // (told by push).
  async function report(tabId: number, attest: Omit<Attest, 'at'>, pushed: boolean): Promise<TabState> {
    const { site, doc } = attest
    const outcome = await run({ kind: 'presence', tabId, attest: { ...attest, at: 0 } }, () => [tabId], {
      tabId,
      site,
      doc,
    })
    const rest = { ...outcome, probe: outcome.probe.filter((id) => id !== tabId) }
    if (pushed) {
      await settle(rest)
    } else {
      void settle(rest, tabId).catch(ignore)
    }
    return outcome.reply!
  }

  // Every page that reported.
  const allTabs = (s: TrackerState) => Object.keys(s.tabs).map(Number)

  return {
    // A content script's presence message; replies with the tab's state.
    presence: (tabId: number, attest: Omit<Attest, 'at'>): Promise<TabState> => report(tabId, attest, false),

    // A content script on a page no grant covers spoke: forget its tab.
    untracked: async (tabId: number, doc: string, departing: boolean): Promise<void> =>
      settle(await run({ kind: 'untracked', tabId, doc, departing })),

    // An extension page's question: the state a tab on `site` is told. Its
    // open interval counts only if it is on that site.
    tabState: (tabId: number, site: Site): Promise<TabState> =>
      ledger.transaction((tx) => {
        const s = tx.tracker
        const known = s.tabs[String(tabId)]?.site === site
        return stater(tx)(tabId, { site }, known ? s : { ...s, open: null })
      }),

    // An extension page's question: every site's time today, the open
    // interval's included.
    todayTotals: (): Promise<TodayTotals> =>
      ledger.transaction(async (tx) => {
        const usage = await tx.today()
        const sites: Record<Site, number> = {}
        for (const site of Object.keys(usage)) {
          sites[site] = siteTotal(usage, site)
        }
        const open = tx.tracker.open
        if (open) {
          sites[open.site] = (sites[open.site] ?? 0) + uncredited(open, tx.now)
        }
        return { day: dayOf(tx.now), asOf: tx.now, seq: tx.seq, running: open?.site ?? null, sites }
      }),

    // A block screen took a snooze: blocking stops for SNOOZE_MS.
    snooze: (): Promise<void> => ledger.transaction((tx) => tx.snooze()),

    // A browser event (tab, window, idle, alarm).
    dispatch: async (event: TrackerEvent): Promise<void> => settle(await run(event)),

    // Limits, the snooze or the prefs changed: every page that reported
    // learns its new state (and an open interval now over its limit closes).
    refresh: async (): Promise<void> => settle(await run(null, allTabs)),

    // The worker started: put the checkpoint alarm in line with the state.
    resume: (): Promise<void> => ledger.transaction((tx) => deps.alarm(tx.tracker.open !== null).catch(ignore)),
  }
}
