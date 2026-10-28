const ROLE_CLICK_STEP_MS = 3_000
const ROLE_CLICK_TOTAL_MS = 15_000
const ROLE_CLICK_POLL_MS = 50
const ROLE_CLICK_FINAL_QUIET_MS = 100
const ROLE_CLICK_NAVIGATION_LOAD_MS = 2_000
const ROLE_CLICK_INPUT_SETTLE_MS = 250
const ROLE_CLICK_SNAPSHOT_MS = 4_000

export const ROLE_CLICK_ROLES = Object.freeze([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'option',
  'combobox',
])

export class RoleClickError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'RoleClickError'
    this.code = code
    Object.assign(this, details)
  }
}

function roleFailure(code, message, details) {
  return new RoleClickError(code, message, details)
}

export function normalizeRoleClickName(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
}

export function parseRoleClickArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'path')) {
    throw roleFailure('BAD_ROLE_PATH', 'click_role accepts only a path argument')
  }
  if (!Array.isArray(args.path) || args.path.length < 1 || args.path.length > 4) {
    throw roleFailure('BAD_ROLE_PATH', 'path must be an array of 1 to 4 role/name objects')
  }
  const roles = new Set(ROLE_CLICK_ROLES)
  const path = args.path.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step) || Object.keys(step).some(key => !['role', 'name'].includes(key))) {
      throw roleFailure('BAD_ROLE_PATH', `path[${index}] must contain only role and name`)
    }
    if (typeof step.role !== 'string' || !roles.has(step.role)) {
      throw roleFailure('BAD_ROLE', `path[${index}].role must be one of ${ROLE_CLICK_ROLES.join(', ')}`)
    }
    const name = normalizeRoleClickName(step.name)
    if (!name) throw roleFailure('BAD_ROLE_NAME', `path[${index}].name must be a non-empty string`)
    return { role: step.role, name }
  })
  return path
}

/**
 * Serialized into each frame. Everything used by this function is scoped inside
 * it so chrome.scripting never needs a content-script dependency.
 */
export function roleClickProbe(request) {
  try {
    const normalize = value => String(value ?? '').replace(/\s+/gu, ' ').trim()
    const composedParent = element => {
      if (element.assignedSlot) return element.assignedSlot
      if (element.parentElement) return element.parentElement
      const root = element.getRootNode?.()
      return root?.host ?? undefined
    }
    const hidden = element => {
      let current = element
      while (current) {
        if (current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert') || current.inert === true || current.hidden === true) return true
        const style = getComputedStyle(current)
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden') return true
        if (style.opacity !== '' && Number(style.opacity) === 0) return true
        current = composedParent(current)
      }
      return false
    }
    const textFor = (node, seen = new Set()) => {
      if (!node || seen.has(node)) return ''
      seen.add(node)
      if (node.nodeType === Node.TEXT_NODE) return String(node.textContent ?? '')
      if (node.nodeType !== Node.ELEMENT_NODE) return ''
      const element = node
      const tag = element.tagName.toLowerCase()
      if (['script', 'style', 'noscript', 'template'].includes(tag)) return ''
      if (element.hidden === true || element.getAttribute('aria-hidden') === 'true' || element.hasAttribute('inert')) return ''
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return ''
      if (tag === 'slot' && typeof element.assignedNodes === 'function') {
        const assigned = element.assignedNodes({ flatten: true })
        if (assigned.length > 0) return assigned.map(child => textFor(child, seen)).join('')
      }
      const children = element.shadowRoot ? element.shadowRoot.childNodes : element.childNodes
      return Array.from(children).map(child => textFor(child, seen)).join('')
    }
    const byId = (root, id) => {
      if (typeof root.getElementById === 'function') return root.getElementById(id)
      return Array.from(root.querySelectorAll?.('[id]') ?? []).find(element => element.id === id)
    }
    const accessibleName = element => {
      const root = element.getRootNode()
      const labelledBy = normalize(element.getAttribute('aria-labelledby'))
      if (labelledBy) {
        const value = labelledBy.split(' ').map(id => textFor(byId(root, id))).join(' ')
        if (normalize(value)) return normalize(value)
      }
      const ariaLabel = normalize(element.getAttribute('aria-label'))
      if (ariaLabel) return ariaLabel
      const labels = Array.from(element.labels ?? [])
      if (labels.length > 0) {
        const value = labels.map(label => textFor(label)).join(' ')
        if (normalize(value)) return normalize(value)
      }
      const tag = element.tagName.toLowerCase()
      if (tag === 'option') {
        const label = normalize(element.getAttribute('label'))
        if (label) return label
      }
      if (tag === 'input' && ['button', 'submit', 'reset'].includes(element.type)) {
        const value = normalize(element.value)
        if (value) return value
        if (element.type === 'submit') return 'Submit'
        if (element.type === 'reset') return 'Reset'
      }
      if (tag === 'input' && element.type === 'image') {
        const alt = normalize(element.getAttribute('alt'))
        if (alt) return alt
      }
      const text = normalize(textFor(element))
      if (text) return text
      const alt = normalize(element.getAttribute('alt'))
      if (alt) return alt
      return normalize(element.getAttribute('title'))
    }
    const roleFor = element => {
      const explicit = normalize(element.getAttribute('role')).toLowerCase()
      if (explicit) return explicit.split(' ')[0]
      const tag = element.tagName.toLowerCase()
      if (tag === 'button' || tag === 'summary') return 'button'
      if (tag === 'a' && element.hasAttribute('href')) return 'link'
      if (tag === 'option') return 'option'
      if (tag === 'select') return !element.multiple && Number(element.size ?? 0) <= 1 ? 'combobox' : 'listbox'
      if (tag === 'input') {
        if (element.type === 'checkbox') return 'checkbox'
        if (element.type === 'radio') return 'radio'
        if (['button', 'submit', 'reset', 'image'].includes(element.type)) return 'button'
      }
      return ''
    }
    const identityFor = element => {
      const parts = []
      let current = element
      while (current) {
        const parent = current.parentElement
        if (parent) {
          const siblings = Array.from(parent.children).filter(sibling => sibling.tagName === current.tagName)
          parts.unshift(`${current.tagName.toLowerCase()}:${Math.max(0, siblings.indexOf(current))}`)
          current = parent
          continue
        }
        const root = current.getRootNode?.()
        if (root?.host) {
          parts.unshift('#shadow')
          current = root.host
          continue
        }
        break
      }
      const identities = globalThis.__crazyagentRoleClickIdentities ??= { next: 1, elements: new WeakMap() }
      let objectId = identities.elements.get(element)
      if (!objectId) {
        objectId = identities.next
        identities.next += 1
        identities.elements.set(element, objectId)
      }
      return `${parts.join('/')}#${objectId}`
    }
    const disabledFor = element => {
      if (element.disabled === true || element.matches(':disabled')) return true
      let current = element
      while (current) {
        if (current.getAttribute('aria-disabled') === 'true') return true
        current = composedParent(current)
      }
      return false
    }
    const editorFor = element => {
      if (document.designMode === 'on') return true
      let current = element
      while (current) {
        const tag = current.tagName.toLowerCase()
        const editable = current.getAttribute('contenteditable')
        const role = normalize(current.getAttribute('role')).toLowerCase()
        if (['canvas', 'iframe', 'object', 'embed'].includes(tag)) return true
        if (current.isContentEditable === true || (editable !== null && editable.toLowerCase() !== 'false')) return true
        if (['document', 'textbox'].includes(role)) return true
        if (current.matches('.kix-appview-editor,.kix-canvas-tile-content,.docs-texteventtarget-iframe,.monaco-editor,.CodeMirror,[data-editor]')) return true
        current = composedParent(current)
      }
      return false
    }
    const stateFor = element => ({
      checked: typeof element.checked === 'boolean' ? element.checked : element.getAttribute('aria-checked'),
      selected: typeof element.selected === 'boolean' ? element.selected : element.getAttribute('aria-selected'),
      expanded: element.getAttribute('aria-expanded'),
      pressed: element.getAttribute('aria-pressed'),
      current: element.getAttribute('aria-current'),
    })
    const deepHit = (x, y) => {
      let hit = document.elementFromPoint(x, y)
      for (let depth = 0; depth < 16 && hit?.shadowRoot && typeof hit.shadowRoot.elementFromPoint === 'function'; depth += 1) {
        const nested = hit.shadowRoot.elementFromPoint(x, y)
        if (!nested || nested === hit) break
        hit = nested
      }
      return hit
    }
    const hitOwner = hit => {
      let current = hit
      while (current) {
        if (roleFor(current) || current.matches('button,a[href],input,select,textarea,summary')) return current
        current = composedParent(current)
      }
      return undefined
    }
    const elements = []
    const seen = new Set()
    const collect = root => {
      for (const element of root.querySelectorAll('*')) {
        if (seen.has(element)) continue
        seen.add(element)
        elements.push(element)
        if (element.shadowRoot) collect(element.shadowRoot)
      }
    }
    collect(document)
    const matches = []
    const nextMatches = []
    let surfaceCount = 0
    for (const element of elements) {
      const role = roleFor(element)
      const tag = element.tagName.toLowerCase()
      if (['menu', 'listbox', 'dialog', 'alertdialog'].includes(role) || (tag === 'dialog' && element.hasAttribute('open'))) {
        const box = element.getBoundingClientRect()
        if (!hidden(element) && box.width > 0 && box.height > 0) surfaceCount += 1
      }
      const wanted = role === request.role
      const wantedNext = request.next && role === request.next.role
      if (!wanted && !wantedNext) continue
      if (!element.isConnected || hidden(element)) continue
      const name = accessibleName(element)
      const matchesCurrent = wanted && name === request.name
      const matchesNext = wantedNext && name === request.next.name
      if (!matchesCurrent && !matchesNext) continue
      const rect = element.getBoundingClientRect()
      if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) continue
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue
      const hit = deepHit(x, y)
      const result = {
        role,
        name,
        identity: identityFor(element),
        x,
        y,
        coordinateSpace: window === window.top ? 'top' : 'frame',
        disabled: disabledFor(element),
        covered: !hit || hitOwner(hit) !== element,
        editor: editorFor(element),
        state: stateFor(element),
      }
      if (matchesCurrent) matches.push(result)
      if (matchesNext) nextMatches.push({ ...result })
    }
    return { ok: true, url: location.href, matches, nextMatches, surfaceCount }
  } catch (error) {
    return {
      ok: false,
      code: 'ROLE_CLICK_PROBE',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Verify one source-marked iframe in the actual owning chain at its local point. */
export function roleClickFrameOwnershipProbe(request) {
  try {
    const KEY = '__crazyagentRoleClickFrameOwnership'
    const owners = []
    const collect = root => {
      for (const element of root.querySelectorAll('iframe,frame')) {
        const record = element[KEY]
        if (record?.token === request.token && record.frameId === request.targetFrameId) owners.push(element)
      }
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) collect(element.shadowRoot)
      }
    }
    collect(document)
    if (owners.length !== 1) {
      return { ok: false, code: 'ROLE_CLICK_FRAME_OWNERSHIP', message: 'The source-verified owning iframe is no longer unique and available' }
    }
    const owner = owners[0]
    const record = owner[KEY]
    const x = Number(record.x) + Number(request.x)
    const y = Number(record.y) + Number(request.y)
    const rect = owner.getBoundingClientRect()
    if (![x, y, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) {
      return { ok: false, code: 'ROLE_CLICK_FRAME_OWNERSHIP', message: 'The owning iframe returned invalid geometry' }
    }
    const composedParent = element => {
      if (element.assignedSlot) return element.assignedSlot
      if (element.parentElement) return element.parentElement
      return element.getRootNode?.()?.host ?? undefined
    }
    let current = owner
    let hidden = false
    while (current) {
      const style = getComputedStyle(current)
      if (current.hidden === true || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')
        || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
        || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) {
        hidden = true
        break
      }
      current = composedParent(current)
    }
    const left = rect.left + (Number(owner.clientLeft) || 0)
    const top = rect.top + (Number(owner.clientTop) || 0)
    const clipped = x < left || y < top || x >= left + owner.clientWidth || y >= top + owner.clientHeight
      || x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight
    let hit = document.elementFromPoint(x, y)
    for (let depth = 0; depth < 16 && hit?.shadowRoot && typeof hit.shadowRoot.elementFromPoint === 'function'; depth += 1) {
      const nested = hit.shadowRoot.elementFromPoint(x, y)
      if (!nested || nested === hit) break
      hit = nested
    }
    let hitFrame = hit
    while (hitFrame && !['iframe', 'frame'].includes(hitFrame.tagName.toLowerCase())) hitFrame = composedParent(hitFrame)
    return { ok: true, owned: !hidden && !clipped && hitFrame === owner }
  } catch (error) {
    return {
      ok: false,
      code: 'ROLE_CLICK_FRAME_OWNERSHIP',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function roleDriver(io) {
  const source = io.driver ?? io
  const methods = [
    'getWindowId',
    'getActiveTab',
    'getTab',
    'listFrames',
    'runInFrame',
    'withDebugger',
    'trustedClick',
    'snapshot',
    'assertCapturable',
  ]
  for (const method of methods) {
    if (typeof source[method] !== 'function') throw roleFailure('ROLE_CLICK_DRIVER', `Missing role-click driver method ${method}`)
  }
  return {
    ...Object.fromEntries(methods.map(method => [method, source[method].bind(source)])),
    sleep: typeof source.sleep === 'function' ? source.sleep.bind(source) : ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: typeof source.now === 'function' ? source.now.bind(source) : () => Date.now(),
    invalidateTab: typeof source.invalidateTab === 'function' ? source.invalidateTab.bind(source) : () => {},
  }
}

function roleDriverError(code, error, details = {}) {
  if (error instanceof RoleClickError) return error
  return roleFailure(code, error instanceof Error ? error.message : String(error), details)
}

function roleNow(context) {
  const value = Number(context.driver.now())
  return Number.isFinite(value) ? value : Date.now()
}

function roleRemaining(context, step) {
  if (context.cancelled || roleNow(context) >= context.deadline) {
    throw roleFailure('ROLE_CLICK_DEADLINE', 'The role click exceeded its 15s overall deadline')
  }
  if (step) {
    if (step.cancelled || roleNow(context) >= step.deadline) {
      throw roleFailure('ROLE_CLICK_STEP_TIMEOUT', `Path step ${step.index + 1} exceeded its 3s deadline`, { index: step.index })
    }
    return Math.max(0, Math.min(context.deadline, step.deadline) - roleNow(context))
  }
  return Math.max(0, context.deadline - roleNow(context))
}

async function roleBounded(promise, timeoutMs, onTimeout, error, input) {
  let timer
  const outcome = promise.then(value => ({ value }), reason => ({ error: reason }))
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      onTimeout()
      resolve('timeout')
    }, Math.max(1, timeoutMs))
  })
  let settled = await Promise.race([outcome, timeout])
  clearTimeout(timer)
  if (settled === 'timeout') {
    if (!input?.inputPending) throw error
    settled = await Promise.race([
      outcome,
      new Promise(resolve => { setTimeout(() => resolve('unsettled'), ROLE_CLICK_INPUT_SETTLE_MS) }),
    ])
    if (settled === 'unsettled') {
      throw roleFailure('ROLE_CLICK_UNSETTLED', 'Trusted input did not settle after cancellation; a delayed press or release may still be pending', {
        dispatchAttempted: input.dispatchAttempted === true,
        unsettled: true,
        cause: error,
      })
    }
    if (settled.value !== undefined) throw error
  }
  if (settled.error) throw settled.error
  return settled.value
}

async function roleObserve(context) {
  const [currentResult, activeResult] = await Promise.allSettled([
    context.driver.getTab(context.tab.id),
    context.driver.getActiveTab(context.windowId),
  ])
  const current = currentResult.status === 'fulfilled' ? currentResult.value : undefined
  const active = activeResult.status === 'fulfilled' ? activeResult.value : undefined
  const navigated = (current !== undefined && (current.id !== context.tab.id || (current.url ?? '') !== context.initialUrl))
    || (active !== undefined && active.id !== context.tab.id)
  if (active) context.snapshotTab = active
  else if (current) context.snapshotTab = current
  if (navigated) return { navigated: true, current, active }
  if (currentResult.status === 'rejected') throw roleDriverError('ROLE_CLICK_TAB_CHECK', currentResult.reason)
  if (activeResult.status === 'rejected') throw roleDriverError('ROLE_CLICK_TAB_CHECK', activeResult.reason)
  if (!current || current.id !== context.tab.id || !active || active.id !== context.tab.id) {
    throw roleFailure('ROLE_CLICK_STALE_TAB', 'The original tab is no longer active and available')
  }
  return { navigated: false, current, active }
}

async function roleAssertStable(context) {
  const observed = await roleObserve(context)
  if (observed.navigated) {
    throw roleFailure('ROLE_CLICK_STALE_NAVIGATION', 'The tab or URL changed before the next target could be clicked', { navigated: true })
  }
}

function roleValidateMatches(matches, step, frameId) {
  if (!Array.isArray(matches)) throw roleFailure('ROLE_CLICK_PROBE', `Frame ${frameId} returned a malformed match list`, { frameId })
  for (const match of matches) {
    if (!match || match.role !== step.role || match.name !== step.name || typeof match.identity !== 'string'
      || !Number.isFinite(match.x) || !Number.isFinite(match.y) || !match.state || typeof match.state !== 'object') {
      throw roleFailure('ROLE_CLICK_PROBE', `Frame ${frameId} returned an invalid exact role/name match`, { frameId })
    }
  }
}

async function roleProbeFrames(context, step, next, deadlineStep) {
  roleRemaining(context, deadlineStep)
  let frames
  try {
    frames = await context.driver.listFrames(context.tab.id)
  } catch (error) {
    throw roleDriverError('ROLE_CLICK_FRAMES', error)
  }
  if (!Array.isArray(frames) || frames.length === 0 || frames.some(frame => !Number.isSafeInteger(frame?.frameId) || frame.frameId < 0)) {
    throw roleFailure('ROLE_CLICK_FRAMES', 'The driver must return every frame with a valid frameId')
  }
  const ids = new Set(frames.map(frame => frame.frameId))
  if (ids.size !== frames.length || !ids.has(0)) {
    throw roleFailure('ROLE_CLICK_FRAMES', 'The frame list must be unique and include top frame 0')
  }
  if (frames.some(frame => frame.errorOccurred === true)) {
    throw roleFailure('ROLE_CLICK_FRAMES', 'A frame reported a navigation or loading error; no target was clicked')
  }
  const request = { role: step.role, name: step.name, ...(next ? { next } : {}) }
  const timeoutMs = Math.max(1, roleRemaining(context, deadlineStep))
  const outcomes = await Promise.all(frames.map(async frame => {
    try {
      const result = await context.driver.runInFrame(context.tab.id, frame.frameId, roleClickProbe, [request], timeoutMs)
      return { frame, result }
    } catch (error) {
      return { frame, error }
    }
  }))
  roleRemaining(context, deadlineStep)
  const matches = []
  const nextMatches = []
  let surfaceCount = 0
  let topUrl
  for (const outcome of outcomes) {
    const frameId = outcome.frame.frameId
    if (outcome.error) throw roleDriverError('ROLE_CLICK_FRAME_PROBE', outcome.error, { frameId })
    const result = outcome.result
    if (!result || result.ok !== true) {
      throw roleFailure(result?.code ?? 'ROLE_CLICK_FRAME_PROBE', result?.message ?? `Frame ${frameId} returned no probe result`, { frameId })
    }
    roleValidateMatches(result.matches, step, frameId)
    if (next) roleValidateMatches(result.nextMatches, next, frameId)
    else if (!Array.isArray(result.nextMatches)) throw roleFailure('ROLE_CLICK_PROBE', `Frame ${frameId} returned malformed next matches`, { frameId })
    if (!Number.isFinite(result.surfaceCount) || result.surfaceCount < 0 || typeof result.url !== 'string') {
      throw roleFailure('ROLE_CLICK_PROBE', `Frame ${frameId} returned malformed page state`, { frameId })
    }
    for (const match of result.matches) matches.push({ ...match, frameId, frame: outcome.frame })
    for (const match of result.nextMatches ?? []) nextMatches.push({ ...match, frameId, frame: outcome.frame })
    surfaceCount += result.surfaceCount
    if (frameId === 0) topUrl = result.url
  }
  return { matches, nextMatches, surfaceCount, url: topUrl, frames }
}

function rolePoint(candidate) {
  if (candidate.frameId === 0 || candidate.coordinateSpace === 'top') return { x: candidate.x, y: candidate.y }
  const { viewportX, viewportY } = candidate.frame
  if (!Number.isFinite(viewportX) || !Number.isFinite(viewportY)) {
    throw roleFailure('ROLE_CLICK_FRAME_COORDINATES', `Frame ${candidate.frameId} has no verified top-viewport coordinate offset`, { frameId: candidate.frameId })
  }
  return { x: candidate.x + viewportX, y: candidate.y + viewportY }
}

function roleAncestorIds(found, candidate) {
  if (candidate.frameId === 0) return []
  const frames = new Map(found.frames.map(frame => [frame.frameId, frame]))
  const ancestors = []
  const seen = new Set([candidate.frameId])
  let current = candidate.frame
  while (current.frameId !== 0) {
    const parentFrameId = current.parentFrameId ?? 0
    if (!Number.isSafeInteger(parentFrameId) || parentFrameId < 0 || seen.has(parentFrameId) || !frames.has(parentFrameId)) {
      throw roleFailure('ROLE_CLICK_FRAME_OWNERSHIP', `Frame ${candidate.frameId} has no verified ancestor chain`, { frameId: candidate.frameId })
    }
    ancestors.unshift(parentFrameId)
    seen.add(parentFrameId)
    current = frames.get(parentFrameId)
    if (ancestors.length > found.frames.length) {
      throw roleFailure('ROLE_CLICK_FRAME_OWNERSHIP', `Frame ${candidate.frameId} has a cyclic ancestor chain`, { frameId: candidate.frameId })
    }
  }
  return ancestors
}

async function roleVerifyOwnership(context, found, candidate, deadlineStep) {
  if (candidate.frameId === 0) return
  const token = candidate.frame?.ownershipToken
  if (typeof token !== 'string' || !token) {
    throw roleFailure('ROLE_CLICK_FRAME_OWNERSHIP', `Frame ${candidate.frameId} has no source-verified iframe chain`, { frameId: candidate.frameId })
  }
  for (const frameId of roleAncestorIds(found, candidate)) {
    roleRemaining(context, deadlineStep)
    let result
    try {
      result = await context.driver.runInFrame(
        context.tab.id,
        frameId,
        roleClickFrameOwnershipProbe,
        [{ token, targetFrameId: candidate.frameId, x: candidate.x, y: candidate.y }],
        Math.max(1, roleRemaining(context, deadlineStep)),
      )
    } catch (error) {
      throw roleDriverError('ROLE_CLICK_FRAME_OWNERSHIP', error, { frameId: candidate.frameId })
    }
    if (!result || result.ok !== true) {
      throw roleFailure(result?.code ?? 'ROLE_CLICK_FRAME_OWNERSHIP', result?.message ?? `Frame ${frameId} returned no ownership result`, { frameId: candidate.frameId })
    }
    if (result.owned !== true) {
      throw roleFailure('ROLE_CLICK_COVERED', `An ancestor or top-level element covers or clips ${JSON.stringify(candidate.name)}`, { frameId: candidate.frameId })
    }
  }
  roleRemaining(context, deadlineStep)
}

async function roleUsableCandidate(context, found, step, deadlineStep) {
  if (found.matches.length > 1) {
    throw roleFailure('ROLE_CLICK_AMBIGUOUS', `Found ${found.matches.length} visible ${step.role} elements named ${JSON.stringify(step.name)}`, { matchCount: found.matches.length })
  }
  if (found.matches.length === 0) return undefined
  const candidate = found.matches[0]
  if (candidate.editor) throw roleFailure('ROLE_CLICK_EDITOR', 'Editor, canvas, and document-content targets are not supported')
  if (candidate.disabled) throw roleFailure('ROLE_CLICK_DISABLED', `The ${step.role} ${JSON.stringify(step.name)} is disabled`)
  if (candidate.covered) throw roleFailure('ROLE_CLICK_COVERED', `Another interactive element owns the center of ${JSON.stringify(step.name)}`)
  candidate.point = rolePoint(candidate)
  await roleVerifyOwnership(context, found, candidate, deadlineStep)
  return candidate
}

async function roleRevalidateCandidate(context, before, step, next, deadlineStep) {
  await roleAssertStable(context)
  roleRemaining(context, deadlineStep)
  const found = await roleProbeFrames(context, step, next, deadlineStep)
  if (found.url !== context.initialUrl) {
    throw roleFailure('ROLE_CLICK_STALE_NAVIGATION', 'The top frame URL changed after hover', { navigated: true })
  }
  if (found.matches.length !== 1) {
    throw roleFailure('ROLE_CLICK_STALE_TARGET', 'The exact unique role target changed after hover; no mouse press was sent')
  }
  const candidate = await roleUsableCandidate(context, found, step, deadlineStep)
  const previous = before.candidate
  if (candidate.frameId !== previous.frameId || candidate.identity !== previous.identity
    || candidate.role !== step.role || candidate.name !== step.name
    || candidate.x !== previous.x || candidate.y !== previous.y
    || candidate.point.x !== previous.point.x || candidate.point.y !== previous.point.y) {
    throw roleFailure('ROLE_CLICK_STALE_TARGET', 'The role target identity, name, role, or position changed after hover; no mouse press was sent')
  }
  await roleAssertStable(context)
  roleRemaining(context, deadlineStep)
  return true
}

async function roleWaitForTarget(context, step, next, deadlineStep) {
  const wait = async () => {
    for (;;) {
      await roleAssertStable(context)
      roleRemaining(context, deadlineStep)
      const found = await roleProbeFrames(context, step, next, deadlineStep)
      if (found.url !== context.initialUrl) {
        throw roleFailure('ROLE_CLICK_STALE_NAVIGATION', 'The top frame URL changed during target resolution', { navigated: true })
      }
      const candidate = await roleUsableCandidate(context, found, step, deadlineStep)
      if (candidate) return { ...found, candidate }
      if (roleNow(context) >= Math.min(context.deadline, deadlineStep.deadline)) {
        throw roleFailure('ROLE_CLICK_NOT_FOUND', `No visible ${step.role} named ${JSON.stringify(step.name)} appeared within 3s`)
      }
      await context.driver.sleep(Math.min(ROLE_CLICK_POLL_MS, roleRemaining(context, deadlineStep)))
    }
  }
  return roleBounded(
    wait(),
    roleRemaining(context, deadlineStep),
    () => { deadlineStep.cancelled = true },
    roleFailure('ROLE_CLICK_NOT_FOUND', `No visible ${step.role} named ${JSON.stringify(step.name)} appeared within 3s`),
  )
}

function roleStateSignature(candidate) {
  const state = candidate.state ?? {}
  return JSON.stringify([
    state.checked,
    state.selected,
    state.expanded,
    state.pressed,
    state.current,
    candidate.disabled === true,
    candidate.covered === true,
  ])
}

export function roleClickTransition(before, after) {
  const previous = before.candidate
  const current = after.matches.find(match => match.frameId === previous.frameId && match.identity === previous.identity)
  if (!current) return true
  if (roleStateSignature(current) !== roleStateSignature(previous)) return true
  if (after.surfaceCount > before.surfaceCount) return true
  return before.nextMatches.length === 0 && after.nextMatches.length > 0
}

async function roleVerifyClick(context, before, step, next, final, deadlineStep) {
  for (;;) {
    const observed = await roleObserve(context)
    if (observed.navigated) {
      if (final) return { verified: true, navigated: true }
      throw roleFailure('ROLE_CLICK_INTERMEDIATE_NAVIGATION', 'An intermediate path step navigated; later steps were not clicked', { navigated: true })
    }
    roleRemaining(context, deadlineStep)
    const after = await roleProbeFrames(context, step, next, deadlineStep)
    const current = await roleObserve(context)
    if (current.navigated || after.url !== context.initialUrl) {
      if (final) return { verified: true, navigated: true }
      throw roleFailure('ROLE_CLICK_INTERMEDIATE_NAVIGATION', 'An intermediate path step navigated; later steps were not clicked', { navigated: true })
    }
    if (roleClickTransition(before, after)) return { verified: true, navigated: false }
    if (roleNow(context) >= Math.min(context.deadline, deadlineStep.deadline)) {
      return { verified: false, navigated: false }
    }
    await context.driver.sleep(Math.min(ROLE_CLICK_POLL_MS, roleRemaining(context, deadlineStep)))
  }
}

async function roleSettleFinal(context) {
  const quietDeadline = roleNow(context) + ROLE_CLICK_FINAL_QUIET_MS
  let navigated = false
  for (;;) {
    const observed = await roleObserve(context)
    navigated = observed.navigated || navigated
    context.finalNavigated = navigated
    const remaining = quietDeadline - roleNow(context)
    if (remaining <= 0) break
    await context.driver.sleep(Math.min(25, remaining))
  }
  if (!navigated) return { navigated: false }
  const loadDeadline = roleNow(context) + ROLE_CLICK_NAVIGATION_LOAD_MS
  for (;;) {
    const observed = await roleObserve(context)
    const current = observed.current ?? observed.active
    const active = observed.active ?? observed.current
    const loading = current?.status === 'loading' || active?.status === 'loading'
    const sameUrl = !current || !active || (current.url ?? '') === (active.url ?? '')
    if (!loading && sameUrl) return { navigated: true }
    const remaining = loadDeadline - roleNow(context)
    if (remaining <= 0) return { navigated: true }
    await context.driver.sleep(Math.min(ROLE_CLICK_POLL_MS, remaining))
  }
}

async function roleClickStep(context, path, index, deadlineStep, attempt) {
  const step = path[index]
  const next = index < path.length - 1 ? path[index + 1] : undefined
  const final = index === path.length - 1
  const before = await roleWaitForTarget(context, step, next, deadlineStep)
  await roleAssertStable(context)
  roleRemaining(context, deadlineStep)
  try {
    await context.driver.withDebugger(context.tab.id, async () => {
      roleRemaining(context, deadlineStep)
      attempt.inputPending = true
      try {
        await context.driver.trustedClick(context.tab.id, before.candidate.point.x, before.candidate.point.y, {
          beforePress: () => roleRevalidateCandidate(context, before, step, next, deadlineStep),
          onPress: () => { attempt.dispatchAttempted = true },
        })
      } finally {
        attempt.inputPending = false
      }
    })
    roleRemaining(context, deadlineStep)
  } catch (error) {
    if (error?.code === 'ROLE_CLICK_UNSETTLED') {
      attempt.unsettled = true
      throw roleFailure('ROLE_CLICK_UNSETTLED', error instanceof Error ? error.message : String(error), {
        dispatchAttempted: attempt.dispatchAttempted,
        unsettled: true,
      })
    }
    if (attempt.dispatchAttempted) await context.driver.invalidateTab(context.tab.id)
    if (attempt.dispatchAttempted) {
      const observed = await roleObserve(context)
      if (observed.navigated) {
        if (!final) throw roleFailure('ROLE_CLICK_INTERMEDIATE_NAVIGATION', 'An intermediate path step navigated; later steps were not clicked', { navigated: true })
        throw roleDriverError('ROLE_CLICK_INPUT', error, { navigated: true })
      }
    }
    throw roleDriverError('ROLE_CLICK_INPUT', error)
  }
  await context.driver.invalidateTab(context.tab.id)
  if (final) return { navigated: false }
  const verified = await roleVerifyClick(context, before, step, next, final, deadlineStep)
  if (!verified.verified) {
    throw roleFailure('ROLE_CLICK_UNVERIFIED', 'Click dispatch did not produce an observable target, menu, dialog, or navigation transition')
  }
  return { navigated: verified.navigated }
}

function roleFailureResult(error, index, step, attempt) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'ROLE_CLICK_FAILED',
    message: error instanceof Error ? error.message : String(error),
    index,
    role: step.role,
    name: step.name,
    ...(Number.isSafeInteger(error?.frameId) ? { frameId: error.frameId } : {}),
    ...(Number.isSafeInteger(error?.matchCount) ? { matchCount: error.matchCount } : {}),
    ...(attempt.dispatchAttempted ? { dispatchAttempted: true } : {}),
  }
}

async function roleFinish(context, path, completed, failure, navigated) {
  const roleClick = {
    status: completed === path.length && !failure ? 'completed' : 'partial',
    completed,
    path: path.slice(0, completed),
    ...(failure ? { failure } : {}),
  }
  let shot
  try {
    shot = await roleBounded(
      context.driver.snapshot(context.settings, context.snapshotTab),
      ROLE_CLICK_SNAPSHOT_MS,
      () => {},
      roleFailure('ROLE_CLICK_SNAPSHOT', 'The final view did not arrive within 4s'),
    )
  } catch (error) {
    const normalized = roleDriverError('ROLE_CLICK_SNAPSHOT', error)
    return {
      op: 'click_role',
      navigated,
      view: 'unavailable',
      viewUnavailable: { code: normalized.code, message: normalized.message },
      roleClick,
    }
  }
  return { ...shot, op: 'click_role', navigated, roleClick }
}

async function roleClickMain(context, path) {
  let windowId
  let tab
  try {
    windowId = await context.driver.getWindowId()
    tab = await context.driver.getActiveTab(windowId)
    if (tab?.id === undefined) throw roleFailure('ROLE_CLICK_TAB', 'There is no active tab')
    context.driver.assertCapturable(tab)
  } catch (error) {
    throw roleDriverError('ROLE_CLICK_TAB', error)
  }
  Object.assign(context, { windowId, tab, initialUrl: tab.url ?? '', snapshotTab: tab })
  let completed = 0
  let failure
  let navigated = false
  for (let index = 0; index < path.length; index += 1) {
    const attempt = { dispatchAttempted: false, inputPending: false }
    const deadlineStep = {
      index,
      deadline: Math.min(context.deadline, roleNow(context) + ROLE_CLICK_STEP_MS),
      cancelled: false,
    }
    try {
      const remaining = Math.min(ROLE_CLICK_STEP_MS, roleRemaining(context))
      const outcome = await roleBounded(
        roleClickStep(context, path, index, deadlineStep, attempt),
        remaining,
        () => { deadlineStep.cancelled = true },
        roleFailure('ROLE_CLICK_STEP_TIMEOUT', `Path step ${index + 1} exceeded its 3s deadline`, { index }),
        attempt,
      )
      completed += 1
      navigated = outcome.navigated || navigated
    } catch (error) {
      const normalized = roleDriverError('ROLE_CLICK_FAILED', error, { index })
      failure = roleFailureResult(normalized, index, path[index], attempt)
      navigated = normalized.navigated === true || navigated
      if (failure.code === 'ROLE_CLICK_UNSETTLED') {
        throw roleFailure(failure.code, failure.message, {
          ...failure,
          completed,
          path: path.slice(0, completed),
          unsettled: true,
          ...(navigated ? { navigated: true } : {}),
        })
      }
      break
    }
  }
  if (!failure) {
    context.finalNavigated = false
    try {
      const settled = await roleBounded(
        roleSettleFinal(context),
        ROLE_CLICK_FINAL_QUIET_MS + ROLE_CLICK_NAVIGATION_LOAD_MS + 500,
        () => {},
        roleFailure('ROLE_CLICK_NAVIGATION_SETTLE', 'The final navigation did not settle within its bounded wait'),
      )
      navigated = settled.navigated || navigated
    } catch {
      navigated = context.finalNavigated === true || navigated
    }
  }
  if (failure && completed === 0 && !failure.dispatchAttempted) {
    throw roleFailure(failure.code, failure.message, {
      ...failure,
      ...(navigated ? { navigated: true } : {}),
    })
  }
  return roleFinish(context, path, completed, failure, navigated)
}

export async function clickRole(settings, args, io = {}) {
  const path = parseRoleClickArgs(args)
  const driver = roleDriver(io)
  const started = Number(driver.now())
  const context = {
    settings,
    driver,
    started: Number.isFinite(started) ? started : Date.now(),
    deadline: 0,
    cancelled: false,
  }
  context.deadline = context.started + ROLE_CLICK_TOTAL_MS
  return roleClickMain(context, path)
}
