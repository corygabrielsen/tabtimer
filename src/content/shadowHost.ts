// Top of the stacking context, so the content UI stays above page chrome.
const MAX_Z_INDEX = 2147483647

// A fixed host element on the page, with `styles` in a closed shadow root:
// the page can't query into it, and the page's CSS and the UI's can't reach
// each other. A stale host left by a previous instance (re-injection, SPA
// remount) is removed first, so hosts never stack.
export function mountShadowHost(id: string, styles: string): { host: HTMLDivElement; shadow: ShadowRoot } {
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
  document.body.appendChild(host)
  return { host, shadow }
}
