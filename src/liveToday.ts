// Today's times for an extension page, as the service worker
// sees them (todayTotals): asked again whenever today's storage changes and
// when a new day starts (at the hour set as the day's start, which is
// followed live), run on each second while a site is running, and storage's
// own (`stored`, the usage the page holds for the day given) while the
// worker doesn't answer. `onChange` runs whenever they may read differently.
import { bus } from './chrome/bus'
import { chromeStore } from './chrome/store'
import { logicalDay, type DayStamp } from './core/day'
import { latestTotals, type TodayTotals } from './core/messages'
import { dayKey, normalizePrefs, siteTotal, PREFS_KEY, type DayUsage } from './core/schema'

export type LiveToday = {
  // Settles once the worker first answers, or doesn't.
  ready: Promise<void>
  // Every site's time today, read with siteTodayAt.
  totals(): TodayTotals
  // The hour days start at, and the logical day containing now.
  dayStart(): number
  today(): DayStamp
}

export function liveToday(stored: (day: DayStamp) => DayUsage, onChange: () => void): LiveToday {
  const local = chromeStore('local')
  let answer: TodayTotals | null = null
  let dayStart = 0
  const today = () => logicalDay(Date.now(), dayStart)
  const ask = async () => {
    answer = latestTotals(answer, await bus.send('todayTotals', {}))
  }
  const again = () => void ask().then(onChange)

  let day = today()
  const readPrefs = local.get(PREFS_KEY).then(
    (p) => {
      dayStart = normalizePrefs(p).dayStart
      day = today()
    },
    () => undefined
  )
  local.onChanged((changes) => {
    if (PREFS_KEY in changes) {
      const next = normalizePrefs(changes[PREFS_KEY]!.newValue).dayStart
      if (next !== dayStart) {
        dayStart = next
        day = today()
        onChange()
        again()
        return
      }
    }
    if (dayKey(today()) in changes) {
      again()
    }
  })
  window.setInterval(() => {
    if (today() !== day) {
      day = today()
      onChange()
      again()
    } else if (answer?.running) {
      onChange()
    }
  }, 1000)

  return {
    ready: Promise.all([ask(), readPrefs]).then(() => undefined),
    totals: () => {
      if (answer) {
        return answer
      }
      const now = Date.now()
      const usage = stored(today())
      const sites = Object.fromEntries(Object.keys(usage).map((site) => [site, siteTotal(usage, site)]))
      return { day: today(), dayStart, asOf: now, seq: 0, running: null, sites }
    },
    dayStart: () => dayStart,
    today,
  }
}
