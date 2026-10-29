// The checkpoint alarm runs only while an interval is open, so the worker
// sleeps while nothing is being counted. Created only if missing: creating
// it again would push its next run back.
import { msToMinutes } from '../core/limits'
import { CHECKPOINT_MS } from '../core/tracker'

export const CHECKPOINT_ALARM = 'checkpoint'

type Alarms = {
  get: (name: string) => Promise<chrome.alarms.Alarm | undefined>
  create: (name: string, info: { periodInMinutes: number }) => Promise<void>
  clear: (name: string) => Promise<boolean>
}

export function checkpointAlarm(alarms: Alarms = chrome.alarms): (on: boolean) => Promise<void> {
  return async (on) => {
    const existing = await alarms.get(CHECKPOINT_ALARM)
    if (on && !existing) {
      await alarms.create(CHECKPOINT_ALARM, { periodInMinutes: msToMinutes(CHECKPOINT_MS) })
    } else if (!on && existing) {
      await alarms.clear(CHECKPOINT_ALARM)
    }
  }
}
