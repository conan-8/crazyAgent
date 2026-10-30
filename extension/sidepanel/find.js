const FIND_MAX_QUERY_CHARS = 200
const FIND_MAX_MATCHES = 200
const FIND_MAX_RESULTS = 20
const FIND_MAX_NODES_PER_FRAME = 20_000

function findFailure(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizedQuery(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
}

export function parseFindArgs(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['query', 'occurrence', 'reveal'].includes(key))) {
    throw findFailure('BAD_FIND', 'find accepts only query, occurrence, and reveal')
  }
  const query = normalizedQuery(args.query)
  if (query.length < 1 || query.length > FIND_MAX_QUERY_CHARS) {
    throw findFailure('BAD_FIND', `find query must contain 1 to ${FIND_MAX_QUERY_CHARS} characters`)
  }
  const occurrence = args.occurrence
  if (occurrence !== undefined && occurrence !== 'first' && occurrence !== 'last' && (!Number.isSafeInteger(occurrence) || occurrence < 1)) {
    throw findFailure('BAD_FIND', 'find occurrence must be first, last, or a positive one-based integer')
  }
  if (args.reveal !== undefined && typeof args.reveal !== 'boolean') throw findFailure('BAD_FIND', 'find reveal must be true or false')
  return { query, occurrence, reveal: args.reveal === true }
}

function publicMatch(match) {
  return {
    occurrence: match.occurrence,
    snippet: match.snippet,
    source: match.source,
    tag: match.tag,
    role: match.role,
    inViewport: match.inViewport,
    ...(match.frameId === 0 ? {} : { frame: match.frameId }),
    ...(match.label === undefined ? {} : { label: match.label }),
  }
}

function occurrenceIndex(occurrence, count, truncated) {
  if (occurrence === undefined) return undefined
  if (occurrence === 'first') return count > 0 ? 0 : undefined
  if (occurrence === 'last') {
    if (truncated) throw findFailure('FIND_REFINE_QUERY', 'The last occurrence is unknown because scanning or matching was truncated; refine the query')
    return count > 0 ? count - 1 : undefined
  }
  return occurrence <= count ? occurrence - 1 : undefined
}

function collectMatches(frames) {
  const matches = []
  let truncated = false
  let scannedNodes = 0
  const ordered = [...frames].sort((left, right) => (left.frameId === 0 ? -1 : right.frameId === 0 ? 1 : left.frameId - right.frameId))
  for (const frame of ordered) {
    truncated = truncated || frame.result?.truncated === true
    scannedNodes += Math.max(0, Number(frame.result?.scannedNodes) || 0)
    if (!Array.isArray(frame.result?.matches)) continue
    for (const match of frame.result.matches) {
      if (matches.length >= FIND_MAX_MATCHES) {
        truncated = true
        break
      }
      const localLabel = Number(match.label)
      matches.push({
        ...match,
        frameId: frame.frameId,
        localIndex: match.localIndex,
        label: Number.isSafeInteger(localLabel) && localLabel > 0
          ? frame.frameId === 0 ? localLabel : frame.frameId * 100_000 + localLabel
          : undefined,
        occurrence: matches.length + 1,
      })
    }
  }
  return { matches, truncated, scannedNodes }
}

export async function executeFind(args, io) {
  const request = parseFindArgs(args)
  const tab = await io.getActiveTab()
  await io.assertCapturable(tab)
  const canvasApp = io.canvasEditorForUrl(tab.url)
  if (canvasApp) {
    throw findFailure('FIND_CANVAS_UNSUPPORTED', `${canvasApp} does not expose reliable rendered document text to generic DOM find. Use its dedicated semantic tools or browser_screenshot instead.`)
  }
  const frames = await io.runInAllFrames(tab.id, findProbe, [{
    mode: 'search',
    query: request.query,
    maxMatches: FIND_MAX_MATCHES,
    maxNodes: FIND_MAX_NODES_PER_FRAME,
  }], 5_000)
  const collected = collectMatches(frames)
  const selectedIndex = occurrenceIndex(request.occurrence, collected.matches.length, collected.truncated)
  if (request.occurrence !== undefined && selectedIndex === undefined) {
    if (collected.truncated) {
      throw findFailure('FIND_REFINE_QUERY', `Occurrence ${String(request.occurrence)} is outside the bounded result set; refine the query`)
    }
    throw findFailure('FIND_OCCURRENCE_NOT_FOUND', `Occurrence ${String(request.occurrence)} of ${JSON.stringify(request.query)} was not found; ${collected.matches.length} match(es) are available`)
  }
  if (request.reveal && collected.matches.length === 0) throw findFailure('FIND_NOT_FOUND', `No rendered match for ${JSON.stringify(request.query)} was found; nothing was scrolled`)
  if (request.reveal && request.occurrence === undefined && collected.truncated) {
    throw findFailure('FIND_REFINE_QUERY', 'The search was truncated, so uniqueness is unknown; refine the query or pass an explicit occurrence. Nothing was scrolled.')
  }
  if (request.reveal && request.occurrence === undefined && collected.matches.length !== 1) {
    throw findFailure('FIND_AMBIGUOUS', `Found ${collected.matches.length} matches for ${JSON.stringify(request.query)}; pass occurrence:"first", "last", or a one-based integer. Nothing was scrolled.`)
  }
  const target = request.reveal ? collected.matches[request.occurrence === undefined ? 0 : selectedIndex] : undefined
  const selected = target ?? (selectedIndex === undefined ? undefined : collected.matches[selectedIndex])
  const visibleMatches = selected ? [selected] : collected.matches.slice(0, FIND_MAX_RESULTS)
  const summary = {
    query: request.query,
    matchCount: collected.matches.length,
    countExact: !collected.truncated,
    returnedCount: visibleMatches.length,
    truncated: collected.truncated,
    scannedNodes: collected.scannedNodes,
    ...(selected ? { occurrence: selected.occurrence } : {}),
    revealed: request.reveal,
  }

  if (!request.reveal) {
    return {
      op: 'find',
      view: 'none',
      screenshotSkipped: true,
      capture: { status: 'skipped', reason: 'FIND_TEXT_ONLY' },
      tab: io.tabSummary(tab),
      find: summary,
      matches: visibleMatches.map(publicMatch),
    }
  }

  const before = await io.getActiveTab()
  if (before.id !== tab.id || before.url !== tab.url) {
    throw findFailure('FIND_STALE_TAB', 'The active tab changed before the match could be revealed; nothing was scrolled')
  }
  let revealed
  try {
    revealed = await io.runInFrame(tab.id, target.frameId, findProbe, [{
      mode: 'reveal',
      query: request.query,
      localIndex: target.localIndex,
      signature: target.signature,
      maxMatches: FIND_MAX_MATCHES,
      maxNodes: FIND_MAX_NODES_PER_FRAME,
    }], 5_000)
  } finally {
    await io.invalidateCoordinates(tab.id)
  }
  if (!revealed?.ok) throw findFailure(revealed?.code ?? 'FIND_STALE', revealed?.message ?? 'The match changed before it could be revealed; search again')
  const after = await io.getActiveTab()
  if (after.id !== tab.id || after.url !== tab.url) {
    throw findFailure('FIND_STALE_TAB', 'The active tab changed while revealing the match; inspect the current tab before taking further action')
  }
  const view = await io.snapshot()
  return {
    ...view,
    op: 'find',
    find: summary,
    matches: [{ ...publicMatch(target), inViewport: revealed.inViewport }],
    reveal: { inViewport: revealed.inViewport, moved: revealed.moved },
  }
}

export function findProbe(request) {
  const normalize = value => String(value ?? '').replace(/\s+/gu, ' ').trim()
  const query = normalize(request.query)
  const foldedQuery = query.toLowerCase()
  const maxMatches = Math.max(1, Math.min(200, Math.floor(Number(request.maxMatches) || 200)))
  const maxNodes = Math.max(1, Math.min(20_000, Math.floor(Number(request.maxNodes) || 20_000)))
  const interactiveSelector = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary', 'label',
    'img[alt]', '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
    '[role="menuitemcheckbox"]', '[role="menuitemradio"]', '[role="checkbox"]', '[role="switch"]',
    '[role="radio"]', '[role="option"]', '[role="combobox"]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
  ].join(',')
  const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'VIDEO', 'AUDIO'])
  const hiddenCache = new WeakMap()
  const hidden = element => {
    if (!element) return true
    if (hiddenCache.has(element)) return hiddenCache.get(element)
    let current = element
    let result = false
    while (current) {
      if (current.hidden === true || current.getAttribute?.('aria-hidden') === 'true' || current.hasAttribute?.('inert')) {
        result = true
        break
      }
      const style = getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
        || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) {
        result = true
        break
      }
      const root = current.getRootNode?.()
      current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
    }
    hiddenCache.set(element, result)
    return result
  }
  const roleFor = element => {
    const explicit = element.getAttribute('role')
    if (explicit) return explicit
    const tag = element.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'img') return 'img'
    if (tag === 'input') {
      const type = (element.type || 'text').toLowerCase()
      if (type === 'checkbox' || type === 'radio') return type
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button'
      if (type === 'search') return 'searchbox'
      return 'textbox'
    }
    return ''
  }
  const items = []
  const groups = new Map()
  const seenRoots = new Set()
  let scannedNodes = 0
  let scanTruncated = false

  const groupFor = node => {
    const parent = node.parentElement
    if (!parent || skipTags.has(parent.tagName) || parent.closest(interactiveSelector) || hidden(parent)) return undefined
    let current = parent
    let boundary = parent
    while (current) {
      const display = getComputedStyle(current).display
      if (display !== 'contents' && (!display.startsWith('inline') || display === 'inline-block')) boundary = current
      if (boundary === current && display !== 'contents' && (!display.startsWith('inline') || display === 'inline-block')) break
      const root = current.getRootNode?.()
      current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
    }
    let group = groups.get(boundary)
    if (!group) {
      group = { type: 'text', element: boundary, raw: '' }
      groups.set(boundary, group)
      items.push(group)
    }
    return group
  }

  const accessibleName = element => {
    const root = element.getRootNode()
    const labelledBy = element.getAttribute('aria-labelledby')
    const fromIds = labelledBy
      ? labelledBy.split(/\s+/u).map(id => root.getElementById?.(id)?.textContent ?? document.getElementById(id)?.textContent ?? '').join(' ')
      : ''
    const labels = element.labels ? Array.from(element.labels).map(label => label.innerText ?? label.textContent ?? '').join(' ') : ''
    const candidates = [
      element.getAttribute('aria-label'), fromIds, labels, element.getAttribute('alt'),
      element.getAttribute('title'), element.innerText, element.textContent,
    ]
    for (const candidate of candidates) {
      const text = normalize(candidate)
      if (text) return text.slice(0, 2_000)
    }
    return ''
  }

  const walk = root => {
    if (seenRoots.has(root) || scanTruncated) return
    seenRoots.add(root)
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      scannedNodes += 1
      if (scannedNodes > maxNodes) {
        scanTruncated = true
        return
      }
      const node = walker.currentNode
      if (node.nodeType === Node.TEXT_NODE) {
        const group = groupFor(node)
        if (group) group.raw += String(node.nodeValue ?? '')
        continue
      }
      const element = node
      if (hidden(element)) continue
      if (element.tagName === 'BR') {
        const group = groupFor(element)
        if (group) group.raw += '\n'
      }
      if (element.matches(interactiveSelector)) {
        if (element.tagName === 'LABEL' && element.control) {
          // The associated control exposes this label as its accessible name.
        } else {
          items.push({ type: 'control', element })
        }
      }
      if (element.shadowRoot) walk(element.shadowRoot)
    }
  }
  walk(document)

  const matches = []
  let matchTruncated = false
  const snippetFor = (text, index) => {
    const before = Math.max(0, index - 80)
    const after = Math.min(text.length, index + foldedQuery.length + 120)
    return `${before > 0 ? '…' : ''}${text.slice(before, after)}${after < text.length ? '…' : ''}`
  }
  const addMatch = (element, source, text, index) => {
    if (matches.length >= maxMatches) {
      matchTruncated = true
      return false
    }
    const rect = element.getBoundingClientRect()
    const state = globalThis.__crazyagent
    const existingLabel = state?.idsByElement?.get(element)
    const label = Number.isSafeInteger(existingLabel) && existingLabel > 0 && state.byId.get(existingLabel) === element ? existingLabel : undefined
    const snippet = snippetFor(text, index)
    const tag = element.tagName.toLowerCase()
    const role = roleFor(element)
    matches.push({
      element,
      localIndex: matches.length,
      snippet,
      source,
      tag,
      role,
      label,
      signature: JSON.stringify([source, tag, role, snippet]),
      inViewport: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth,
    })
    return true
  }
  const matchText = (element, source, raw, multiple) => {
    const text = normalize(raw)
    if (!text) return true
    const folded = text.toLowerCase()
    let from = 0
    while (from <= folded.length - foldedQuery.length) {
      const index = folded.indexOf(foldedQuery, from)
      if (index < 0) return true
      if (!addMatch(element, source, text, index)) return false
      from = index + foldedQuery.length
      if (!multiple) return true
    }
    return true
  }

  for (const item of items) {
    if (matches.length >= maxMatches) {
      matchTruncated = true
      break
    }
    if (item.type === 'text') {
      if (!matchText(item.element, 'text', item.raw, true)) break
      continue
    }
    const element = item.element
    if (!element.isConnected || hidden(element)) continue
    const type = (element.type || '').toLowerCase()
    const sources = [
      ['accessible-name', accessibleName(element)],
      ...type === 'password' ? [] : [['value', normalize(element.value)]],
      ['placeholder', normalize(element.getAttribute('placeholder'))],
    ]
    for (const [source, text] of sources) {
      if (!text.toLowerCase().includes(foldedQuery)) continue
      if (!matchText(element, source, text, false)) break
      break
    }
  }

  const serialize = match => ({
    localIndex: match.localIndex,
    snippet: match.snippet,
    source: match.source,
    tag: match.tag,
    role: match.role,
    label: match.label,
    signature: match.signature,
    inViewport: match.inViewport,
  })
  if (request.mode === 'reveal') {
    const target = matches[request.localIndex]
    if (!target || target.signature !== request.signature || !target.element.isConnected || hidden(target.element)) {
      return { ok: false, code: 'FIND_STALE', message: 'The matched content changed before reveal; nothing was scrolled. Search again.' }
    }
    const before = target.element.getBoundingClientRect()
    const root = document.scrollingElement || document.documentElement
    const beforeX = root.scrollLeft || 0
    const beforeY = root.scrollTop || 0
    target.element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const rect = target.element.getBoundingClientRect()
    const inViewport = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth
    if (!inViewport) return { ok: false, code: 'FIND_REVEAL_FAILED', message: 'The matched element could not be brought into its frame viewport; inspect the page visually.' }
    return {
      ok: true,
      inViewport,
      moved: Math.abs(rect.left - before.left) > 1 || Math.abs(rect.top - before.top) > 1
        || Math.abs((root.scrollLeft || 0) - beforeX) > 1 || Math.abs((root.scrollTop || 0) - beforeY) > 1,
    }
  }
  return {
    matches: matches.map(serialize),
    truncated: scanTruncated || matchTruncated,
    scannedNodes,
  }
}
