import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test'

export const EXTENSION_PATH = path.resolve(import.meta.dirname, '..', 'dist-e2e')

// Mirrors src/core/schema.ts (schema 3). Kept literal so a change to the
// storage layout also fails these tests.
export const SCHEMA_KEY = 'schema'
export const LIMITS_KEY = 'limits'
export const OVERLAY_ID = 'tabtimer-root'
export const BLOCK_ID = 'tabtimer-block'
export const MINUTE = 60_000

type WorkerFixtures = { port: number }
type TestFixtures = {
  context: BrowserContext
  serviceWorker: Worker
  extensionId: string
  // URL of a fixture page on `host` (resolved to the local server).
  site: (host: string, path?: string) => string
}

// Two seconds of silent 8 kHz 8-bit mono PCM: something an <audio> element
// can genuinely play (and loop) without any media files in the repo.
function silentWav(): Buffer {
  const samples = 16_000
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + samples, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(8000, 24) // sample rate
  header.writeUInt32LE(8000, 28) // byte rate
  header.writeUInt16LE(1, 32) // block align
  header.writeUInt16LE(8, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(samples, 40)
  return Buffer.concat([header, Buffer.alloc(samples, 128)])
}

// Pages that scroll the ways real sites do, on a bright background: the
// document itself, <body> as the scroller (html and body sized to the
// viewport, body overflow:auto), and an app shell whose content scrolls in an
// inner element (#shell) while the document stays put.
const TALL = '<div style="height:5000px;width:5000px;background:linear-gradient(#ff0,#0ff)">tall</div>'
const SCROLL_PAGES: Record<string, string> = {
  '/scroll-document': `<style>html,body{background:#fff}</style>${TALL}`,
  '/scroll-body': `<style>html,body{height:100%;margin:0;background:#fff}body{overflow:auto}</style>${TALL}`,
  '/scroll-inner':
    '<style>html,body{height:100%;margin:0;overflow:hidden;background:#fff}' +
    '#shell{position:absolute;inset:0;overflow:auto}</style>' +
    `<div id="shell">${TALL}</div>`,
}

// Every *.test host resolves to the fixture server. Any path serves a plain
// page; /interactive adds focusable controls, looping audio, and a way into
// fullscreen (the button, or the F key like a video player), counting requests
// in window.fullscreenAttempts and entries in window.fullscreenEntries. SCROLL_PAGES serve scrolling layouts.
function startServer(): Promise<Server> {
  const wav = silentWav()
  const server = createServer((req, res) => {
    const host = req.headers.host ?? ''
    if (req.url === '/silence.wav') {
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length })
      res.end(wav)
      return
    }
    const extra =
      SCROLL_PAGES[req.url ?? ''] ??
      (req.url === '/interactive'
        ? '<button id="page-button">page button</button><a id="page-link" href="#x">page link</a>' +
          '<audio id="media" src="/silence.wav" loop></audio>' +
          '<button id="fullscreen-button">fullscreen</button>' +
          `<script>
            window.fullscreenEntries = 0
            window.fullscreenAttempts = 0
            window.pageClicks = 0
            const enter = () => {
              window.fullscreenAttempts++
              document.documentElement.requestFullscreen().catch(() => {})
            }
            document.getElementById('fullscreen-button').addEventListener('click', enter)
            document.getElementById('page-button').addEventListener('click', () => window.pageClicks++)
            document.addEventListener('keydown', (e) => e.key === 'f' && enter())
            document.addEventListener('fullscreenchange', () => document.fullscreenElement && window.fullscreenEntries++)
          </script>`
        : '')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>${host}</title><h1>fixture ${host}</h1>${extra}`)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

// Chromium with the e2e build loaded, on the profile in `userDataDir` ('' =
// a fresh temporary one) and the unpacked extension at `extensionPath`.
export function launch(userDataDir: string, extensionPath = EXTENSION_PATH): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    // Playwright turns the back/forward cache off by default; the content
    // script has to cope with it, so keep Chrome's real behaviour.
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--host-resolver-rules=MAP *.test 127.0.0.1',
      // Let fixture media play() without a user gesture.
      '--autoplay-policy=no-user-gesture-required',
      // Middle-click autoscroll, as on Windows (off by default on Linux).
      '--enable-blink-features=MiddleClickAutoscroll',
    ],
  })
}

// The extension's service worker, once it has finished starting up: the
// content script registration comes last (after storage is checked), so the
// first navigation is already covered.
export async function extensionWorker(context: BrowserContext): Promise<Worker> {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  await test
    .expect(async () => {
      const n = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts().then((s) => s.length))
      test.expect(n).toBe(1)
    })
    .toPass()
  return sw
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  port: [
    async ({}, use) => {
      const server = await startServer()
      await use((server.address() as AddressInfo).port)
      await new Promise((resolve) => server.close(resolve))
    },
    { scope: 'worker' },
  ],

  context: async ({}, use) => {
    // Fresh profile per test: a clean install, empty storage.
    const context = await launch('')
    await use(context)
    await context.close()
  },

  serviceWorker: async ({ context }, use) => {
    await use(await extensionWorker(context))
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host)
  },

  site: async ({ port }, use) => {
    await use((host, path = '/') => `http://${host}:${port}${path}`)
  },
})

export const expect = test.expect

export function seed(sw: Worker, items: Record<string, unknown>): Promise<void> {
  return sw.evaluate((items) => chrome.storage.local.set(items), items)
}

export function read(sw: Worker, key: string): Promise<unknown> {
  return sw.evaluate((key) => chrome.storage.local.get(key).then((items) => items[key]), key)
}

// Today's usage key (one object for every site), dated in the browser's
// local time zone.
export function todayKey(sw: Worker): Promise<string> {
  return sw.evaluate(() => {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `day:${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  })
}

// A storage entry for today's usage: each site's time in the current local
// hour's bucket (of 24), to spread into a seed().
export async function today(sw: Worker, sites: Record<string, number>): Promise<Record<string, unknown>> {
  const hour = await sw.evaluate(() => new Date().getHours())
  const usage = Object.fromEntries(
    Object.entries(sites).map(([site, ms]) => [site, Array.from({ length: 24 }, (_, h) => (h === hour ? ms : 0))])
  )
  return { [await todayKey(sw)]: usage }
}

// A site's stored time today: the sum of its hourly buckets.
export async function readToday(sw: Worker, site: string): Promise<number> {
  const usage = (await read(sw, await todayKey(sw))) as Record<string, number[]> | undefined
  return (usage?.[site] ?? []).reduce((total, ms) => total + ms, 0)
}

// Call the e2e build's test hook (src/sw/testHook.ts) in the worker.
async function callHook(sw: Worker, name: string, arg?: unknown): Promise<void> {
  type Hook = Record<string, (arg: unknown) => unknown>
  await sw.evaluate(([name, arg]) => (globalThis as unknown as { __tabtimerTest: Hook }).__tabtimerTest[name]!(arg), [
    name,
    arg,
  ] as const)
}

export const setIdle = (sw: Worker, state: 'active' | 'idle' | 'locked') => callHook(sw, 'idle', state)
// Credit the open interval now (the minute's checkpoint alarm).
export const checkpoint = (sw: Worker) => callHook(sw, 'checkpoint')
// Move the worker's clock forward: time accrues without waiting it out.
export const advance = (sw: Worker, ms: number) => callHook(sw, 'advance', ms)
// Headless Chromium focuses a window but sends no focus event; the hook
// delivers the one Chrome would.
export const focusWindow = (sw: Worker, windowId: number) => callHook(sw, 'focusWindow', windowId)

// The worker's open interval (in storage.session), or null.
export function openInterval(sw: Worker): Promise<{ windowId: number; media: boolean; since: number } | null> {
  return sw.evaluate(() =>
    chrome.storage.session
      .get('worker')
      .then(
        ({ worker }) =>
          (worker as { tracker?: { open?: { windowId: number; media: boolean; since: number } | null } } | undefined)
            ?.tracker?.open ?? null
      )
  )
}

// The popup acts on the active tab. Opened as a page it would see itself, so
// point it at the open tab whose URL starts with `url`.
export async function openPopup(context: BrowserContext, sw: Worker, extensionId: string, url: string): Promise<Page> {
  const [tab] = await sw.evaluate((url) => chrome.tabs.query({ url }), `${url}*`)
  const popup = await context.newPage()
  await popup.addInitScript(
    ({ id, url }) => {
      const query = chrome.tabs.query.bind(chrome.tabs)
      chrome.tabs.query = ((info: chrome.tabs.QueryInfo, callback?: (tabs: chrome.tabs.Tab[]) => void) => {
        if (info.active && callback) {
          callback([{ id, url } as chrome.tabs.Tab])
          return
        }
        return query(info, callback as never)
      }) as typeof chrome.tabs.query
    },
    { id: tab!.id!, url: tab!.url! }
  )
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  return popup
}

// The overlay and block screen render into closed shadow roots, which page
// script and Playwright locators can't enter. DevTools can: DOM.getDocument
// with pierce returns closed shadow trees too.
type CdpNode = {
  nodeId: number
  nodeType: number
  nodeName: string
  nodeValue: string
  attributes?: string[]
  children?: CdpNode[]
  shadowRoots?: CdpNode[]
}

async function shadowRootOf(page: Page, hostId: string) {
  const cdp = await page.context().newCDPSession(page)
  const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: CdpNode }
  const find = (node: CdpNode): CdpNode | undefined => {
    const attrs = node.attributes ?? []
    for (let i = 0; i < attrs.length; i += 2) {
      if (attrs[i] === 'id' && attrs[i + 1] === hostId) {
        return node
      }
    }
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
      const hit = find(child)
      if (hit) {
        return hit
      }
    }
    return undefined
  }
  return { cdp, shadow: find(root)?.shadowRoots?.[0] }
}

// Visible text inside a host element's closed shadow root ('' if absent).
export async function shadowText(page: Page, hostId: string): Promise<string> {
  const { cdp, shadow } = await shadowRootOf(page, hostId)
  await cdp.detach()
  const parts: string[] = []
  const walk = (node: CdpNode) => {
    // Text nodes only, skipping the <style> element's CSS.
    if (node.nodeType === 3) {
      parts.push(node.nodeValue)
    }
    for (const child of node.children ?? []) {
      if (child.nodeName !== 'STYLE') {
        walk(child)
      }
    }
  }
  if (shadow) {
    walk(shadow)
  }
  return parts.join(' ')
}

// Real mouse click on an element inside a host's closed shadow root.
export async function clickInShadow(page: Page, hostId: string, selector: string): Promise<void> {
  const { cdp, shadow } = await shadowRootOf(page, hostId)
  if (!shadow) {
    throw new Error(`no shadow root on #${hostId}`)
  }
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: shadow.nodeId, selector })
  if (!nodeId) {
    throw new Error(`${selector} not found in #${hostId}`)
  }
  const { model } = await cdp.send('DOM.getBoxModel', { nodeId })
  await cdp.detach()
  const [x1, y1, , , x3, y3] = model.content
  await page.mouse.click((x1! + x3!) / 2, (y1! + y3!) / 2)
}

// An attribute of an element inside a host's closed shadow root (null if the
// element or attribute is absent).
export async function shadowAttribute(
  page: Page,
  hostId: string,
  selector: string,
  name: string
): Promise<string | null> {
  const { cdp, shadow } = await shadowRootOf(page, hostId)
  try {
    if (!shadow) {
      return null
    }
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: shadow.nodeId, selector })
    if (!nodeId) {
      return null
    }
    const { attributes } = await cdp.send('DOM.getAttributes', { nodeId })
    const i = attributes.findIndex((attr, j) => j % 2 === 0 && attr === name)
    return i === -1 ? null : (attributes[i + 1] ?? null)
  } finally {
    await cdp.detach()
  }
}
