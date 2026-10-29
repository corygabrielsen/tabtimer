// Shared fixtures for content-script tests: a fake clock, the real background
// single-writer, and teardown for Models.
import { vi } from 'vitest'
import Model from '../content/FocusTracker'
import { todayKeyForHost } from '../storage'
import { fakeChrome } from './chrome'
import { resetPageState } from './dom'

// Wire the real background.ts into the fake browser so Model's reports land
// in storage exactly as in the extension.
export async function startBackground(): Promise<void> {
  vi.resetModules()
  await import('../sw/background')
}

export function useClock(now: Date): void {
  vi.useFakeTimers({ now })
  resetPageState()
}

const models: Model[] = []

export function trackModel(model: Model): Model {
  models.push(model)
  return model
}

// Stop a Model's tick and listeners so it can't keep reporting into a later
// test.
export function disposeModels(): void {
  for (const model of models.splice(0)) {
    model.destroy()
  }
}

export function storedToday(host = window.location.hostname, date = new Date()): number {
  return (fakeChrome().storage.local.data[todayKeyForHost(host, date)] as number | undefined) ?? 0
}

export const minutes = (n: number) => n * 60_000
export const seconds = (n: number) => n * 1000
