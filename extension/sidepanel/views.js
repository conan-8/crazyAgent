/**
 * View coordinate-basis and layout-drift checks (D1 extraction #4 from browser.js).
 * Pure functions: they resolve which captured view an image-space action maps
 * through, detect stale/ambiguous coordinates, compare layout fingerprints, and
 * summarize the basis/scope. No module mutable state and no Chrome injection
 * closures live here — the view registry (lastViewByTab/imageBasesByTab) and the
 * view-building functions stay in browser.js. Byte-identical move; browser.js
 * re-imports and re-exports the public checks.
 */

/** Layout drift (CSS px) that makes a previous view's coordinates stale. */
const LAYOUT_SHIFT_THRESHOLD_PX = 8

/**
 * Compare layout signatures from two views. A row expanding moves every control
 * below it, so the previous view's pixel coordinates aim at different controls
 * even though nothing the model can read says so. Controls are matched by
 * (tag, text) so a re-rendered row that keeps its text still counts as the same
 * control; changed/added/removed text is structural change and is deliberately
 * not reported as drift (that would warn on every normal page change). Pure, so
 * the "warn, but do not cry wolf" rule is testable without Chrome.
 * @param {Array<{tag?: string, text?: string, x?: number, y?: number, w?: number, h?: number}>} [before]
 * @param {Array<{tag?: string, text?: string, x?: number, y?: number, w?: number, h?: number}>} [after]
 * @param {number} [threshold] px of movement that counts as a shift
 * @returns {{layoutChanged: boolean, movedCount: number, maxDx: number, maxDy: number, structural: boolean, moved: Array<{tag: string, text: string, dx: number, dy: number}>}}
 */
export function compareLayoutFingerprints(before, after, threshold = LAYOUT_SHIFT_THRESHOLD_PX) {
  const unchanged = { layoutChanged: false, movedCount: 0, maxDx: 0, maxDy: 0, structural: false, moved: [] }
  if (!Array.isArray(before) || !Array.isArray(after)) return unchanged
  const limit = Math.max(1, Number(threshold) || LAYOUT_SHIFT_THRESHOLD_PX)
  const keyOf = item => `${String(item?.tag ?? '')}\u0000${String(item?.text ?? '')}`
  const group = items => {
    /** @type {Map<string, Array<Record<string, any>>>} */
    const groups = new Map()
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const key = keyOf(item)
      const bucket = groups.get(key)
      if (bucket) bucket.push(item)
      else groups.set(key, [item])
    }
    for (const bucket of groups.values()) {
      bucket.sort((a, b) => (Number(a?.y) || 0) - (Number(b?.y) || 0) || (Number(a?.x) || 0) - (Number(b?.x) || 0))
    }
    return groups
  }
  const beforeGroups = group(before)
  const afterGroups = group(after)
  let movedCount = 0
  let maxDx = 0
  let maxDy = 0
  const moved = []
  for (const [key, fromItems] of beforeGroups) {
    const toItems = afterGroups.get(key)
    // A different count means controls were added or removed around this one;
    // their own positions cannot be attributed to a shift, so skip the group.
    if (!toItems || toItems.length !== fromItems.length) continue
    for (let index = 0; index < fromItems.length; index += 1) {
      const from = fromItems[index]
      const to = toItems[index]
      const dx = Math.round((Number(to?.x) || 0) - (Number(from?.x) || 0))
      const dy = Math.round((Number(to?.y) || 0) - (Number(from?.y) || 0))
      if (Math.abs(dx) < limit && Math.abs(dy) < limit) continue
      movedCount += 1
      if (Math.abs(dy) > Math.abs(maxDy)) maxDy = dy
      if (Math.abs(dx) > Math.abs(maxDx)) maxDx = dx
      if (moved.length < 5) {
        const separator = key.indexOf('\u0000')
        moved.push({ tag: key.slice(0, separator), text: key.slice(separator + 1), dx, dy })
      }
    }
  }
  const structural = before.length !== after.length
    || beforeGroups.size !== afterGroups.size
    || [...beforeGroups].some(([key, fromItems]) => (afterGroups.get(key)?.length ?? 0) !== fromItems.length)
  return { layoutChanged: movedCount > 0, movedCount, maxDx, maxDy, structural, moved }
}

/**
 * Canvas coordinates may use only the newest retained view.
 * @param {number|undefined} viewId
 * @param {Array<Record<string, any>>} history
 */
export function resolveCanvasImageBasis(viewId, history) {
  const basis = (Array.isArray(history) ? history : []).find(item => item && Number(item.imageWidth) > 0)
  if (!basis) {
    return { error: { code: 'NO_VIEW', message: 'Take a full fresh view before using coordinates in this canvas editor.' } }
  }
  if (viewId !== undefined && Number(viewId) !== Number(basis.viewId)) {
    return {
      error: {
        code: 'STALE_VIEW',
        message: `View #${viewId} is not the newest usable canvas view (#${basis.viewId}). Take a full fresh view and measure the point again.`,
      },
    }
  }
  return { basis }
}

/**
 * Validate the live page against a canvas coordinate basis before dispatch.
 * @param {Record<string, any>} basis
 * @param {Record<string, any>} metrics
 * @param {Record<string, any>} scroll
 */
export function canvasBasisError(basis, metrics, scroll) {
  const stale = reason => ({ code: 'STALE_VIEW', message: `${reason} Take a full fresh view and measure the coordinates again.` })
  if (!basis || !metrics) return { code: 'NO_VIEW', message: 'Take a full fresh view before using coordinates in this canvas editor.' }
  if (String(basis.url ?? '') !== String(metrics.url ?? '')) return stale('The page URL changed since the canvas view was captured.')
  const before = basis.viewport ?? {}
  const after = metrics.viewport ?? {}
  if (Math.abs((Number(before.width) || 0) - (Number(after.width) || 0)) > 1
    || Math.abs((Number(before.height) || 0) - (Number(after.height) || 0)) > 1) {
    return stale('The viewport changed since the canvas view was captured.')
  }
  if (Math.abs((Number(basis.scroll?.x) || 0) - (Number(scroll?.x) || 0)) > 2
    || Math.abs((Number(basis.scroll?.y) || 0) - (Number(scroll?.y) || 0)) > 2) {
    return stale('The page scrolled since the canvas view was captured.')
  }
  const layout = compareLayoutFingerprints(basis.fingerprint?.layout, metrics.fingerprint?.layout)
  if (layout.layoutChanged || layout.structural) return stale('The page controls or layout changed since the canvas view was captured.')
  return undefined
}

/**
 * Resolve which captured view an image-space action maps through. An explicit
 * view_id wins (the model says which screenshot it measured on) and must be one
 * of the recent bases; without one the newest capture is used and reported in
 * the result, so a mismatch is visible rather than silent. CSS coordinates do
 * not depend on an image scale and resolve to no basis. Pure, so the selection
 * and refusal rules are testable without Chrome.
 * @param {{space?: 'image'|'css', viewId?: number, points?: Array<{x: number, y: number}>}} request
 * @param {Array<{viewId: number, imageWidth: number, imageHeight: number, viewport: {width: number, height: number}}>} history newest first
 * @returns {{basis?: Record<string, any>, error?: {code: string, message: string}}}
 */
export function resolveImageBasis(request, history) {
  if (request?.space === 'css') return {}
  const bases = (Array.isArray(history) ? history : [])
    .filter(basis => basis && Number.isSafeInteger(Number(basis.viewId)) && Number(basis.imageWidth) > 0)
  if (bases.length === 0) {
    return { error: { code: 'NO_VIEW', message: 'Take a screenshot first so image coordinates can be mapped to the page.' } }
  }
  if (request?.viewId !== undefined && request?.viewId !== null) {
    const wanted = Number(request.viewId)
    const basis = bases.find(item => Number(item.viewId) === wanted)
    if (!basis) {
      return {
        error: {
          code: 'NO_VIEW',
          message: `View ${wanted} is not a recent view of this page, so its image scale is unknown. Take a fresh view and use coordinates measured on that screenshot.`,
        },
      }
    }
    return { basis }
  }
  return { basis: bases[0] }
}

/**
 * Detect coordinates measured on a different captured view. Off-screen under
 * the selected basis but valid under another is stale evidence; materially
 * different mappings that fit two bases are ambiguous. Callers reject both
 * before input. Same-scale bases are ignored because they map identically. Pure.
 * @param {Array<{x: number, y: number}>} points
 * @param {{viewId: number, imageWidth: number, imageHeight: number, viewport: {width: number, height: number}}} basis
 * @param {Array<Record<string, any>>} history newest first
 * @param {number} [margin] px inside a basis that still counts as reachable
 * @returns {{stale: Array<Record<string, any>>, ambiguous: Array<Record<string, any>>}}
 */
export function findCoordinateBasisMismatch(points, basis, history, margin = 2) {
  const result = { stale: [], ambiguous: [] }
  if (!basis || !Array.isArray(points)) return result
  const scaleOf = item => (Number(item?.viewport?.width) || 0) / (Number(item?.imageWidth) || 1)
  const mapPoint = (point, item) => {
    const scale = scaleOf(item)
    return { x: (Number(point?.x) || 0) * scale, y: (Number(point?.y) || 0) * scale }
  }
  const inside = (mapped, item) => mapped.x >= -margin && mapped.y >= -margin
    && mapped.x <= (Number(item?.viewport?.width) || 0) + margin
    && mapped.y <= (Number(item?.viewport?.height) || 0) + margin
  const baseScale = scaleOf(basis)
  const others = (Array.isArray(history) ? history : [])
    .filter(item => item && Number(item.viewId) !== Number(basis.viewId) && Number(item.imageWidth) > 0)
    .filter(item => Math.abs(scaleOf(item) - baseScale) >= baseScale * 0.01)
  for (const [index, point] of points.entries()) {
    if (!Number.isFinite(Number(point?.x)) || !Number.isFinite(Number(point?.y))) continue
    const mapped = mapPoint(point, basis)
    const onScreen = inside(mapped, basis)
    const alternatives = []
    for (const other of others) {
      const mappedOther = mapPoint(point, other)
      if (!inside(mappedOther, other)) continue
      alternatives.push({
        viewId: Number(other.viewId),
        imageWidth: Number(other.imageWidth),
        imageHeight: Number(other.imageHeight),
        cssX: Math.round(mappedOther.x),
        cssY: Math.round(mappedOther.y),
        dx: Math.round(mappedOther.x - mapped.x),
        dy: Math.round(mappedOther.y - mapped.y),
      })
    }
    if (alternatives.length === 0) continue
    if (!onScreen) {
      result.stale.push({
        index,
        x: point.x,
        y: point.y,
        cssX: Math.round(mapped.x),
        cssY: Math.round(mapped.y),
        from: alternatives[0],
      })
      continue
    }
    // Both bases put the point on screen: only report the ones that differ
    // enough that the click would land on a visibly different target.
    const differing = alternatives.filter(item => Math.abs(item.dx) >= 8 || Math.abs(item.dy) >= 8)
    if (differing.length === 0) continue
    result.ambiguous.push({
      index,
      x: point.x,
      y: point.y,
      cssX: Math.round(mapped.x),
      cssY: Math.round(mapped.y),
      alternatives: differing.slice(0, 3),
    })
  }
  return result
}

/**
 * The result-facing coordinate basis: which view the pixels were mapped through
 * and its scale, so the model can tell when a coordinate is not from the view it
 * thinks it is.
 * @param {Record<string, any>} basis
 */
function basisSummary(basis) {
  const width = Number(basis?.imageWidth) || 0
  const viewportWidth = Number(basis?.viewport?.width) || 0
  return {
    viewId: Number(basis?.viewId),
    imageWidth: width,
    imageHeight: Number(basis?.imageHeight) || 0,
    cssPerImagePx: width > 0 ? Number((viewportWidth / width).toFixed(3)) : 0,
  }
}

function actionPixelScope(view) {
  const width = Math.round(Number(view?.viewport?.width) || 0)
  const height = Math.round(Number(view?.viewport?.height) || 0)
  const tabId = view?.tab?.id
  const url = view?.tab?.url
  const timeOrigin = view?.timeOrigin
  if (!Number.isSafeInteger(tabId) || typeof url !== 'string' || url.length === 0
    || !Number.isFinite(timeOrigin) || timeOrigin <= 0) {
    return { kind: 'viewport-region', target: 'unknown', detail: 'document-identity-unavailable' }
  }
  return { kind: 'viewport-region', id: tabId, target: 'not-applicable', detail: `${timeOrigin}|${url}|${width}x${height}` }
}

export { actionPixelScope, basisSummary }
