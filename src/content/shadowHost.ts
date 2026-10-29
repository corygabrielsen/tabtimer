// Top of the stacking context, so the content UI stays above page chrome.
const MAX_Z_INDEX = 2147483647

export type ShadowHost = {
  host: HTMLDivElement
  shadow: ShadowRoot
  // Put the host back on <html> if the page took it off; true if it did.
  attach: () => boolean
}

// A fixed host element on the page, with `styles` in a closed shadow root:
// the page can't query into it, and the page's CSS and the UI's can't reach
// each other. A stale host left by a previous instance (re-injection, SPA
// remount) is removed first, so hosts never stack. The host is a child of
// <html>, outside <body>, so pages that replace or re-render <body> leave it
// in place; attach() covers the rest (the host removed, <html> replaced).
export function mountShadowHost(id: string, styles: string): ShadowHost {
  document.getElementById(id)?.remove()
  const host = document.createElement('div')
  host.id = id
  // Marked important so page rules can't dislodge it.
  host.style.setProperty('position', 'fixed', 'important')
  host.style.setProperty('z-index', String(MAX_Z_INDEX), 'important')
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = styles
  shadow.append(style)
  const attach = () => {
    const root = document.documentElement as HTMLElement | null
    if (!root || host.parentNode === root) {
      return false
    }
    root.append(host)
    return true
  }
  attach()
  return { host, shadow, attach }
}

// An element's shadow root, closed ones too (chrome.dom, in content
// scripts), or null.
export function shadowRootOf(el: Element): ShadowRoot | null {
  try {
    return chrome.dom.openOrClosedShadowRoot(el as HTMLElement)
  } catch {
    return el.shadowRoot
  }
}
