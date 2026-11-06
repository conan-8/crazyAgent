const MAX_FILENAME_CHARS = 1_024
const MAX_TARGET_NAME_CHARS = 200

function fileFailure(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function absolutePath(value) {
  return typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\'))
}

function normalizedPath(value, windows) {
  let path = String(value ?? '')
  if (windows) path = path.replace(/\\/gu, '/')
  path = path.replace(/\/+/gu, '/')
  if (path.length > 1 && !/^[A-Za-z]:\/$/u.test(path)) path = path.replace(/\/+$/u, '')
  return windows ? path.toLowerCase() : path
}

export function pathInsideRoot(root, candidate) {
  if (!absolutePath(root) || !absolutePath(candidate)) return false
  const windows = /^[A-Za-z]:[\\/]/u.test(root) || root.startsWith('\\\\')
  const base = normalizedPath(root, windows)
  const path = normalizedPath(candidate, windows)
  if (base.split('/').includes('..') || path.split('/').includes('..')) return false
  if (base === '/') return path.length > 1
  return path.startsWith(`${base}/`) && path.length > base.length + 1
}

function validRelativeFilename(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_FILENAME_CHARS || value.includes('\0') || absolutePath(value)) return false
  const parts = value.replace(/\\/gu, '/').split('/')
  return !parts.some(part => part === '..')
}

function basename(path) {
  const windows = /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('\\\\')
  return normalizedPath(path, windows).split('/').at(-1) ?? ''
}

function targetName(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
}

function parseView(value) {
  const view = value ?? 'auto'
  if (!['auto', 'full', 'compact', 'none'].includes(view)) throw fileFailure('BAD_UPLOAD', 'view must be auto, full, compact, or none')
  return view
}

export function parseDownloadArgs(args = {}) {
  if (!record(args) || Object.keys(args).some(key => !['url', 'label', 'filename', 'root', 'timeout_ms'].includes(key))) {
    throw fileFailure('BAD_DOWNLOAD', 'download accepts only url, label, filename, root, and timeout_ms')
  }
  const hasUrl = args.url !== undefined
  const hasLabel = args.label !== undefined
  if (hasUrl === hasLabel) throw fileFailure('BAD_DOWNLOAD', 'Provide exactly one of url or label')
  if (!absolutePath(args.root)) throw fileFailure('BAD_DOWNLOAD', 'download requires an absolute Downloads root')
  let url
  if (hasUrl) {
    try {
      const parsed = new URL(args.url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol')
      url = parsed.href
    } catch {
      throw fileFailure('BAD_DOWNLOAD_URL', 'download url must be an absolute http(s) URL')
    }
  }
  if (hasLabel && (!Number.isSafeInteger(args.label) || args.label <= 0)) {
    throw fileFailure('BAD_DOWNLOAD', 'label must be a positive integer from the current view')
  }
  if (args.filename !== undefined && !validRelativeFilename(args.filename)) {
    throw fileFailure('BAD_DOWNLOAD_FILENAME', `filename must be a relative path inside Downloads with at most ${MAX_FILENAME_CHARS} characters and no parent traversal`)
  }
  const timeoutMs = args.timeout_ms ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw fileFailure('BAD_DOWNLOAD', 'timeout_ms must be an integer from 1000 to 120000')
  }
  return { url, label: args.label, filename: args.filename, root: args.root, timeoutMs }
}

export function parseUploadArgs(args = {}) {
  const allowed = ['filename', 'path', 'root', 'size', 'label', 'name', 'input', 'view']
  if (!record(args) || Object.keys(args).some(key => !allowed.includes(key))) {
    throw fileFailure('BAD_UPLOAD', `upload accepts only ${allowed.join(', ')}`)
  }
  if (!validRelativeFilename(args.filename)) throw fileFailure('BAD_UPLOAD', 'filename must be a relative path inside Downloads without parent traversal')
  if (!absolutePath(args.path) || !absolutePath(args.root) || !pathInsideRoot(args.root, args.path)) {
    throw fileFailure('UPLOAD_OUTSIDE_FOLDER', 'The upload path must stay inside the configured Downloads folder; no file was assigned.')
  }
  if (basename(args.path) !== basename(args.filename)) throw fileFailure('BAD_UPLOAD', 'filename does not match the resolved upload path')
  if (!Number.isSafeInteger(args.size) || args.size < 0) throw fileFailure('BAD_UPLOAD', 'size must be a non-negative safe integer')
  if (args.label !== undefined && (!Number.isSafeInteger(args.label) || args.label <= 0)) {
    throw fileFailure('BAD_UPLOAD', 'label must be a positive integer from the current view')
  }
  if (args.input !== undefined && (!Number.isSafeInteger(args.input) || args.input <= 0)) {
    throw fileFailure('BAD_UPLOAD', 'input must be a positive one-based file-input index')
  }
  const name = args.name === undefined ? undefined : targetName(args.name)
  if (name !== undefined && (name.length === 0 || name.length > MAX_TARGET_NAME_CHARS)) {
    throw fileFailure('BAD_UPLOAD', `name must contain 1 to ${MAX_TARGET_NAME_CHARS} characters`)
  }
  const selectors = Number(args.label !== undefined) + Number(args.input !== undefined) + Number(name !== undefined)
  if (selectors > 1) throw fileFailure('BAD_UPLOAD', 'Use only one file-input selector: label, name, or input')
  return {
    filename: args.filename,
    path: args.path,
    root: args.root,
    size: args.size,
    label: args.label,
    name,
    input: args.input,
    view: parseView(args.view),
  }
}

export function fileInputProbe(request) {
  const normalize = value => String(value ?? '').replace(/\s+/gu, ' ').trim()
  // A file input injected from this frame can only be assigned through the
  // tab-level CDP DOM tree when the whole ancestor chain is same-origin: a
  // cross-origin (site-isolated) iframe is a separate CDP target whose document
  // the tab session cannot see. Check every ancestor because a same-origin
  // frame nested inside a cross-origin one is still unreachable.
  const frameIsCrossOrigin = () => {
    let current = window
    for (let depth = 0; depth < 64; depth += 1) {
      let parent
      try {
        parent = current.parent
      } catch {
        return true
      }
      if (!parent || parent === current) return false
      try {
        void parent.document?.documentElement
        void parent.location.href
      } catch {
        return true
      }
      current = parent
    }
    return true
  }
  const crossOrigin = frameIsCrossOrigin()
  const allInputs = () => {
    const inputs = []
    const collect = root => {
      for (const element of root.querySelectorAll('input[type="file"]')) inputs.push(element)
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) collect(element.shadowRoot)
      }
    }
    collect(document)
    return inputs
  }
  const nameFor = element => {
    const labelledBy = normalize(element.getAttribute('aria-labelledby'))
    if (labelledBy) {
      const root = element.getRootNode()
      const byId = id => typeof root.getElementById === 'function'
        ? root.getElementById(id)
        : [...root.querySelectorAll('[id]')].find(candidate => candidate.id === id)
      const value = normalize(labelledBy.split(' ').map(id => byId(id)?.textContent ?? '').join(' '))
      if (value) return value
    }
    const aria = normalize(element.getAttribute('aria-label'))
    if (aria) return aria
    const labels = normalize([...element.labels ?? []].map(label => label.textContent ?? '').join(' '))
    if (labels) return labels
    return normalize(element.getAttribute('title'))
      || normalize(element.getAttribute('name'))
      || normalize(element.id)
  }
  const signatureFor = element => JSON.stringify({
    name: nameFor(element),
    accept: element.getAttribute('accept') ?? '',
    multiple: element.multiple === true,
    id: element.id ?? '',
    attributeName: element.getAttribute('name') ?? '',
  })
  const describe = (element, localIndex) => {
    const state = globalThis.__crazyagent
    const ownLabel = state?.idsByElement?.get(element)
    const associatedLabel = [...element.labels ?? []].map(label => state?.idsByElement?.get(label)).find(Number.isSafeInteger)
    return {
      localIndex,
      name: nameFor(element),
      accept: element.getAttribute('accept') ?? '',
      multiple: element.multiple === true,
      disabled: element.disabled === true,
      crossOrigin,
      signature: signatureFor(element),
      ...(Number.isSafeInteger(ownLabel) || Number.isSafeInteger(associatedLabel)
        ? { label: Number.isSafeInteger(ownLabel) ? ownLabel : associatedLabel }
        : {}),
    }
  }
  const prepare = (element, token) => {
    if (!element.isConnected) return { ok: false, code: 'UPLOAD_STALE', message: 'The file input was removed before upload; take a fresh view.' }
    if (element.disabled === true) return { ok: false, code: 'UPLOAD_DISABLED', message: `The file input ${JSON.stringify(nameFor(element) || '(unnamed)')} is disabled.` }
    if (crossOrigin) {
      const name = nameFor(element) || '(unnamed)'
      return {
        ok: false,
        code: 'UPLOAD_FRAME_UNSUPPORTED',
        message: `The file input ${JSON.stringify(name)} is inside a cross-origin (site-isolated) iframe, whose document the tab-level debugging session cannot see, so CDP file assignment is unsupported there. No file was assigned. Do not retry this input: use a same-origin file input, open the frame's own page as the active tab, or ask the user.`,
      }
    }
    element.setAttribute('data-crazyagent-upload', token)
    const localIndex = allInputs().indexOf(element)
    if (localIndex < 0) return { ok: false, code: 'UPLOAD_STALE', message: 'The file input could not be re-resolved; no file was assigned.' }
    return { ok: true, ...describe(element, localIndex) }
  }
  if (request.mode === 'discover') {
    return { ok: true, inputs: allInputs().map((element, index) => describe(element, index)) }
  }
  if (request.mode === 'cleanup') {
    for (const element of allInputs()) {
      if (element.getAttribute('data-crazyagent-upload') === request.token) element.removeAttribute('data-crazyagent-upload')
    }
    return { ok: true }
  }
  let element
  if (request.mode === 'label') {
    const state = globalThis.__crazyagent
    const labelled = state?.byId?.get(request.label)
    if (!labelled) return { ok: false, code: 'UNKNOWN_LABEL', message: `Label ${request.label} is not in the current view.` }
    if (!labelled.isConnected) return { ok: false, code: 'DETACHED', message: `Label ${request.label} no longer exists.` }
    element = labelled.tagName.toLowerCase() === 'input' && labelled.type === 'file' ? labelled : labelled.control
    if (!element || element.tagName.toLowerCase() !== 'input' || element.type !== 'file') {
      return { ok: false, code: 'NOT_FILE_INPUT', message: `Label ${request.label} is not a file input or a label associated with one.` }
    }
  } else {
    element = allInputs()[request.localIndex]
    if (!element) return { ok: false, code: 'UPLOAD_STALE', message: 'The selected file input no longer exists; inspect current file inputs before retrying.' }
    if (request.mode === 'verify' && element.getAttribute('data-crazyagent-upload') !== request.token) {
      return { ok: false, code: 'UPLOAD_STALE', message: 'The selected file input changed before verification; do not retry blindly.' }
    }
  }
  if (request.mode === 'verify') {
    const files = [...element.files ?? []].map(file => ({ name: file.name, size: file.size, type: file.type }))
    if (files.length !== 1 || files[0].name !== request.expectedName || files[0].size !== request.expectedSize) {
      return {
        ok: false,
        code: 'UPLOAD_READBACK_FAILED',
        message: `The file input did not retain exactly ${JSON.stringify(request.expectedName)} (${request.expectedSize} bytes); assignment was attempted, so do not retry blindly.`,
        files,
      }
    }
    return { ok: true, files, ...describe(element, request.localIndex) }
  }
  if (request.mode === 'prepare' && signatureFor(element) !== request.signature) {
    return { ok: false, code: 'UPLOAD_STALE', message: 'The selected file input changed before upload; no file was assigned.' }
  }
  if (request.mode === 'label' || request.mode === 'prepare') return prepare(element, request.token)
  return { ok: false, code: 'BAD_UPLOAD', message: `Unknown file-input probe mode ${String(request.mode)}` }
}

export function downloadLinkProbe(label) {
  const state = globalThis.__crazyagent
  const element = state?.byId?.get(label)
  if (!element) return { ok: false, code: 'UNKNOWN_LABEL', message: `Label ${label} is not in the current view.` }
  if (!element.isConnected) return { ok: false, code: 'DETACHED', message: `Label ${label} no longer exists.` }
  const info = state?.infoById?.get(label) ?? {}
  const text = String(info.text ?? element.innerText ?? element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 200)
  const downloadNamed = /\bdownload\b/iu.test(text)
  if (element.tagName.toLowerCase() === 'a') {
    let url
    try {
      url = new URL(element.getAttribute('href') ?? '', document.baseURI)
      if (url.protocol === 'http:' || url.protocol === 'https:') return { ok: true, url: url.href, text }
    } catch {
      if (!downloadNamed) return { ok: false, code: 'BAD_DOWNLOAD_URL', message: 'The labelled link has no valid URL.' }
    }
    if (!downloadNamed) return { ok: false, code: 'BAD_DOWNLOAD_URL', message: 'Only http(s) download links are supported.' }
  } else if (!downloadNamed) {
    return { ok: false, code: 'NOT_DOWNLOAD_BUTTON', message: 'The label is not a direct download link or a control named Download; no click was dispatched.' }
  }
  return { ok: true, click: true, text }
}

function inputChoices(inputs) {
  return inputs.slice(0, 12).map(item => {
    const details = [`input:${item.input}`, JSON.stringify(item.name || '(unnamed)')]
    if (item.accept) details.push(`accept=${item.accept}`)
    if (item.frameId !== 0) details.push(`frame=${item.frameId}`)
    if (item.label !== undefined) details.push(`label=${item.label}`)
    if (item.disabled) details.push('disabled')
    if (item.crossOrigin === true) details.push('cross-origin-unsupported')
    return details.join(' ')
  }).join('; ')
}

function frameUnsupportedError(input, inputs) {
  const name = JSON.stringify(input?.name || '(unnamed)')
  const choices = inputChoices(inputs)
  return fileFailure(
    'UPLOAD_FRAME_UNSUPPORTED',
    `File input ${name} lives inside a cross-origin (site-isolated) iframe, whose document the tab-level debugging session cannot see, so CDP file assignment is unsupported there. No file was assigned. Do not retry this input: use a same-origin file input, open the frame's own page as the active tab, or ask the user.${choices ? ` Choices: ${choices}` : ''}`,
  )
}

async function discoverInputs(tabId, io) {
  const frames = await io.runInAllFrames(tabId, fileInputProbe, [{ mode: 'discover' }], 5_000)
  const ordered = [...frames].sort((left, right) => left.frameId === 0 ? -1 : right.frameId === 0 ? 1 : left.frameId - right.frameId)
  const inputs = []
  for (const frame of ordered) {
    for (const input of frame.result?.inputs ?? []) {
      const localLabel = input.label
      inputs.push({
        ...input,
        frameId: frame.frameId,
        input: inputs.length + 1,
        label: Number.isSafeInteger(localLabel) && localLabel > 0
          ? frame.frameId === 0 ? localLabel : frame.frameId * 100_000 + localLabel
          : undefined,
      })
    }
  }
  return inputs
}

function selectInput(inputs, request) {
  if (request.input !== undefined) {
    const selected = inputs.find(item => item.input === request.input)
    if (!selected) throw fileFailure('UPLOAD_TARGET_NOT_FOUND', `File input ${request.input} is outside the available range 1..${inputs.length}. Choices: ${inputChoices(inputs)}`)
    if (selected.crossOrigin === true) throw frameUnsupportedError(selected, inputs)
    return selected
  }
  const matches = request.name === undefined ? inputs : inputs.filter(item => item.name === request.name)
  if (matches.length === 0) {
    const reason = request.name === undefined ? 'No file inputs were found in accessible frames or open shadow roots.' : `No file input has the exact accessible name ${JSON.stringify(request.name)}.`
    throw fileFailure('UPLOAD_TARGET_NOT_FOUND', `${reason} Choices: ${inputChoices(inputs) || 'none'}`)
  }
  if (matches.length > 1) {
    throw fileFailure('UPLOAD_TARGET_AMBIGUOUS', `Found ${matches.length} matching file inputs; no file was assigned. Retry with one returned input:<index> or a visible label. Choices: ${inputChoices(matches)}`)
  }
  if (matches[0].crossOrigin === true) throw frameUnsupportedError(matches[0], inputs)
  return matches[0]
}

export async function executeDownload(args, io) {
  const request = parseDownloadArgs(args)
  const tab = await io.getActiveTab()
  await io.assertCapturable(tab)
  let url = request.url
  let link
  if (request.label !== undefined) {
    const target = io.resolveLabelTarget(tab, request.label)
    if (!target) throw fileFailure('UNKNOWN_LABEL', `Label ${request.label} is not in the current view; take a fresh view before downloading.`)
    link = await io.runInFrame(tab.id, target.frameId, downloadLinkProbe, [target.localId], 4_000)
    if (!link?.ok) throw fileFailure(link?.code ?? 'DOWNLOAD_LINK_FAILED', link?.message ?? 'The download link could not be resolved')
    url = link.url
    const current = await io.getActiveTab()
    if (current.id !== tab.id || current.url !== tab.url) throw fileFailure('DOWNLOAD_STALE_TAB', 'The active tab changed before the download started; nothing was downloaded.')
    if (link.click === true && request.filename !== undefined) {
      throw fileFailure('BAD_DOWNLOAD_FILENAME', 'filename is supported only for direct URLs and direct links, not page download buttons; no click was dispatched.')
    }
  }
  const downloaded = link?.click === true
    ? await io.downloadClick({ label: request.label, root: request.root, timeoutMs: request.timeoutMs })
    : await io.download({
        url,
        filename: request.filename,
        root: request.root,
        timeoutMs: request.timeoutMs,
      })
  return {
    op: 'download',
    view: 'none',
    screenshotSkipped: true,
    capture: { status: 'skipped', reason: 'DOWNLOAD_TEXT_ONLY' },
    tab: io.tabSummary(tab),
    download: {
      status: 'complete',
      path: downloaded.path,
      size: downloaded.size,
      mime: downloaded.mime ?? '',
      finalUrl: downloaded.finalUrl ?? url,
      ...(link ? { label: request.label, linkText: link.text } : {}),
    },
  }
}

export async function executeUpload(args, io) {
  const request = parseUploadArgs(args)
  const tab = await io.getActiveTab()
  await io.assertCapturable(tab)
  const token = crypto.randomUUID()
  let target
  if (request.label !== undefined) {
    const resolved = io.resolveLabelTarget(tab, request.label)
    if (!resolved) throw fileFailure('UNKNOWN_LABEL', `Label ${request.label} is not in the current view; take a fresh view before uploading.`)
    target = { frameId: resolved.frameId, localId: resolved.localId }
  } else {
    target = selectInput(await discoverInputs(tab.id, io), request)
  }
  const expectedName = basename(request.path)
  let prepared
  let attempted = false
  try {
    prepared = await io.runInFrame(tab.id, target.frameId, fileInputProbe, [target.localIndex === undefined
      ? { mode: 'label', label: target.localId ?? (request.label >= 100_000 ? request.label % 100_000 : request.label), token }
      : { mode: 'prepare', localIndex: target.localIndex, signature: target.signature, token }], 4_000)
    if (!prepared?.ok) throw fileFailure(prepared?.code ?? 'UPLOAD_TARGET_FAILED', prepared?.message ?? 'The file input could not be prepared; no file was assigned.')
    attempted = true
    await io.setFileInput(tab.id, token, request.path)
    const verified = await io.runInFrame(tab.id, target.frameId, fileInputProbe, [{
      mode: 'verify',
      localIndex: prepared.localIndex,
      token,
      expectedName,
      expectedSize: request.size,
    }], 4_000)
    if (!verified?.ok) throw fileFailure(verified?.code ?? 'UPLOAD_READBACK_FAILED', verified?.message ?? 'The file assignment could not be verified; do not retry blindly.', { mutationPossible: true })
    const current = await io.getActiveTab()
    const built = await io.actionView(current, request.view, { changed: true, signals: ['file-input-readback'] })
    const result = {
      ...built.payload,
      op: 'upload',
      upload: {
        status: 'attached',
        filename: verified.files[0].name,
        size: verified.files[0].size,
        mime: verified.files[0].type,
        verifiedBy: 'file-input-readback',
        input: {
          index: target.input,
          name: prepared.name,
          frame: target.frameId,
          ...(request.label !== undefined ? { label: request.label } : {}),
        },
      },
    }
    if (built.mode !== 'full') {
      result.view = built.mode
      result.screenshotSkipped = true
    }
    return result
  } catch (error) {
    // The probe cannot always see site isolation from inside the frame (a
    // sandboxed/opaque frame still looks same-origin to a script that cannot
    // inspect its own process). When assignment fails with the tab-level CDP
    // token lookup finding no marked node although the target lives in a
    // non-top frame, that is the cross-origin/isolated-frame signature: report
    // it as unsupported instead of a misleading stale view.
    if (target.frameId !== 0 && error?.code === 'UPLOAD_STALE' && /found 0\b/u.test(error?.message ?? '')) {
      throw fileFailure(
        'UPLOAD_FRAME_UNSUPPORTED',
        `The file input ${JSON.stringify(prepared?.name || '(unnamed)')} was found in frame ${target.frameId}, but the tab-level debugging session could not see it when assigning the file. That happens when the input lives in a cross-origin (site-isolated) iframe, whose document is outside the tab-level CDP DOM tree; file assignment is unsupported there. No file was assigned. Do not retry this input: use a same-origin file input, open the frame's own page as the active tab, or ask the user.`,
        { mutationPossible: false, frameId: target.frameId },
      )
    }
    if (attempted && error?.mutationPossible !== false) {
      if (!/do not retry blindly|inspect the page/u.test(error.message)) {
        error.message = `${error.message} File assignment was attempted and may have succeeded; inspect the page before any retry.`
      }
      error.mutationPossible = true
    }
    throw error
  } finally {
    if (prepared?.localIndex !== undefined) {
      await io.runInFrame(tab.id, target.frameId, fileInputProbe, [{ mode: 'cleanup', localIndex: prepared.localIndex, token }], 1_000).catch(() => {})
    }
  }
}
