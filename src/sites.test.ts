import { describe, it, expect } from 'vitest'
import { SUGGESTED_SITES, normalizeHost, originsForHost, hostFromOrigin } from './sites'
import { baseHost, baseKeyForHost } from './storage'

describe('normalizeHost', () => {
  it.each([
    ['reddit.com', 'reddit.com'],
    ['  Reddit.COM  ', 'reddit.com'],
    ['www.reddit.com', 'reddit.com'],
    ['old.reddit.com', 'reddit.com'],
    ['https://www.youtube.com/watch?v=abc', 'youtube.com'],
    ['http://news.ycombinator.com:8080/item', 'ycombinator.com'],
    ['twitch.tv/somechannel', 'twitch.tv'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeHost(input)).toBe(expected)
  })

  it.each(['', '   ', 'localhost', 'http://intranet/', 'not a url at all', 'https://'])('rejects %j', (input) => {
    expect(normalizeHost(input)).toBeNull()
  })

  it('produces the same host the content script keys storage by', () => {
    // A site added as a URL must share a counter with the page itself.
    const added = normalizeHost('https://m.facebook.com/home')
    expect(added).not.toBeNull()
    expect(baseKeyForHost('www.facebook.com')).toBe(baseKeyForHost(added!))
  })
})

describe('origin patterns', () => {
  it('cover the apex and every subdomain', () => {
    expect(originsForHost('reddit.com')).toEqual(['*://reddit.com/*', '*://*.reddit.com/*'])
  })

  it('round-trip back to the host', () => {
    for (const origin of originsForHost('x.com')) {
      expect(hostFromOrigin(origin)).toBe('x.com')
    }
  })
})

describe('SUGGESTED_SITES', () => {
  it('lists hosts already in normalized, counter-matching form', () => {
    for (const site of SUGGESTED_SITES) {
      expect(normalizeHost(site.host), site.label).toBe(site.host)
      expect(baseHost(site.host)).toBe(site.host)
    }
  })

  it('has no duplicate hosts or labels', () => {
    expect(new Set(SUGGESTED_SITES.map((s) => s.host)).size).toBe(SUGGESTED_SITES.length)
    expect(new Set(SUGGESTED_SITES.map((s) => s.label)).size).toBe(SUGGESTED_SITES.length)
  })
})

describe('baseHost', () => {
  it('collapses subdomains of a .com to one site', () => {
    expect(baseHost('a.b.example.com')).toBe('example.com')
  })

  it.fails('B4: keeps the registrable domain under a multi-label public suffix', () => {
    expect(baseHost('www.bbc.co.uk')).toBe('bbc.co.uk')
  })

  it.fails('B4: does not merge unrelated sites that share a public suffix', () => {
    expect(baseHost('bbc.co.uk')).not.toBe(baseHost('amazon.co.uk'))
  })

  it.fails('B4: keeps an IP address intact', () => {
    expect(baseHost('192.168.1.1')).toBe('192.168.1.1')
  })
})
