/**
 * Pure Google Docs helpers (D1 extraction #6, partial, from browser.js):
 * font-name normalization, the Docs-document URL predicate, same-document URL
 * comparison, Find-bar readiness, and literal substring positions. These are
 * self-contained and unit-test-covered. The Docs ORCHESTRATION (docsDriver +
 * the async docs* operation functions), the injected docsPageProbe, and the
 * BrowserError-dependent helpers (docsFailure/docsResolveOccurrence/
 * docsParagraphPlan) STAY in browser.js — the orchestration's IO defaults close
 * over browser.js helpers and BrowserError (circular), and docsPageProbe has no
 * headless gate coverage; moving them needs a shared-module refactor, not a pure
 * move. Byte-identical move; browser.js re-imports and re-exports.
 */

/** Strip only the accessible-name suffix used to advertise a submenu. */
export function docsFontName(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().replace(/\s+(?:▸|›|»|▶|►)$/u, '')
}

/** @param {unknown} value */
export function docsToolbarFont(value) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  const match = /^Font list\.\s+(.+?)\s+selected\.$/u.exec(text)
  if (match) return docsFontName(match[1])
  return text && !text.startsWith('Font list.') ? docsFontName(text) : undefined
}

function docsUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'docs.google.com' && /^\/document(?:\/|$)/u.test(url.pathname)
  } catch {
    return false
  }
}

export function docsSameDocumentUrl(before, after) {
  try {
    const left = new URL(before)
    const right = new URL(after)
    return left.origin === right.origin && left.pathname === right.pathname && left.search === right.search && docsUrl(right.href)
  } catch {
    return false
  }
}

function docsFindReady(state, text) {
  return state.open && state.enabled && state.focused === true && state.value === text && state.match !== undefined
}

function docsLiteralPositions(haystack, needle) {
  const source = String(haystack).toLowerCase()
  const wanted = String(needle).toLowerCase()
  if (!wanted) return []
  const positions = []
  for (let index = source.indexOf(wanted); index >= 0; index = source.indexOf(wanted, index + wanted.length)) {
    positions.push(index)
  }
  return positions
}

export { docsFindReady, docsLiteralPositions, docsUrl }
