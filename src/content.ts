import Controller from './Controller'
import Model from './Model'
import View from './View'

try {
  const model = new Model()
  const view = new View(model)
  const controller = new Controller(model, view)
  model.start()

  // Best-effort: persist pending focus time and tear down listeners/intervals
  // when the page goes away.
  window.addEventListener('pagehide', () => {
    model.flush()
    controller.destroy()
  })
} catch {
  // Never spam a host page's console if init fails on a hostile/odd page.
}
