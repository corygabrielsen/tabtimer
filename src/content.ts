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
      window.removeEventListener('pagehide', instance.dispose)
      model.flush()
      controller.destroy()
      model.destroy()
      if (slot[INSTANCE] === instance) {
        delete slot[INSTANCE]
      }
    },
  }
  slot[INSTANCE] = instance

  // Best-effort: when the page goes away.
  window.addEventListener('pagehide', instance.dispose)
} catch {
  // Never spam a host page's console if init fails on a hostile/odd page.
}
