/**
 * Durable image-history budgeting.
 *
 * DSH freezes model requests, so request-level rewriting is impossible. The
 * supported seam is the durable `image/offload` projection: it marks selected
 * input-image occurrences as omitted, and every later request sends placeholder
 * text instead of bytes. The session log and attachments stay intact.
 */

const MAX_KEEP = 64

/**
 * @typedef {{seq: number, liveIndexes: number[]}} ImageEntry
 *   `liveIndexes` are absolute zero-based image positions in one message that
 *   are not yet offloaded, in ascending order.
 */

/**
 * Clamp a keep budget to the supported range.
 * @param {unknown} keep
 * @returns {number}
 */
function normalizeKeep(keep) {
  return Math.max(0, Math.min(MAX_KEEP, Math.floor(Number(keep) || 0)))
}

/**
 * Choose the oldest live images to omit, keeping the newest `keep`.
 * @param {ImageEntry[]} entries message-order entries (oldest first)
 * @param {number} keep newest live images to retain
 * @returns {{targets: Array<{seq: number, imageIndexes: number[]}>, offloaded: number, live: number}}
 */
export function planImageOffload(entries, keep) {
  const list = Array.isArray(entries) ? entries.filter(entry => entry && Number.isSafeInteger(entry.seq) && Array.isArray(entry.liveIndexes) && entry.liveIndexes.length > 0) : []
  const live = list.reduce((total, entry) => total + entry.liveIndexes.length, 0)
  const limit = normalizeKeep(keep)
  let need = Math.max(0, live - limit)
  if (need === 0) return { targets: [], offloaded: 0, live }
  const targets = []
  for (const entry of list) {
    if (need === 0) break
    const take = Math.min(need, entry.liveIndexes.length)
    targets.push({ seq: entry.seq, imageIndexes: entry.liveIndexes.slice(0, take) })
    need -= take
  }
  return { targets, offloaded: live - limit, live }
}

/**
 * Mid-turn pruning with hysteresis. Re-planning on every tool result would
 * invalidate the provider prompt cache on every screenshot; instead only act
 * once the live history has grown more than `threshold` images past `keep`,
 * then offload all the way back down to `keep`. That makes at most one
 * offload batch per `threshold + 1` new images.
 * @param {ImageEntry[]} entries message-order entries (oldest first)
 * @param {number} keep newest live images to retain
 * @param {number} [threshold] extra live images tolerated above `keep`; default 8
 * @returns {{triggered: boolean, targets: Array<{seq: number, imageIndexes: number[]}>, offloaded: number, live: number, after: number}}
 */
export function planMidTurnOffload(entries, keep, threshold = 8) {
  const gap = Number.isFinite(Number(threshold)) ? Math.max(0, Math.floor(Number(threshold))) : 8
  const plan = planImageOffload(entries, keep)
  if (plan.live <= normalizeKeep(keep) + gap) {
    return { triggered: false, targets: [], offloaded: 0, live: plan.live, after: plan.live }
  }
  return {
    triggered: true,
    targets: plan.targets,
    offloaded: plan.offloaded,
    live: plan.live,
    after: plan.live - plan.offloaded,
  }
}
