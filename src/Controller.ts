import type Model from './Model'
import type View from './View'

export default class Controller {
  constructor(
    private model: Model,
    private view: View
  ) {
    setInterval(() => this.view.updateDisplayText(), 1000)
  }

  reset() {
    this.model.reset()
    this.view.updateDisplayText()
  }
}
