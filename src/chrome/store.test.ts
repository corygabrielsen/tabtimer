import { describe, it, expect } from 'vitest'
import { chromeStore, loadThenPatch } from './store'
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
    await expect(store.keys()).resolves.toEqual(['a', 'b', 'c'])
    await store.remove(['a', 'b'])
    await expect(store.getAll()).resolves.toEqual({ c: 3 })
    await store.clear()
    await expect(store.getAll()).resolves.toEqual({})
  })

  it('lists keys by reading everything where getKeys is missing (before Chrome 130)', async () => {
    const area = fakeChrome().storage.local as { getKeys?: unknown; seed: (items: object) => void }
    delete area.getKeys
    area.seed({ a: 1, b: 2 })
    await expect(chromeStore('local').keys()).resolves.toEqual(['a', 'b'])
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

describe('loadThenPatch', () => {
  it('applies changes made during the load after it, in order, then each as it comes', async () => {
    const store = chromeStore('local')
    const log: string[] = []
    let finish!: () => void
    const load = () =>
      new Promise<void>((resolve) => {
        finish = () => {
          log.push('loaded')
          resolve()
        }
      })
    const done = loadThenPatch(store, load, (changes) => log.push(Object.keys(changes).join()))
    fakeChrome().storage.local.seed({ a: 1 })
    fakeChrome().storage.local.seed({ b: 1 })
    await flush()
    expect(log).toEqual([])
    finish()
    await done
    expect(log).toEqual(['loaded', 'a', 'b'])
    fakeChrome().storage.local.seed({ c: 1 })
    expect(log).toEqual(['loaded', 'a', 'b', 'c'])
  })

  it('applies them even when the load fails', async () => {
    const applied: unknown[] = []
    const done = loadThenPatch(
      chromeStore('local'),
      () => Promise.reject(new Error('broken')),
      (changes) => applied.push(changes)
    )
    fakeChrome().storage.local.seed({ a: 1 })
    await expect(done).rejects.toThrow('broken')
    expect(applied).toEqual([{ a: { newValue: 1 } }])
  })
})
