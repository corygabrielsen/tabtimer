import Model from './Model'

document.addEventListener('DOMContentLoaded', () => {
  const model = new Model()
  const reloadBtn = document.getElementById('reload-btn')
  const resetBtn = document.getElementById('reset-btn')

  resetBtn?.addEventListener('click', () => {
    model.reset()
  })

  reloadBtn?.addEventListener('click', () => {
    model.reset()
    chrome.runtime.reload()
  })
})
