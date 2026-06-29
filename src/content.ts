import Controller from './Controller'
import Model from './Model'
import View from './View'

console.log('[TabTimer] Content script loaded on', window.location.hostname)

try {
  const model = new Model()
  console.log('[TabTimer] Model created')
  const view = new View(model)
  console.log('[TabTimer] View created')
  new Controller(model, view)
  console.log('[TabTimer] Controller created')
  model.start()
  console.log('[TabTimer] Model started')
} catch (e) {
  console.error('[TabTimer] Error initializing:', e)
}
