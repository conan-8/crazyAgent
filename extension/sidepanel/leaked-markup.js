/**
 * Leaked tool-call markup guard for the side panel's live reply stream.
 *
 * A dead model step can write its tool call as literal DeepSeek DSML markup.
 * The runtime then streams that markup as ordinary text deltas, and the
 * companion suppresses only the committed reply — the live deltas still reach
 * the panel. Without this guard they render as a "reply" row that stays in the
 * collapsed step body and in saved history. The phone is safe because its
 * draft is dropped at the turn ending; the panel keeps its rows, so it needs
 * its own render-time guard.
 *
 * The predicate mirrors `isLeakedToolCallText` in companion/session-controller.mjs
 * (a parity test replays both over the same corpus). Tool rows are never
 * stripped: their argument values may legitimately contain DSML-looking text.
 */

/**
 * True when the text is a tool call written as DSML markup instead of a
 * structured call. Fullwidth-bar tags never occur in ordinary prose and count
 * anywhere; the ASCII form counts only at the very start of the reply.
 * @param {unknown} text
 * @returns {boolean}
 */
export function isLeakedToolCallText(text) {
  return typeof text === 'string'
    && (/<\/?｜\s*DSML\s*｜\s*(?:calls|invoke|function_calls|parameter)\b/.test(text) || /^\s*<\/?\|\s*DSML\s*\|/.test(text))
}

/**
 * Decide what to do with one streamed reply delta. Matching runs on the
 * accumulated reply, not the lone delta, so a tag split across deltas is
 * caught as soon as its pieces join. Once a stream leaked, every later delta
 * of that same stream is dropped until the stream boundary resets the guard.
 * @param {string} priorText accumulated text of the current reply row ('' when none)
 * @param {string} delta the incoming chunk
 * @param {boolean} suppressed the current reply stream already leaked
 * @returns {'append' | 'suppress' | 'drop'}
 */
export function textStreamDeltaAction(priorText, delta, suppressed) {
  if (suppressed) return 'drop'
  if (isLeakedToolCallText(`${priorText}${delta}`)) return 'suppress'
  return 'append'
}

/**
 * True when the root contains a reply row whose text is leaked markup.
 * @param {ParentNode} root
 * @returns {boolean}
 */
export function hasLeakedReplyRow(root) {
  for (const entry of root.querySelectorAll('.activity-entry.text')) {
    if (isLeakedToolCallText(entry.querySelector('.activity-text')?.textContent ?? '')) return true
  }
  return false
}

/**
 * Remove leaked-markup reply rows from a feed root (the live feed, an archive
 * clone, or restored history). Returns how many rows were removed. Only reply
 * rows (`.activity-entry.text`) are considered; tool rows, reasoning, prompts,
 * and answers are left untouched.
 * @param {ParentNode} root
 * @returns {number}
 */
export function removeLeakedReplyRows(root) {
  let removed = 0
  for (const entry of root.querySelectorAll('.activity-entry.text')) {
    if (isLeakedToolCallText(entry.querySelector('.activity-text')?.textContent ?? '')) {
      entry.remove()
      removed += 1
    }
  }
  return removed
}
