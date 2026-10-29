// One handler per message type, behind a sender policy. Order of checks:
//   1. the sender is this extension (sender.id), else 'forbidden';
//   2. the payload parses (core/messages.ts parseRequest), else 'bad_request';
//   3. the sender may send this type (SENDERS): an extension page is
//      recognized by its URL; a content script by a tab, the top frame and
//      an http(s) URL, and its site is taken from that URL, never from the
//      payload; else 'forbidden';
//   4. the handler runs; a throw is 'internal'.
// A page being navigated away from may still report (its last report is
// sent as it is hidden): it is heard as hidden, whatever it says.
import { parseRequest, SENDERS, type Contract, type MessageType, type Origin, type RequestOf } from '../core/messages'
import { siteOf, siteOfUrl, type Site } from '../core/site'
import type { Handler, Sender } from '../chrome/bus'
import type { Ledger } from './ledger'
import type { Tracker } from './tracker'

export type RouterDeps = {
  ledger: Pick<Ledger, 'setLimit' | 'snooze' | 'setPrefs'>
  tracker: Pick<Tracker, 'presence' | 'resetToday'>
  extensionId: string
  // chrome.runtime.getURL(''): the prefix of every extension page URL.
  extensionUrl: string
  openOptions: () => Promise<void>
}

// Where a request came from, and for a content script the site it runs on
// and its tab.
type Tab = { id: number; windowId: number; doc: string; departing: boolean }
type Context = { origin: Origin; site: Site | null; tab: Tab | null }

type Handlers = { [K in MessageType]: (req: RequestOf<K>, ctx: Context) => Promise<Contract[K]['res']> }

class BadRequest extends Error {}

// A site named by an extension page must already be in canonical form.
function canonical(site: Site): Site {
  if (siteOf(site) !== site) {
    throw new BadRequest(site)
  }
  return site
}

// The tab's top frame is frame 0 while its page is the one shown. A page
// being navigated away from (its last report is sent on pagehide) is no
// longer frame 0 by the time the message arrives: it is in the back/forward
// cache or unloading. The content script is registered for top frames only,
// so a departing document can't be a subframe running it.
const DEPARTING = new Set(['cached', 'pending_deletion'])

const isDeparting = (sender: Sender) => DEPARTING.has(sender.documentLifecycle ?? '')

function isTopFrame(sender: Sender): boolean {
  return sender.frameId === 0 || (sender.frameId !== undefined && isDeparting(sender))
}

function classify(sender: Sender, extensionUrl: string): Context | null {
  const url = sender.url ?? ''
  if (url.startsWith(extensionUrl)) {
    return { origin: 'extension', site: null, tab: null }
  }
  const site = siteOfUrl(url)
  const tab = sender.tab
  if (typeof tab?.id === 'number' && isTopFrame(sender) && site !== null) {
    return {
      origin: 'content',
      site,
      tab: { id: tab.id, windowId: tab.windowId ?? -1, doc: sender.documentId ?? '', departing: isDeparting(sender) },
    }
  }
  return null
}

export function createRouter(deps: RouterDeps): Handler {
  const { ledger, tracker } = deps
  // Content-only handlers can rely on ctx.site and ctx.tab: classify set them.
  const handlers: Handlers = {
    presence: ({ visible, focused, media, blocked }, ctx) => {
      const tab = ctx.tab!
      return tracker.presence(
        tab.id,
        { site: ctx.site!, windowId: tab.windowId, doc: tab.doc },
        { visible: visible && !tab.departing, focused, media, blocked }
      )
    },
    resetToday: async (req) => {
      await tracker.resetToday(canonical(req.site))
      return null
    },
    setLimit: (req) =>
      ledger.setLimit(
        req.scope === 'global'
          ? { scope: 'global', ms: req.ms }
          : { scope: 'site', site: canonical(req.site), ms: req.ms }
      ),
    snooze: async () => ({ snoozeUntil: await ledger.snooze() }),
    setPrefs: ({ hidden, scale }) =>
      ledger.setPrefs({ ...(hidden === undefined ? {} : { hidden }), ...(scale === undefined ? {} : { scale }) }),
    openOptions: async () => {
      await deps.openOptions()
      return null
    },
  }

  return async (raw, sender) => {
    if (sender.id !== deps.extensionId) {
      return { ok: false, error: 'forbidden' }
    }
    const req = parseRequest(raw)
    if (!req) {
      return { ok: false, error: 'bad_request' }
    }
    const ctx = classify(sender, deps.extensionUrl)
    if (!ctx || !SENDERS[req.type].includes(ctx.origin)) {
      return { ok: false, error: 'forbidden' }
    }
    try {
      const handler = handlers[req.type] as (req: unknown, ctx: Context) => Promise<unknown>
      return { ok: true, value: await handler(req, ctx) } as never
    } catch (error) {
      return { ok: false, error: error instanceof BadRequest ? 'bad_request' : 'internal' }
    }
  }
}
