// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { MAX_LIMIT_MINUTES } from './core/limits'
import { h, firstDayOfWeek, formatDuration, placeChildren, uiLocale, validateMinutes, flashSaved } from './ui'

describe('h', () => {
  it('builds an element with attributes and text children, never parsing HTML', () => {
    const el = h('p', { id: 'x', hidden: true, title: undefined, 'data-on': false }, 'a <b>', null, h('span', {}, 'c'))
    expect(el.id).toBe('x')
    expect(el.hasAttribute('hidden')).toBe(true)
    expect(el.hasAttribute('title')).toBe(false)
    expect(el.hasAttribute('data-on')).toBe(false)
    expect(el.textContent).toBe('a <b>c')
    expect(el.querySelector('b')).toBeNull()
  })
})

describe('placeChildren', () => {
  it('orders the children around the one holding focus, which never moves', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => h('li', { id }, h('input', { id: `${id}-in` })))
    const list = h('ul', {}, a!, b!, c!)
    document.body.replaceChildren(list)
    document.getElementById('b-in')!.focus()
    const blurs = vi.fn()
    document.getElementById('b-in')!.addEventListener('blur', blurs)
    const moved = vi.spyOn(b!, 'remove')
    placeChildren(list, [d!, c!, b!])
    expect([...list.children].map((li) => li.id)).toEqual(['d', 'c', 'b'])
    expect(moved).not.toHaveBeenCalled()
    expect(document.activeElement?.id).toBe('b-in')
    expect(blurs).not.toHaveBeenCalled()
  })

  it('replaces them outright when focus is elsewhere', () => {
    const [a, b] = ['a', 'b'].map((id) => h('li', { id }))
    const list = h('ul', {}, a!)
    document.body.replaceChildren(list)
    placeChildren(list, [b!, a!])
    expect([...list.children].map((li) => li.id)).toEqual(['b', 'a'])
  })
})

describe('formatDuration', () => {
  it.each([
    [0, '0 min'],
    [-5 * 60_000, '0 min'],
    [45 * 60_000, '45 min'],
    [89_999, '1 min'],
    [60 * 60_000, '1 h'],
    [65 * 60_000, '1 h 05 min'],
    [180 * 60_000, '3 h'],
  ])('%i ms reads as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })
})

describe('validateMinutes', () => {
  it('reads blank as no limit, and whole minutes in range as a number', () => {
    expect(validateMinutes('  ')).toBeNull()
    expect(validateMinutes(' 30 ')).toBe(30)
    expect(validateMinutes('007')).toBe(7)
    expect(validateMinutes(String(MAX_LIMIT_MINUTES))).toBe(1440)
  })

  it.each(['0', '1441', '-1', '1.5', '1e3', 'ten'])('rejects %s', (raw) => {
    expect(validateMinutes(raw)).toBe('invalid')
  })
})

describe('flashSaved', () => {
  it('shows "Saved", then fades it out; a repeat restarts the clock', () => {
    vi.useFakeTimers()
    try {
      const el = document.createElement('span')
      flashSaved(el)
      expect(el.textContent).toBe('Saved')
      expect(el.classList.contains('is-on')).toBe(true)
      vi.advanceTimersByTime(1000)
      flashSaved(el)
      vi.advanceTimersByTime(1000)
      expect(el.classList.contains('is-on')).toBe(true)
      vi.advanceTimersByTime(600)
      expect(el.classList.contains('is-on')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a missing element', () => {
    expect(() => flashSaved(null)).not.toThrow()
  })
})

describe('locale', () => {
  it('is the browser UI language', () => {
    expect(uiLocale()).toBe('en-US')
    vi.spyOn(chrome.i18n, 'getUILanguage').mockReturnValue('')
    expect(uiLocale()).toBe('en')
  })

  it('knows where the week starts', () => {
    expect(firstDayOfWeek('en-US')).toBe(0)
    expect(firstDayOfWeek('en-GB')).toBe(1)
    expect(firstDayOfWeek('not a locale!')).toBe(0)
  })

  it('reads the older weekInfo property, or falls back to Sunday', () => {
    // Engines differ in which of the two they have; stand in for both.
    let locale: object = { weekInfo: { firstDay: 1 } }
    vi.spyOn(Intl, 'Locale').mockImplementation(function () {
      return locale as Intl.Locale
    } as never)
    expect(firstDayOfWeek('en-GB')).toBe(1)
    locale = {}
    expect(firstDayOfWeek('en-GB')).toBe(0)
  })
})
