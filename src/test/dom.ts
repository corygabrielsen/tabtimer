// DOM helpers for the content-script tests (happy-dom environment).
import { vi } from 'vitest'
import popupHtml from '../../popup.html?raw'
import optionsHtml from '../../options.html?raw'

// The overlay and block screen live in *closed* shadow roots, which the page
// (and so a test) can't reach via `host.shadowRoot`. Record each root as it's
// created by wrapping attachShadow — production code still gets a genuinely
// closed root; only the test keeps a reference. Call before constructing.
export function trackShadowRoots(): (hostId: string) => ShadowRoot {
  const roots = new WeakMap<Element, ShadowRoot>()
  const original = Element.prototype.attachShadow
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init: ShadowRootInit) {
    const root = original.call(this, init)
    roots.set(this, root)
    return root
  })
  return (hostId: string) => {
    const host = document.getElementById(hostId)
    const root = host && roots.get(host)
    if (!root) {
      throw new Error(`no shadow root for #${hostId}`)
    }
    return root
  }
}

let hidden = false
let focused = true

// Control page visibility/focus the way the browser reports it, firing the
// events the content script listens for.
export function setPageState(state: { hidden?: boolean; focused?: boolean }, fireEvents = true): void {
  installPageStateHooks()
  if (state.hidden !== undefined && state.hidden !== hidden) {
    hidden = state.hidden
    if (fireEvents) {
      document.dispatchEvent(new Event('visibilitychange'))
    }
  }
  if (state.focused !== undefined && state.focused !== focused) {
    focused = state.focused
    if (fireEvents) {
      window.dispatchEvent(new Event(focused ? 'focus' : 'blur'))
    }
  }
}

function installPageStateHooks(): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
}

// Start each test as a visible, focused tab.
export function resetPageState(): void {
  hidden = false
  focused = true
  installPageStateHooks()
}

// Drain pending microtasks (the fake chrome delivers callbacks/events as
// microtasks, and the code chains several promises per operation).
export async function flush(rounds = 200): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
  }
}

export function text(root: ParentNode, selector: string): string | null {
  return root.querySelector(selector)?.textContent ?? null
}

export function click(el: Element | null | undefined): void {
  if (!el) {
    throw new Error('click target not found')
  }
  ;(el as HTMLElement).click()
}

// Load the <body> of one of the extension's HTML pages into the document.
export function loadPageBody(file: 'popup.html' | 'options.html'): void {
  const html = file === 'popup.html' ? popupHtml : optionsHtml
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? ''
  // Drop the module script tag; tests import the entry module themselves.
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '')
}
