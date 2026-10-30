// The service worker's check of incoming requests against the contract
// (core/messages.ts). It needs the public suffix list, so content.js never
// imports it.
import { isBool, isFiniteNumber, isObject, type Raw } from './guards'
import { MAX_LIMIT_MINUTES, MIN_LIMIT_MINUTES } from './limits'
import { parsePresence, type Request } from './messages'
import { MAX_SCALE, MIN_SCALE, type Prefs } from './schema'
import { siteOf, type Site } from './site'

// A site in canonical form: a plausible lowercase hostname that is its own
// site.
function isSite(v: unknown): v is Site {
  return typeof v === 'string' && v.length > 0 && v.length <= 253 && /^[a-z0-9.\-[\]:]+$/.test(v) && siteOf(v) === v
}

// A limit: whole minutes in the settable range, or null (no limit).
// undefined = reject.
function parseLimitMinutes(v: unknown): number | null | undefined {
  if (v === null) {
    return null
  }
  return isFiniteNumber(v) && Number.isInteger(v) && v >= MIN_LIMIT_MINUTES && v <= MAX_LIMIT_MINUTES ? v : undefined
}

function parsePrefs(raw: Raw): Partial<Prefs> | null {
  const prefs: Partial<Prefs> = {}
  if ('hidden' in raw) {
    if (!isBool(raw.hidden)) {
      return null
    }
    prefs.hidden = raw.hidden
  }
  if ('scale' in raw) {
    if (!isFiniteNumber(raw.scale) || raw.scale < MIN_SCALE || raw.scale > MAX_SCALE) {
      return null
    }
    prefs.scale = raw.scale
  }
  return Object.keys(prefs).length > 0 ? prefs : null
}

// Validate an incoming message against the contract. The result is rebuilt
// from the checked fields only, so anything else in the payload (a `site` on
// a content request, say) is dropped. null = reject.
export function parseRequest(raw: unknown): Request | null {
  if (!isObject(raw)) {
    return null
  }
  switch (raw.type) {
    case 'snooze':
      return { type: 'snooze' }
    case 'todayTotals':
      return { type: 'todayTotals' }
    case 'open':
      return raw.page === 'options' || raw.page === 'activity' ? { type: 'open', page: raw.page } : null
    case 'presence': {
      const presence = parsePresence(raw)
      return presence ? { type: 'presence', ...presence } : null
    }
    case 'tabState':
      return isFiniteNumber(raw.tabId) && Number.isInteger(raw.tabId) && isSite(raw.site)
        ? { type: 'tabState', tabId: raw.tabId, site: raw.site }
        : null
    case 'setLimit': {
      const minutes = parseLimitMinutes(raw.minutes)
      if (minutes === undefined) {
        return null
      }
      if (raw.scope === 'global') {
        return { type: 'setLimit', scope: 'global', minutes }
      }
      if (raw.scope === 'site' && isSite(raw.site)) {
        return { type: 'setLimit', scope: 'site', site: raw.site, minutes }
      }
      return null
    }
    case 'setPrefs': {
      const prefs = parsePrefs(raw)
      return prefs ? { type: 'setPrefs', ...prefs } : null
    }
    default:
      return null
  }
}
