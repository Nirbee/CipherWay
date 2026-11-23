// «DevVersion» look: one attribute on <html> switches the accent tokens
// (styles/index.css `[data-edition='dev']`, tailwind.config.ts reads them).

export const EDITION_ATTR = 'data-edition'
export const DEV_EDITION = 'dev'

interface AttrTarget {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

export function applyEdition(root: AttrTarget, dev: boolean): void {
  if (dev) root.setAttribute(EDITION_ATTR, DEV_EDITION)
  else root.removeAttribute(EDITION_ATTR)
}
