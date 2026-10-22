/**
 * Reasoning-effort policy for browser turns.
 *
 * DSH fixes one effort per call. Reasoning is cheap on tool-selection steps but
 * expensive on long answer steps, so the policy classifies the *user prompt*
 * once per turn and holds that effort for every step of the turn (no mid-turn
 * request-header churn). The classification is local, deterministic, and free.
 * Reactive game bursts are classified as `rapid`, and short imperative work
 * prompts as `act`: both spend the turn doing browser work, not narrating it,
 * so reasoning is switched off for those turns. A run of failed tool results
 * can escalate an `off` turn back to `low` for the rest of the turn.
 */

const VIEW_BLOCK = /<current_view>[\s\S]*?<\/current_view>/giu

/** @param {unknown} text */
export function stripViewHeader(text) {
  return String(text ?? '').replace(VIEW_BLOCK, ' ').replace(/\s+/gu, ' ').trim()
}

const NAVIGATE_VERB = /^(?:(?:please|ok|okay|now|can you|could you)\s+)*(?:go|switch|jump|move|take me|open|focus|scroll|page|list|show)\b/iu
const REPORT_VERB = /\b(tell me|what|whats|what's|describe|read|find|check|look|see|summar|explain|which|where|report|give me|update me)\b/iu
const SYNTHESIZE = /\b(summar\w*|compare|contrast|analy[sz]\w*|evaluate|explain|why|how come|draft|write|compose|recommend|prioriti[sz]\w*|extract|list all|all about|every|each|detailed|in detail|step by step|outline|review|critique|assess|plan|research|organi[sz]e)\b/iu
const REACTIVE = /\b(play|playing|game|whack(?:-a-mole)?|click the dots?|rapid|hasty|as fast as|spam|reflex|combo|reaction)\b/iu
const ACT = /^(?:(?:please|ok|okay|now|hey|just|quickly|can you|could you|would you|will you)\s+)*(?:add|align|apply|attach|bold|center|centre|change|check|click|close|decrease|delete|drag|edit|fill|fix|format|highlight|increase|insert|italicize|make|modify|move|open|put|redo|remove|rename|reply|replace|resize|resolve|scroll|select|send|set|submit|toggle|type|underline|undo|update|upload)\b/iu
// Short corrections on the previous step ("smaller", "try again", "the other
// one") carry no verb but are still pure browser work. Only very short prompts
// qualify so a long request that happens to say "again" stays inspectable.
const FOLLOW_UP = /\b(smaller|bigger|larger|wider|narrower|taller|shorter|again|retry|not (?:that|this) (?:one|tab|button)|the other (?:one|tab|button)|other one|scroll(?:ed)? (?:up|down)|go back|go forward|undo(?: that)?|redo(?: that)?|wrong (?:one|tab|button)|next (?:one|tab|button)|previous (?:one|tab|button)|keep going|continue)\b/iu
const FOLLOW_UP_MAX_WORDS = 6

/** @typedef {'navigate'|'inspect'|'synthesize'|'rapid'|'act'} TurnClass */

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
  if (REACTIVE.test(clean)) return 'rapid'
  const reports = REPORT_VERB.test(clean)
  if (!reports && ACT.test(clean)) return 'act'
  if (!reports && questions === 0 && words < FOLLOW_UP_MAX_WORDS && FOLLOW_UP.test(clean)) return 'act'
  if (!reports && NAVIGATE_VERB.test(clean) && words <= 25 && questions === 0) return 'navigate'
  return 'inspect'
}

/**
 * Effort for one turn under the `auto` policy. Navigation-only turns, reactive
 * game bursts, and short imperative action prompts have no user-facing
 * synthesis, so reasoning is disabled; anything that must be read, described,
 * or synthesized keeps `low`.
 * @param {TurnClass} classification
 * @returns {'off'|'low'}
 */
export function autoEffort(classification) {
  return classification === 'navigate' || classification === 'rapid' || classification === 'act' ? 'off' : 'low'
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

/**
 * Turn reasoning back on for the rest of a turn that keeps failing. The turn
 * starts `off` for pure browser work; after several consecutive tool results
 * without visible progress, a little reasoning is cheaper than more blind
 * retries. Other efforts are returned unchanged.
 * @param {'off'|'low'|'medium'|'high'} effort
 * @returns {'off'|'low'|'medium'|'high'}
 */
export function escalateEffort(effort) {
  return effort === 'off' ? 'low' : effort
}

/**
 * Whether a run of consecutive no-progress tool results is long enough to
 * justify switching reasoning back on for the rest of the turn.
 * @param {number} noProgress consecutive no-progress tool results this turn
 * @param {number} [threshold] consecutive failures required; default 3
 * @returns {boolean}
 */
export function shouldEscalate(noProgress, threshold = 3) {
  const limit = Number.isFinite(Number(threshold)) ? Math.max(1, Math.floor(Number(threshold))) : 3
  const count = Number(noProgress)
  return Number.isFinite(count) && count >= limit
}
