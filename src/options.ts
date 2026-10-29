import { SUGGESTED_SITES, originsForHost, hostFromOrigin, normalizeHost } from './sites'
import { readLimits, setGlobalLimit, setPerSiteLimit, msToMinutes, parseLimitMinutes } from './limits'
import { localizeDom, t } from './i18n'

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function enable(host: string): Promise<boolean> {
  // Must run during a user gesture — call request first, no awaits before it.
  return chrome.permissions.request({ origins: originsForHost(host) }).catch(() => false)
}

function disable(host: string): Promise<boolean> {
  return chrome.permissions.remove({ origins: originsForHost(host) }).catch(() => false)
}

async function grantedHosts(): Promise<Set<string>> {
  const perms = await chrome.permissions.getAll().catch(() => ({ origins: [] as string[] }))
  return new Set((perms.origins ?? []).map(hostFromOrigin))
}

function limitField(host: string, currentMs: number | undefined): HTMLSpanElement {
  const wrap = document.createElement('span')
  wrap.className = 'limitfield'

  const input = document.createElement('input')
  input.type = 'number'
  input.min = '1'
  input.inputMode = 'numeric'
  input.placeholder = t('optionsLimitOff')
  input.setAttribute('aria-label', t('optionsSiteLimitAria', host))
  if (typeof currentMs === 'number') {
    input.value = String(msToMinutes(currentMs))
  }
  input.addEventListener('change', () => {
    void setPerSiteLimit(host, parseLimitMinutes(input.value))
  })

  const unit = document.createElement('span')
  unit.className = 'unit'
  unit.textContent = t('optionsMinutes')

  wrap.append(input, unit)
  return wrap
}

function siteRow(
  label: string,
  host: string,
  enabled: boolean,
  limitMs: number | undefined,
  onToggle: () => void
): HTMLLIElement {
  const li = document.createElement('li')
  li.className = 'item'

  const left = document.createElement('div')
  left.className = 'left'
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = label
  const sub = document.createElement('span')
  sub.className = 'host'
  sub.textContent = host
  left.append(name, sub)
  li.append(left)

  // Only enabled (tracked) sites can carry a limit.
  if (enabled) {
    li.append(limitField(host, limitMs))
  }

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = enabled ? 'toggle on' : 'toggle'
  btn.textContent = enabled ? t('optionsEnabled') : t('optionsEnable')
  btn.setAttribute('aria-pressed', String(enabled))
  btn.addEventListener('click', onToggle)
  li.append(btn)

  return li
}

async function render() {
  const suggestedUl = byId<HTMLUListElement>('suggested')
  const customUl = byId<HTMLUListElement>('custom')
  const customH = byId('custom-h')
  if (!suggestedUl || !customUl) {
    return
  }

  const [granted, limits] = await Promise.all([grantedHosts(), readLimits()])

  suggestedUl.replaceChildren(
    ...SUGGESTED_SITES.map((s) => {
      const enabled = granted.has(s.host)
      return siteRow(s.label, s.host, enabled, limits.perSite[s.host], () => {
        void (enabled ? disable(s.host) : enable(s.host))
      })
    })
  )

  const suggested = new Set(SUGGESTED_SITES.map((s) => s.host))
  const customHosts = [...granted].filter((h) => !suggested.has(h)).sort()
  customH?.toggleAttribute('hidden', customHosts.length === 0)
  customUl.replaceChildren(...customHosts.map((h) => siteRow(h, h, true, limits.perSite[h], () => void disable(h))))
}

async function initGlobalLimit() {
  const input = byId<HTMLInputElement>('global-limit')
  if (!input) {
    return
  }
  const limits = await readLimits()
  if (limits.global) {
    input.value = String(msToMinutes(limits.global))
  }
  input.addEventListener('change', () => {
    void setGlobalLimit(parseLimitMinutes(input.value))
  })
}

byId('enable-suggested')?.addEventListener('click', () => {
  void chrome.permissions
    .request({ origins: SUGGESTED_SITES.flatMap((s) => originsForHost(s.host)) })
    .catch(() => false)
})

byId<HTMLFormElement>('add-form')?.addEventListener('submit', (e) => {
  e.preventDefault()
  const input = byId<HTMLInputElement>('add-input')
  const host = normalizeHost(input?.value ?? '')
  if (!host) {
    return
  }
  void enable(host).then((ok) => {
    if (ok && input) {
      input.value = ''
    }
  })
})

// Re-render whenever a grant changes (including the prompts above).
chrome.permissions.onAdded.addListener(() => void render())
chrome.permissions.onRemoved.addListener(() => void render())

localizeDom()
void initGlobalLimit()
void render()
