export const SCREENSHOT_SCOPES = ['viewport', 'full_page', 'region']
export const FULL_PAGE_MAX_DIMENSION = 16_384
export const FULL_PAGE_MAX_PIXELS = 32_000_000

function captureError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function parseScreenshotArgs(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw captureError('BAD_SCREENSHOT', 'screenshot arguments must be an object')
  }
  const allowed = new Set(['detail', 'delay_ms', 'scope', 'region', 'space', 'view_id', 'to_clipboard'])
  if (Object.keys(args).some(key => !allowed.has(key))) {
    throw captureError('BAD_SCREENSHOT', 'screenshot received an unknown argument')
  }
  const detail = args.detail === undefined ? 'normal' : args.detail
  if (!['normal', 'high', 'fast'].includes(detail)) {
    throw captureError('BAD_SCREENSHOT', 'detail must be normal, high, or fast')
  }
  const delayMs = args.delay_ms === undefined ? 0 : args.delay_ms
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 5_000) {
    throw captureError('BAD_SCREENSHOT', 'delay_ms must be an integer from 0 to 5000')
  }
  const scope = args.scope === undefined ? 'viewport' : args.scope
  if (!SCREENSHOT_SCOPES.includes(scope)) {
    throw captureError('BAD_SCREENSHOT', 'scope must be viewport, full_page, or region')
  }
  const space = args.space === undefined ? 'image' : args.space
  if (space !== 'image' && space !== 'css') {
    throw captureError('BAD_REGION', 'space must be image or css')
  }
  if (scope !== 'region' && (args.region !== undefined || args.space !== undefined || args.view_id !== undefined)) {
    throw captureError('BAD_REGION', 'region, space, and view_id are valid only with scope:"region"')
  }
  let region
  if (scope === 'region') {
    const value = args.region
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['x', 'y', 'width', 'height'].includes(key))) {
      throw captureError('BAD_REGION', 'region must contain only x, y, width, and height')
    }
    const numbers = ['x', 'y', 'width', 'height'].map(key => Number(value[key]))
    if (numbers.some(number => !Number.isFinite(number)) || numbers[2] <= 0 || numbers[3] <= 0) {
      throw captureError('BAD_REGION', 'region requires finite x/y and positive width/height')
    }
    region = { x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] }
  }
  let viewId
  if (args.view_id !== undefined) {
    if (!Number.isSafeInteger(args.view_id) || args.view_id <= 0) {
      throw captureError('BAD_VIEW', 'view_id must be a positive integer from a previous viewport screenshot')
    }
    viewId = args.view_id
  }
  if (args.to_clipboard !== undefined && typeof args.to_clipboard !== 'boolean') {
    throw captureError('BAD_SCREENSHOT', 'to_clipboard must be true or false')
  }
  return { detail, delayMs, scope, region, space, viewId, toClipboard: args.to_clipboard === true }
}

export function mapScreenshotRegion(region, space, viewport, imageScale = 1) {
  const scale = space === 'image' ? Number(imageScale) : 1
  if (!Number.isFinite(scale) || scale <= 0) throw captureError('NO_VIEW', 'A valid screenshot scale is required for image coordinates')
  const rawLeft = Number(region.x) * scale
  const rawTop = Number(region.y) * scale
  const rawRight = rawLeft + Number(region.width) * scale
  const rawBottom = rawTop + Number(region.height) * scale
  const left = Math.floor(rawLeft)
  const top = Math.floor(rawTop)
  const right = Math.ceil(rawRight)
  const bottom = Math.ceil(rawBottom)
  const viewportWidth = Math.max(0, Math.floor(Number(viewport?.width) || 0))
  const viewportHeight = Math.max(0, Math.floor(Number(viewport?.height) || 0))
  if (left < 0 || top < 0 || right > viewportWidth || bottom > viewportHeight || right <= left || bottom <= top) {
    throw captureError('OFF_SCREEN_REGION', `The region must be fully inside the current ${viewportWidth}x${viewportHeight} CSS-pixel viewport; scroll or take a fresh view and measure it again`)
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function checkedFullPageSize(width, height) {
  const cssWidth = Math.ceil(Number(width) || 0)
  const cssHeight = Math.ceil(Number(height) || 0)
  if (cssWidth <= 0 || cssHeight <= 0) throw captureError('CAPTURE_EMPTY', 'Chrome reported an empty page size')
  if (cssWidth > FULL_PAGE_MAX_DIMENSION || cssHeight > FULL_PAGE_MAX_DIMENSION
    || cssWidth * cssHeight > FULL_PAGE_MAX_PIXELS) {
    throw captureError(
      'CAPTURE_TOO_LARGE',
      `The full page is ${cssWidth}x${cssHeight} CSS px; captures are limited to ${FULL_PAGE_MAX_DIMENSION}px per side and ${FULL_PAGE_MAX_PIXELS} total pixels. Capture a smaller region instead.`,
    )
  }
  return { width: cssWidth, height: cssHeight }
}
