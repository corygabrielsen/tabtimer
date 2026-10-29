import { describe, it, expect } from 'vitest'
import { SUGGESTED_SITES, normalizeSiteInput, originsForSite, siteFromOrigin, siteOf, siteOfUrl } from './site'

describe('siteOf (Public Suffix List)', () => {
  it.each([
    ['news.bbc.co.uk', 'bbc.co.uk'],
    ['www.reddit.com', 'reddit.com'],
    ['old.reddit.com', 'reddit.com'],
    ['reddit.com', 'reddit.com'],
    ['WWW.Reddit.COM', 'reddit.com'],
    // A private suffix: each user's site is its own.
    ['foo.github.io', 'foo.github.io'],
    ['a.b.vercel.app', 'b.vercel.app'],
    // No registrable domain: the exact host.
    ['192.168.1.1', '192.168.1.1'],
    ['[::1]', '[::1]'],
    ['localhost', 'localhost'],
    // Unlisted TLDs (the e2e fixture hosts) behave like .com.
    ['www.site-a.test', 'site-a.test'],
  ])('%s is %s', (host, site) => {
    expect(siteOf(host)).toBe(site)
  })

  it('B4: keeps the registrable domain under a multi-label public suffix', () => {
    expect(siteOf('www.bbc.co.uk')).toBe('bbc.co.uk')
  })

  it('B4: does not merge unrelated sites that share a public suffix', () => {
    expect(siteOf('bbc.co.uk')).not.toBe(siteOf('amazon.co.uk'))
  })

  it('B4: keeps an IP address intact', () => {
    expect(siteOf('192.168.1.1')).toBe('192.168.1.1')
  })

  it('does not merge different users of a shared host', () => {
    expect(siteOf('foo.github.io')).not.toBe(siteOf('bar.github.io'))
  })
})

describe('siteOfUrl', () => {
  it('resolves http(s) URLs only', () => {
    expect(siteOfUrl('https://old.reddit.com/r/all')).toBe('reddit.com')
    expect(siteOfUrl('http://news.bbc.co.uk:8080/x')).toBe('bbc.co.uk')
    expect(siteOfUrl('chrome-extension://abc/popup.html')).toBeNull()
    expect(siteOfUrl('about:blank')).toBeNull()
    expect(siteOfUrl('not a url')).toBeNull()
  })
})

describe('normalizeSiteInput', () => {
  it.each([
    ['reddit.com', 'reddit.com'],
    ['  Reddit.COM  ', 'reddit.com'],
    ['www.reddit.com', 'reddit.com'],
    ['old.reddit.com', 'reddit.com'],
    ['https://www.youtube.com/watch?v=abc', 'youtube.com'],
    ['http://news.ycombinator.com:8080/item', 'ycombinator.com'],
    ['twitch.tv/somechannel', 'twitch.tv'],
    ['https://news.bbc.co.uk/sport', 'bbc.co.uk'],
    ['foo.github.io', 'foo.github.io'],
    ['192.168.1.1', '192.168.1.1'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeSiteInput(input)).toBe(expected)
  })

  it.each(['', '   ', 'localhost', 'http://intranet/', 'not a url at all', 'https://', 'co.uk', 'github.io'])(
    'rejects %j',
    (input) => {
      expect(normalizeSiteInput(input)).toBeNull()
    }
  )

  it('produces the same site the service worker counts a page under', () => {
    const added = normalizeSiteInput('https://m.facebook.com/home')
    expect(added).toBe(siteOf('www.facebook.com'))
  })
})

describe('origin patterns', () => {
  it('cover the apex and every subdomain', () => {
    expect(originsForSite('reddit.com')).toEqual(['*://reddit.com/*', '*://*.reddit.com/*'])
    expect(originsForSite('bbc.co.uk')).toEqual(['*://bbc.co.uk/*', '*://*.bbc.co.uk/*'])
  })

  it('cover just the address for an IP', () => {
    expect(originsForSite('192.168.1.1')).toEqual(['*://192.168.1.1/*'])
  })

  it('round-trip back to the site', () => {
    for (const site of ['x.com', 'bbc.co.uk', '192.168.1.1']) {
      for (const origin of originsForSite(site)) {
        expect(siteFromOrigin(origin)).toBe(site)
      }
    }
  })
})

describe('SUGGESTED_SITES', () => {
  it('lists sites already in canonical form', () => {
    for (const site of SUGGESTED_SITES) {
      expect(normalizeSiteInput(site.host), site.label).toBe(site.host)
      expect(siteOf(site.host)).toBe(site.host)
    }
  })

  it('has no duplicate hosts or labels', () => {
    expect(new Set(SUGGESTED_SITES.map((s) => s.host)).size).toBe(SUGGESTED_SITES.length)
    expect(new Set(SUGGESTED_SITES.map((s) => s.label)).size).toBe(SUGGESTED_SITES.length)
  })
})
