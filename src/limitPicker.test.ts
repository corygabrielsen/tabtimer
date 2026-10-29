// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createLimitPicker,
  formatChipMinutes,
  SITE_PRESETS,
  ARROW_SAVE_DELAY_MS,
  type LimitPicker,
} from './limitPicker'
import { flush } from './test/dom'

let picker: LimitPicker
let commit: ReturnType<typeof vi.fn<(minutes: number | null) => Promise<void>>>
let onChange: ReturnType<typeof vi.fn<(minutes: number | null) => void>>
let saved: HTMLElement

function mount(value: number | null, extra: { onEscape?: () => void } = {}) {
  saved = document.createElement('span')
  commit = vi.fn(() => Promise.resolve())
  onChange = vi.fn()
  picker = createLimitPicker({
    id: 'lp',
    presets: SITE_PRESETS,
    label: 'Daily limit for x.com',
    fieldLabel: 'Custom daily limit for x.com, in minutes',
    value,
    saved,
    commit,
    onChange,
    ...extra,
  })
  document.body.replaceChildren(picker.el)
}

const group = () => document.querySelector<HTMLElement>('[role="radiogroup"]')!
const chips = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
const chip = (label: string) => chips().find((c) => c.textContent === label)!
const checked = () => chips().filter((c) => c.getAttribute('aria-checked') === 'true')
const field = () => document.getElementById('lp-custom') as HTMLInputElement
const error = () => document.getElementById('lp-error')!
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))

beforeEach(() => {
  document.body.replaceChildren()
})

describe('formatChipMinutes', () => {
  it.each([
    [15, '15m'],
    [50, '50m'],
    [60, '1h'],
    [90, '1h 30m'],
    [1440, '24h'],
  ])('%i reads as %s', (minutes, text) => {
    expect(formatChipMinutes(minutes)).toBe(text)
  })
})

describe('limit picker', () => {
  it('is a labelled radio group of presets, Off and Custom, with exactly one checked', () => {
    mount(null)
    expect(group().getAttribute('aria-label')).toBe('Daily limit for x.com')
    expect(chips().map((c) => c.textContent)).toEqual(['Off', '15m', '30m', '1h', '2h', 'Custom'])
    expect(checked().map((c) => c.textContent)).toEqual(['Off'])
    // Presets read as durations to assistive tech.
    expect(chip('1h').getAttribute('aria-label')).toBe('1 h')
  })

  it('selects the preset matching the stored value', () => {
    mount(30)
    expect(checked().map((c) => c.textContent)).toEqual(['30m'])
    expect(chip('Custom')).toBeDefined()
  })

  it('shows a non-preset value as its own chip in place of Custom', () => {
    mount(90)
    expect(chips().map((c) => c.textContent)).toEqual(['Off', '15m', '30m', '1h', '2h', '1h 30m'])
    expect(checked()[0]?.textContent).toBe('1h 30m')
    expect(checked()[0]?.getAttribute('aria-label')).toBe('Custom: 1 h 30 min')
  })

  it('saves a preset as soon as it is picked, with the Saved notice', async () => {
    mount(null)
    chip('30m').click()
    expect(commit).toHaveBeenCalledWith(30)
    expect(onChange).toHaveBeenCalledWith(30)
    await flush()
    expect(saved.textContent).toBe('Saved')
    expect(checked().map((c) => c.textContent)).toEqual(['30m'])
    chip('Off').click()
    expect(commit).toHaveBeenLastCalledWith(null)
  })

  it('does not save again when the checked preset is picked', () => {
    mount(30)
    chip('30m').click()
    expect(commit).not.toHaveBeenCalled()
  })

  it('uses a roving tabindex: only the checked chip is in the tab order', () => {
    mount(60)
    expect(chips().map((c) => c.tabIndex)).toEqual([-1, -1, -1, 0, -1, -1])
  })

  describe('custom value', () => {
    it('opens one labelled minutes field, saves on Enter and shows the value as a chip', async () => {
      mount(60)
      chip('Custom').click()
      const input = field()
      expect(input.closest('[hidden]')).toBeNull()
      expect(document.activeElement).toBe(input)
      expect(input.getAttribute('aria-label')).toBe('Custom daily limit for x.com, in minutes')
      expect(input.getAttribute('inputmode')).toBe('numeric')
      expect(document.getElementById('lp-hint')?.textContent).toBe('Enter to save')
      expect(checked().map((c) => c.textContent)).toEqual(['Custom'])

      input.value = '50'
      key(input, 'Enter')
      expect(commit).toHaveBeenCalledWith(50)
      expect(input.closest('[hidden]')).not.toBeNull()
      expect(checked().map((c) => c.textContent)).toEqual(['50m'])
      expect(document.activeElement).toBe(checked()[0])
      await flush()
      expect(saved.textContent).toBe('Saved')
    })

    it('saves on blur too, leaving focus where it went', () => {
      mount(null)
      chip('Custom').click()
      field().value = '007'
      field().dispatchEvent(new Event('blur'))
      expect(commit).toHaveBeenCalledWith(7)
      expect(checked()[0]?.textContent).toBe('7m')
    })

    it('treats a custom value equal to a preset as that preset', () => {
      mount(50)
      chip('50m').click()
      expect(field().value).toBe('50') // reopens prefilled
      field().value = '120'
      key(field(), 'Enter')
      expect(commit).toHaveBeenCalledWith(120)
      expect(checked().map((c) => c.textContent)).toEqual(['2h'])
      expect(chips().at(-1)?.textContent).toBe('Custom')
    })

    it.each(['abc', '0', '-5', '2.5', '1441', ''])('rejects %j on Enter without saving', (bad) => {
      mount(30)
      chip('Custom').click()
      field().value = bad
      key(field(), 'Enter')
      expect(commit).not.toHaveBeenCalled()
      expect(field().getAttribute('aria-invalid')).toBe('true')
      expect(error().hidden).toBe(false)
      expect(error().textContent).toBe('Enter whole minutes from 1 to 1440.')
      expect(field().getAttribute('aria-describedby')).toContain('lp-error')
    })

    it('keeps an invalid value open on blur, and clears the error once fixed', () => {
      mount(30)
      chip('Custom').click()
      field().value = 'x'
      field().dispatchEvent(new Event('blur'))
      expect(error().hidden).toBe(false)
      field().value = '45'
      field().dispatchEvent(new Event('input'))
      expect(error().hidden).toBe(true)
      expect(field().getAttribute('aria-invalid')).toBe('false')
    })

    it('Escape cancels and restores the previous selection', () => {
      mount(30)
      chip('Custom').click()
      field().value = 'nope'
      key(field(), 'Enter')
      key(field(), 'Escape')
      expect(commit).not.toHaveBeenCalled()
      expect(field().closest('[hidden]')).not.toBeNull()
      expect(error().hidden).toBe(true)
      expect(checked().map((c) => c.textContent)).toEqual(['30m'])
      expect(document.activeElement).toBe(chip('30m'))
    })

    it('a blank field on blur cancels', () => {
      mount(30)
      chip('Custom').click()
      field().dispatchEvent(new Event('blur'))
      expect(commit).not.toHaveBeenCalled()
      expect(checked().map((c) => c.textContent)).toEqual(['30m'])
    })

    it('picking a preset while editing closes the field', () => {
      mount(null)
      chip('Custom').click()
      chip('1h').click()
      expect(field().closest('[hidden]')).not.toBeNull()
      expect(commit).toHaveBeenCalledWith(60)
    })
  })

  describe('keyboard', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('arrow keys move and select, saving once the keys settle', () => {
      mount(null)
      chip('Off').focus()
      key(chip('Off'), 'ArrowRight')
      key(chip('15m'), 'ArrowRight')
      key(chip('30m'), 'ArrowDown')
      expect(document.activeElement).toBe(chip('1h'))
      expect(checked().map((c) => c.textContent)).toEqual(['1h'])
      expect(chips().map((c) => c.tabIndex)).toEqual([-1, -1, -1, 0, -1, -1])
      expect(commit).not.toHaveBeenCalled() // no 15m / 30m on the way
      vi.advanceTimersByTime(ARROW_SAVE_DELAY_MS)
      expect(commit).toHaveBeenCalledExactlyOnceWith(60)
    })

    // U4: Escape or a click outside closes the popup within the delay, and
    // the choice shown as checked was never saved.
    it('U4: saves a choice still settling when the page goes away', () => {
      mount(null)
      chip('Off').focus()
      key(chip('Off'), 'ArrowRight')
      window.dispatchEvent(new Event('pagehide'))
      expect(commit).toHaveBeenCalledExactlyOnceWith(15)
      vi.advanceTimersByTime(ARROW_SAVE_DELAY_MS)
      expect(commit).toHaveBeenCalledOnce()
    })

    it('U4: saves it when the page is hidden, and not when it is shown', () => {
      mount(null)
      chip('Off').focus()
      key(chip('Off'), 'ArrowRight')
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      expect(commit).not.toHaveBeenCalled()
      visibility.mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      expect(commit).toHaveBeenCalledExactlyOnceWith(15)
      visibility.mockRestore()
    })

    it('wraps around, and Home/End jump to the ends', () => {
      mount(null)
      chip('Off').focus()
      key(chip('Off'), 'ArrowLeft')
      expect(document.activeElement).toBe(chip('Custom'))
      key(chip('Custom'), 'ArrowUp')
      expect(document.activeElement).toBe(chip('2h'))
      key(chip('2h'), 'Home')
      expect(document.activeElement).toBe(chip('Off'))
      key(chip('Off'), 'End')
      expect(document.activeElement).toBe(chip('Custom'))
      key(chip('Custom'), 'ArrowRight')
      expect(document.activeElement).toBe(chip('Off'))
    })

    it('landing on Custom only focuses it; Enter or Space opens the field', () => {
      mount(30)
      chip('30m').focus()
      key(chip('30m'), 'End')
      vi.advanceTimersByTime(ARROW_SAVE_DELAY_MS)
      expect(commit).not.toHaveBeenCalled()
      expect(checked().map((c) => c.textContent)).toEqual(['30m'])
      expect(chip('Custom').tabIndex).toBe(0)
      chip('Custom').click() // what Enter/Space do on a button
      expect(document.activeElement).toBe(field())
    })

    it('ignores other keys and stored changes mid-arrow', () => {
      mount(null)
      chip('Off').focus()
      key(chip('Off'), 'a')
      expect(document.activeElement).toBe(chip('Off'))
      key(chip('Off'), 'ArrowRight')
      picker.set(120)
      expect(checked().map((c) => c.textContent)).toEqual(['15m'])
      vi.advanceTimersByTime(ARROW_SAVE_DELAY_MS)
      expect(commit).toHaveBeenCalledWith(15)
    })

    it('arrowing away from an open field closes it', () => {
      mount(null)
      chip('Custom').click()
      chip('Custom').focus() // Shift+Tab back to the chips
      key(chip('Custom'), 'ArrowLeft')
      expect(field().closest('[hidden]')).not.toBeNull()
    })

    it('Escape on a chip calls onEscape when given', () => {
      const onEscape = vi.fn()
      mount(null, { onEscape })
      key(chip('Off'), 'Escape')
      expect(onEscape).toHaveBeenCalledOnce()
    })

    it('arrow keys do nothing without a focused chip', () => {
      mount(null)
      key(group(), 'ArrowRight')
      expect(checked().map((c) => c.textContent)).toEqual(['Off'])
    })
  })

  it('follows a value stored elsewhere, but not while editing', () => {
    mount(null)
    picker.set(45)
    expect(checked().map((c) => c.textContent)).toEqual(['45m'])
    picker.set(15)
    expect(checked().map((c) => c.textContent)).toEqual(['15m'])
    chip('Custom').click()
    picker.set(120)
    expect(checked().map((c) => c.textContent)).toEqual(['Custom'])
  })

  it('focus() moves to the checked chip', () => {
    mount(120)
    picker.focus()
    expect(document.activeElement).toBe(chip('2h'))
  })
})
