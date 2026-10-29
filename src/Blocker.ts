import type Model from './Model'
import { baseHost } from './storage'
import {
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
    color: #5f5f5f;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .manage:hover {
    color: #8a8a8a;
  }
  .snooze:focus-visible,
  .manage:focus-visible {
    outline: 1px solid #9a9a9a;
    outline-offset: 2px;
  }
`

export default class Blocker {
  private host: HTMLDivElement
  private shadow: ShadowRoot
  private hostLine: HTMLDivElement
  private detailLine: HTMLDivElement
  private siteHost: string
  private limits: Limits = { global: null, perSite: {} }
  private snoozeUntil = 0
  private blocked = false

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

    const screen = document.createElement('div')
    screen.className = 'screen'
    screen.setAttribute('role', 'alertdialog')
    screen.setAttribute('aria-label', t('blockTitle'))

    const box = document.createElement('div')
    box.className = 'box'

    const title = document.createElement('div')
    title.className = 'title'
    title.textContent = t('blockTitle')

    this.hostLine = document.createElement('div')
    this.hostLine.className = 'host'

    this.detailLine = document.createElement('div')
    this.detailLine.className = 'detail'

    const snooze = document.createElement('button')
    snooze.type = 'button'
    snooze.className = 'snooze'
    snooze.textContent = t('blockSnooze')
    snooze.addEventListener('click', () => {
      this.unblock()
      void snoozeBlocking()
    })

    const manage = document.createElement('button')
    manage.type = 'button'
    manage.className = 'manage'
    manage.textContent = t('blockManage')
    manage.addEventListener('click', () => {
      void sendMessage({ type: 'openOptions' }).catch(() => undefined)
    })

    box.append(title, this.hostLine, this.detailLine, snooze, manage)
    screen.append(box)
    this.shadow.append(style, screen)
    document.body.appendChild(this.host)

    void this.refresh()
    chrome.storage.onChanged.addListener(this.handleStorageChange)
  }

  private async refresh() {
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
    if (!this.blocked) {
      this.blocked = true
      this.model.setBlocked(true)
      this.host.style.setProperty('display', 'block', 'important')
      document.documentElement.style.setProperty('overflow', 'hidden', 'important')
    }
  }

  private unblock() {
    if (!this.blocked) {
      return
    }
    this.blocked = false
    this.model.setBlocked(false)
    this.host.style.setProperty('display', 'none', 'important')
    document.documentElement.style.removeProperty('overflow')
  }

  destroy() {
    if (this.blocked) {
      this.model.setBlocked(false)
    }
    chrome.storage.onChanged.removeListener(this.handleStorageChange)
    document.documentElement.style.removeProperty('overflow')
    this.host.remove()
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
