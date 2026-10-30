import type FocusTracker from './FocusTracker'
import BASE from '../styles/base.css?raw'
import { bus as chromeBus } from '../chrome/bus'
import { hourOf } from '../core/day'
import { msToMinutes, SNOOZE_MS, type BlockReason } from '../core/limits'
import { hoursAt, type TabState } from '../core/messages'
import { hourLabel, splitAtLimit } from '../core/usage'
import type { Bus } from '../ports'
import { drawBar, HOUR_FLOOR_MS } from '../bars'
import { t } from '../i18n'
import { formatDuration, h, svg, uiLocale } from '../ui'
import { HoldButton } from './hold'
import { mountShadowHost, shadowRootOf } from './shadowHost'

const HOST_ID = 'tabtimer-block'

// The hours the chart's axis names besides Now: midnight, 6, noon and 18.
const AXIS_MARKS = [0, 6, 12, 18]

// The shared components (base.css), then the block screen's own.
const STYLES = `${BASE}
  :host { all: initial; }
  /* The top-layer scroll container every wheel, touch and key scroll
     targets; contain keeps them from chaining to the page behind. */
  dialog.screen {
    width: 100%;
    height: 100%;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: var(--s-4);
    border: 0;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .screen:not([open]) { display: none; }
  /* Opaque: nothing of the page shows through. */
  .screen::backdrop { background: var(--bg); }
  .screen {
    position: fixed;
    inset: 0;
    display: flex;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: var(--t-md);
    line-height: 1.45;
    -webkit-font-smoothing: antialiased;
    -webkit-user-select: none;
    user-select: none;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .sheet {
    width: 100%;
    max-width: 560px;
    margin: auto;
    padding: var(--s-10) var(--s-10) var(--s-8);
    border-radius: var(--r-2xl);
    background: var(--sheet);
    box-shadow: var(--shadow);
    animation: sheet-in 0.48s var(--ease) both;
  }
  @keyframes sheet-in { from { opacity: 0; transform: translateY(14px) scale(0.985); } }
  .site {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    min-width: 0;
    color: var(--muted);
    font-size: var(--t-md);
    overflow-wrap: anywhere;
  }
  .site .fav { width: 24px; height: 24px; border-radius: var(--r-sm); font-size: var(--t-xs); }
  h1 {
    margin: var(--s-4) 0 var(--s-2);
    font-size: 36px;
    line-height: 1.1;
    letter-spacing: -0.022em;
    font-weight: 680;
  }
  .used {
    margin: 0;
    color: var(--muted);
    font-size: 16px;
    line-height: 24px;
    font-variant-numeric: tabular-nums;
  }
  .used b { color: var(--text); font-weight: 600; }
  .panel {
    margin: var(--s-6) 0;
    padding: var(--s-4) var(--s-5) var(--s-3);
    border-radius: var(--r-lg);
    background: var(--sunk);
  }
  /* 24 hour columns; the top 20 px holds the values over the bars. */
  .plot {
    position: relative;
    display: grid;
    grid-template-columns: repeat(24, 1fr);
    column-gap: 6px;
    height: 104px;
    padding-top: 20px;
  }
  .plot::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 1px;
    background: var(--line);
  }
  .val {
    position: absolute;
    left: 50%;
    bottom: calc(var(--v) * 100% + 6px);
    transform: translateX(-50%);
    color: var(--muted);
    font-size: var(--t-2xs);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .hbar[data-now] .val { color: var(--accent-ink); }
  .axis {
    position: relative;
    height: 16px;
    margin-top: var(--s-2);
    color: var(--muted);
    font-size: var(--t-2xs);
    font-variant-numeric: tabular-nums;
  }
  .axis span {
    position: absolute;
    left: calc(var(--h) * (100% + 6px) / 24 + (100% + 6px) / 48 - 3px);
    transform: translateX(-50%);
    white-space: nowrap;
  }
  .axis span.first { left: 0; transform: none; }
  .axis span.now { color: var(--accent-ink); font-weight: 650; }
  .btn svg { width: 18px; height: 18px; flex: none; margin-left: -2px; }
  .icon { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .btn.is-focus { outline: 2px solid var(--focus); outline-offset: 2px; }
  .close {
    width: 100%;
    min-height: 56px;
    font-size: 17px;
  }
  .close svg { width: 20px; height: 20px; }
  /* Hold to snooze: one cue, the ring's arc closing over a soft fill whose
     leading edge shows how far. --p: 0..1. */
  .btn.hold {
    position: relative;
    isolation: isolate;
    overflow: hidden;
    width: 100%;
    min-height: 48px;
    margin-top: var(--s-3);
    border: 1px solid var(--bar);
    background: var(--sheet);
    box-shadow: none;
    color: var(--text);
    font-size: var(--t-md);
    font-weight: 500;
    touch-action: none;
  }
  .btn.hold:hover { background: var(--hover); border-color: var(--muted); }
  .btn.hold:active { transform: none; }
  .btn.hold.holding,
  .btn.hold.released {
    border-color: var(--accent-ink);
    background: var(--sheet);
    color: var(--accent-ink);
  }
  .btn.hold.holding { transform: scale(0.985); }
  .btn.hold.done { border-color: var(--accent-ink); background: var(--accent-soft); color: var(--accent-ink); }
  .hold .fill {
    position: absolute;
    inset: 0;
    z-index: -1;
    border-right: 2px solid var(--accent);
    background: var(--accent-soft);
    transform: translateX(calc((var(--p, 0) - 1) * 100%));
  }
  .hold.done .fill { border-right-color: transparent; }
  .hold.released .fill { transition: transform 0.32s var(--ease); }
  .hold .lbl { display: inline-flex; align-items: center; gap: var(--s-2); }
  .hold.done .lbl { animation: settle 0.36s var(--ease); }
  @keyframes settle { from { transform: scale(0.92); opacity: 0.4; } }
  .ring { transform: rotate(-90deg); }
  .ring circle { fill: none; }
  .ring .trk { stroke: var(--bar); stroke-width: 1.75; }
  .ring .prg {
    stroke: var(--accent-ink);
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-dasharray: calc(var(--p, 0) * 100) 100;
    opacity: clamp(0, calc(var(--p, 0) * 1000), 1);
  }
  .hold.released .ring .prg { transition: stroke-dasharray 0.32s var(--ease); }
  .check { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .subrow { display: flex; justify-content: center; gap: var(--s-2); margin-top: var(--s-4); }
  .subrow .btn { padding: 0 var(--s-4); font-size: var(--t-md); }
  @media (max-width: 480px) {
    .sheet { padding: var(--s-6) var(--s-5) var(--s-5); border-radius: var(--r-xl); }
    h1 { font-size: 30px; }
    .plot { column-gap: 3px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .btn.hold.holding { transform: none; }
  }
`

// Each set and put back on its own: a page script may change one.
const OVERFLOW_PROPS = ['overflow-x', 'overflow-y'] as const
type SavedStyle = { value: string; priority: string }
type ScrollPosition = { left: number; top: number }
type Scope = Document | ShadowRoot

type Tracker = Pick<FocusTracker, 'blockReason' | 'setBlocked' | 'snooze' | 'site' | 'tabState' | 'onState'>

// The block screen is a modal <dialog> inside a closed shadow root. While it
// is open (showModal), the browser puts it in the top layer and makes the rest
// of the page inert: no clicks, no Tab stops, hidden from assistive tech. The
// handlers below cover what showModal leaves open: Escape (a close request),
// later top-layer elements (fullscreen, or a page dialog or popover opened
// above it), media that keeps playing behind it, focus leaving it (Tab past
// the last button, or browsers without a modal top layer), and the page
// taking the host or <body> away.
//
// What it shows is a pause, not a lock: the site, today's time as the
// worker counts it, today's hours, and leaving (Close tab) first.
// Five more minutes takes a deliberate press and hold.
export default class BlockScreen {
  private host: HTMLDivElement
  private shadow: ShadowRoot
  private attach: () => boolean
  private dialog: HTMLDialogElement
  private fav: HTMLSpanElement
  private siteName: HTMLSpanElement
  private summary: HTMLParagraphElement
  private chart: HTMLDivElement
  private closeButton: HTMLButtonElement
  private holdButton: HoldButton
  private settingsButton: HTMLButtonElement
  private activityButton: HTMLButtonElement
  // What the content was last drawn from, so a tick redraws only on change.
  private drawn = ''
  private blocked = false
  private unsubscribeState: () => void
  // Where focus was before blocking, restored on dismissal.
  private previousFocus: Element | null = null
  // The page's own inline overflow on <html> and <body>, saved only while this
  // instance overrides it.
  private savedOverflow: Map<HTMLElement, Map<string, SavedStyle>> | null = null
  // The window's scroll offset when blocking began, restored on dismissal.
  private savedWindow: ScrollPosition | null = null
  // The page's top-layer elements known to be below the dialog.
  private below = new Set<Element>()
  // Where the play listener is held while blocked: the document and the
  // shadow roots and frames found in it.
  private playScopes = new Set<Scope>()

  constructor(
    private tracker: Tracker,
    private bus: Bus = chromeBus
  ) {
    const { host, shadow, attach } = mountShadowHost(HOST_ID, STYLES)
    this.host = host
    this.shadow = shadow
    this.attach = attach
    const s = host.style
    s.setProperty('inset', '0', 'important')
    s.setProperty('display', 'none', 'important')
    // Opaque even before (or without) the modal dialog painting over it.
    s.setProperty('background', 'var(--bg)', 'important')

    const button = (cls: string, onClick: () => void, ...children: Array<Node | string>) => {
      const el = h('button', { type: 'button', class: cls }, ...children)
      el.addEventListener('click', onClick)
      return el
    }
    // Leaving is the primary action: the worker closes this tab.
    this.closeButton = button(
      'btn btn-primary close',
      () => void this.bus.send('closeTab', {}),
      svg('0 0 20 20', 'icon', ['path', { d: 'M5.75 5.75l8.5 8.5m0-8.5l-8.5 8.5' }]),
      t('blockClose')
    )
    const minutes = String(msToMinutes(SNOOZE_MS))
    this.holdButton = new HoldButton(
      {
        rest: t('blockHold', minutes),
        holding: t('blockHolding'),
        done: t('blockSnooze', minutes),
        hint: t('blockHoldHint'),
      },
      () => {
        this.unblock()
        void this.tracker.snooze()
      }
    )
    // Each opens in a tab of its own, through the service worker; this page
    // stays blocked.
    this.settingsButton = button(
      'btn btn-quiet settings',
      () => void this.bus.send('open', { page: 'options' }),
      t('popupSettings')
    )
    this.activityButton = button(
      'btn btn-quiet activity',
      () => void this.bus.send('open', { page: 'activity' }),
      t('blockSeeActivity')
    )
    this.fav = h('span', { class: 'fav', 'aria-hidden': 'true' })
    this.siteName = h('span', { class: 'name' })
    this.summary = h('p', { class: 'used', id: 'used' })
    this.chart = h('div', { class: 'chart', role: 'img' })

    const hold = this.holdButton
    this.dialog = h(
      'dialog',
      {
        class: 'screen',
        role: 'alertdialog',
        'aria-modal': 'true',
        'aria-labelledby': 'title',
        'aria-describedby': 'used',
      },
      h(
        'div',
        { class: 'sheet' },
        h('div', { class: 'site' }, this.fav, this.siteName),
        h('h1', { id: 'title' }, t('blockTitle')),
        this.summary,
        h('div', { class: 'panel' }, this.chart),
        this.closeButton,
        hold.el,
        hold.hint,
        hold.status,
        h('div', { class: 'subrow' }, this.settingsButton, this.activityButton)
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
    const state = this.tracker.tabState
    if (state) {
      this.draw(state, reason)
    }
    if (this.blocked) {
      this.hold()
      return
    }
    this.blocked = true
    this.holdButton.reset()
    this.tracker.setBlocked(true)
    this.previousFocus = document.activeElement
    this.savedWindow = { left: window.scrollX, top: window.scrollY }
    this.host.style.setProperty('display', 'block', 'important')
    this.attach()
    this.lockScroll()
    this.exitFullscreen()
    this.raise()
    this.pauseMedia(reachableScopes(this.host))
    this.listen(true)
  }

  // The site, the summary line and the chart, from the worker's state at
  // now: redrawn only when what they show changed.
  private draw(state: TabState, reason: BlockReason) {
    const now = Date.now()
    const hours = hoursAt(state, now)
    const { scope, limit, elapsed } = reason
    const shown = [state.site, scope, limit, toMinutes(elapsed), hours.map(toMinutes), hourOf(now)]
    const key = JSON.stringify(shown)
    if (key === this.drawn) {
      return
    }
    this.drawn = key
    this.fav.textContent = state.site.charAt(0)
    this.siteName.textContent = state.site
    this.summary.replaceChildren(...summaryOf(reason))
    // The site's hours split where its own limit fell; against the
    // all-sites limit, the hours of one site can't be.
    drawChart(this.chart, hours, scope === 'site' ? limit : null, hourOf(now), state.site)
  }

  // Each tick while blocked, take back what the page changed since the last:
  // the host put back (and the dialog with it, as removal took it out of the
  // top layer), the dialog raised above a page dialog or popover opened over
  // it, a replaced <body> locked, and media found since paused.
  private hold() {
    const scopes = reachableScopes(this.host)
    if (this.attach() || this.covered(scopes)) {
      this.raise()
    }
    this.lockScroll()
    this.pauseMedia(scopes)
  }

  private unblock() {
    if (!this.release()) {
      return
    }
    this.holdButton.reset()
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
    for (const scope of this.playScopes) {
      scope.removeEventListener('play', this.handlePlay, true)
    }
    this.playScopes.clear()
    this.below.clear()
    return true
  }

  // Add (or remove) the page listeners held while blocked.
  private listen(on: boolean) {
    const listeners: Array<[EventTarget, string, (e: never) => void, boolean]> = [
      [document, 'focusin', this.handleFocusIn, true],
      [document, 'toggle', this.handleToggle, true],
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
    this.focusClose()
  }

  // Focus Close tab with its ring showing: a browser that withholds
  // :focus-visible from script focus gets the ring by class, until focus
  // moves or a pointer is used.
  private focusClose() {
    const button = this.closeButton
    button.focus({ preventScroll: true, focusVisible: true } as FocusOptions)
    if (!button.matches(':focus-visible')) {
      button.classList.add('is-focus')
      const drop = () => {
        button.classList.remove('is-focus')
        button.removeEventListener('blur', drop)
        this.dialog.removeEventListener('pointerdown', drop)
      }
      button.addEventListener('blur', drop)
      this.dialog.addEventListener('pointerdown', drop)
    }
  }

  // Show the dialog again, now the newest entry in the top layer: above, and
  // making inert, whatever the page put there.
  private raise() {
    this.dialog.close()
    this.showDialog()
    this.below = new Set(topLayer(reachableScopes(this.host)))
  }

  // Whether a page element entered the top layer, above the dialog, since
  // the last look.
  private covered(scopes: Scope[]): boolean {
    const open = topLayer(scopes)
    const above = open.some((el) => !this.below.has(el))
    this.below = new Set(open)
    return above
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
  // A <body> (or <html>) the page swaps in while blocked is locked too.
  private lockScroll() {
    this.savedOverflow ??= new Map()
    for (const el of [document.documentElement, document.body]) {
      if (!el || this.savedOverflow.has(el)) {
        continue
      }
      const style = el.style
      this.savedOverflow.set(
        el,
        new Map(
          OVERFLOW_PROPS.map((p) => [p, { value: style.getPropertyValue(p), priority: style.getPropertyPriority(p) }])
        )
      )
      for (const p of OVERFLOW_PROPS) {
        style.setProperty(p, 'hidden', 'important')
      }
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

  // Pause media already playing, wherever the content script can reach it;
  // handlePlay keeps it paused. play doesn't cross a shadow root, so each
  // root and frame found gets its own listener. What is out of reach (a
  // cross-origin frame, a detached element) the worker silences by muting
  // the tab while blocked. Nothing is resumed on dismissal.
  private pauseMedia(scopes: Scope[]) {
    for (const scope of scopes) {
      scope.querySelectorAll<HTMLMediaElement>('video, audio').forEach((media) => {
        if (!media.paused) {
          media.pause()
        }
      })
      if (!this.playScopes.has(scope)) {
        this.playScopes.add(scope)
        scope.addEventListener('play', this.handlePlay, true)
      }
    }
  }

  // A frame's media is of the frame's window, so no instanceof check.
  private handlePlay = (e: Event) => {
    const media = e.target as Partial<HTMLMediaElement> | null
    media?.pause?.()
  }

  // A page popover (or, in newer browsers, dialog) just opened above the
  // dialog.
  private handleToggle = (e: Event) => {
    const el = e.target as Element
    if (!this.below.has(el) && isTopLayer(el)) {
      this.raise()
    }
  }

  private handleFullscreenChange = () => {
    this.exitFullscreen()
  }

  // Focus landing anywhere on the page goes back to the block screen. If it
  // can't (a page dialog opened over it made it inert), raise the dialog,
  // once the page's script has run.
  private handleFocusIn = (e: FocusEvent) => {
    if (e.composedPath().includes(this.host)) {
      return
    }
    // Focus in the closed shadow root reads as the host.
    const refocus = () => {
      this.closeButton.focus({ preventScroll: true })
      return document.activeElement === this.host
    }
    if (!refocus()) {
      queueMicrotask(() => {
        if (this.blocked && !refocus()) {
          this.raise()
        }
      })
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
    const order = [this.closeButton, this.holdButton.el, this.settingsButton, this.activityButton]
    const current = order.indexOf(this.shadow.activeElement as HTMLButtonElement)
    const step = e.shiftKey ? order.length - 1 : 1
    const next = current === -1 ? this.closeButton : order[(current + step) % order.length]!
    next.focus({ preventScroll: true })
  }
}

// The document and everything in it the content script can reach: shadow
// roots (open ones, and closed ones through chrome.dom) other than `skip`'s,
// and same-origin frames' documents, recursively.
function reachableScopes(skip: Element): Scope[] {
  const scopes: Scope[] = []
  const visit = (root: Scope) => {
    scopes.push(root)
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
    for (let el = walker.nextNode() as Element | null; el; el = walker.nextNode() as Element | null) {
      if (el === skip) {
        continue
      }
      const shadow = shadowRootOf(el)
      if (shadow) {
        visit(shadow)
      }
      const frame = el.localName === 'iframe' || el.localName === 'frame'
      const inner = frame ? (el as HTMLIFrameElement).contentDocument : null
      if (inner) {
        visit(inner)
      }
    }
  }
  visit(document)
  return scopes
}

// The page's open modal dialogs and popovers in `scopes`. A frame's own top
// layer sits inside the frame, below the dialog.
function topLayer(scopes: Scope[]): Element[] {
  return scopes
    .filter((scope) => (scope.ownerDocument ?? scope) === document)
    .flatMap((scope) => [...scope.querySelectorAll(':modal, :popover-open')])
}

function isTopLayer(el: Element): boolean {
  return el.matches(':modal, :popover-open')
}

// Scroll the window back to `position`, if it moved.
function restoreWindowScroll(position: ScrollPosition | null) {
  if (position && (window.scrollX !== position.left || window.scrollY !== position.top)) {
    window.scrollTo({ left: position.left, top: position.top, behavior: 'instant' })
  }
}

// Put back an element's saved inline overflow, each longhand on its own:
// one the page set while blocked is no longer ours to undo, and the other
// still is.
function restoreOverflow(style: CSSStyleDeclaration, saved: Map<string, SavedStyle>) {
  for (const p of OVERFLOW_PROPS) {
    if (style.getPropertyValue(p) !== 'hidden' || style.getPropertyPriority(p) !== 'important') {
      continue
    }
    style.removeProperty(p)
    const { value, priority } = saved.get(p)!
    if (value) {
      style.setProperty(p, value, priority)
    }
  }
}

const toMinutes = (ms: number) => Math.round(ms / 60_000)

// "1 h 10 min today · 10 min over": the time against the limit that
// blocked, then the time past it in the accent (the chart's overage), when
// there is any.
function summaryOf(reason: BlockReason): Array<Node | string> {
  const today = reason.scope === 'site' ? t('blockToday') : t('blockTodayAllSites')
  const parts: Array<Node | string> = [h('b', {}, formatDuration(reason.elapsed)), ` ${today}`]
  const over = reason.elapsed - reason.limit
  if (toMinutes(over) >= 1) {
    parts.push(' · ', h('span', { class: 'over-ink' }, t('popupOverSite', formatDuration(over))))
  }
  return parts
}

// Today on `site` by hour: grey within `limit` (null: none to split at), an
// accent cap past it, the limit's tick named where it fell, a value over the
// busiest bars that have room, and the current hour marked Now.
function drawChart(el: HTMLElement, hours: number[], limit: number | null, now: number, site: string): void {
  const top = Math.max(HOUR_FLOOR_MS, ...hours)
  const parts = splitAtLimit(hours, limit, true)
  // Values over bars with no labelled neighbour: Now first, then the
  // busiest.
  const labelled = new Set<number>()
  const order = [now, ...hours.map((_, i) => i).sort((a, b) => hours[b]! - hours[a]!)]
  for (const i of order) {
    if (toMinutes(hours[i]!) >= 1 && !labelled.has(i - 1) && !labelled.has(i + 1)) {
      labelled.add(i)
    }
  }
  const empty = (i: number) => i < 0 || i >= hours.length || hours[i]! === 0
  const cols = parts.map((part, i) => {
    const col = h('div', { 'data-hour': String(i), 'data-now': i === now })
    // The limit's name on the side with room: left unless that neighbour has
    // a bar and the right one doesn't (or there is no room left).
    const side = i >= 2 && (empty(i - 1) || !empty(i + 1)) ? 'left' : 'right'
    drawBar(col, part, top, limit === null ? null : { text: formatDuration(limit), side })
    if (labelled.has(i)) {
      col.append(h('span', { class: 'val' }, t('limitChipMinutes', String(toMinutes(hours[i]!)))))
    }
    return col
  })
  const locale = uiLocale()
  // Axis names that would crowd Now give way to it.
  const marks = AXIS_MARKS.filter((hour) => Math.abs(hour - now) >= 3)
  const axisLabel = (hour: number, text: string, cls?: string) => {
    const span = h('span', { class: cls }, text)
    span.style.setProperty('--h', String(hour))
    return span
  }
  el.setAttribute('aria-label', t('popupStripAria', site))
  el.replaceChildren(
    h('div', { class: 'plot' }, ...cols),
    h(
      'div',
      { class: 'axis', 'aria-hidden': 'true' },
      ...marks.map((hour) => axisLabel(hour, hourLabel(hour, locale), hour === 0 ? 'first' : undefined)),
      axisLabel(now, t('blockNow'), now === 0 ? 'now first' : 'now')
    )
  )
}
