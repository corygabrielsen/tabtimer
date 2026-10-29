// Daily-limit picker shared by the popup and the options page: a radio group of
// preset chips (Off, a few durations, Custom). Custom opens one whole-minutes
// field; a saved custom value takes the Custom chip's place, so the selected
// chip always names the stored limit.
//
// Values are minutes (null = no limit); callers convert to the stored ms.
import { t } from './i18n'
import { h, flashSaved, formatDuration, validateMinutes, MAX_LIMIT_MINUTES } from './ui'

export const SITE_PRESETS = [15, 30, 60, 120]
export const GLOBAL_PRESETS = [60, 120, 180, 240]

// Arrow keys select as they move; wait for the key to settle before saving so
// stepping from Off to 2 h doesn't briefly store 15 min and block the tab.
export const ARROW_SAVE_DELAY_MS = 400

// Chip text: "15m", "1h", "1h 30m".
export function formatChipMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) {
    return t('limitChipMinutes', String(rest))
  }
  if (rest === 0) {
    return t('limitChipHours', String(hours))
  }
  return t('limitChipHoursMinutes', [String(hours), String(rest)])
}

export type LimitPickerOptions = {
  id: string // base for the element ids (`${id}-error`, …)
  presets: number[]
  label: string // the radio group's accessible name
  fieldLabel: string // the custom minutes field's accessible name
  value: number | null
  saved: HTMLElement | null // "Saved" live region
  commit: (minutes: number | null) => Promise<void>
  onChange?: (minutes: number | null) => void
  onEscape?: () => void // Escape on a chip (not in the field)
}

export type LimitPicker = {
  el: HTMLElement
  // Reflect a value stored elsewhere; ignored mid-edit or mid-arrow.
  set: (minutes: number | null) => void
  focus: () => void
}

type Choice = number | null | 'custom'

export function createLimitPicker(opts: LimitPickerOptions): LimitPicker {
  const choices: Choice[] = [null, ...opts.presets, 'custom']
  const customIdx = choices.length - 1
  let value = opts.value
  let editing = false
  let pending: { minutes: number | null; timer: number } | null = null
  // The chip shown as checked: the stored value's chip, or a pending/editing one.
  let checkedIdx = 0

  const indexFor = (minutes: number | null): number => {
    const i = choices.indexOf(minutes)
    return i === -1 ? customIdx : i
  }
  const isCustomValue = () => indexFor(value) === customIdx

  const chips = choices.map((choice, i) => {
    const chip = h('button', {
      type: 'button',
      role: 'radio',
      class: 'limit-chip',
      id: `${opts.id}-chip-${i}`,
      'data-choice': choice === null ? 'off' : String(choice),
      'aria-label': typeof choice === 'number' ? formatDuration(choice * 60000) : undefined,
    })
    chip.textContent = choice === null ? t('limitOff') : typeof choice === 'number' ? formatChipMinutes(choice) : ''
    chip.addEventListener('click', () => choose(i))
    return chip
  })
  const group = h(
    'div',
    { class: 'limit-chips', role: 'radiogroup', 'aria-label': opts.label, id: `${opts.id}-chips` },
    ...chips
  )
  group.addEventListener('keydown', onGroupKey)

  const errorId = `${opts.id}-error`
  const hintId = `${opts.id}-hint`
  const input = h('input', {
    class: 'field',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    id: `${opts.id}-custom`,
    'aria-label': opts.fieldLabel,
    'aria-describedby': `${hintId} ${errorId}`,
  })
  const error = h('p', { class: 'error', id: errorId, hidden: true })
  const field = h(
    'div',
    { class: 'limit-custom', hidden: true },
    h('span', { class: 'minutes' }, input, h('span', { class: 'unit' }, t('optionsMinutes'))),
    h('span', { class: 'limit-hint', id: hintId }, t('limitCustomHint'))
  )
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveCustom(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeField(true)
    }
  })
  input.addEventListener('input', () => {
    if (input.getAttribute('aria-invalid') === 'true') {
      showError(!customValid())
    }
  })
  input.addEventListener('blur', () => {
    if (!editing) {
      return
    }
    if (input.value.trim() === '') {
      closeField(false)
    } else {
      saveCustom(false)
    }
  })

  const el = h('div', { class: 'limit-picker', id: opts.id }, group, field, error)

  function paint() {
    const custom = chips[customIdx]!
    if (isCustomValue() && value !== null) {
      custom.textContent = formatChipMinutes(value)
      custom.setAttribute('aria-label', t('limitCustomAria', formatDuration(value * 60000)))
    } else {
      custom.textContent = t('limitCustom')
      custom.removeAttribute('aria-label')
    }
    chips.forEach((chip, i) => {
      chip.setAttribute('aria-checked', String(i === checkedIdx))
      chip.tabIndex = i === checkedIdx ? 0 : -1
    })
  }

  function save(minutes: number | null) {
    checkedIdx = indexFor(minutes)
    if (minutes !== value) {
      value = minutes
      void opts.commit(minutes).then(() => flashSaved(opts.saved))
      opts.onChange?.(minutes)
    }
    paint()
  }

  function cancelPending() {
    if (pending) {
      window.clearTimeout(pending.timer)
      pending = null
    }
  }

  function choose(i: number) {
    cancelPending()
    if (i === customIdx) {
      openField()
      return
    }
    if (editing) {
      closeField(false)
    }
    save(choices[i] as number | null)
  }

  function onGroupKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && opts.onEscape) {
      e.preventDefault()
      opts.onEscape()
      return
    }
    const from = chips.indexOf(document.activeElement as HTMLButtonElement)
    if (from === -1) {
      return
    }
    const last = chips.length - 1
    const to = {
      ArrowRight: from === last ? 0 : from + 1,
      ArrowDown: from === last ? 0 : from + 1,
      ArrowLeft: from === 0 ? last : from - 1,
      ArrowUp: from === 0 ? last : from - 1,
      Home: 0,
      End: last,
    }[e.key]
    if (to === undefined) {
      return
    }
    e.preventDefault()
    if (editing) {
      closeField(false)
    }
    cancelPending()
    const chip = chips[to]!
    if (to === customIdx) {
      // Custom needs a value; Enter or Space opens the field. Focus only.
      checkedIdx = indexFor(value)
      paint()
      chips.forEach((c) => (c.tabIndex = c === chip ? 0 : -1))
      chip.focus()
      return
    }
    checkedIdx = to
    paint()
    chip.focus()
    const minutes = choices[to] as number | null
    pending = {
      minutes,
      timer: window.setTimeout(() => {
        pending = null
        save(minutes)
      }, ARROW_SAVE_DELAY_MS),
    }
  }

  function customValid(): number | null {
    const result = validateMinutes(input.value)
    return result.ok && result.value !== '' ? Number(result.value) : null
  }

  function showError(on: boolean) {
    input.setAttribute('aria-invalid', String(on))
    error.hidden = !on
    error.textContent = on ? t('limitCustomInvalid', String(MAX_LIMIT_MINUTES)) : ''
  }

  function openField() {
    editing = true
    checkedIdx = customIdx
    paint()
    input.value = isCustomValue() && value !== null ? String(value) : ''
    showError(false)
    field.hidden = false
    input.focus()
    input.select()
  }

  // Close the field. With refocus, put focus back on the checked chip (Enter
  // and Escape); a blur leaves focus where the user sent it.
  function closeField(refocus: boolean) {
    editing = false
    field.hidden = true
    showError(false)
    checkedIdx = indexFor(value)
    paint()
    if (refocus) {
      chips[checkedIdx]?.focus()
    }
  }

  function saveCustom(refocus: boolean) {
    const minutes = customValid()
    if (minutes === null) {
      showError(true)
      return
    }
    editing = false
    field.hidden = true
    showError(false)
    save(minutes)
    if (refocus) {
      chips[checkedIdx]?.focus()
    }
  }

  checkedIdx = indexFor(value)
  paint()

  return {
    el,
    set(minutes) {
      if (editing || pending) {
        return
      }
      value = minutes
      checkedIdx = indexFor(minutes)
      paint()
    },
    focus() {
      chips[checkedIdx]?.focus()
    },
  }
}
