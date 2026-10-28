/**
 * Build the SDK prompt blocks for one user turn.
 *
 * The current view is captured before the model request so the model starts
 * with the page already in context. The image rides as a user content block;
 * DSH admits it to durable attachment storage before the prompt is accepted.
 */

const MAX_PROMPT_IMAGES = 4
const MAX_PROMPT_IMAGE_BYTES = 5_000_000
const MAX_PROMPT_TOTAL_IMAGE_BYTES = 12_000_000
const PROMPT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export function normalizeImageAttachments(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('images must be an array')
  if (value.length > MAX_PROMPT_IMAGES) throw new Error(`up to ${MAX_PROMPT_IMAGES} images are allowed`)
  let totalBytes = 0
  return value.map((image, index) => {
    if (!image || typeof image !== 'object' || Array.isArray(image)) throw new Error(`image ${index + 1} must be an object`)
    if (!PROMPT_IMAGE_TYPES.has(image.mimeType)) throw new Error(`image ${index + 1} must be PNG, JPEG, WebP, or GIF`)
    if (typeof image.data !== 'string' || image.data.length === 0 || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(image.data)) {
      throw new Error(`image ${index + 1} has invalid base64 data`)
    }
    const bytes = Buffer.from(image.data, 'base64')
    if (bytes.length === 0 || bytes.toString('base64') !== image.data) throw new Error(`image ${index + 1} has invalid base64 data`)
    if (bytes.length > MAX_PROMPT_IMAGE_BYTES) throw new Error(`image ${index + 1} exceeds the ${MAX_PROMPT_IMAGE_BYTES}-byte limit`)
    totalBytes += bytes.length
    if (totalBytes > MAX_PROMPT_TOTAL_IMAGE_BYTES) throw new Error(`images exceed the ${MAX_PROMPT_TOTAL_IMAGE_BYTES}-byte total limit`)
    return {
      name: typeof image.name === 'string' && image.name.length > 0 ? image.name.slice(0, 200) : `image-${index + 1}`,
      mimeType: image.mimeType,
      data: image.data,
    }
  })
}

/** @param {Record<string, any> | null | undefined} view */
export function formatViewText(view) {
  if (!view || !view.tab) return '<current_view unavailable="no snapshot was captured"/>'
  const tab = view.tab
  const viewport = view.viewport ?? {}
  const scroll = view.scroll ?? {}
  const image = view.image ?? {}
  const lines = [
    '<current_view>',
    `tab ${tab.id ?? '?'} ${JSON.stringify(tab.title ?? '')} ${tab.url ?? ''}`,
    `viewport ${viewport.width ?? '?'}x${viewport.height ?? '?'} css; image ${image.width ?? '?'}x${image.height ?? '?'} px`
      + (Number.isFinite(image.cssPerImagePixel) ? `; css/imagePx ${Number(image.cssPerImagePixel).toFixed(3)}` : ''),
    `scroll ${scroll.container ?? 'document'} y=${Math.round(Number(scroll.y) || 0)}/${Math.round(Number(scroll.maxY) || 0)}; at_top=${Boolean(scroll.atTop)} at_bottom=${Boolean(scroll.atBottom)}`,
  ]
  const surfaces = Array.isArray(view.surfaces) ? view.surfaces : []
  if (surfaces.length > 0) {
    const listed = surfaces.slice(0, 6).map(surface => `${surface?.kind ?? 'surface'} ${Math.round(Number(surface?.w) || 0)}x${Math.round(Number(surface?.h) || 0)} @${Math.round(Number(surface?.x) || 0)},${Math.round(Number(surface?.y) || 0)}`)
    lines.push(`surfaces (no DOM labels; use browser_click_at): ${listed.join(' · ')}`)
  }
  const labels = Array.isArray(view.labels) ? view.labels : []
  if (labels.length > 0) {
    const listed = labels.slice(0, 60)
    lines.push(`labels (click by number): ${labels.length}`)
    for (const label of listed) {
      const role = label?.role || label?.tag || 'element'
      lines.push(`[${label?.id}] ${role}${label?.disabled ? ' (disabled)' : ''}${label?.frame ? ' (iframe)' : ''} ${JSON.stringify(String(label?.text ?? ''))}`)
    }
    if (labels.length > listed.length) {
      lines.push(`... ${labels.length - listed.length} more labels not listed; take a fresh view for the rest`)
    }
  }
  lines.push('</current_view>')
  return lines.join('\n')
}

function formatTimeContext(now) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
  return [
    '<current_time>',
    `local ${now.toString()}`,
    `utc ${now.toISOString()}`,
    `timezone ${timezone}`,
    'Use this snapshot for “today”, “now”, and relative date/time requests; no web lookup is needed.',
    '</current_time>',
  ].join('\n')
}

/**
 * @param {Record<string, any> | null | undefined} view
 * @param {string} text
 * @param {Date} now
 * @param {Array<{mimeType: string, data: string}>} images
 * @returns {Array<Record<string, unknown>>}
 */
export function buildPromptBlocks(view, text, now = new Date(), images = []) {
  const header = view?.image?.data === undefined
    ? `${formatViewText(view)}\n(No screenshot is attached for this turn. Use browser_screenshot if you need to see the page.)`
    : formatViewText(view)
  /** @type {Array<Record<string, unknown>>} */
  const blocks = [{ type: 'text', text: `${header}\n\n${formatTimeContext(now)}\n\n${text}` }]
  for (const image of images) blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType })
  if (typeof view?.image?.data === 'string' && view.image.data.length > 0 && typeof view.image.mimeType === 'string') {
    blocks.push({ type: 'image', data: view.image.data, mimeType: view.image.mimeType })
  }
  return blocks
}

/** @param {Array<Record<string, unknown>>} blocks */
export function promptStats(blocks) {
  let textBytes = 0
  let imageBytes = 0
  let images = 0
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') textBytes += Buffer.byteLength(block.text)
    if (block.type === 'image' && typeof block.data === 'string') {
      images += 1
      imageBytes += Math.floor((block.data.length * 3) / 4)
    }
  }
  return { textBytes, imageBytes, images }
}