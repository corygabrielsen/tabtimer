import { describe, it, expect } from 'vitest'
import { formatTime } from './format'

describe('formatTime', () => {
  it('formats zero as 00:00:00', () => {
    expect(formatTime(0)).toBe('00:00:00')
  })

  it('zero-pads hours, minutes and seconds', () => {
    expect(formatTime((1 * 3600 + 2 * 60 + 3) * 1000)).toBe('01:02:03')
  })

  it('truncates partial seconds rather than rounding up', () => {
    expect(formatTime(59_999)).toBe('00:00:59')
    expect(formatTime(60_000)).toBe('00:01:00')
  })

  it('rolls minutes and seconds over at 60', () => {
    expect(formatTime(3_599_000)).toBe('00:59:59')
    expect(formatTime(3_600_000)).toBe('01:00:00')
  })

  it('keeps counting hours past a day instead of wrapping', () => {
    expect(formatTime(100 * 3_600_000)).toBe('100:00:00')
  })

  it('clamps negative durations (backward clock jump) to zero', () => {
    expect(formatTime(-5000)).toBe('00:00:00')
  })
})
