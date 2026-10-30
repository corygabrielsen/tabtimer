import type { CDPSession, Page } from '@playwright/test'
import { test, expect, seed, today, openPopup, snoozeBlock, LIMITS_KEY, OVERLAY_ID, BLOCK_ID, MINUTE } from './fixtures'

// WCAG AA on the real built pages, light and dark: every visible text
// against what is behind it (4.5:1, 3:1 when large), and the graphics that
// carry meaning (the meter, the hour bars, the limit's mark, the switch, a
// chosen chip, field edges) against theirs (3:1). The page script's shadow
// roots are read through DevTools, which sees into closed roots. States the
// pages don't show at rest (hover, pressed, focus) are checked as the token
// pairs they paint.

const SITE_A = 'site-a.test'
const UNTRACKED = 'untracked.test'

type RGBA = [number, number, number, number]
type Node = {
  nodeId: number
  nodeType: number
  nodeName: string
  nodeValue: string
  attributes?: string[]
  children?: Node[]
  shadowRoots?: Node[]
}

const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const lum = ([r, g, b]: RGBA) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const ratio = (a: RGBA, b: RGBA) => {
  const [x, y] = [lum(a), lum(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const over = (top: RGBA, under: RGBA): RGBA => {
  const a = top[3]
  return [0, 1, 2].map((i) => top[i]! * a + under[i]! * (1 - a)).concat(1) as RGBA
}

function parse(css: string | undefined): RGBA | null {
  const m = /rgba?\(([^)]+)\)/.exec(css ?? '')
  if (!m) {
    return null
  }
  const [r, g, b, a = 1] = m[1]!
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number)
  return [r!, g!, b!, a]
}

const attr = (node: Node, name: string) => {
  const a = node.attributes ?? []
  for (let i = 0; i < a.length; i += 2) {
    if (a[i] === name) {
      return a[i + 1]!
    }
  }
  return null
}

const classes = (n: Node) => (attr(n, 'class') ?? '').split(/\s+/)

// The graphics that carry meaning, by tag and class.
const GRAPHICS: Array<[string, (node: Node) => boolean]> = [
  ['hour bar', (n) => classes(n).includes('seg') && attr(n, 'data-part') !== null],
  ['limit tick', (n) => classes(n).includes('tick')],
  ['meter piece', (n) => n.nodeName === 'SPAN' && /^(in|over)$/.test(attr(n, 'class') ?? '')],
  ['meter mark', (n) => classes(n).includes('lim')],
  ['switch', (n) => classes(n).includes('switch')],
  ['chosen chip', (n) => classes(n).includes('limit-chip') && attr(n, 'aria-checked') === 'true'],
]

type Finding = { what: string; ratio: number; need: number }

async function audit(page: Page): Promise<Finding[]> {
  // Transitions settle first.
  await page.waitForTimeout(400)
  const cdp: CDPSession = await page.context().newCDPSession(page)
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: Node }
  const parent = new Map<number, Node>()
  const texts: Array<{ el: Node; text: string }> = []
  const graphics: Array<{ el: Node; kind: string }> = []
  const walk = (node: Node) => {
    if (node.nodeName === 'STYLE' || node.nodeName === 'SCRIPT' || node.nodeName === 'HEAD') {
      return
    }
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
      parent.set(child.nodeId, node)
      if (child.nodeType === 3 && child.nodeValue.trim()) {
        texts.push({ el: node, text: child.nodeValue.trim() })
      }
      walk(child)
    }
    const kind = node.nodeType === 1 ? GRAPHICS.find(([, is]) => is(node))?.[0] : undefined
    if (kind) {
      graphics.push({ el: node, kind })
    }
  }
  walk(root)

  const styles = new Map<number, Record<string, string>>()
  const style = async (node: Node) => {
    let s = styles.get(node.nodeId)
    if (!s) {
      const { computedStyle } = (await cdp.send('CSS.getComputedStyleForNode', { nodeId: node.nodeId })) as {
        computedStyle: Array<{ name: string; value: string }>
      }
      s = Object.fromEntries(computedStyle.map((p) => [p.name, p.value]))
      styles.set(node.nodeId, s)
    }
    return s
  }
  const shown = async (node: Node) => {
    try {
      const { model } = (await cdp.send('DOM.getBoxModel', { nodeId: node.nodeId })) as {
        model: { width: number; height: number }
      }
      return model.width > 1 && model.height > 1
    } catch {
      return false
    }
  }
  // The elements from `node` up, across shadow roots.
  const ancestors = (node: Node) => {
    const out: Node[] = []
    for (let n: Node | undefined = node; n; n = parent.get(n.nodeId)) {
      if (n.nodeType === 1) {
        out.push(n)
      }
    }
    return out
  }
  // What is painted behind `node` (its own fill excluded when `self` is
  // false), and the opacity it is seen through.
  const behind = async (node: Node, self: boolean): Promise<{ bg: RGBA; opacity: number }> => {
    const chain = ancestors(node).slice(self ? 0 : 1)
    const layers: RGBA[] = []
    let opacity = 1
    for (const n of ancestors(node)) {
      opacity *= Number((await style(n)).opacity ?? 1)
    }
    for (const n of chain) {
      const c = parse((await style(n))['background-color'])
      if (c && c[3] > 0) {
        layers.push(c)
        if (c[3] >= 1) {
          break
        }
      }
    }
    let bg: RGBA = [255, 255, 255, 1]
    for (const layer of layers.reverse()) {
      bg = over(layer, bg)
    }
    return { bg, opacity }
  }
  const disabled = (node: Node) =>
    ancestors(node).some((n) => (n.nodeName === 'BUTTON' || n.nodeName === 'INPUT') && attr(n, 'disabled') !== null)

  const findings: Finding[] = []
  for (const { el, text } of texts) {
    const s = await style(el)
    if (s.visibility !== 'visible' || disabled(el) || !(await shown(el))) {
      continue
    }
    const { bg, opacity } = await behind(el, true)
    if (opacity === 0) {
      continue
    }
    const fg = parse(s.color)!
    const ink = over([fg[0], fg[1], fg[2], fg[3] * opacity], bg)
    const size = parseFloat(s['font-size']!)
    const large = size >= 24 || (size >= 18.66 && Number(s['font-weight']) >= 700)
    findings.push({
      what: `text "${text.slice(0, 24)}" (${s.color} on ${bg})`,
      ratio: ratio(ink, bg),
      need: large ? 3 : 4.5,
    })
  }
  for (const { el, kind } of graphics) {
    if (disabled(el) || !(await shown(el))) {
      continue
    }
    const s = await style(el)
    const fill = parse(s['background-color'])!
    const { bg } = await behind(el, false)
    findings.push({ what: `${kind} (${s['background-color']} on ${bg})`, ratio: ratio(over(fill, bg), bg), need: 3 })
  }
  await cdp.detach()
  return findings
}

// The token pairs the pages paint in states a still page doesn't show.
async function tokenPairs(page: Page): Promise<Finding[]> {
  const pairs: Array<[string, string, number]> = [
    ['--on-accent', '--accent-hover', 4.5],
    ['--on-accent', '--accent-press', 4.5],
    ['--accent-ink', '--accent-soft', 4.5],
    ['--accent-ink', '--accent-soft-hover', 4.5],
    ['--accent-ink', '--accent-soft-press', 4.5],
    ['--text', '--hover', 4.5],
    ['--text', '--press', 4.5],
    ['--text', '--chip', 4.5],
    ['--text', '--chip-hover', 4.5],
    ['--muted', '--bg', 4.5],
    ['--muted', '--sunk', 4.5],
    ['--quiet-ink', '--bg', 4.5],
    ['--focus', '--sheet', 3],
    ['--focus', '--bg', 3],
    ['--focus', '--sunk', 3],
    ['--field-line', '--sheet', 3],
    ['--bar', '--sunk', 3],
    ['--accent', '--sunk', 3],
    ['--thumb-on', '--accent', 3],
    ['--series-other', '--sunk', 3],
  ]
  const colors = await page.evaluate(
    (names) => {
      const probe = document.createElement('i')
      document.body.append(probe)
      const out = names.map((name) => {
        probe.style.color = `var(${name})`
        return getComputedStyle(probe).color
      })
      probe.remove()
      return out
    },
    pairs.flatMap(([a, b]) => [a, b])
  )
  return pairs.map(([a, b, need], i) => ({
    what: `${a} on ${b}`,
    ratio: ratio(parse(colors[2 * i])!, parse(colors[2 * i + 1])!),
    need,
  }))
}

// The pairs below AA, after checking the audit saw what it must (`kinds`).
function misses(findings: Finding[], kinds: string[]): string[] {
  for (const kind of kinds) {
    expect(
      findings.some((f) => f.what.startsWith(kind)),
      `saw no ${kind}`
    ).toBe(true)
  }
  if (process.env.CONTRAST_REPORT) {
    const low = [...findings].sort((a, b) => a.ratio / a.need - b.ratio / b.need).slice(0, 3)
    console.log(low.map((f) => `${f.ratio.toFixed(2)} (need ${f.need}) ${f.what}`).join('\n'))
  }
  return findings.filter((f) => f.ratio < f.need).map((f) => `${f.what}: ${f.ratio.toFixed(2)} < ${f.need}`)
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme}`, () => {
    test('the popup, over and snoozed, under, and not tracked', async ({
      context,
      serviceWorker,
      extensionId,
      site,
    }) => {
      const now = await serviceWorker.evaluate(() => Date.now())
      await seed(serviceWorker, {
        ...(await today(serviceWorker, { [SITE_A]: 70 * MINUTE, 'site-b.test': 20 * MINUTE })),
        [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: 60, 'site-b.test': 30 }, snoozeUntil: now + 4 * MINUTE },
      })
      const tab = await context.newPage()
      await tab.goto(site(SITE_A))
      const popup = await openPopup(context, serviceWorker, extensionId, site(SITE_A))
      await popup.emulateMedia({ colorScheme: scheme })
      await expect(popup.locator('#summary')).toContainText('10 min over')
      const findings = [...(await audit(popup)), ...(await tokenPairs(popup))]

      const tabB = await context.newPage()
      await tabB.goto(site('site-b.test'))
      const under = await openPopup(context, serviceWorker, extensionId, site('site-b.test'))
      await under.emulateMedia({ colorScheme: scheme })
      await expect(under.locator('#summary')).toHaveText('10 min left')
      findings.push(...(await audit(under)))

      // A site not tracked: its URL isn't visible to tabs.query, so the
      // popup is told it directly.
      const off = await context.newPage()
      await off.addInitScript((url) => {
        chrome.tabs.query = ((_: unknown, callback?: (tabs: chrome.tabs.Tab[]) => void) =>
          callback?.([{ id: 999_999, url } as chrome.tabs.Tab])) as typeof chrome.tabs.query
      }, site(UNTRACKED))
      await off.goto(`chrome-extension://${extensionId}/popup.html`)
      await off.emulateMedia({ colorScheme: scheme })
      await expect(off.locator('#enable')).toBeVisible()
      findings.push(...(await audit(off)))
      expect(misses(findings, ['text', 'meter piece', 'meter mark', 'hour bar', 'switch', 'chosen chip'])).toEqual([])
    })

    test('Settings and Activity', async ({ context, serviceWorker, extensionId }) => {
      await seed(serviceWorker, {
        ...(await today(serviceWorker, { [SITE_A]: 70 * MINUTE, 'site-b.test': 20 * MINUTE })),
        [LIMITS_KEY]: { global: 120, perSite: { [SITE_A]: 60 } },
      })
      const options = await context.newPage()
      await options.emulateMedia({ colorScheme: scheme })
      await options.goto(`chrome-extension://${extensionId}/options.html`)
      await expect(options.locator('#week-card')).toBeVisible()
      const findings = await audit(options)

      const usage = await context.newPage()
      await usage.emulateMedia({ colorScheme: scheme })
      await usage.goto(`chrome-extension://${extensionId}/usage.html`)
      await expect(usage.locator('#report')).toBeVisible()
      findings.push(...(await audit(usage)))
      await usage.locator(`[data-site="${SITE_A}"]`).click()
      await expect(usage.locator('#bars .tick')).toHaveCount(1)
      findings.push(...(await audit(usage)))
      await usage.getByRole('radio', { name: 'Week' }).check()
      await expect(usage.locator('.ref-limit')).toBeVisible()
      findings.push(...(await audit(usage)))
      expect(misses(findings, ['text', 'hour bar', 'limit tick', 'switch', 'chosen chip'])).toEqual([])
    })

    test('the block screen and the timer, under and over', async ({ context, serviceWorker, site }) => {
      await seed(serviceWorker, {
        ...(await today(serviceWorker, { [SITE_A]: 70 * MINUTE })),
        [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: 60 } },
      })
      const page = await context.newPage()
      await page.emulateMedia({ colorScheme: scheme })
      await page.goto(site(SITE_A))
      await expect(page.locator(`#${BLOCK_ID}`)).toBeVisible()
      const findings = await audit(page)

      await snoozeBlock(page)
      await expect(page.locator(`#${OVERLAY_ID}`)).toBeVisible()
      findings.push(...(await audit(page)))
      await seed(serviceWorker, { [LIMITS_KEY]: { global: null, perSite: { [SITE_A]: 120 } } })
      await page.waitForTimeout(500)
      findings.push(...(await audit(page)))
      // The pill's dimmed panel rows are the original design, kept as is.
      expect(misses(findings, ['text', 'hour bar', 'limit tick'])).toEqual([])
    })
  })
}
