/**
 * Bounded model-facing label list selection and formatting.
 *
 * Full views cap the text label list at 60 entries to keep tool results and
 * initial prompts compact. On chrome-heavy web apps like Google Docs (~55
 * permanent top-bar/toolbar controls), naive DOM-order slicing pushes newly
 * opened dropdown menus, dialogs, and suggestion popups past index 60.
 *
 * When any overlay/popup label would be truncated past the cap, keep priority
 * overlay labels within the 60-label window, fill the remaining slots with
 * leading background labels, and preserve original DOM order so layout
 * intuition stays consistent. Every label ID in the view remains valid in the
 * executor registry.
 */

export const MAX_LISTED_LABELS = 60

const POPUP_LABEL_ROLES = new Set([
  'menu',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'listbox',
  'option',
  'dialog',
  'alertdialog',
])

/**
 * Select up to `maxCount` labels to print in text, prioritizing active
 * overlay/popup/menu/dialog/listbox controls whenever any would be cut off.
 * Pure helper shared by the provider (`formatView`) and companion
 * (`formatViewText`).
 *
 * @param {Array<Record<string, any>> | undefined} labels
 * @param {number} [maxCount]
 * @returns {{listed: Array<Record<string, any>>, omitted: number, prioritized: boolean, prioritizedCount: number}}
 */
export function selectListedLabels(labels, maxCount = MAX_LISTED_LABELS) {
  const list = Array.isArray(labels) ? labels : []
  const cap = Math.max(1, Math.floor(Number(maxCount) || MAX_LISTED_LABELS))
  if (list.length <= cap) {
    return { listed: list, omitted: 0, prioritized: false, prioritizedCount: 0 }
  }
  const hasExplicitPopup = list.some(label => label?.popup === true)
  const isPriority = label => {
    if (hasExplicitPopup) return label?.popup === true
    const role = String(label?.role ?? '').toLowerCase()
    return POPUP_LABEL_ROLES.has(role)
  }
  let hasOverflowPriority = false
  for (let i = cap; i < list.length; i += 1) {
    if (isPriority(list[i])) {
      hasOverflowPriority = true
      break
    }
  }
  if (!hasOverflowPriority) {
    return {
      listed: list.slice(0, cap),
      omitted: list.length - cap,
      prioritized: false,
      prioritizedCount: 0,
    }
  }
  const keepIndices = new Set()
  let prioritizedCount = 0
  for (let i = 0; i < list.length && keepIndices.size < cap; i += 1) {
    if (isPriority(list[i])) {
      keepIndices.add(i)
      prioritizedCount += 1
    }
  }
  for (let i = 0; i < list.length && keepIndices.size < cap; i += 1) {
    if (!keepIndices.has(i)) keepIndices.add(i)
  }
  const listed = []
  for (let i = 0; i < list.length; i += 1) {
    if (keepIndices.has(i)) listed.push(list[i])
  }
  return {
    listed,
    omitted: list.length - listed.length,
    prioritized: true,
    prioritizedCount,
  }
}

/**
 * Format the model-facing label list lines for a full view.
 * @param {Array<Record<string, any>> | undefined} labels
 * @param {number} [maxCount]
 * @returns {string[]}
 */
export function formatViewLabels(labels, maxCount = MAX_LISTED_LABELS) {
  const list = Array.isArray(labels) ? labels : []
  if (list.length === 0) return []
  const { listed, omitted, prioritized, prioritizedCount } = selectListedLabels(list, maxCount)
  const lines = [`labels (click by number): ${list.length}`]
  for (const label of listed) {
    const role = label?.role || label?.tag || 'element'
    const text = String(label?.text ?? '')
    lines.push(`[${label?.id}] ${role}${label?.disabled ? ' (disabled)' : ''}${label?.frame ? ' (iframe)' : ''} ${JSON.stringify(text)}`)
  }
  if (omitted > 0) {
    const note = prioritized
      ? ` (${prioritizedCount} popup/menu/dialog labels prioritized)`
      : ''
    lines.push(`... ${omitted} more labels not listed${note}; take a fresh view for the rest`)
  }
  return lines
}
