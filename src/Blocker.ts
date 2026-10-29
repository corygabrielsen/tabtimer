import type Model from './Model'
import { baseHost } from './storage'
import {
  SNOOZE_MS,
  evaluateLimits,
  normalizeLimits,
  readLimits,
  readSnoozeUntil,
  snoozeBlocking,
  LIMITS_KEY,
  BLOCK_SNOOZE_KEY,
  type BlockReason,
  type Limits,
} from './limits'
import { sendMessage } from './messages'
import { formatTime } from './format'
import { t } from './i18n'

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
  .screen::backdrop { background: transparent; }
  .screen {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.96);
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

// The block screen is a modal <dialog> inside a closed shadow root. While it
// is open (showModal), the browser puts it in the top layer and makes the rest
// of the page inert: no clicks, no Tab stops, hidden from assistive tech. The
// handlers below cover what showModal leaves open: Escape (a close request),
// fullscreen (a later top-layer element would cover the dialog), media that
// keeps playing behind it, and focus leaving it (Tab past the last button, or
// browsers without a modal top layer).
export default class Blocker {
  private host: HTMLDivElement
  private shadow: ShadowRoot
  private dialog: HTMLDialogElement
  private hostLine: HTMLDivElement
  private detailLine: HTMLDivElement
  private snoozeButton: HTMLButtonElement
  private manageButton: HTMLButtonElement
  private siteHost: string
  private limits: Limits = { global: null, perSite: {} }
  private snoozeUntil = 0
  private blocked = false
  // Where focus was before blocking, restored on dismissal.
  private previousFocus: Element | null = null
  // The page's own inline overflow, saved only while this instance overrides it.
  private savedOverflow: Map<string, SavedStyle> | null = null

  constructor(private model: Model) {
    this.siteHost = baseHost(window.location.hostname)

    document.getElementById(HOST_ID)?.remove()
    this.host = document.createElement('div')
    this.host.id = HOST_ID
    const s = this.host.style
    s.setProperty('position', 'fixed', 'important')
    s.setProperty('inset', '0', 'important')
    s.setProperty('z-index', String(MAX_Z_INDEX), 'important')
    s.setProperty('display', 'none', 'important')

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
      void snoozeBlocking()
    })

    this.manageButton = document.createElement('button')
    this.manageButton.type = 'button'
    this.manageButton.className = 'manage'
    this.manageButton.textContent = t('blockManage')
    this.manageButton.addEventListener('click', () => {
      void sendMessage({ type: 'openOptions' }).catch(() => undefined)
    })

    box.append(title, this.hostLine, this.detailLine, this.snoozeButton, this.manageButton)
    this.dialog.append(box)
    this.shadow.append(style, this.dialog)
    document.body.appendChild(this.host)

    void this.refresh()
    chrome.storage.onChanged.addListener(this.handleStorageChange)
  }

  // Re-read limits and snooze state, then re-evaluate.
  async refresh(): Promise<void> {
    this.limits = await readLimits()
    this.snoozeUntil = await readSnoozeUntil()
    await this.tick()
  }

  // Called each second by the controller (visible tab only) and on pref change.
  async tick(): Promise<void> {
    const siteLimit = this.limits.perSite[this.siteHost]
    const hasSite = typeof siteLimit === 'number' && siteLimit > 0
    const hasGlobal = typeof this.limits.global === 'number' && this.limits.global > 0
    if ((!hasSite && !hasGlobal) || Date.now() < this.snoozeUntil) {
      this.unblock()
      return
    }

    const siteToday = hasSite
      ? await this.model
          .readElapsed()
          .then((e) => e.today.elapsed)
          .catch(() => 0)
      : 0
    const globalToday = hasGlobal ? await this.model.readGlobalToday().catch(() => 0) : 0
    const reason = evaluateLimits(this.limits, this.siteHost, siteToday, globalToday)
    if (reason) {
      this.block(reason)
    } else {
      this.unblock()
    }
  }

  private block(reason: BlockReason) {
    this.hostLine.textContent = reason.scope === 'site' ? this.siteHost : t('blockAllSites')
    this.detailLine.textContent = t('blockDetail', [formatTime(reason.elapsed), formatTime(reason.limit)])
    if (this.blocked) {
      return
    }
    this.blocked = true
    this.model.setBlocked(true)
    this.previousFocus = document.activeElement
    this.host.style.setProperty('display', 'block', 'important')
    this.lockScroll()
    this.exitFullscreen()
    this.showDialog()
    this.pauseMedia()
    document.addEventListener('focusin', this.handleFocusIn, true)
    document.addEventListener('play', this.handlePlay, true)
    document.addEventListener('fullscreenchange', this.handleFullscreenChange)
  }

  private unblock() {
    if (!this.blocked) {
      return
    }
    this.blocked = false
    this.model.setBlocked(false)
    this.removePageListeners()
    this.dialog.close()
    this.host.style.setProperty('display', 'none', 'important')
    this.restoreScroll()
    this.restoreFocus()
  }

  destroy() {
    if (this.blocked) {
      this.blocked = false
      this.model.setBlocked(false)
      this.removePageListeners()
    }
    chrome.storage.onChanged.removeListener(this.handleStorageChange)
    this.restoreScroll()
    this.host.remove()
    this.restoreFocus()
  }

  private removePageListeners() {
    document.removeEventListener('focusin', this.handleFocusIn, true)
    document.removeEventListener('play', this.handlePlay, true)
    document.removeEventListener('fullscreenchange', this.handleFullscreenChange)
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

  // Save the page's inline overflow (values and priorities) before overriding
  // it, so dismissal restores exactly what the page had.
  private lockScroll() {
    const style = document.documentElement.style
    this.savedOverflow ??= new Map(
      OVERFLOW_PROPS.map((p) => [p, { value: style.getPropertyValue(p), priority: style.getPropertyPriority(p) }])
    )
    style.setProperty('overflow', 'hidden', 'important')
  }

  private restoreScroll() {
    const saved = this.savedOverflow
    if (!saved) {
      return
    }
    this.savedOverflow = null
    const style = document.documentElement.style
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

  private handleStorageChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    if (areaName !== 'local') {
      return
    }
    let dirty = false
    if (changes[LIMITS_KEY]) {
      this.limits = normalizeLimits(changes[LIMITS_KEY].newValue)
      dirty = true
    }
    if (changes[BLOCK_SNOOZE_KEY]) {
      this.snoozeUntil = Number(changes[BLOCK_SNOOZE_KEY].newValue) || 0
      dirty = true
    }
    if (dirty) {
      void this.tick()
    }
  }
}
