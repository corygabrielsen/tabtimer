import type Model from './Model'
import type View from './View'
import type Blocker from './Blocker'

export default class Controller {
  private intervalId: number

  constructor(
    private model: Model,
    private view: View,
    private blocker: Blocker
  ) {
    this.intervalId = setInterval(() => {
      // A hidden/background tab doesn't need to re-render or enforce limits;
      // skip the per-second work. Both re-evaluate when the tab becomes
      // visible again (View on visibilitychange, Blocker on the next tick).
      if (document.hidden) {
        return
      }
      this.view.updateDisplayText()
      void this.blocker.tick()
    }, 1000)
  }

  reset() {
    this.model.reset()
    this.view.updateDisplayText()
  }

  destroy() {
    clearInterval(this.intervalId)
    this.view.destroy()
    this.blocker.destroy()
  }
}
