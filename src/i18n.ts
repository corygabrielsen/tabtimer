// Thin wrapper over chrome.i18n plus DOM helpers so static markup can be
// localized declaratively.

export function t(key: string, substitutions?: string | string[]): string {
  return chrome.i18n.getMessage(key, substitutions) || key
}

// Replace the text of [data-i18n="key"] elements and set attributes from
// [data-i18n-attr="attr=key;attr2=key2"].
export function localizeDom(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n
    if (key) {
      el.textContent = t(key)
    }
  })
  root.querySelectorAll<HTMLElement>('[data-i18n-attr]').forEach((el) => {
    const spec = el.dataset.i18nAttr
    if (!spec) {
      return
    }
    for (const pair of spec.split(';')) {
      const [attr, key] = pair.split('=')
      if (attr && key) {
        el.setAttribute(attr.trim(), t(key.trim()))
      }
    }
  })
}
