import { describe, it, expect } from 'vitest'
import { chromeStore } from './store'
import { fakeChrome, installChrome } from '../test/chrome'
import { flush } from '../test/dom'

describe('chromeStore', () => {
  it('reads one key, or undefined when absent', async () => {
    fakeChrome().storage.local.seed({ a: 1, b: { c: true } })
    const store = chromeStore('local')
    await expect(store.get('a')).resolves.toBe(1)
    await expect(store.get('b')).resolves.toEqual({ c: true })
    await expect(store.get('missing')).resolves.toBeUndefined()
  })

  it('reads everything, writes, removes and clears', async () => {
    const store = chromeStore('local')
    await store.set({ a: 1, b: 2, c: 3 })
    await expect(store.getAll()).resolves.toEqual({ a: 1, b: 2, c: 3 })
    await store.remove(['a', 'b'])
    await expect(store.getAll()).resolves.toEqual({ c: 3 })
    await store.clear()
    await expect(store.getAll()).resolves.toEqual({})
  })

  it('rejects when the storage call fails', async () => {
    const store = chromeStore('local')
    fakeChrome().storage.local.error = 'QUOTA_BYTES quota exceeded'
    await expect(store.set({ a: 1 })).rejects.toThrow('QUOTA_BYTES quota exceeded')
    await expect(store.get('a')).rejects.toThrow()
  })

  it('reports changes to its own area only, until unsubscribed', async () => {
    const store = chromeStore('local')
    const seen: unknown[] = []
    const unsubscribe = store.onChanged((changes) => seen.push(changes))
    fakeChrome().storage.sync.seed({ other: 1 })
    fakeChrome().storage.local.seed({ mine: 1 })
    expect(seen).toEqual([{ mine: { newValue: 1 } }])
    unsubscribe()
    fakeChrome().storage.local.seed({ mine: 2 })
    await flush()
    expect(seen).toHaveLength(1)
  })

  it('follows a replaced chrome global', async () => {
    const store = chromeStore('local')
    installChrome().storage.local.seed({ fresh: true })
    await expect(store.get('fresh')).resolves.toBe(true)
  })
})
