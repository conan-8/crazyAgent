import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const MAX_FILENAME_CHARS = 1_024
// `browser_download` may save a relative path such as reports/q1/x.pdf, so the
// discovery list must look below the top level. Bounded depth and entry count
// keep one tool call cheap even for a huge Downloads folder.
const MAX_LIST_DEPTH = 3
const MAX_LIST_ENTRIES = 5_000

function downloadsError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.code = code
  return error
}

function inside(root, candidate) {
  const path = relative(root, candidate)
  return path.length > 0 && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function publicFilename(root, path) {
  return relative(root, path).split(sep).join('/')
}

async function resolvedRoot(root) {
  let path
  try {
    path = await realpath(root)
    const details = await stat(path)
    if (!details.isDirectory()) throw new Error('not a directory')
  } catch (error) {
    throw downloadsError('DOWNLOADS_FOLDER_UNAVAILABLE', `The Downloads folder is unavailable: ${root}`, error)
  }
  return path
}

async function resolvedFile(root, candidate, code) {
  let path
  try {
    path = await realpath(candidate)
  } catch (error) {
    throw downloadsError('DOWNLOADS_FILE_NOT_FOUND', `The requested file does not exist in Downloads: ${code}`, error)
  }
  if (path !== root && !inside(root, path)) {
    throw downloadsError('DOWNLOADS_OUTSIDE_FOLDER', 'The requested file resolves outside the Downloads folder; no file was uploaded.')
  }
  let details
  try {
    details = await stat(path)
  } catch (error) {
    throw downloadsError('DOWNLOADS_FILE_NOT_FOUND', `The requested file is no longer available in Downloads: ${code}`, error)
  }
  if (!details.isFile()) {
    throw downloadsError('DOWNLOADS_NOT_A_FILE', 'Only regular files inside Downloads can be used; directories and other file types are refused.')
  }
  return { path, size: details.size, filename: publicFilename(root, path), root, modifiedMs: details.mtimeMs }
}

function normalizedSearch(value) {
  let text = String(value ?? '')
  try { text = decodeURIComponent(text) } catch {}
  return text.replace(/\+/gu, ' ').replace(/\s+/gu, ' ').trim().toLowerCase()
}

/** Names in one folder that equal `wanted` once "+", URL escapes, case, and spacing are ignored. */
async function nearMissNames(folder, wanted) {
  let entries
  try {
    entries = await readdir(folder, { withFileTypes: true })
  } catch {
    return []
  }
  const target = normalizedSearch(wanted)
  if (target.length === 0) return []
  return entries
    .filter(entry => entry.isFile() && entry.name !== wanted && normalizedSearch(entry.name) === target)
    .map(entry => entry.name)
    .sort()
    .slice(0, 5)
}

export function createDownloadsFolder(configuredRoot) {
  const root = configuredRoot ?? resolve(homedir(), 'Downloads')
  if (typeof root !== 'string' || root.trim().length === 0 || !isAbsolute(root)) {
    throw downloadsError('DOWNLOADS_FOLDER_INVALID', 'downloadsDir must be a non-empty absolute path')
  }
  return {
    root,
    async resolveRoot() {
      return resolvedRoot(root)
    },
    async resolveUpload(filename) {
      if (typeof filename !== 'string' || filename.trim().length === 0 || filename.length > MAX_FILENAME_CHARS || filename.includes('\0')) {
        throw downloadsError('DOWNLOADS_FILENAME_INVALID', `filename must be a non-empty relative path of at most ${MAX_FILENAME_CHARS} characters`)
      }
      if (isAbsolute(filename)) {
        throw downloadsError('DOWNLOADS_FILENAME_INVALID', 'filename must be relative to Downloads, not an absolute path')
      }
      const base = await resolvedRoot(root)
      const candidate = resolve(base, filename)
      if (candidate !== base && !inside(base, candidate)) {
        throw downloadsError('DOWNLOADS_OUTSIDE_FOLDER', 'filename must stay inside the Downloads folder; no file was uploaded.')
      }
      try {
        return await resolvedFile(base, candidate, filename)
      } catch (error) {
        if (error?.code !== 'DOWNLOADS_FILE_NOT_FOUND') throw error
        // Search treats "+" and spaces alike, so a model can ask for a name that
        // differs from the real one only by that. Never substitute: name the
        // exact files so the next call can use one.
        const alternatives = await nearMissNames(dirname(candidate), basename(candidate))
        if (alternatives.length === 0) throw error
        const folder = publicFilename(base, dirname(candidate))
        const exact = alternatives.map(name => JSON.stringify(folder ? `${folder}/${name}` : name))
        const failure = downloadsError(
          'DOWNLOADS_FILE_NOT_FOUND',
          `${error.message}. No file was uploaded. ${alternatives.length === 1 ? `The exact name on disk is ${exact[0]}` : `Files with a similar name: ${exact.join(', ')}`}; retry with that exact filename ("+" and spaces are different characters).`,
          error,
        )
        failure.alternatives = alternatives
        throw failure
      }
    },
    async verifyDownload(path) {
      if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
        throw downloadsError('DOWNLOADS_PATH_INVALID', 'Chrome did not return a valid absolute download path')
      }
      const base = await resolvedRoot(root)
      const candidate = resolve(path)
      if (!inside(base, candidate)) {
        throw downloadsError('DOWNLOADS_OUTSIDE_FOLDER', `The browser saved the file outside the configured Downloads folder: ${path}`)
      }
      return resolvedFile(base, candidate, path)
    },
    async list(options = {}) {
      if (typeof options !== 'object' || options === null || Array.isArray(options)) {
        throw downloadsError('DOWNLOADS_QUERY_INVALID', 'Downloads list options must be an object')
      }
      const query = options.query === undefined ? '' : normalizedSearch(options.query)
      if (query.length > 200) throw downloadsError('DOWNLOADS_QUERY_INVALID', 'Downloads query must be at most 200 characters')
      const limit = options.limit ?? 10
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw downloadsError('DOWNLOADS_QUERY_INVALID', 'Downloads limit must be an integer from 1 to 50')
      }
      const base = await resolvedRoot(root)
      const files = []
      let scanned = 0
      let scanTruncated = false
      const walk = async (directory, depth) => {
        let entries
        try {
          entries = await readdir(directory, { withFileTypes: true })
        } catch {
          // A directory can disappear between readdir calls; skip it.
          return
        }
        entries.sort((left, right) => left.name.localeCompare(right.name))
        for (const entry of entries) {
          if (scanTruncated) return
          scanned += 1
          if (scanned > MAX_LIST_ENTRIES) {
            scanTruncated = true
            return
          }
          const candidate = resolve(directory, entry.name)
          // Dirent reflects lstat, so a symlinked directory is not isDirectory
          // and is never followed; symlinked files still go through the
          // real-path confinement check below.
          if (entry.isDirectory()) {
            if (depth < MAX_LIST_DEPTH) await walk(candidate, depth + 1)
            continue
          }
          try {
            const file = await resolvedFile(base, candidate, entry.name)
            if (query.length > 0 && !normalizedSearch(file.filename).includes(query)) continue
            files.push(file)
          } catch {
            // Broken links and non-regular entries are not upload candidates.
          }
        }
      }
      await walk(base, 0)
      files.sort((left, right) => right.modifiedMs - left.modifiedMs || left.filename.localeCompare(right.filename))
      return {
        files: files.slice(0, limit),
        totalMatches: files.length,
        truncated: files.length > limit,
        scanTruncated,
        scanned,
      }
    },
  }
}
