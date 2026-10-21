/**
 * Durable image-history budgeting.
 *
 * DSH freezes model requests, so request-level rewriting is impossible. The
 * supported seam is the durable `image/offload` projection: it marks selected
 * input-image occurrences as omitted, and every later request sends placeholder
 * text instead of bytes. The session log and attachments stay intact.
 */

/**
 * @typedef {{seq: number, liveIndexes: number[]}} ImageEntry
 *   `liveIndexes` are absolute zero-based image positions in one message that
 *   are not yet offloaded, in ascending order.
 */

/**
 * Choose the oldest live images to omit, keeping the newest `keep`.
 * @param {ImageEntry[]} entries message-order entries (oldest first)
 * @param {number} keep newest live images to retain
 * @returns {{targets: Array<{seq: number, imageIndexes: number[]}>, offloaded: number, live: number}}
 */
export function planImageOffload(entries, keep) {
  const list = Array.isArray(entries) ? entries.filter(entry => entry && Number.isSafeInteger(entry.seq) && Array.isArray(entry.liveIndexes) && entry.liveIndexes.length > 0) : []
  const live = list.reduce((total, entry) => total + entry.liveIndexes.length, 0)
  const limit = Math.max(0, Math.min(64, Math.floor(Number(keep) || 0)))
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
