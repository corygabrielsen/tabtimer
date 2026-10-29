// Sites: what time is counted under, limits are set for, and grants cover.
// Pure: no chrome, no DOM.
//
// A site is the registrable domain of a host under the Public Suffix List
// (private suffixes included, so foo.github.io and bar.github.io are separate
// sites), or the exact host when there is none (an IP address, localhost).
//
// The list is large: this module is for the service worker, popup and options
// bundles only. content.js never imports it (an ESLint rule enforces that); it
// learns its site from the service worker.
import { parse } from 'tldts'

export type Site = string

const PSL = { allowPrivateDomains: true } as const

// A hostname as Chrome's match patterns compare it: lowercase, without the
// trailing dot of a fully qualified name. Every host is read through this.
function canonicalHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '')
}

// The site a hostname belongs to.
export function siteOf(hostname: string): Site {
  const host = canonicalHost(hostname)
  return parse(host, PSL).domain ?? host
}

// Is `hostname` an IP address (v4, or v6 in URL brackets)?
function isIp(hostname: string): boolean {
  return parse(hostname.replace(/^\[(.*)\]$/, '$1'), PSL).isIp === true
}

// The site tracking runs under for `hostname`, or null: a name without a
// dot, or a bare public suffix (co.uk, s3.amazonaws.com), whose grant would
// cover every site under it. An IP address is its own site. The one test
// the popup, the settings input and the service worker share.
export function trackableSite(hostname: string): Site | null {
  const host = canonicalHost(hostname)
  if (isIp(host)) {
    return host
  }
  return host.includes('.') ? (parse(host, PSL).domain ?? null) : null
}

// Hosts extensions can never run on, even with a grant.
const RESTRICTED_HOSTS = new Set(['chromewebstore.google.com', 'chrome.google.com', 'microsoftedge.microsoft.com'])

function httpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname ? parsed : null
  } catch {
    return null
  }
}

// The trackable site of a page URL, or null where tracking can't run (not
// http(s), a restricted host, or no trackable site).
export function trackableSiteOfUrl(url: string): Site | null {
  const parsed = httpUrl(url)
  return parsed && !RESTRICTED_HOSTS.has(canonicalHost(parsed.hostname)) ? trackableSite(parsed.hostname) : null
}

// Normalize free-form input (a bare host or a full URL) to its trackable
// site, so grants and counters line up.
export function normalizeSiteInput(input: string): Site | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  try {
    // Accept full URLs and protocol-relative input.
    return trackableSite(new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname)
  } catch {
    return null
  }
}

// The match patterns granted/registered for a site: its apex and subdomains
// (an IP address has no subdomains).
export function originsForSite(site: Site): string[] {
  return isIp(site) ? [`*://${site}/*`] : [`*://${site}/*`, `*://*.${site}/*`]
}

// An http(s) host permission in the match-pattern grammar
// (<scheme>://<host>[:<port>]/<path>). `wildcard` adds every subdomain of
// `host`; the "*" host is the wildcard over the empty host: every host.
export type Pattern = { scheme: '*' | 'http' | 'https'; host: string; wildcard: boolean }

const PATTERN = /^(\*|https?):\/\/(\*|\*\.[^/:*]+|\[[^\]/]+\]|[^/:*]+)(?::(?:\*|\d+))?\/.*$/

// Parse a granted origin; null for anything that isn't an http(s) pattern.
export function parsePattern(origin: string): Pattern | null {
  if (origin === '<all_urls>') {
    return { scheme: '*', host: '', wildcard: true }
  }
  const m = PATTERN.exec(origin)
  if (!m) {
    return null
  }
  const scheme = m[1] as Pattern['scheme']
  const host = canonicalHost(m[2]!)
  if (host === '*') {
    return { scheme, host: '', wildcard: true }
  }
  return host.startsWith('*.') ? { scheme, host: host.slice(2), wildcard: true } : { scheme, host, wildcard: false }
}

// Does `pattern` cover the page at `url`?
function patternMatches(pattern: Pattern, url: string): boolean {
  const parsed = httpUrl(url)
  if (!parsed || (pattern.scheme !== '*' && `${pattern.scheme}:` !== parsed.protocol)) {
    return false
  }
  const host = canonicalHost(parsed.hostname)
  return host === pattern.host || (pattern.wildcard && (pattern.host === '' || host.endsWith(`.${pattern.host}`)))
}

// Granted origins as the user sees them: per site, the raw patterns granted
// for it (so stopping removes exactly those), and the every-host grants
// apart. Origins that aren't http(s) patterns are left out.
export type Grants = { sites: Map<Site, string[]>; all: string[] }

export function grantsOf(origins: readonly string[]): Grants {
  const grants: Grants = { sites: new Map(), all: [] }
  for (const origin of origins) {
    const pattern = parsePattern(origin)
    if (!pattern) {
      continue
    }
    if (pattern.host === '') {
      grants.all.push(origin)
      continue
    }
    const site = siteOf(pattern.host)
    grants.sites.set(site, [...(grants.sites.get(site) ?? []), origin])
  }
  return grants
}

// The granted origins tracking runs on: every-host grants, and grants whose
// host has a trackable site. A grant for a bare public suffix would count
// each site under it apart, with no row or limit of its own.
export function trackedOrigins(origins: readonly string[]): string[] {
  return origins.filter((origin) => {
    const pattern = parsePattern(origin)
    return pattern !== null && (pattern.host === '' || trackableSite(pattern.host) !== null)
  })
}

// Is the page at `url` covered by one of the tracked `origins`?
export function isTracked(origins: readonly string[], url: string): boolean {
  return trackedOrigins(origins).some((origin) => patternMatches(parsePattern(origin)!, url))
}

// Which sites the tracked `origins` count time for: those granted, or every
// site under an every-host grant.
export function trackedSite(origins: readonly string[]): (site: Site) => boolean {
  const grants = grantsOf(trackedOrigins(origins))
  return (site) => grants.all.length > 0 || grants.sites.has(site)
}

// Suggested social sites the user can enable with one click. They can also add
// any other site from the options page.
export const SUGGESTED_SITES: Array<{ label: string; host: Site }> = [
  { label: 'Discord', host: 'discord.com' },
  { label: 'Facebook', host: 'facebook.com' },
  { label: 'Instagram', host: 'instagram.com' },
  { label: 'LinkedIn', host: 'linkedin.com' },
  { label: 'Pinterest', host: 'pinterest.com' },
  { label: 'Quora', host: 'quora.com' },
  { label: 'Reddit', host: 'reddit.com' },
  { label: 'Snapchat', host: 'snapchat.com' },
  { label: 'Telegram', host: 'telegram.org' },
  { label: 'TikTok', host: 'tiktok.com' },
  { label: 'Tumblr', host: 'tumblr.com' },
  { label: 'Twitch', host: 'twitch.tv' },
  { label: 'X', host: 'x.com' },
  { label: 'YouTube', host: 'youtube.com' },
]
