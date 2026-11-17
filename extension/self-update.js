/**
 * Reloads the unpacked extension after its files on disk moved to a newer
 * version (the companion's automatic update checks a newer release out into
 * the same checkout this extension is loaded from).
 *
 * An unpacked extension serves its files straight from disk, so the manifest
 * fetched here is the one on disk while `runningVersion` is the one that was
 * loaded. A newer version on disk must be seen on two checks at least
 * SETTLE_MS apart (a checkout in progress is never loaded half-written), the
 * extension must not be executing anything, and each version is reloaded at
 * most once, so a reload that does not pick the files up cannot loop.
 *
 * Everything chrome-specific is injected so the rules can be unit-tested.
 */

export const SELF_UPDATE_KEY = 'crazyagent.selfUpdate'
export const SETTLE_MS = 20_000

/** @param {unknown} text @returns {number[] | null} */
function parse(text) {
  const value = String(text ?? '')
  return /^\d{1,6}(\.\d{1,6}){0,3}$/u.test(value) ? value.split('.').map(Number) : null
}

/** @param {unknown} candidate @param {unknown} running */
export function isNewerVersion(candidate, running) {
  const a = parse(candidate)
  const b = parse(running)
  if (a === null || b === null) return false
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    if (left !== right) return left > right
  }
  return false
}

/**
 * @param {{
 *   runningVersion: string,
 *   readDiskVersion: () => Promise<unknown>,
 *   isBusy: () => boolean,
 *   loadState: () => Promise<any>,
 *   saveState: (state: Record<string, unknown>) => Promise<unknown>,
 *   reload: () => void,
 *   now?: () => number,
 * }} deps
 * @returns {Promise<'current' | 'seen' | 'settling' | 'busy' | 'already-tried' | 'reloading'>}
 */
export async function checkSelfUpdate(deps) {
  const now = (deps.now ?? (() => Date.now()))()
  let disk
  try {
    disk = await deps.readDiskVersion()
  } catch {
    return 'current'
  }
  if (!isNewerVersion(disk, deps.runningVersion)) return 'current'
  const stored = await deps.loadState()
  const state = stored !== null && typeof stored === 'object' ? stored : {}
  if (state.reloadedFor === disk) return 'already-tried'
  if (state.seen !== disk || typeof state.seenAt !== 'number') {
    await deps.saveState({ seen: disk, seenAt: now })
    return 'seen'
  }
  if (now - state.seenAt < SETTLE_MS) return 'settling'
  if (deps.isBusy()) return 'busy'
  await deps.saveState({ seen: disk, seenAt: state.seenAt, reloadedFor: disk, reloadedAt: now })
  deps.reload()
  return 'reloading'
}
