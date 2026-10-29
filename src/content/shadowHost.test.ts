// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { shadowRootOf } from './shadowHost'

describe('shadowRootOf', () => {
  it('reaches a closed root through chrome.dom', () => {
    const el = document.createElement('div')
    const closed = el.attachShadow({ mode: 'closed' })
    chrome.dom.openOrClosedShadowRoot = () => closed
    expect(shadowRootOf(el)).toBe(closed)
  })

  it('falls back to the open root where chrome.dom is missing', () => {
    const el = document.createElement('div')
    const open = el.attachShadow({ mode: 'open' })
    ;(chrome as { dom?: unknown }).dom = undefined
    expect(shadowRootOf(el)).toBe(open)
  })
})
