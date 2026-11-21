/**
 * Label assignment inspection + signature-recovery policy (D1 extraction #5
 * from browser.js). Pure helpers: inspect whether a label id was ever assigned,
 * format the missing-label message, normalize/resolve a recorded tag/role/text
 * signature against a fresh label list, and classify recoverable stale codes.
 * No module mutable state and no Chrome injection closures live here — the
 * cumulative label registry (tabLabelsByTab) and the recovery orchestration
 * (recoverStaleLabel/decorateStaleLabelError) stay in browser.js. Byte-identical
 * move; browser.js re-imports and re-exports the public helpers.
 */

/** Click failure codes that mean the label list moved on; the retry hint applies. */
const STALE_LABEL_CODES = new Set(['DETACHED', 'NOT_VISIBLE', 'UNKNOWN_LABEL'])

/**
 * Stale codes that mean the id no longer names a live labelled element, so the
 * same logical element can only be found again by its recorded signature.
 * NOT_VISIBLE is deliberately excluded: that element still exists, it just has
 * no box right now, and a text lookalike would be a different element.
 */
const RECOVERABLE_LABEL_CODES = new Set(['DETACHED', 'UNKNOWN_LABEL'])

/**
 * Inspect an id the registry cannot resolve against the ids this page ever
 * handed out. Label ids are assigned sequentially per frame (frame 0 gets
 * `id`, a subframe gets `frameId * 100000 + id`), so the highest recorded local
 * id in a frame is exactly the range of ids that can ever have existed there:
 * an id above it was never assigned and can never resolve, no matter how many
 * fresh views are taken. Pure, so the "hallucinated vs stale" distinction is
 * testable without Chrome.
 * @param {number} label
 * @param {{labels?: Map<number, {frameId?: number, localId?: number}>} | undefined} registry
 * @returns {{frameId: number, localId: number, maxLocalId: number, frameLabels: number, everAssigned: boolean, hasAnyLabels: boolean}}
 */
export function inspectLabelAssignment(label, registry) {
  const id = Math.max(0, Math.floor(Number(label) || 0))
  const frameId = Math.floor(id / 100_000)
  const localId = id - frameId * 100_000
  let maxLocalId = 0
  let frameLabels = 0
  const labels = registry?.labels
  if (labels instanceof Map) {
    for (const entry of labels.values()) {
      if ((Number(entry?.frameId) || 0) !== frameId) continue
      frameLabels += 1
      const local = Number(entry?.localId) || 0
      if (local > maxLocalId) maxLocalId = local
    }
  }
  return {
    frameId,
    localId,
    maxLocalId,
    frameLabels,
    everAssigned: localId >= 1 && localId <= maxLocalId,
    hasAnyLabels: labels instanceof Map && labels.size > 0,
  }
}

/**
 * Error text for a label id the registry cannot resolve. The old wording ("is
 * not in the current view") was identical for two very different mistakes: a
 * real id that went stale (a fresh view helps) and an id that was never handed
 * out at all (in the 2026-10-23 run the model clicked label 999, which no view
 * ever contained; no amount of re-viewing can resolve it, and the honest answer
 * is the valid range plus the coordinate alternative). Pure.
 * @param {number} label
 * @param {ReturnType<typeof inspectLabelAssignment>} assignment
 * @param {{urlChanged?: boolean}} [options]
 * @returns {{kind: 'never-assigned'|'stale'|'no-labels'|'url-changed', message: string}}
 */
export function formatMissingLabelMessage(label, assignment, options = {}) {
  const frameId = Number(assignment?.frameId) || 0
  const maxLocalId = Number(assignment?.maxLocalId) || 0
  if (options?.urlChanged === true) {
    return {
      kind: 'url-changed',
      message: `Label ${label} belongs to a previous page URL and is no longer valid after navigation. Take a fresh screenshot (or use one of the current labels listed below).`,
    }
  }
  if (!assignment || assignment.hasAnyLabels !== true) {
    return {
      kind: 'no-labels',
      message: `Label ${label} was never assigned: no labels have been handed out on this page yet. Take a fresh view (browser_screenshot) so the page is labelled, or use browser_click_at with coordinates.`,
    }
  }
  if (assignment.everAssigned === true) {
    return {
      kind: 'stale',
      message: `Label ${label} is not in the current view. Take a fresh screenshot to get current labels.`,
    }
  }
  const where = frameId === 0 ? '' : ` in frame ${frameId}`
  // Subframe ids are global ids (`frameId * 100000 + localId`), so the range is
  // reported in the same numbering the model saw in the label list.
  const range = maxLocalId > 0
    ? frameId === 0
      ? `1..${maxLocalId}`
      : `${frameId * 100_000 + 1}..${frameId * 100_000 + maxLocalId} (frame ${frameId})`
    : 'none yet'
  return {
    kind: 'never-assigned',
    message: `Label ${label} was never assigned${where}; labels assigned on this page are ${range}. The target may be unlabelled — use browser_click_at with screenshot coordinates, or take a fresh view and use one of its labels.`,
  }
}

/**
 * Normalize one signature source (a recorded label signature or a fresh label)
 * into the comparable {tag, role, text, frame} shape. Inner whitespace is
 * collapsed because a fresh labelling pass reads the text off the live DOM
 * again, and an optional frame keeps recovery inside the frame the label came
 * from. Pure helper.
 * @param {{tag?: unknown, role?: unknown, text?: unknown, frame?: unknown, frameId?: unknown}} [source]
 * @returns {{tag: string, role: string, text: string, frame: number | undefined}}
 */
function normalizeLabelSignature(source) {
  const read = value => String(value ?? '').replace(/\s+/gu, ' ').trim()
  const frameValue = source?.frame ?? source?.frameId
  return {
    tag: read(source?.tag).toLowerCase(),
    role: read(source?.role).toLowerCase(),
    text: read(source?.text),
    frame: Number.isFinite(Number(frameValue)) ? Number(frameValue) : undefined,
  }
}

/**
 * Frame a label belongs to; labels from the top frame carry no frame marker.
 * @param {Record<string, any>} label
 */
function labelFrame(label) {
  return Number.isFinite(Number(label?.frame)) ? Number(label.frame) : 0
}

/**
 * Recover a stale label id by matching its recorded signature against a fresh
 * label list. Label ids are keyed on element identity, so a re-render (Gmail
 * replaces virtualized list rows instead of updating them) detaches the old
 * element and the replacement gets a new id. The only safe recovery is an
 * exact, unique match on tag, role, and text: zero matches or more than one
 * candidate means any pick would be a guess, and a wrong click is worse than a
 * stale-label error. A signature with no text carries no identifying value and
 * is refused too. Pure, so the refusal behavior is testable without Chrome.
 * @param {Array<Record<string, any>>} candidateLabels labels from a fresh pass
 * @param {{tag?: string, role?: string, text?: string, frame?: number, frameId?: number}} signature recorded tag/role/text
 * @returns {{matched: true, label: Record<string, any>, candidateCount: number}
 *   | {matched: false, reason: 'WEAK_SIGNATURE'|'NO_MATCH'|'AMBIGUOUS', candidateCount: number, matchCount: number}}
 */
export function resolveLabelSignature(candidateLabels, signature) {
  const wanted = normalizeLabelSignature(signature)
  const candidates = (Array.isArray(candidateLabels) ? candidateLabels : [])
    .filter(label => label && Number.isFinite(Number(label.id)))
  const candidateCount = candidates.length
  if (wanted.text.length === 0) {
    return { matched: false, reason: 'WEAK_SIGNATURE', candidateCount, matchCount: 0 }
  }
  const matches = candidates.filter(label => {
    if (wanted.frame !== undefined && labelFrame(label) !== wanted.frame) return false
    const candidate = normalizeLabelSignature(label)
    return candidate.tag === wanted.tag
      && candidate.role === wanted.role
      && candidate.text === wanted.text
  })
  if (matches.length === 1) return { matched: true, label: matches[0], candidateCount }
  return {
    matched: false,
    reason: matches.length === 0 ? 'NO_MATCH' : 'AMBIGUOUS',
    candidateCount,
    matchCount: matches.length,
  }
}

/**
 * True when a stale-label failure code means the labelled element itself is
 * gone, so the id may be recoverable by signature. NOT_VISIBLE is deliberately
 * not recoverable: that element still exists, it just has no box right now, so
 * a same-text control would be a different element. Pure, so the recovery
 * policy is testable without Chrome.
 * @param {unknown} code
 */
export function isRecoverableLabelCode(code) {
  return RECOVERABLE_LABEL_CODES.has(String(code ?? ''))
}

export { STALE_LABEL_CODES, normalizeLabelSignature }
