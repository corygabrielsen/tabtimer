// One handler per message type, behind a sender policy. Order of checks:
//   1. the sender is this extension (sender.id), else 'forbidden';
//   2. the payload parses (core/requests.ts parseRequest), else 'bad_request';
//   3. the sender may send this type (SENDERS): an extension page is
//      recognized by its URL; a content script by a tab, its document's
//      lifecycle and a trackable URL (core/site.ts), and its site is taken
//      from that URL, never from the payload; else 'forbidden';
//   4. a content script's URL is covered by the current grants, else
//      'untracked' (the page stops, and the worker forgets its tab);
//   5. the handler runs; a throw is 'internal'.
import { SENDERS, type Contract, type MessageType, type Origin, type Page, type RequestOf } from '../core/messages'
import { parseRequest } from '../core/requests'
import { isTracked, trackableSiteOfUrl, type Site } from '../core/site'
import type { Handler, Sender } from '../chrome/bus'
import type { Ledger } from './ledger'
import type { Tracker } from './tracker'

export type RouterDeps = {
  ledger: Pick<Ledger, 'setLimit' | 'setPrefs'>
  tracker: Pick<Tracker, 'presence' | 'untracked' | 'tabState' | 'todayTotals' | 'snooze'>
  // The tracked grants (sw/grants.ts).
  granted: () => Promise<readonly string[]>
  extensionId: string
  // chrome.runtime.getURL(''): the prefix of every extension page URL.
  extensionUrl: string
  open: (page: Page) => Promise<void>
  // Close a tab (a block screen's Close tab).
  closeTab: (tabId: number) => Promise<void>
}

// Where a request came from, and for a content script the site it runs on
// and its tab (audible: the browser hears it).
type Tab = { id: number; windowId: number; doc: string; departing: boolean; audible: boolean }
type Context = { origin: Origin; url: string; site: Site | null; tab: Tab | null }

type Handlers = { [K in MessageType]: (req: RequestOf<K>, ctx: Context) => Promise<Contract[K]['res']> }

// Where the sending document is in its life. The tab's shown page is
// 'active' in frame 0. A page being navigated away from sends its last
// report on pagehide, which arrives once it is in the back/forward cache
// ('cached') or unloading ('pending_deletion'), no longer frame 0: it is
// departing (core/tracker.ts). Anything else (a subframe, a prerender) is
// refused. The content script is registered for top frames only, so a
// departing document can't be a subframe running it.
function departing(sender: Sender): boolean | null {
  switch (sender.documentLifecycle) {
    case 'active':
      return sender.frameId === 0 ? false : null
    case 'cached':
    case 'pending_deletion':
      return true
    default:
      return null
  }
}

function classify(sender: Sender, extensionUrl: string): Context | null {
  const url = sender.url ?? ''
  if (url.startsWith(extensionUrl)) {
    return { origin: 'extension', url, site: null, tab: null }
  }
  const site = trackableSiteOfUrl(url)
  const tab = sender.tab
  const leaving = departing(sender)
  if (typeof tab?.id === 'number' && leaving !== null && site !== null) {
    return {
      origin: 'content',
      url,
      site,
      tab: {
        id: tab.id,
        windowId: tab.windowId ?? -1,
        doc: sender.documentId ?? '',
        departing: leaving,
        audible: tab.audible === true,
      },
    }
  }
  return null
}

export function createRouter(deps: RouterDeps): Handler {
  const { ledger, tracker } = deps
  // Content-only handlers can rely on ctx.site and ctx.tab: classify set them.
  const handlers: Handlers = {
    presence: ({ visible, focused, media, blocked }, ctx) => {
      const { id, ...tab } = ctx.tab!
      return tracker.presence(id, { site: ctx.site!, ...tab, visible, focused, media, blocked })
    },
    tabState: ({ tabId, site }) => tracker.tabState(tabId, site),
    todayTotals: () => tracker.todayTotals(),
    setLimit: async (edit) => {
      await ledger.setLimit(edit)
      return null
    },
    snooze: async (_req, ctx) => {
      await tracker.snooze(ctx.site!)
      return null
    },
    closeTab: async (_req, ctx) => {
      await deps.closeTab(ctx.tab!.id)
      return null
    },
    setPrefs: async (change) => {
      await ledger.setPrefs(change)
      return null
    },
    open: async ({ page }) => {
      await deps.open(page)
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
      if (ctx.origin === 'content' && !isTracked(await deps.granted(), ctx.url)) {
        const { id, doc, departing } = ctx.tab!
        await tracker.untracked(id, doc, departing)
        return { ok: false, error: 'untracked' }
      }
      const handler = handlers[req.type] as (req: unknown, ctx: Context) => Promise<unknown>
      return { ok: true, value: await handler(req, ctx) } as never
    } catch {
      return { ok: false, error: 'internal' }
    }
  }
}
