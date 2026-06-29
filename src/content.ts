import Controller from './Controller'
import Model from './Model'
import View from './View'

console.log('[TabTimer] Content script loaded on', window.location.hostname)

try {
  const model = new Model()
  console.log('[TabTimer] Model created')
  const view = new View(model)
  console.log('[TabTimer] View created')
  const controller = new Controller(model, view)
  console.log('[TabTimer] Controller created')
  model.start()
  console.log('[TabTimer] Model started')

  // Best-effort: persist pending focus time and tear down listeners/intervals
  // when the page goes away.
  window.addEventListener('pagehide', () => {
    model.flush()
    controller.destroy()
  })
} catch (e) {
  console.error('[TabTimer] Error initializing:', e)
}
