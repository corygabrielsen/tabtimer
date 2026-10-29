import type Model from './Model'
import type View from './View'
import type Blocker from './Blocker'

// Drives the overlay and the block screen off the Model's tick, so a tab has
// a single per-second interval.
export default class Controller {
  private unsubscribe: () => void

  constructor(
    private model: Model,
    private view: View,
    private blocker: Blocker
  ) {
    this.unsubscribe = model.onTick(() => {
      // A hidden/background tab doesn't need to re-render or enforce limits;
      // skip the per-second work. Both re-evaluate when the tab becomes
      // visible again (View on visibilitychange, Blocker on the next tick).
      if (document.hidden) {
        return
      }
      this.view.updateDisplayText()
      void this.blocker.tick()
    })
  }

  reset() {
    this.model.reset()
    this.view.updateDisplayText()
  }

  destroy() {
    this.unsubscribe()
    this.view.destroy()
    this.blocker.destroy()
  }
}
