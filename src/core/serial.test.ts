import { describe, it, expect } from 'vitest'
import { serial } from './serial'

describe('serial', () => {
  it('runs each task after the one before it, a failure included', async () => {
    const queue = serial()
    const log: string[] = []
    let release!: () => void
    const first = queue(() => new Promise<void>((resolve) => (release = resolve)).then(() => log.push('first')))
    const failed = queue(() => Promise.reject(new Error('boom')))
    const last = queue(async () => log.push('last'))
    await Promise.resolve()
    expect(log).toEqual([])
    release()
    await first
    await expect(failed).rejects.toThrow('boom')
    await last
    expect(log).toEqual(['first', 'last'])
  })
})
