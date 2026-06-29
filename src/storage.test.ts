import { describe, it, expect } from 'vitest'
import { baseHost, baseKeyForHost, todayKeyForHost, ELAPSED_KEY_PREFIX } from './storage'

describe('baseHost', () => {
  it('strips subdomains down to the last two labels', () => {
    expect(baseHost('www.reddit.com')).toBe('reddit.com')
    expect(baseHost('old.reddit.com')).toBe('reddit.com')
    expect(baseHost('reddit.com')).toBe('reddit.com')
    expect(baseHost('x.com')).toBe('x.com')
  })
})

describe('baseKeyForHost', () => {
  it('builds a stable base key from the registrable host', () => {
    expect(baseKeyForHost('www.youtube.com')).toBe(`${ELAPSED_KEY_PREFIX}_youtube.com`)
  })
})

describe('todayKeyForHost', () => {
  it('appends a zero-padded ISO date for the given day', () => {
    const day = new Date(2026, 0, 5) // 2026-01-05, local
    expect(todayKeyForHost('m.youtube.com', day)).toBe(`${ELAPSED_KEY_PREFIX}_youtube.com_2026-01-05`)
  })

  it('maps two subdomains of one site to the same key', () => {
    const day = new Date(2026, 5, 28)
    expect(todayKeyForHost('old.reddit.com', day)).toBe(todayKeyForHost('www.reddit.com', day))
  })
})
