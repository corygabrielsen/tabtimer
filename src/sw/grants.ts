// The granted origins tracking runs on (core/site.ts trackedOrigins), as the
// worker checks every page against them: read once, and again after any
// grant or revoke. Call synchronously at the worker's top level (it
// listens for changes), before the listeners that act on a change.
import { trackedOrigins } from '../core/site'

export type Granted = () => Promise<string[]>

type Permissions = Pick<typeof chrome.permissions, 'getAll' | 'onAdded' | 'onRemoved'>

export function watchGrants(permissions: Permissions = chrome.permissions): Granted {
  let cached: Promise<string[]> | null = null
  const changed = () => {
    cached = null
  }
  permissions.onAdded.addListener(changed)
  permissions.onRemoved.addListener(changed)
  return () => {
    if (cached === null) {
      const read = permissions.getAll().then((perms) => trackedOrigins(perms.origins ?? []))
      // A failed read isn't kept: the next check reads again.
      read.catch(() => {
        if (cached === read) {
          cached = null
        }
      })
      cached = read
    }
    return cached
  }
}
