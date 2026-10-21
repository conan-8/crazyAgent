/**
 * Reasoning-effort policy for browser turns.
 *
 * DSH fixes one effort per call. Reasoning is cheap on tool-selection steps but
 * expensive on long answer steps, so the policy classifies the *user prompt*
 * once per turn and holds that effort for every step of the turn (no mid-turn
 * request-header churn). The classification is local, deterministic, and free.
 */

const VIEW_BLOCK = /<current_view>[\s\S]*?<\/current_view>/giu

/** @param {unknown} text */
export function stripViewHeader(text) {
  return String(text ?? '').replace(VIEW_BLOCK, ' ').replace(/\s+/gu, ' ').trim()
}

const NAVIGATE_VERB = /^(?:(?:please|ok|okay|now|can you|could you)\s+)*(?:go|switch|jump|move|take me|open|focus|scroll|page|list|show)\b/iu
const REPORT_VERB = /\b(tell me|what|whats|what's|describe|read|find|check|look|see|summar|explain|which|where|report|give me)\b/iu
const SYNTHESIZE = /\b(summar\w*|compare|contrast|analy[sz]\w*|evaluate|explain|why|how come|draft|write|compose|recommend|prioriti[sz]\w*|extract|list all|all about|every|each|detailed|in detail|step by step|outline|review|critique|assess|plan|research|organi[sz]e)\b/iu

/** @typedef {'navigate'|'inspect'|'synthesize'} TurnClass */

/**
 * @param {string} text user prompt without the view header
 * @returns {TurnClass}
 */
export function classifyPrompt(text) {
  const clean = stripViewHeader(text)
  if (clean.length === 0) return 'inspect'
  const words = clean.split(/\s+/u).filter(Boolean).length
  const questions = (clean.match(/\?/gu) ?? []).length
  if (SYNTHESIZE.test(clean) || questions >= 2 || words > 60 || clean.length > 220) return 'synthesize'
  if (NAVIGATE_VERB.test(clean) && !REPORT_VERB.test(clean) && words <= 25 && questions === 0) return 'navigate'
  return 'inspect'
}

/**
 * Effort for one turn under the `auto` policy. Navigation-only turns have no
 * user-facing synthesis, so reasoning is disabled; anything that must be read,
 * described, or synthesized keeps `low`.
 * @param {TurnClass} classification
 * @returns {'off'|'low'}
 */
export function autoEffort(classification) {
  return classification === 'navigate' ? 'off' : 'low'
}

/**
 * Resolve the effort to request for one turn.
 * @param {'auto'|'off'|'low'|'medium'|'high'} policy
 * @param {TurnClass} classification
 * @returns {'off'|'low'|'medium'|'high'}
 */
export function effortFor(policy, classification) {
  if (policy === 'auto') return autoEffort(classification)
  if (policy === 'off' || policy === 'low' || policy === 'medium' || policy === 'high') return policy
  return autoEffort(classification)
}
