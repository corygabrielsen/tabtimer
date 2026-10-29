import Blocker from './Blocker'
import Controller from './Controller'
import Model from './Model'
import View from './View'

// content.js can run more than once in the same page: the popup's "Enable"
// injects it into an open tab that may still be running an instance from an
// earlier grant. Each run shares the extension's isolated world (and so this
// window), so the running instance is recorded here and a new run disposes
// it first; otherwise both would count the same focus time.
const INSTANCE = Symbol.for('tabtimer.content')
type Instance = { dispose: () => void }
const slot = window as unknown as Record<symbol, Instance | undefined>

try {
  try {
    slot[INSTANCE]?.dispose()
  } catch {
    // A previous instance from a reloaded extension can throw on teardown
    // (its context is gone); it can't count anything any more either.
  }

  const model = new Model()
  const view = new View(model)
  const blocker = new Blocker(model)
  const controller = new Controller(model, view, blocker)
  model.start()

  // Persist pending focus time and tear down listeners, the tick and the UI.
  const instance: Instance = {
    dispose: () => {
      window.removeEventListener('pagehide', handlePageHide)
      window.removeEventListener('pageshow', handlePageShow)
      model.flush()
      controller.destroy()
      model.destroy()
      if (slot[INSTANCE] === instance) {
        delete slot[INSTANCE]
      }
    },
  }
  slot[INSTANCE] = instance

  // A page entering the back/forward cache (persisted) is frozen, not
  // destroyed, and may be shown again: keep everything alive and only
  // persist pending time. Otherwise the page is going away for good.
  const handlePageHide = (event: PageTransitionEvent) => {
    if (event.persisted) {
      model.flush()
    } else {
      instance.dispose()
    }
  }
  // Restored from the back/forward cache: catch up on what changed while
  // frozen (totals, limits, snooze) and redraw.
  const handlePageShow = (event: PageTransitionEvent) => {
    if (event.persisted) {
      model.resync()
      void blocker.refresh()
      view.updateDisplayText()
    }
  }
  window.addEventListener('pagehide', handlePageHide)
  window.addEventListener('pageshow', handlePageShow)
} catch {
  // Never spam a host page's console if init fails on a hostile/odd page.
}
