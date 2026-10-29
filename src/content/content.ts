import BlockScreen from './BlockScreen'
import FocusTracker from './FocusTracker'
import Overlay from './Overlay'

// content.js can run more than once in the same page: the popup's "Enable"
// injects it into an open tab that may still be running an instance from an
// earlier grant. Each run shares the extension's isolated world (and so this
// window), so the running instance is recorded here and a new run disposes
// it first; otherwise both would report (and draw) the same page.
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

  const tracker = new FocusTracker()
  const overlay = new Overlay(tracker)
  const blockScreen = new BlockScreen(tracker)
  // Drive the overlay and the block screen off the tracker's tick, so a tab
  // has a single per-second interval. A hidden/background tab doesn't need
  // to re-render or enforce limits; skip the per-second work. Both
  // re-evaluate when the tab becomes visible again (Overlay on
  // visibilitychange, BlockScreen on the next tick), and whenever the
  // service worker sends a new state (each subscribes itself).
  const render = () => {
    if (document.hidden) {
      return
    }
    overlay.render()
    blockScreen.tick()
  }
  const unsubscribeTick = tracker.onTick(render)
  tracker.start()

  // Report the page gone and tear down listeners, the tick and the UI.
  const instance: Instance = {
    dispose: () => {
      window.removeEventListener('pagehide', handlePageHide)
      window.removeEventListener('pageshow', handlePageShow)
      unsubscribeTick()
      overlay.destroy()
      blockScreen.destroy()
      tracker.destroy()
      if (slot[INSTANCE] === instance) {
        delete slot[INSTANCE]
      }
    },
  }
  slot[INSTANCE] = instance

  // A page entering the back/forward cache (persisted) is frozen, not
  // destroyed, and may be shown again: keep everything alive and report it
  // hidden. Otherwise the page is going away for good.
  const handlePageHide = (event: PageTransitionEvent) => {
    if (event.persisted) {
      void tracker.report()
    } else {
      instance.dispose()
    }
  }
  // Restored from the back/forward cache: report again, catching up on what
  // changed while frozen (totals, limits, snooze), and redraw.
  const handlePageShow = (event: PageTransitionEvent) => {
    if (event.persisted) {
      tracker.resync()
      render()
    }
  }
  window.addEventListener('pagehide', handlePageHide)
  window.addEventListener('pageshow', handlePageShow)
} catch {
  // Never spam a host page's console if init fails on a hostile/odd page.
}
