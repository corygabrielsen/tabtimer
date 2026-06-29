export type Site = { label: string; host: string }

// Suggested social sites the user can enable with one click. They can also add
// any other site from the options page.
export const SUGGESTED_SITES: Site[] = [
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

// Normalize free-form input (a bare host or a full URL) to a registrable host.
export function normalizeHost(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  let host = trimmed
  try {
    // Accept full URLs and protocol-relative input.
    host = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname
  } catch {
    return null
  }
  host = host.replace(/^www\./, '').toLowerCase()
  // Require at least one dot (a real domain).
  return host.includes('.') ? host : null
}

// The match patterns granted/registered for a host: its apex and subdomains.
export function originsForHost(host: string): string[] {
  return [`*://${host}/*`, `*://*.${host}/*`]
}

// Recover the registrable host from one of our origin patterns.
export function hostFromOrigin(origin: string): string {
  return origin
    .replace(/^\*:\/\//, '')
    .replace(/^\*\./, '')
    .replace(/\/\*$/, '')
}
