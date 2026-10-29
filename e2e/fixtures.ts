import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test'

const EXTENSION_PATH = path.resolve(import.meta.dirname, '..', 'dist-e2e')

// Mirrors src/storage.ts / src/limits.ts. Kept literal so a schema change
// that would strand users' stored data also fails these tests.
export const LIMITS_KEY = 'tabtimer_limits'
export const SNOOZE_KEY = 'tabtimer_block_snooze_until'
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

// Every *.test host resolves to the fixture server. Any path serves a plain
// page; /interactive adds focusable controls and looping audio.
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
      req.url === '/interactive'
        ? '<button id="page-button">page button</button><a id="page-link" href="#x">page link</a>' +
          '<audio id="media" src="/silence.wav" loop></audio>'
        : ''
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>${host}</title><h1>fixture ${host}</h1>${extra}`)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
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
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      // Playwright turns the back/forward cache off by default; the content
      // script has to cope with it, so keep Chrome's real behaviour.
      ignoreDefaultArgs: ['--disable-back-forward-cache'],
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--host-resolver-rules=MAP *.test 127.0.0.1',
        // Let fixture media play() without a user gesture.
        '--autoplay-policy=no-user-gesture-required',
      ],
    })
    await use(context)
    await context.close()
  },

  serviceWorker: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
    // onInstalled registers the content script asynchronously; wait for it so
    // the first navigation is already covered.
    await test
      .expect(async () => {
        const n = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts().then((s) => s.length))
        test.expect(n).toBe(1)
      })
      .toPass()
    await use(sw)
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

// Today's per-site counter key, dated in the browser's local time zone.
export function todayKey(sw: Worker, host: string): Promise<string> {
  return sw.evaluate((host) => {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `focusTimer_elapsed_today_${host}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }, host)
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
