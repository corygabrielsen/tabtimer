import type Model from './Model'
import type View from './View'

export default class Controller {
  private intervalId: number

  constructor(
    private model: Model,
    private view: View
  ) {
    this.intervalId = setInterval(() => {
      // A hidden/background tab doesn't need to re-render; skip the
      // per-second storage read + DOM work. The View re-renders itself
      // on visibilitychange when the tab becomes visible again.
      if (document.hidden) {
        return
      }
      this.view.updateDisplayText()
    }, 1000)
  }

  reset() {
    this.model.reset()
    this.view.updateDisplayText()
  }

  destroy() {
    clearInterval(this.intervalId)
    this.view.destroy()
  }
}
