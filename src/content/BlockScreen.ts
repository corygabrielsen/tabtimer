import type FocusTracker from './FocusTracker'
import { bus as chromeBus } from '../chrome/bus'
import { SNOOZE_MS, type BlockReason } from '../core/limits'
import type { Bus } from '../ports'
import { formatTime } from '../format'
import { t } from '../i18n'

const HOST_ID = 'tabtimer-block'
const MAX_Z_INDEX = 2147483647

const STYLES = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  dialog.screen {
    width: 100%;
    height: 100%;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: 0;
    border: 0;
  }
  .screen:not([open]) { display: none; }
  .screen,
  .screen::backdrop {
    background: #000;
    overscroll-behavior: none;
    touch-action: none;
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
  .manage:focus-visible {
    outline: 1px solid #9a9a9a;
    outline-offset: 2px;
  }
`

const OVERFLOW_PROPS = ['overflow', 'overflow-x', 'overflow-y'] as const
type SavedStyle = { value: string; priority: string }
type ScrollPosition = { left: number; top: number }

// Keys that scroll the page (or the nearest scroller) by default.
const SCROLL_KEYS = new Set([
  ' ',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
])
// Capture phase, and not passive, so preventDefault holds for wheel/touch.
const ACTIVE_CAPTURE: AddEventListenerOptions = { capture: true, passive: false }

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
  private manageButton: HTMLButtonElement
  private blocked = false
  private unsubscribeState: () => void
  // Where focus was before blocking, restored on dismissal.
  private previousFocus: Element | null = null
  // The page's own inline overflow on <html> and <body>, saved only while this
  // instance overrides it.
  private savedOverflow: Map<HTMLElement, Map<string, SavedStyle>> | null = null
  // Scroll offsets frozen while blocked: the window's, and every element that
  // was scrolled away from the origin when blocking began.
  private frozenWindow: ScrollPosition | null = null
  private frozenElements = new Map<Element, ScrollPosition>()

  constructor(
    private tracker: Pick<FocusTracker, 'blockReason' | 'setBlocked' | 'snooze' | 'site' | 'onState'>,
    private bus: Bus = chromeBus
  ) {
    document.getElementById(HOST_ID)?.remove()
    this.host = document.createElement('div')
    this.host.id = HOST_ID
    const s = this.host.style
    s.setProperty('position', 'fixed', 'important')
    s.setProperty('inset', '0', 'important')
    s.setProperty('z-index', String(MAX_Z_INDEX), 'important')
    s.setProperty('display', 'none', 'important')
    // Opaque even before (or without) the modal dialog painting over it.
    s.setProperty('background', '#000', 'important')

    this.shadow = this.host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = STYLES

    this.dialog = document.createElement('dialog')
    this.dialog.className = 'screen'
    this.dialog.setAttribute('role', 'alertdialog')
    this.dialog.setAttribute('aria-modal', 'true')
    this.dialog.setAttribute('aria-label', t('blockTitle'))
    this.dialog.addEventListener('cancel', this.handleCancel)
    this.dialog.addEventListener('close', this.handleClose)
    this.dialog.addEventListener('keydown', this.handleKeydown)

    const box = document.createElement('div')
    box.className = 'box'

    const title = document.createElement('div')
    title.className = 'title'
    title.textContent = t('blockTitle')

    this.hostLine = document.createElement('div')
    this.hostLine.className = 'host'

    this.detailLine = document.createElement('div')
    this.detailLine.className = 'detail'

    this.snoozeButton = document.createElement('button')
    this.snoozeButton.type = 'button'
    this.snoozeButton.className = 'snooze'
    this.snoozeButton.textContent = t('blockSnooze', String(Math.round(SNOOZE_MS / 60_000)))
    this.snoozeButton.addEventListener('click', () => {
      this.unblock()
      void this.tracker.snooze()
    })

    this.manageButton = document.createElement('button')
    this.manageButton.type = 'button'
    this.manageButton.className = 'manage'
    this.manageButton.textContent = t('blockManage')
    this.manageButton.addEventListener('click', () => {
      void this.bus.send('openOptions', {})
    })

    box.append(title, this.hostLine, this.detailLine, this.snoozeButton, this.manageButton)
    this.dialog.append(box)
    this.shadow.append(style, this.dialog)
    document.body.appendChild(this.host)

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
    document.addEventListener('focusin', this.handleFocusIn, true)
    document.addEventListener('play', this.handlePlay, true)
    document.addEventListener('fullscreenchange', this.handleFullscreenChange)
    window.addEventListener('wheel', this.handleWheel, ACTIVE_CAPTURE)
    window.addEventListener('touchmove', this.preventDefault, ACTIVE_CAPTURE)
    window.addEventListener('mousedown', this.handleMouseDown, true)
    window.addEventListener('keydown', this.handleScrollKey, true)
    window.addEventListener('scroll', this.handleScroll, true)
  }

  private unblock() {
    if (!this.blocked) {
      return
    }
    this.blocked = false
    this.tracker.setBlocked(false)
    this.removePageListeners()
    this.dialog.close()
    this.host.style.setProperty('display', 'none', 'important')
    this.restoreScroll()
    this.restoreFocus()
  }

  destroy() {
    this.unsubscribeState()
    if (this.blocked) {
      this.blocked = false
      this.tracker.setBlocked(false)
      this.removePageListeners()
    }
    this.restoreScroll()
    this.host.remove()
    this.restoreFocus()
  }

  private removePageListeners() {
    document.removeEventListener('focusin', this.handleFocusIn, true)
    document.removeEventListener('play', this.handlePlay, true)
    document.removeEventListener('fullscreenchange', this.handleFullscreenChange)
    window.removeEventListener('wheel', this.handleWheel, ACTIVE_CAPTURE)
    window.removeEventListener('touchmove', this.preventDefault, ACTIVE_CAPTURE)
    window.removeEventListener('mousedown', this.handleMouseDown, true)
    window.removeEventListener('keydown', this.handleScrollKey, true)
    window.removeEventListener('scroll', this.handleScroll, true)
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
    this.freezeScrollPositions()
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
    const frozen = this.frozenWindow
    this.frozenWindow = null
    this.frozenElements.clear()
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
    if (frozen && (window.scrollX !== frozen.left || window.scrollY !== frozen.top)) {
      window.scrollTo({ left: frozen.left, top: frozen.top, behavior: 'instant' })
    }
  }

  // Record where everything is scrolled to. Anything not recorded was at the
  // origin.
  private freezeScrollPositions() {
    this.frozenWindow = { left: window.scrollX, top: window.scrollY }
    this.frozenElements.clear()
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollLeft !== 0 || el.scrollTop !== 0) {
        this.frozenElements.set(el, { left: el.scrollLeft, top: el.scrollTop })
      }
    }
  }

  // Backstop for whatever the input handlers miss (a page script, an input
  // path they don't cover): put anything that scrolls while blocked back.
  private handleScroll = (e: Event) => {
    const target = e.target
    if (target === document || target === document.scrollingElement) {
      const frozen = this.frozenWindow
      if (frozen && (window.scrollX !== frozen.left || window.scrollY !== frozen.top)) {
        window.scrollTo({ left: frozen.left, top: frozen.top, behavior: 'instant' })
      }
      return
    }
    if (!(target instanceof Element)) {
      return
    }
    const frozen = this.frozenElements.get(target) ?? { left: 0, top: 0 }
    if (target.scrollLeft !== frozen.left || target.scrollTop !== frozen.top) {
      target.scrollTo({ left: frozen.left, top: frozen.top, behavior: 'instant' })
    }
  }

  private preventDefault = (e: Event) => {
    e.preventDefault()
  }

  // Ctrl+wheel (and trackpad pinch) zooms rather than scrolls; leave it be.
  private handleWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) {
      e.preventDefault()
    }
  }

  // Middle-click starts autoscroll.
  private handleMouseDown = (e: MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault()
    }
  }

  // Scroll keys scroll the page behind the block screen; Space on one of its
  // buttons presses it instead, so that one goes through. Alt/Meta with
  // Left/Right is history navigation, not scrolling.
  private handleScrollKey = (e: KeyboardEvent) => {
    if (!SCROLL_KEYS.has(e.key)) {
      return
    }
    if (
      e.key === ' ' &&
      e.composedPath().includes(this.host) &&
      this.shadow.activeElement instanceof HTMLButtonElement
    ) {
      return
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (e.altKey || e.metaKey)) {
      return
    }
    e.preventDefault()
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

  // Keep Tab cycling between the two buttons, and swallow Escape.
  private handleKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      return
    }
    if (e.key !== 'Tab') {
      return
    }
    e.preventDefault()
    const order = [this.snoozeButton, this.manageButton]
    const current = order.indexOf(this.shadow.activeElement as HTMLButtonElement)
    const next = current === -1 ? this.snoozeButton : order[(current + 1) % order.length]!
    next.focus({ preventScroll: true })
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
