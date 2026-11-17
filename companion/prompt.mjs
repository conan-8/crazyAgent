/**
 * Build the SDK prompt blocks for one user turn.
 *
 * The current view is captured before the model request so the model starts
 * with the page already in context. The image rides as a user content block;
 * DSH admits it to durable attachment storage before the prompt is accepted.
 */

import { DOCS_MODE_GUIDANCE } from '../packages/dsh-browser-extension/lib/guidance.js'
import { PLAN_LIMITS } from '../packages/dsh-browser-extension/lib/plan.js'

const MAX_PROMPT_IMAGES = 4
const MAX_PROMPT_IMAGE_BYTES = 5_000_000
const MAX_PROMPT_TOTAL_IMAGE_BYTES = 12_000_000
const PROMPT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * M2: the marathon guidance block (renamed from PLAN_MODE_GUIDANCE). Sent on
 * every turn armed by the companion-owned marathon switch (or the legacy
 * planMode alias). Per-turn text outside the 17,100-character core+Docs
 * ceiling, with its own test ceiling of 1,500 characters for this fixed part;
 * a carried plan appends at most PLAN_LIMITS.openSummaryItems item lines.
 */
export const MARATHON_MODE_GUIDANCE = `<marathon_mode>
Marathon mode is on: this chat plans and executes multi-step work with browser_plan, available on every turn while the switch stays on.
Before browser work, create a concise 2-7 item checklist with expected_revision:0 and exactly one in_progress item — unless a carried plan is listed below, then continue from its revision. Include an independent final-state verification item. Do not substitute narration or a prose to-do list for the tool, and do not stop after planning: execute the plan.
After real work, replace the COMPLETE list with the latest returned revision. Keep one item in_progress while pending work remains. Report completed only after the item's own evidence supports it; completion is still a model report, not independent verification. Preserve open items unless acknowledge_open_removal:true and a specific reason honestly record a scope change.
If genuinely blocked after real attempts, mark the affected item blocked with the reason. If user input is needed, call browser_plan with the unchanged complete list and user_input_needed:true, then ask the user. Finish only when every item is completed or blocked, or report remaining work honestly after the bounded harness nudges.
</marathon_mode>`

const PLAN_ITEM_STATUSES = new Set(['pending', 'in_progress', 'completed', 'blocked'])

/**
 * Validate a carried-plan seed for prompt rendering (the provider validates
 * strictly via seedPlanState; an invalid seed here simply renders no list).
 * @param {unknown} seed
 * @returns {{revision: number, items: Array<{content: string, status: string}>} | null}
 */
export function normalizePlanSeed(seed) {
  if (seed === null || typeof seed !== 'object' || Array.isArray(seed)) return null
  if (!Number.isSafeInteger(seed.revision) || seed.revision < 0) return null
  if (!Array.isArray(seed.items) || seed.items.length === 0 || seed.items.length > PLAN_LIMITS.maxItems) return null
  const items = []
  for (const item of seed.items) {
    if (item === null || typeof item !== 'object' || typeof item.content !== 'string' || item.content.trim().length === 0) return null
    if (typeof item.status !== 'string' || !PLAN_ITEM_STATUSES.has(item.status)) return null
    items.push({ content: item.content, status: item.status })
  }
  return { revision: seed.revision, items }
}

/**
 * The carried-plan text appended inside <marathon_mode> when a seed exists.
 * Only open items are listed, capped at PLAN_LIMITS.openSummaryItems lines.
 * @param {{revision: number, items: Array<{content: string, status: string}>}} seed
 */
export function formatCarriedPlan(seed) {
  const open = seed.items.filter(item => item.status === 'pending' || item.status === 'in_progress')
  const listed = open.slice(0, PLAN_LIMITS.openSummaryItems)
  const lines = [
    `Carried plan, revision ${seed.revision} (${open.length} open). If this message continues that work, keep going and use expected_revision:${seed.revision}.`,
    'If it is a different task, replace the plan with acknowledge_open_removal:true and a reason.',
    ...listed.map(item => `- [${item.status}] ${item.content}`),
  ]
  if (open.length > listed.length) lines.push(`…and ${open.length - listed.length} more open item(s) not listed.`)
  return lines.join('\n')
}

/** The full marathon block for one turn: fixed guidance plus any carried plan. */
export function marathonModeBlock(seed) {
  const normalized = normalizePlanSeed(seed)
  if (normalized === null) return MARATHON_MODE_GUIDANCE
  return MARATHON_MODE_GUIDANCE.replace('</marathon_mode>', `${formatCarriedPlan(normalized)}\n</marathon_mode>`)
}

/**
 * B9a: sent only on turns where the companion's opt-in `confirmIrreversible`
 * setting is on. It deliberately overrides the persona's "pick a default
 * instead of asking" rule for irreversible actions. Not part of the standing
 * guidance, so the 17,100-character ceiling is unaffected; it has its own size
 * test (at most 600 characters).
 */
export const CONFIRM_MODE_GUIDANCE = `<confirm_mode>
The user enabled "Ask before submitting, sending, paying, or deleting"; this overrides picking a default instead of asking. Before an action that submits for grading or review, sends a message, pays or places an order, deletes, or publishes: call agent_request_confirmation with action and target, then end your turn. Never perform it in the same turn. Drafts, navigation, and filling fields need none. An action still needs confirmation unless the latest turn carries <user_confirmation decision="approve"> for the same action; after deny, do not perform it.
</confirm_mode>`

/**
 * D2: the Docs guidance block is conditional. A turn whose turn-start view is
 * a Google Docs document gets it appended to the first prompt; other turns
 * stay on the smaller core guidance. A mid-turn switch to Docs is covered by
 * the provider's fail-safe (the first Docs tool result carries the rules).
 * Sheets/Slides are not Docs documents; their generic canvas rules stay in
 * the core block.
 * @param {unknown} url
 */
export function isDocsDocumentUrl(url) {
  if (typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'docs.google.com'
      && /^\/document\/(?:u\/\d+\/)?d\//u.test(parsed.pathname)
  } catch {
    return false
  }
}

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
  if (typeof view.text === 'string' && view.text.length > 0) {
    lines.push(`rendered_text ${JSON.stringify(view.text)}`)
    if (view.truncated === true) lines.push(`rendered_text truncated; next_offset ${Number(view.nextOffset) || view.text.length}; use browser_read_text to paginate`)
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
 * @param {{planMode?: boolean, confirmMode?: boolean, docsMode?: boolean, marathon?: {seed?: unknown}}} [options]
 * @returns {Array<Record<string, unknown>>}
 */
export function buildPromptBlocks(view, text, now = new Date(), images = [], options = {}) {
  const header = view?.image?.data === undefined
    ? `${formatViewText(view)}\n(No screenshot is attached for this turn. Use browser_screenshot if you need to see the page.)`
    : formatViewText(view)
  const planGuidance = options.planMode === true ? `\n\n${marathonModeBlock(options.marathon?.seed)}` : ''
  const confirmGuidance = options.confirmMode === true ? `\n\n${CONFIRM_MODE_GUIDANCE}` : ''
  const docsGuidance = options.docsMode === true ? `\n\n${DOCS_MODE_GUIDANCE}` : ''
  /** @type {Array<Record<string, unknown>>} */
  const blocks = [{ type: 'text', text: `${header}\n\n${formatTimeContext(now)}${planGuidance}${confirmGuidance}${docsGuidance}\n\n${text}` }]
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