/**
 * Reasoning-effort policy for browser turns.
 *
 * DSH fixes one effort per call. Auto requests `low` from the first model step
 * for every turn, including navigation, action, and reactive game prompts, so
 * thinking is available before the first tool selection. Explicit
 * off/low/medium/high policies remain authoritative. The resolved effort is
 * held for every step of the turn (no mid-turn request-header churn).
 *
 * Prompt classification remains local, deterministic, and free. It describes
 * the turn in activity and logs without changing the Auto effort. Reactive
 * game bursts are classified as `rapid`, short imperative work prompts as
 * `act`, and navigation-only prompts as `navigate`.
 *
 * What the run logs said (65 `reasoning.policy` events under
 * .dsh-home/browser-agent/logs/*\/events.jsonl): the classifier emitted
 * inspect 46, synthesize 8, rapid 6, navigate 3, act 2, while reasoning was
 * ~35% of output tokens and one turn spent 34.8s streaming reasoning before
 * its first action. Most work turns were misread for one of two reasons, both
 * fixed here:
 *
 * - A single observational verb (check/look/see/find/read) cancelled `act`
 *   wherever it appeared, so "add a few paragraphs to the doc and check it"
 *   came out inspect. A leading imperative now dominates an observational verb
 *   used as a side remark; only verbs that ask for information back (tell me /
 *   what / which / describe / ...) keep a turn classified as `inspect`.
 * - `write|compose|draft` were tested as synthesis before anything else, so
 *   "write a title and subtite too" came out synthesize. Authoring verbs are
 *   now `act` for short page edits and `synthesize` only for long-form content
 *   ("... about ...", "write a paragraph", "draft an email to ...").
 *
 * Reading turns such as "go to my emails and check what there is to respond
 * to" still classify `inspect`, preserving their intent in the policy logs.
 */

const VIEW_BLOCK = /<current_view>[\s\S]*?<\/current_view>/giu

/** @param {unknown} text */
export function stripViewHeader(text) {
  return String(text ?? '').replace(VIEW_BLOCK, ' ').replace(/\s+/gu, ' ').trim()
}

// Prompt shapes that need reading or synthesis no matter which action verb
// appears: comparing, summarizing, deciding, enumerating everything.
const SYNTHESIZE = /\b(summar\w*|compare|contrast|analy[sz]\w*|evaluate|explain|why|how come|recommend|prioriti[sz]\w*|extract|list all|all about|detailed|in detail|step by step|outline|review|critique|assess|research|plan|organi[sz]e)\b/iu
// Authoring verbs. A short one ("write a title", "type the heading") is a page
// edit; the long-form markers below turn it into a content request.
const AUTHOR = /\b(write|rewrite|compose|draft|type|transcribe)\b/iu
const AUTHOR_LONG_FORM = /\b(about|explain\w*|describ\w*|essay|article|paragraph|sentences?|story|poem|letter|e-?mail|message|report|summary|in detail|detailed|step by step|steps?|argue|persuade|analy[sz]\w*|compare|review|critique|theme|topic|content|blog|post|proposal|cover letter|resume|script)\b/iu
// Reactive game bursts: a game noun, or rapid clicking of dot/target/mole style
// targets. Speed adjectives alone are not enough, so "be quick and hasty" on a
// typing task does not become `rapid`.
const GAME = /\b(play|playing|game|games|whack(?:-a-mole)?|aim trainer|chimp test|sequence memory|reaction time|reflex|combo)\b/iu
const GAME_TARGET = /\b(dots?|targets?|moles?)\b/iu
const GAME_ACTION = /\b(click|tap|hit|shoot|catch|whack)\b/iu
const NAVIGATE_VERB = /^(?:(?:please|ok|okay|now|can you|could you)\s+)*(?:go|switch|jump|move|take me|open|focus|scroll|page|list|show)\b/iu
// The prompt asks for information back, so it must stay inspectable even when
// it also contains action verbs ("scroll down and tell me which marker is
// visible").
const REPORT = /\b(tell me|what(?:'s|s| is| are| was| were| else)?|which|where|who|whom|whose|why|describe|explain\w*|summar\w*|report|give me|update me|show me|how (?:many|much|come|do|does|can|should|would|is|are|did))\b/iu
// Observational verbs may be part of the action ("add a few paragraphs and
// check it"), so they do not cancel a leading imperative. They do mean the
// turn touches page content, so navigation alone is not enough for a prompt
// that contains one ("go to my email and see the newest one"), and a prompt
// that *starts* with one is an inspection ("check each course calendar") even
// though "check the box" would be manipulation.
const OBSERVE = /\b(check|look|looks|looking|see|sees|saw|find|finds|read|reading|search|locate|verify|inspect|make sure|whether|browse|scan|skim|glance)\b/iu
const OBSERVE_LEAD = /^(?:(?:please|ok|okay|now|hey|just|quickly|can you|could you|would you|will you)\s+)*(?:check|look|see|find|read|search|verify|inspect|scan|browse)\b/iu
const ACT = /^(?:(?:please|ok|okay|now|hey|just|quickly|can you|could you|would you|will you)\s+)*(?:add|align|apply|attach|bold|center|centre|change|click|close|compose|decrease|delete|download|drag|draft|edit|export|fill|fix|format|highlight|increase|insert|italicize|make|modify|move|open|put|redo|remove|rename|reply|replace|resize|resolve|scroll|select|send|set|submit|toggle|transcribe|type|underline|undo|update|upload|write)\b/iu
// Short corrections on the previous step ("smaller", "try again", "the other
// one") carry no verb but are still pure browser work. Only short prompts
// qualify so a long request that happens to say "again" stays inspectable.
const FOLLOW_UP = /\b(smaller|bigger|larger|wider|narrower|taller|shorter|again|retry|not (?:that|this) (?:one|tab|button)|the other (?:one|tab|button)|other one|scroll(?:ed)? (?:up|down)|go back|go forward|undo(?: that)?|redo(?: that)?|wrong (?:one|tab|button)|next (?:one|tab|button)|previous (?:one|tab|button)|keep going|continue)\b/iu
const FOLLOW_UP_MAX_WORDS = 6
// "one last try", "you can do it, please try": retry nudges on a turn that is
// already doing browser work. Longer than a correction, but still not a request
// for prose; Auto nevertheless requests low reasoning from the first step.
const RETRY = /\b(try again|try it again|one more (?:try|time|go|round)|one last (?:try|time|attempt)|another (?:try|go|attempt)|last try|give it another|do it again|please try|just try|try harder|keep trying|do your best)\b/iu
const RETRY_MAX_WORDS = 12
// Page-work verbs that can appear anywhere in a short prompt, not just first:
// "its a bit cramped, format it nicely" opens with an opinion, "unify the
// formatting. some is small some is bold" opens with the noun, and both are
// pure formatting work. Observation verbs are deliberately absent so a short
// lookup ("find the super matt email") is not mistaken for an edit.
const WORK = /\b(format|reformat|unify|restyle|tidy|clean(?: ?up)?|spacing?|remove|delete|strip|prune|trim|add|insert|append|replace|rename|restructure|reorgani[sz]e|reorder|merge|split|convert|fix|correct|adjust|resize|indent|align|center|centre|bold|italicize|underline|bullet|heading|title|font|serif|sans|paste|apply|cramped|cluttered|messy|ugly|nicer|prettier)\b/iu
// "do it", "do it and do it fast": a continuation of the previous turn's work
// with no object of its own, so it is action work, not inspection.
const CONTINUATION = /\b(do it|just do it|do that|do this|go ahead|finish it|wrap it up|proceed|carry on|keep going|same for|all of them|the rest)\b/iu
// Prompts this short that name page work anywhere are action turns.
const SHORT_WORK_MAX_WORDS = 14

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
  const reports = REPORT.test(clean)
  const observes = OBSERVE.test(clean)
  // 1. Shapes that need reading or synthesis whatever verbs they contain.
  if (words > 60 || clean.length > 220 || questions >= 2) return 'synthesize'
  if (SYNTHESIZE.test(clean)) return 'synthesize'
  // 2. Authoring is manipulation for a short page edit, synthesis for
  //    long-form content ("write a paragraph about ...", "draft an email to").
  if (AUTHOR.test(clean) && (questions > 0 || words > 30 || AUTHOR_LONG_FORM.test(clean))) return 'synthesize'
  // 3. Reactive game bursts.
  if (!reports && (GAME.test(clean) || (GAME_TARGET.test(clean) && GAME_ACTION.test(clean)))) return 'rapid'
  // 4. A short prompt that names page work anywhere is an action turn, even
  //    when the verb is not first ("its a bit cramped, format it nicely",
  //    "unify the formatting", "do it and do it fast"). Measured on the
  //    2026-10-23 run: those turns ran at `low` and spent 286-467 output
  //    tokens per call, against 101-176 on browser-work turns under the former
  //    off policy.
  if (!reports && !OBSERVE_LEAD.test(clean) && questions === 0 && words <= SHORT_WORK_MAX_WORDS
    && (WORK.test(clean) || CONTINUATION.test(clean))) return 'act'
  // 5. A leading imperative dominates an observational verb ("add a few
  //    paragraphs and check it"), but not a prompt that asks for a report back,
  //    opens with an observation, or only uses the leading verb to reach the
  //    content ("open the dashboard and check the numbers").
  if (!reports && !OBSERVE_LEAD.test(clean) && ACT.test(clean) && !(observes && NAVIGATE_VERB.test(clean))) return 'act'
  // 6. Short retry and continuation nudges are browser work, not prose.
  if (!reports && questions === 0 && words <= RETRY_MAX_WORDS && RETRY.test(clean)) return 'act'
  if (!reports && questions === 0 && words <= FOLLOW_UP_MAX_WORDS && FOLLOW_UP.test(clean)) return 'act'
  // 7. Navigation, only when nothing asks the agent to read page content.
  if (!reports && !observes && NAVIGATE_VERB.test(clean) && words <= 25 && questions === 0) return 'navigate'
  return 'inspect'
}

/**
 * Effort for one turn under the `auto` policy. Every classification requests
 * `low` so thinking is available from the first model step, including before
 * navigation, action, and reactive tool selection.
 * @param {TurnClass} _classification
 * @returns {'low'}
 */
export function autoEffort(_classification) {
  return 'low'
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
 * Turn an `off` effort into `low` for failure-based escalation. After several
 * consecutive tool results without visible progress, a little reasoning is
 * cheaper than more blind retries. Other efforts are returned unchanged.
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
