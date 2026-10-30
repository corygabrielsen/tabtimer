// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { t, localizeDom } from './i18n'
import enMessages from '../_locales/en/messages.json'
import popupHtml from '../popup.html?raw'
import optionsHtml from '../options.html?raw'
import usageHtml from '../usage.html?raw'
import manifestJson from '../manifest.json?raw'

const sources = import.meta.glob<string>(['./**/*.ts', '!./**/*.test.ts', '!./test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

describe('t', () => {
  it('returns the localized message', () => {
    expect(t('blockTitle')).toBe("Time's up")
  })

  it('fills placeholders from substitutions', () => {
    expect(t('blockDetail', ['00:10:00', '00:30:00'])).toBe('00:10:00 today · 00:30:00 limit')
    expect(t('popupLimitAria', 'reddit.com')).toBe('Daily limit for reddit.com')
  })

  it('falls back to the key when no message exists', () => {
    expect(t('noSuchMessage')).toBe('noSuchMessage')
  })
})

describe('localizeDom', () => {
  it('replaces text of [data-i18n] elements and sets [data-i18n-attr] attributes', () => {
    document.body.innerHTML = `
      <span id="a" data-i18n="labelToday">stale</span>
      <input id="b" data-i18n-attr="placeholder=optionsAddPlaceholder; aria-label=optionsGlobalLimit" />
      <span id="c" data-i18n-attr="title=">keep</span>`
    localizeDom()
    expect(document.getElementById('a')?.textContent).toBe('Today')
    const input = document.getElementById('b')!
    expect(input.getAttribute('placeholder')).toBe('example.com')
    expect(input.getAttribute('aria-label')).toBe('All sites')
    expect(document.getElementById('c')?.hasAttribute('title')).toBe(false)
  })

  it('only touches the given subtree', () => {
    document.body.innerHTML = `<div id="in"><b data-i18n="labelFocus">x</b></div><b id="out" data-i18n="labelFocus">x</b>`
    localizeDom(document.getElementById('in')!)
    expect(document.querySelector('#in b')?.textContent).toBe('Focus')
    expect(document.getElementById('out')?.textContent).toBe('x')
  })
})

// Every place a message key can be referenced. Add a page or script here and
// both directions of the coverage check below include it.
const SCRIPTS = Object.values(sources)
const PAGES = [popupHtml, optionsHtml, usageHtml]
const MANIFESTS = [manifestJson]

function keysInScripts(): Set<string> {
  const used = new Set<string>()
  for (const code of SCRIPTS) {
    for (const m of code.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) {
      used.add(m[1]!)
    }
  }
  return used
}

function keysInPages(): Set<string> {
  const used = new Set<string>()
  for (const html of PAGES) {
    for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) {
      used.add(m[1]!)
    }
    for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
      for (const pair of m[1]!.split(';')) {
        used.add(pair.split('=')[1]!.trim())
      }
    }
  }
  return used
}

function keysInManifests(): Set<string> {
  const used = new Set<string>()
  for (const json of MANIFESTS) {
    for (const m of json.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) {
      used.add(m[1]!)
    }
  }
  return used
}

describe('locale catalogue', () => {
  const defined = new Set(Object.keys(enMessages))
  const missing = (used: Set<string>) => [...used].filter((k) => !defined.has(k))

  it('defines every key the scripts look up', () => {
    const used = keysInScripts()
    // Guard against the pattern silently matching nothing.
    expect(used.size).toBeGreaterThan(30)
    expect(used).toContain('blockSnooze')
    expect(used).toContain('popupLimitAria')
    expect(missing(used)).toEqual([])
  })

  it('defines every key the HTML pages reference', () => {
    const used = keysInPages()
    expect(used.size).toBeGreaterThan(10)
    expect(missing(used)).toEqual([])
  })

  it('defines every key the manifest references', () => {
    const used = keysInManifests()
    expect(used).toContain('appName')
    expect(missing(used)).toEqual([])
  })

  it('has no unused keys', () => {
    const used = new Set([...keysInScripts(), ...keysInPages(), ...keysInManifests()])
    expect([...defined].filter((k) => !used.has(k))).toEqual([])
  })
})
