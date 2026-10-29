import { describe, it, expect } from 'vitest'
import {
  SUGGESTED_SITES,
  grantsOf,
  isTracked,
  normalizeSiteInput,
  originsForSite,
  parsePattern,
  siteOf,
  trackableSite,
  trackableSiteOfUrl,
  trackedOrigins,
  trackedSite,
} from './site'

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

describe('trackableSiteOfUrl', () => {
  it('resolves http(s) URLs only', () => {
    expect(trackableSiteOfUrl('https://old.reddit.com/r/all')).toBe('reddit.com')
    expect(trackableSiteOfUrl('http://news.bbc.co.uk:8080/x')).toBe('bbc.co.uk')
    expect(trackableSiteOfUrl('http://192.168.1.1/')).toBe('192.168.1.1')
    expect(trackableSiteOfUrl('chrome-extension://abc/popup.html')).toBeNull()
    expect(trackableSiteOfUrl('about:blank')).toBeNull()
    expect(trackableSiteOfUrl('not a url')).toBeNull()
  })

  it('refuses hosts extensions never run on', () => {
    expect(trackableSiteOfUrl('https://chromewebstore.google.com/detail/x')).toBeNull()
    expect(trackableSiteOfUrl('https://www.google.com/')).toBe('google.com')
  })

  it.each([
    'https://s3.amazonaws.com/bucket/key',
    'https://githubusercontent.com/',
    'https://vercel.app/',
    'https://co.uk/',
    'http://localhost:3000/',
    'http://intranet/',
  ])('U2: %s has no trackable site', (url) => {
    expect(trackableSiteOfUrl(url)).toBeNull()
  })
})

describe('one host rule (C1, C2)', () => {
  it('C1: a trailing-dot host is the same site, tracked by the same grants', () => {
    const url = 'https://www.youtube.com./watch'
    expect(trackableSiteOfUrl(url)).toBe('youtube.com')
    expect(isTracked(originsForSite('youtube.com'), url)).toBe(true)
    expect(isTracked(['*://www.youtube.com./*'], 'https://www.youtube.com/')).toBe(true)
    expect(siteOf('youtube.com.')).toBe('youtube.com')
    expect(normalizeSiteInput('youtube.com.')).toBe('youtube.com')
  })

  it('C1: a trailing dot does not get past the restricted hosts', () => {
    expect(trackableSiteOfUrl('https://chromewebstore.google.com./detail/x')).toBeNull()
  })

  it('C2: an IPv6 address is a trackable site of its own', () => {
    expect(trackableSite('[::1]')).toBe('[::1]')
    expect(trackableSiteOfUrl('http://[2001:DB8::1]:8080/')).toBe('[2001:db8::1]')
    expect(normalizeSiteInput('http://[2001:db8::1]/x')).toBe('[2001:db8::1]')
    expect(originsForSite('[2001:db8::1]')).toEqual(['*://[2001:db8::1]/*'])
    expect(isTracked(originsForSite('[2001:db8::1]'), 'http://[2001:db8::1]/x')).toBe(true)
    expect(isTracked(originsForSite('[2001:db8::1]'), 'http://[2001:db8::2]/x')).toBe(false)
    expect(grantsOf(originsForSite('[::1]')).sites).toEqual(new Map([['[::1]', ['*://[::1]/*']]]))
  })
})

describe('trackedSite', () => {
  it('X4: is a site some tracked grant covers', () => {
    const tracked = trackedSite(['https://www.reddit.com/*', ...originsForSite('s3.amazonaws.com')])
    expect(tracked('reddit.com')).toBe(true)
    expect(tracked('x.com')).toBe(false)
    expect(tracked('s3.amazonaws.com')).toBe(false)
  })

  it('X4: is every site under an every-host grant', () => {
    expect(trackedSite(['*://*/*'])('x.com')).toBe(true)
    expect(trackedSite([])('x.com')).toBe(false)
  })
})

describe('trackableSite', () => {
  it('is the one test the settings input applies', () => {
    for (const host of ['s3.amazonaws.com', 'github.io', 'co.uk', 'localhost', 'www.reddit.com', '10.0.0.1']) {
      expect(normalizeSiteInput(host)).toBe(trackableSite(host))
    }
  })

  it('keeps a site under a private suffix', () => {
    expect(trackableSite('bucket.s3.amazonaws.com')).toBe('bucket.s3.amazonaws.com')
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
      expect(grantsOf(originsForSite(site)).sites).toEqual(new Map([[site, originsForSite(site)]]))
    }
  })
})

describe('parsePattern (match-pattern grammar)', () => {
  it.each([
    ['*://reddit.com/*', { scheme: '*', host: 'reddit.com', wildcard: false }],
    ['*://*.reddit.com/*', { scheme: '*', host: 'reddit.com', wildcard: true }],
    ['https://www.Reddit.com/*', { scheme: 'https', host: 'www.reddit.com', wildcard: false }],
    ['http://localhost:8080/path/*', { scheme: 'http', host: 'localhost', wildcard: false }],
    ['*://[::1]/*', { scheme: '*', host: '[::1]', wildcard: false }],
    ['*://*/*', { scheme: '*', host: '', wildcard: true }],
    ['https://*/*', { scheme: 'https', host: '', wildcard: true }],
    ['<all_urls>', { scheme: '*', host: '', wildcard: true }],
  ])('%s', (origin, pattern) => {
    expect(parsePattern(origin)).toEqual(pattern)
  })

  it.each(['file:///*', 'ftp://x.com/*', 'reddit.com', '*://reddit.com', '*://www.*.com/*', '*://*reddit.com/*'])(
    'rejects %s',
    (origin) => {
      expect(parsePattern(origin)).toBeNull()
    }
  )
})

describe('grantsOf', () => {
  it('X3/U5: groups any granted shape under its site, keeping the raw patterns', () => {
    const grants = grantsOf([
      'https://www.reddit.com/*',
      '*://*.reddit.com/*',
      '*://x.com/*',
      'http://news.bbc.co.uk/*',
      '*://*/*',
      'file:///*',
    ])
    expect(grants.sites).toEqual(
      new Map([
        ['reddit.com', ['https://www.reddit.com/*', '*://*.reddit.com/*']],
        ['x.com', ['*://x.com/*']],
        ['bbc.co.uk', ['http://news.bbc.co.uk/*']],
      ])
    )
    expect(grants.all).toEqual(['*://*/*'])
  })

  it('X3: never yields a site that is not a hostname', () => {
    const grants = grantsOf(['*://*/*', 'https://*/*', '<all_urls>', 'https://www.reddit.com/*'])
    expect([...grants.sites.keys()]).toEqual(['reddit.com'])
    expect(grants.all).toEqual(['*://*/*', 'https://*/*', '<all_urls>'])
  })
})

describe('trackedOrigins', () => {
  it('U2: drops grants for a bare public suffix', () => {
    expect(trackedOrigins([...originsForSite('s3.amazonaws.com'), ...originsForSite('x.com'), '*://*/*'])).toEqual([
      ...originsForSite('x.com'),
      '*://*/*',
    ])
  })

  it('drops what is not an http(s) pattern', () => {
    expect(trackedOrigins(['file:///*', 'nonsense'])).toEqual([])
  })
})

describe('isTracked', () => {
  it.each([
    [originsForSite('reddit.com'), 'https://old.reddit.com/r/all', true],
    [originsForSite('reddit.com'), 'https://reddit.com/', true],
    [originsForSite('reddit.com'), 'https://notreddit.com/', false],
    [['https://www.reddit.com/*'], 'https://www.reddit.com/r/all', true],
    [['https://www.reddit.com/*'], 'http://www.reddit.com/', false],
    [['https://www.reddit.com/*'], 'https://old.reddit.com/', false],
    [['*://*/*'], 'https://example.org/', true],
    [['*://*/*'], 'chrome://extensions/', false],
    [originsForSite('s3.amazonaws.com'), 'https://bucket.s3.amazonaws.com/', false],
  ])('%j covers %s: %s', (origins, url, expected) => {
    expect(isTracked(origins, url)).toBe(expected)
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
