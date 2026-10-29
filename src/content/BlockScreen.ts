import type FocusTracker from './FocusTracker'
import { bus as chromeBus } from '../chrome/bus'
import { msToMinutes, SNOOZE_MS, type BlockReason } from '../core/limits'
import type { Bus } from '../ports'
import { formatTime } from '../format'
import { t } from '../i18n'
import { h } from '../ui'
import { mountShadowHost } from './shadowHost'

const HOST_ID = 'tabtimer-block'

const STYLES = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  /* The top-layer scroll container every wheel, touch and key scroll
     targets; contain keeps them from chaining to the page behind. */
  dialog.screen {
    width: 100%;
    height: 100%;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: 0;
    border: 0;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .screen:not([open]) { display: none; }
  .screen,
  .screen::backdrop {
    background: #000;
  }
  .screen {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #f5f5f5;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-variant-numeric: tabular-nums;
    -webkit-user-select: none;
    user-select: none;
  }
  .box {
    text-align: center;
    padding: 24px;
    max-width: 440px;
  }
  .title {
    font-size: 12px;
    letter-spacing: 0.3em;
    text-transform: uppercase;
    color: #8a8a8a;
    margin-bottom: 20px;
  }
  .host {
    font-size: 22px;
    margin-bottom: 10px;
    word-break: break-all;
  }
  .detail {
    font-size: 13px;
    color: #8a8a8a;
    margin-bottom: 28px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
  }
  .activity {
    border: 0;
    padding: 8px 4px;
    background: transparent;
    color: #8a8a8a;
    font: inherit;
    font-size: 12px;
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
  }
  .activity:hover {
    color: #f5f5f5;
  }
  .snooze {
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 2px;
    background: transparent;
    color: #8a8a8a;
    font: inherit;
    font-size: 12px;
    padding: 8px 16px;
    cursor: pointer;
  }
  .snooze:hover {
    color: #f5f5f5;
    border-color: rgba(255, 255, 255, 0.35);
  }
  .manage {
    display: block;
    margin: 16px auto 0;
    border: 0;
    background: transparent;
    color: #8a8a8a;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .manage:hover {
    color: #f5f5f5;
  }
  .snooze:focus-visible,
  .activity:focus-visible,
  .manage:focus-visible {
    outline: 1px solid #9a9a9a;
    outline-offset: 2px;
  }
`

const OVERFLOW_PROPS = ['overflow', 'overflow-x', 'overflow-y'] as const
type SavedStyle = { value: string; priority: string }
type ScrollPosition = { left: number; top: number }

// The block screen is a modal <dialog> inside a closed shadow root. While it
// is open (showModal), the browser puts it in the top layer and makes the rest
// of the page inert: no clicks, no Tab stops, hidden from assistive tech. The
// handlers below cover what showModal leaves open: Escape (a close request),
// fullscreen (a later top-layer element would cover the dialog), media that
// keeps playing behind it, and focus leaving it (Tab past the last button, or
// browsers without a modal top layer).
export default class BlockScreen {
  private host: HTMLDivElement
  private shadow: ShadowRoot
  private dialog: HTMLDialogElement
  private hostLine: HTMLDivElement
  private detailLine: HTMLDivElement
  private snoozeButton: HTMLButtonElement
  private activityButton: HTMLButtonElement
  private manageButton: HTMLButtonElement
  private blocked = false
  private unsubscribeState: () => void
  // Where focus was before blocking, restored on dismissal.
  private previousFocus: Element | null = null
  // The page's own inline overflow on <html> and <body>, saved only while this
  // instance overrides it.
  private savedOverflow: Map<HTMLElement, Map<string, SavedStyle>> | null = null
  // The window's scroll offset when blocking began, restored on dismissal.
  private savedWindow: ScrollPosition | null = null

  constructor(
    private tracker: Pick<FocusTracker, 'blockReason' | 'setBlocked' | 'snooze' | 'site' | 'onState'>,
    private bus: Bus = chromeBus
  ) {
    const { host, shadow } = mountShadowHost(HOST_ID, STYLES)
    this.host = host
    this.shadow = shadow
    const s = host.style
    s.setProperty('inset', '0', 'important')
    s.setProperty('display', 'none', 'important')
    // Opaque even before (or without) the modal dialog painting over it.
    s.setProperty('background', '#000', 'important')

    const button = (cls: string, text: string, onClick: () => void) => {
      const el = h('button', { type: 'button', class: cls }, text)
      el.addEventListener('click', onClick)
      return el
    }
    this.snoozeButton = button('snooze', t('blockSnooze', String(msToMinutes(SNOOZE_MS))), () => {
      this.unblock()
      void this.tracker.snooze()
    })
    // Opens in a new tab, through the service worker; this page stays blocked.
    this.activityButton = button('activity', t('blockSeeActivity'), () => {
      void this.bus.send('open', { page: 'activity' })
    })
    this.manageButton = button('manage', t('blockManage'), () => {
      void this.bus.send('open', { page: 'options' })
    })
    this.hostLine = h('div', { class: 'host' })
    this.detailLine = h('div', { class: 'detail' })

    this.dialog = h(
      'dialog',
      { class: 'screen', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': t('blockTitle') },
      h(
        'div',
        { class: 'box' },
        h('div', { class: 'title' }, t('blockTitle')),
        this.hostLine,
        this.detailLine,
        h('div', { class: 'row' }, this.snoozeButton, this.activityButton),
        this.manageButton
      )
    )
    this.dialog.addEventListener('cancel', this.handleCancel)
    this.dialog.addEventListener('close', this.handleClose)
    this.dialog.addEventListener('keydown', this.handleKeydown)
    shadow.append(this.dialog)

    // A new state from the service worker may block or lift the block.
    this.unsubscribeState = tracker.onState(() => this.tick())
    this.tick()
  }

  // Called each second by content.ts (visible tab only) and whenever the
  // service worker's state for the tab changes. The worker decides when the
  // page blocks (TabState.blockAt); until it has answered, nothing does.
  tick(): void {
    const reason = this.tracker.blockReason()
    if (reason) {
      this.block(reason)
    } else {
      this.unblock()
    }
  }

  private block(reason: BlockReason) {
    this.hostLine.textContent = reason.scope === 'site' ? (this.tracker.site ?? '') : t('blockAllSites')
    this.detailLine.textContent = t('blockDetail', [formatTime(reason.elapsed), formatTime(reason.limit)])
    if (this.blocked) {
      return
    }
    this.blocked = true
    this.tracker.setBlocked(true)
    this.previousFocus = document.activeElement
    this.host.style.setProperty('display', 'block', 'important')
    this.lockScroll()
    this.exitFullscreen()
    this.showDialog()
    this.pauseMedia()
    this.listen(true)
  }

  private unblock() {
    if (!this.release()) {
      return
    }
    this.dialog.close()
    this.host.style.setProperty('display', 'none', 'important')
    this.restoreScroll()
    this.restoreFocus()
  }

  destroy() {
    this.unsubscribeState()
    this.release()
    this.restoreScroll()
    this.host.remove()
    this.restoreFocus()
  }

  // End the block's hold on the page: the tracker told, the page listeners
  // removed. False if it wasn't blocked.
  private release(): boolean {
    if (!this.blocked) {
      return false
    }
    this.blocked = false
    this.tracker.setBlocked(false)
    this.listen(false)
    return true
  }

  // Add (or remove) the page listeners held while blocked.
  private listen(on: boolean) {
    const listeners: Array<[EventTarget, string, (e: never) => void, boolean]> = [
      [document, 'focusin', this.handleFocusIn, true],
      [document, 'play', this.handlePlay, true],
      [document, 'fullscreenchange', this.handleFullscreenChange, false],
    ]
    for (const [target, type, listener, options] of listeners) {
      if (on) {
        target.addEventListener(type, listener as EventListener, options)
      } else {
        target.removeEventListener(type, listener as EventListener, options)
      }
    }
  }

  // showModal: top layer, inert page, focus inside. Chromium allows it from a
  // closed shadow root.
  private showDialog() {
    if (!this.dialog.open) {
      try {
        this.dialog.showModal()
      } catch {
        // The page detached the host: show it non-modally rather than not at
        // all; the focus handlers still keep the page out of reach.
        this.dialog.setAttribute('open', '')
      }
    }
    this.snoozeButton.focus({ preventScroll: true })
  }

  private restoreFocus() {
    const previous = this.previousFocus
    this.previousFocus = null
    if (previous instanceof HTMLElement && previous.isConnected && previous !== document.body) {
      previous.focus({ preventScroll: true })
    }
  }

  // Hide overflow on <html> and <body>: hiding it on <html> alone stops the
  // body's overflow propagating to the viewport, which turns a body set to
  // scroll into a scroller of its own. The page's inline values and
  // priorities are saved first, so dismissal restores exactly what it had.
  private lockScroll() {
    this.savedWindow = { left: window.scrollX, top: window.scrollY }
    if (this.savedOverflow) {
      return
    }
    this.savedOverflow = new Map()
    for (const el of new Set([document.documentElement, document.body])) {
      if (!el) {
        continue
      }
      const style = el.style
      this.savedOverflow.set(
        el,
        new Map(
          OVERFLOW_PROPS.map((p) => [p, { value: style.getPropertyValue(p), priority: style.getPropertyPriority(p) }])
        )
      )
      style.setProperty('overflow', 'hidden', 'important')
    }
  }

  private restoreScroll() {
    const position = this.savedWindow
    this.savedWindow = null
    const saved = this.savedOverflow
    if (!saved) {
      return
    }
    this.savedOverflow = null
    for (const [el, props] of saved) {
      restoreOverflow(el.style, props)
    }
    // Hiding overflow can shrink the viewport's scroll range (a body sized to
    // the viewport) and clamp its offset; go back to where the page was.
    restoreWindowScroll(position)
  }

  // A fullscreen element shares the top layer and would cover the dialog;
  // leave fullscreen so the page can't be used around the block screen.
  private exitFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
    }
  }

  // Pause media already playing; handlePlay keeps it paused. Nothing is
  // resumed on dismissal.
  private pauseMedia() {
    document.querySelectorAll<HTMLMediaElement>('video, audio').forEach((media) => {
      if (!media.paused) {
        media.pause()
      }
    })
  }

  private handlePlay = (e: Event) => {
    if (e.target instanceof HTMLMediaElement) {
      e.target.pause()
    }
  }

  private handleFullscreenChange = () => {
    this.exitFullscreen()
  }

  // Focus landing anywhere on the page goes back to the block screen.
  private handleFocusIn = (e: FocusEvent) => {
    if (!e.composedPath().includes(this.host)) {
      this.snoozeButton.focus({ preventScroll: true })
    }
  }

  // Escape is a close request; the block screen isn't dismissable that way.
  private handleCancel = (e: Event) => {
    e.preventDefault()
  }

  // A close request can't always be cancelled (the browser lets a repeated
  // Escape through without user activation); reopen while still blocked.
  private handleClose = () => {
    if (this.blocked) {
      this.showDialog()
    }
  }

  // Keep Tab cycling through the buttons (Shift+Tab backwards), and swallow
  // Escape.
  private handleKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      return
    }
    if (e.key !== 'Tab') {
      return
    }
    e.preventDefault()
    const order = [this.snoozeButton, this.activityButton, this.manageButton]
    const current = order.indexOf(this.shadow.activeElement as HTMLButtonElement)
    const step = e.shiftKey ? order.length - 1 : 1
    const next = current === -1 ? this.snoozeButton : order[(current + step) % order.length]!
    next.focus({ preventScroll: true })
  }
}

// Scroll the window back to `position`, if it moved.
function restoreWindowScroll(position: ScrollPosition | null) {
  if (position && (window.scrollX !== position.left || window.scrollY !== position.top)) {
    window.scrollTo({ left: position.left, top: position.top, behavior: 'instant' })
  }
}

// Put back an element's saved inline overflow, unless the page set its own
// while blocked (the override is no longer ours to undo).
function restoreOverflow(style: CSSStyleDeclaration, saved: Map<string, SavedStyle>) {
  if (style.getPropertyValue('overflow') !== 'hidden' || style.getPropertyPriority('overflow') !== 'important') {
    return
  }
  for (const p of OVERFLOW_PROPS) {
    style.removeProperty(p)
  }
  // The shorthand only reads back when both longhands agree; restore it as
  // one, otherwise each longhand on its own.
  const props = saved.get('overflow')?.value ? (['overflow'] as const) : (['overflow-x', 'overflow-y'] as const)
  for (const p of props) {
    const { value, priority } = saved.get(p)!
    if (value) {
      style.setProperty(p, value, priority)
    }
  }
}
