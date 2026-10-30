// Today's times and snoozes for an extension page, as the service worker
// sees them (todayTotals): asked again whenever today's storage changes and at
// midnight, run on each second while a site is running, and storage's own
// (`stored`, today's usage as the page holds it) while the worker doesn't
// answer. `onChange` runs whenever they may read differently.
import { bus } from './chrome/bus'
import { chromeStore } from './chrome/store'
import { dayOf } from './core/day'
import { latestTotals, type TodayTotals } from './core/messages'
import { dayKey, siteTotal, snoozeKey, type DayUsage } from './core/schema'

export type LiveToday = {
  // Settles once the worker first answers, or doesn't.
  ready: Promise<void>
  // Every site's time today, read with siteTodayAt.
  totals(): TodayTotals
}

export function liveToday(stored: () => DayUsage, onChange: () => void): LiveToday {
  let answer: TodayTotals | null = null
  const ask = async () => {
    answer = latestTotals(answer, await bus.send('todayTotals', {}))
  }
  const again = () => void ask().then(onChange)

  let day = dayOf(Date.now())
  chromeStore('local').onChanged((changes) => {
    const today = dayOf(Date.now())
    if (dayKey(today) in changes || snoozeKey(today) in changes) {
      again()
    }
  })
  window.setInterval(() => {
    if (dayOf(Date.now()) !== day) {
      day = dayOf(Date.now())
      onChange()
      again()
    } else if (answer?.running) {
      onChange()
    }
  }, 1000)

  return {
    ready: ask(),
    totals: () => {
      if (answer) {
        return answer
      }
      const now = Date.now()
      const usage = stored()
      const sites = Object.fromEntries(Object.keys(usage).map((site) => [site, siteTotal(usage, site)]))
      return { day: dayOf(now), asOf: now, seq: 0, running: null, sites, snoozes: {} }
    },
  }
}
