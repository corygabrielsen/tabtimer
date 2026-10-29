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

// The site a hostname belongs to.
export function siteOf(hostname: string): Site {
  const host = hostname.toLowerCase()
  return parse(host, PSL).domain ?? host
}

// The site of an http(s) URL, or null for any other URL.
export function siteOfUrl(url: string): Site | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }
  return parsed.hostname ? siteOf(parsed.hostname) : null
}

// Is `hostname` an IP address (v4, or v6 in URL brackets)?
function isIp(hostname: string): boolean {
  return parse(hostname.replace(/^\[(.*)\]$/, '$1'), PSL).isIp === true
}

// Normalize free-form input (a bare host or a full URL) to the site it
// belongs to, so grants and counters line up. Rejects hosts without a dot and
// bare public suffixes (co.uk, github.io): granting one would cover every site
// under it.
export function normalizeSiteInput(input: string): Site | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  let hostname: string
  try {
    // Accept full URLs and protocol-relative input.
    hostname = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname.toLowerCase()
  } catch {
    return null
  }
  if (!hostname.includes('.')) {
    return null
  }
  if (isIp(hostname)) {
    return hostname
  }
  return parse(hostname, PSL).domain ?? null
}

// The match patterns granted/registered for a site: its apex and subdomains
// (an IP address has no subdomains).
export function originsForSite(site: Site): string[] {
  return isIp(site) ? [`*://${site}/*`] : [`*://${site}/*`, `*://*.${site}/*`]
}

// Recover the site from one of our origin patterns.
export function siteFromOrigin(origin: string): Site {
  return origin
    .replace(/^\*:\/\//, '')
    .replace(/^\*\./, '')
    .replace(/\/\*$/, '')
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
