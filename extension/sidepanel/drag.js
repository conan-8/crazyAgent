const DRAG_DEFAULT_HOLD_MS = 60
const DRAG_DEFAULT_SETTLE_MS = 150
const DRAG_ACTIVATION_PX = 6
const DRAG_MAX_HOLD_MS = 3_000
const DRAG_MAX_SETTLE_MS = 2_000
const DRAG_SELECTION_LIMIT = 100_000
const DRAG_BOUNDS_TOLERANCE_PX = 0
const DRAG_POSITIONS = new Set(['center', 'top', 'right', 'bottom', 'left'])
const DRAG_KEYS = new Set([
  'label', 'ref', 'x', 'y',
  'to_label', 'to_ref', 'to_x', 'to_y', 'dx', 'dy', 'to_position',
  'hold', 'hold_ms', 'settle_ms',
])

export class DragError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DragError'
    this.code = code
    Object.assign(this, details)
  }
}

function dragFailure(code, message, details = {}) {
  if (code === 'BAD_DRAG' && details.mutationPossible === undefined) details = { ...details, mutationPossible: false }
  return new DragError(code, message, details)
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function dragLabel(value, name, allowRef = false) {
  if (Number.isSafeInteger(value) && value > 0) return value
  if (allowRef && typeof value === 'string') {
    const text = value.trim()
    if (/^e?[1-9]\d*$/u.test(text)) {
      const parsed = Number(text.startsWith('e') ? text.slice(1) : text)
      if (Number.isSafeInteger(parsed)) return parsed
    }
  }
  throw dragFailure('BAD_DRAG', `${name} must be a positive current-view label${allowRef ? ' or ref (for example 12, "12", or "e12")' : ''}`)
}

function boundedMs(value, fallback, maximum, name) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw dragFailure('BAD_DRAG', `${name} must be an integer from 0 to ${maximum}`)
  }
  return value
}

export function parseDragArgs(args = {}) {
  if (!record(args) || Object.keys(args).some(key => !DRAG_KEYS.has(key))) {
    throw dragFailure('BAD_DRAG', 'drag accepts only label/ref or x/y, one destination, optional to_position, hold/hold_ms, and settle_ms')
  }
  const sourceSelectors = ['label', 'ref', 'x', 'y'].filter(key => args[key] !== undefined)
  const hasSourcePoint = args.x !== undefined || args.y !== undefined
  const sourceKinds = Number(args.label !== undefined || args.ref !== undefined) + Number(hasSourcePoint)
  if (sourceKinds !== 1 || (args.label !== undefined && args.ref !== undefined)) {
    throw dragFailure('DRAG_SOURCE_AMBIGUOUS', 'Provide exactly one drag source: label, ref, or x/y; no drag was dispatched', { mutationPossible: false })
  }
  if (hasSourcePoint && sourceSelectors.filter(key => key === 'x' || key === 'y').length !== 2) {
    throw dragFailure('BAD_DRAG', 'A coordinate drag source requires both finite x and y', { mutationPossible: false })
  }
  const source = hasSourcePoint
    ? { x: args.x, y: args.y }
    : { label: dragLabel(args.label ?? args.ref, args.label !== undefined ? 'label' : 'ref', args.ref !== undefined) }
  if (hasSourcePoint && (!finite(source.x) || !finite(source.y))) {
    throw dragFailure('BAD_DRAG', 'A coordinate drag source requires both finite x and y', { mutationPossible: false })
  }

  const hasDestinationLabel = args.to_label !== undefined || args.to_ref !== undefined
  const hasDestinationPoint = args.to_x !== undefined || args.to_y !== undefined
  const hasDelta = args.dx !== undefined || args.dy !== undefined
  if (Number(hasDestinationLabel) + Number(hasDestinationPoint) + Number(hasDelta) !== 1
    || (args.to_label !== undefined && args.to_ref !== undefined)) {
    throw dragFailure('DRAG_DESTINATION_AMBIGUOUS', 'Provide exactly one destination: to_label, to_ref, to_x/to_y, or dx/dy; no drag was dispatched', { mutationPossible: false })
  }
  let destination
  if (hasDestinationLabel) {
    destination = {
      label: dragLabel(args.to_label ?? args.to_ref, args.to_label !== undefined ? 'to_label' : 'to_ref', args.to_ref !== undefined),
      position: args.to_position ?? 'center',
    }
    if (typeof destination.position !== 'string' || !DRAG_POSITIONS.has(destination.position)) {
      throw dragFailure('BAD_DRAG', 'to_position must be center, top, right, bottom, or left', { mutationPossible: false })
    }
  } else if (hasDestinationPoint) {
    if (args.to_x === undefined || args.to_y === undefined || !finite(args.to_x) || !finite(args.to_y)) {
      throw dragFailure('BAD_DRAG', 'A coordinate destination requires both finite to_x and to_y', { mutationPossible: false })
    }
    destination = { x: args.to_x, y: args.to_y }
  } else {
    const dx = args.dx ?? 0
    const dy = args.dy ?? 0
    if (!finite(dx) || !finite(dy)) throw dragFailure('BAD_DRAG', 'dx and dy must be finite numbers', { mutationPossible: false })
    destination = { dx, dy }
  }
  if (!hasDestinationLabel && args.to_position !== undefined) {
    throw dragFailure('BAD_DRAG', 'to_position is valid only with to_label or to_ref', { mutationPossible: false })
  }
  if (args.hold !== undefined && args.hold_ms !== undefined) {
    throw dragFailure('BAD_DRAG', 'Use only one of hold and hold_ms', { mutationPossible: false })
  }
  return {
    source,
    destination,
    holdMs: boundedMs(args.hold_ms ?? args.hold, DRAG_DEFAULT_HOLD_MS, DRAG_MAX_HOLD_MS, 'hold_ms'),
    settleMs: boundedMs(args.settle_ms, DRAG_DEFAULT_SETTLE_MS, DRAG_MAX_SETTLE_MS, 'settle_ms'),
  }
}

export function docsDragError(url) {
  if (!/^https:\/\/docs\.google\.com\/document(?:\/|$|\?)/u.test(String(url ?? ''))) return undefined
  return dragFailure(
    'DOCS_CANVAS_SELECT_UNSUPPORTED',
    'Google Docs drag selection is disabled because it can move text instead of selecting. Use browser_docs_select_text, browser_docs_replace, or browser_docs_format instead; no drag was dispatched.',
    { mutationPossible: false },
  )
}

function sameValue(left, right) {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right)
}

function boundsChanged(before, after) {
  return ['left', 'top', 'right', 'bottom', 'width', 'height']
    .some(key => Math.abs(Number(after[key]) - Number(before[key])) > DRAG_BOUNDS_TOLERANCE_PX)
}

export function evaluateDragOutcome(before, after) {
  const checks = {}
  const sourceConnected = before?.connected === true && after?.connected === true
  for (const name of ['parent', 'index', 'bounds', 'value', 'ariaValueNow']) {
    if (!sourceConnected) {
      checks[name] = 'unknown'
      continue
    }
    if (name === 'parent') {
      checks.parent = sameValue(before.parent, after.parent) ? 'unchanged' : 'changed'
    } else if (name === 'index') {
      checks.index = Number.isSafeInteger(before.index) && Number.isSafeInteger(after.index)
        ? before.index === after.index ? 'unchanged' : 'changed'
        : 'unknown'
    } else if (name === 'bounds') {
      const valid = box => record(box) && ['left', 'top', 'right', 'bottom', 'width', 'height'].every(key => finite(box[key]))
      checks.bounds = !valid(before.bounds) || !valid(after.bounds)
        ? 'unknown'
        : boundsChanged(before.bounds, after.bounds) ? 'changed' : 'unchanged'
    } else {
      const left = before[name]
      const right = after[name]
      if (left?.measured !== true && right?.measured !== true) checks[name] = 'not-applicable'
      else if (left?.measured !== true || right?.measured !== true) checks[name] = 'unknown'
      else checks[name] = sameValue(left.value, right.value) ? 'unchanged' : 'changed'
    }
  }
  const beforeSelection = before?.selection
  const afterSelection = after?.selection
  if (beforeSelection?.measured !== true || afterSelection?.measured !== true) {
    checks.selection = 'unknown'
  } else if (afterSelection.collapsed !== false) {
    checks.selection = beforeSelection.collapsed === false ? 'changed' : 'unchanged'
  } else if (beforeSelection.collapsed !== false || !sameValue(beforeSelection.signature, afterSelection.signature)) {
    checks.selection = 'changed'
  } else if (beforeSelection.truncated === true || afterSelection.truncated === true) {
    checks.selection = 'unknown'
  } else {
    checks.selection = 'unchanged'
  }
  const signals = Object.entries(checks).filter(([, status]) => status === 'changed').map(([name]) => {
    if (name === 'ariaValueNow') return 'aria-valuenow-changed'
    return `${name.replace(/([A-Z])/gu, letter => `-${letter.toLowerCase()}`)}-changed`
  })
  const unknownChecks = Object.entries(checks).filter(([, status]) => status === 'unknown').map(([name]) => name)
  return {
    changed: signals.length > 0 ? true : unknownChecks.length > 0 ? null : false,
    complete: unknownChecks.length === 0,
    signals,
    checks,
    unknownChecks,
  }
}

export function evaluateDragDestinationOutcome(before, after) {
  const checks = {}
  for (const name of ['children', 'text']) {
    const left = before?.[name]
    const right = after?.[name]
    if (before?.connected !== true || after?.connected !== true || left?.measured !== true || right?.measured !== true) {
      checks[name] = 'unknown'
    } else if (!sameValue(left.signature, right.signature)) {
      checks[name] = 'changed'
    } else if (left.truncated === true || right.truncated === true) {
      checks[name] = 'unknown'
    } else {
      checks[name] = 'unchanged'
    }
  }
  const signals = Object.entries(checks).filter(([, status]) => status === 'changed')
    .map(([name]) => `destination-${name}-changed`)
  const unknownChecks = Object.entries(checks).filter(([, status]) => status === 'unknown').map(([name]) => name)
  return {
    changed: signals.length > 0 ? true : unknownChecks.length > 0 ? null : false,
    complete: unknownChecks.length === 0,
    signals,
    checks,
    unknownChecks,
  }
}

function combineDragOutcomes(source, destination) {
  const signals = [...new Set([...source.signals, ...destination.signals])]
  const unknown = source.changed === null || destination.changed === null
  return {
    changed: signals.length > 0 ? true : unknown ? null : false,
    complete: source.complete && destination.complete,
    signals,
    checks: { source: source.checks, destination: destination.checks },
    unknownChecks: { source: source.unknownChecks, destination: destination.unknownChecks },
  }
}

function normalizeDispatchRequest(request) {
  if (!record(request) || !record(request.from) || !record(request.to)
    || !finite(request.from.x) || !finite(request.from.y) || !finite(request.to.x) || !finite(request.to.y)) {
    throw dragFailure('BAD_DRAG', 'Trusted drag requires finite from and to CSS viewport points', { mutationPossible: false })
  }
  return {
    from: { x: request.from.x, y: request.from.y },
    to: { x: request.to.x, y: request.to.y },
    holdMs: boundedMs(request.holdMs, DRAG_DEFAULT_HOLD_MS, DRAG_MAX_HOLD_MS, 'holdMs'),
    stepMs: boundedMs(request.stepMs, 16, 250, 'stepMs'),
    destinationHoldMs: boundedMs(request.destinationHoldMs, 100, 1_000, 'destinationHoldMs'),
    intercept: request.intercept !== false,
  }
}

export async function dispatchTrustedDrag(rawRequest, io = {}) {
  const request = normalizeDispatchRequest(rawRequest)
  if (typeof io.sendCommand !== 'function' || typeof io.onDragIntercepted !== 'function' || typeof io.sleep !== 'function') {
    throw dragFailure('DRAG_DRIVER', 'Trusted drag requires sendCommand, onDragIntercepted, and sleep dependencies', { mutationPossible: false })
  }
  const send = (method, params) => io.sendCommand(method, params)
  const mouse = (type, point, pressed = false) => send('Input.dispatchMouseEvent', {
    type,
    x: point.x,
    y: point.y,
    button: type === 'mouseMoved' && !pressed ? 'none' : 'left',
    buttons: pressed ? 1 : 0,
    clickCount: type === 'mouseMoved' && !pressed ? 0 : 1,
  })
  const distance = Math.hypot(request.to.x - request.from.x, request.to.y - request.from.y)
  const steps = distance === 0 ? 0 : Math.max(8, Math.min(40, Math.ceil(distance / 24)))
  const at = fraction => ({
    x: request.from.x + (request.to.x - request.from.x) * fraction,
    y: request.from.y + (request.to.y - request.from.y) * fraction,
  })
  const activationDistance = Math.min(DRAG_ACTIVATION_PX, distance)
  const activation = distance === 0 ? request.from : at(activationDistance / distance)
  let current = request.from
  let intercepted = false
  let dragData
  let unsubscribe
  let interceptAttempted = false
  let inputAttempted = false
  let pressAttempted = false
  let released = false
  let movementCount = 0
  let dropDispatched = false
  let dropCancelled = false
  let result
  let failure
  const cleanupErrors = []
  const release = async (point = current) => {
    if (!pressAttempted || released) return
    await mouse('mouseReleased', point)
    released = true
  }
  try {
    if (request.intercept) {
      unsubscribe = io.onDragIntercepted(data => {
        if (intercepted) return
        intercepted = true
        dragData = data
      })
      if (typeof unsubscribe !== 'function') throw dragFailure('DRAG_DRIVER', 'onDragIntercepted must return an unsubscribe function', { mutationPossible: false })
      interceptAttempted = true
      await send('Input.setInterceptDrags', { enabled: true })
    }
    if (typeof io.moveCursor === 'function') await io.moveCursor(request.from, { press: true, maxMs: 300 })
    if (typeof io.beforeHover === 'function') await io.beforeHover()
    inputAttempted = true
    await mouse('mouseMoved', request.from)
    if (typeof io.beforePress === 'function') await io.beforePress()
    pressAttempted = true
    await mouse('mousePressed', request.from, true)
    await io.sleep(request.holdMs)
    if (typeof io.moveCursor === 'function') void io.moveCursor(request.to, { maxMs: Math.max(190, steps * request.stepMs) })
    if (distance > 0) {
      current = activation
      await mouse('mouseMoved', current, true)
      movementCount += 1
      if (!intercepted) await io.sleep(50)
    }
    let nextStep = 1
    if (!intercepted) {
      for (let index = 1; index <= steps; index += 1) {
        const travelled = distance * index / steps
        if (travelled <= activationDistance) continue
        current = at(index / steps)
        await mouse('mouseMoved', current, true)
        movementCount += 1
        nextStep = index + 1
        if (intercepted) break
        await io.sleep(request.stepMs)
      }
    }
    if (!intercepted) {
      if (current.x !== request.to.x || current.y !== request.to.y) {
        current = request.to
        await mouse('mouseMoved', current, true)
        movementCount += 1
      }
      await io.sleep(request.destinationHoldMs)
      if (typeof io.beforeDrop === 'function') await io.beforeDrop()
      await release()
    } else {
      if (!record(dragData) || !Array.isArray(dragData.items)) {
        throw dragFailure('DRAG_INTERCEPT_DATA', 'Chrome intercepted a native drag without usable DataTransfer data; inspect the page before retrying', { mutationPossible: true })
      }
      const drag = (type, point) => send('Input.dispatchDragEvent', { type, x: point.x, y: point.y, data: dragData })
      await drag('dragEnter', current)
      for (let index = nextStep; index <= steps; index += 1) {
        const travelled = distance * index / steps
        if (travelled <= activationDistance) continue
        current = at(index / steps)
        await drag('dragOver', current)
        await io.sleep(request.stepMs)
      }
      if (current.x !== request.to.x || current.y !== request.to.y) {
        current = request.to
        await drag('dragOver', current)
      }
      await io.sleep(request.destinationHoldMs)
      if (typeof io.beforeDrop === 'function') await io.beforeDrop()
      await drag('drop', request.to)
      dropDispatched = true
      await release()
    }
    result = {
      mode: intercepted ? 'html5' : 'pointer',
      intercepted,
      dropDispatched,
      movementCount,
      mouseReleased: released,
    }
  } catch (error) {
    failure = error?.code
      ? error
      : dragFailure('DRAG_INPUT_FAILED', `Trusted drag input failed: ${error instanceof Error ? error.message : String(error)}`, {
        mutationPossible: inputAttempted,
        cause: error,
      })
  } finally {
    if (failure && intercepted && record(dragData)) {
      try {
        await send('Input.dispatchDragEvent', { type: 'dragCancel', x: 0, y: 0, data: dragData })
        dropCancelled = true
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (pressAttempted && !released) {
      try {
        await release({ x: 0, y: 0 })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (interceptAttempted) {
      try {
        await send('Input.setInterceptDrags', { enabled: false })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (typeof unsubscribe === 'function') {
      try {
        unsubscribe()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
  }
  if (failure) {
    if (failure.mutationPossible === undefined) failure.mutationPossible = inputAttempted
    failure.dispatch = {
      ...(failure.dispatch ?? {}),
      mode: intercepted ? 'html5' : 'pointer',
      intercepted,
      dropDispatched,
      dropCancelled,
      movementCount,
      mouseReleased: released,
    }
    if (cleanupErrors.length > 0) failure.cleanupErrors = cleanupErrors
    throw failure
  }
  if (cleanupErrors.length > 0) {
    throw dragFailure('DRAG_CLEANUP_FAILED', 'Drag input finished, but mouse release or drag-interception cleanup failed; inspect the page before retrying', {
      mutationPossible: inputAttempted,
      dispatch: result,
      cleanupErrors,
    })
  }
  return result
}

/** Serialized alone into a frame; all helpers and state are scoped here. */
export function dragProbe(request) {
  const sessions = globalThis.__crazyagentDragSessions ??= new Map()
  if (request.phase === 'cleanup') {
    sessions.delete(request.token)
    return { ok: true }
  }
  const identities = globalThis.__crazyagentDragIdentities ??= { next: 1, elements: new WeakMap() }
  const identity = element => {
    if (!element) return null
    let id = identities.elements.get(element)
    if (!id) {
      id = identities.next
      identities.next += 1
      identities.elements.set(element, id)
    }
    return id
  }
  const deepHit = (x, y) => {
    let hit = document.elementFromPoint(x, y)
    for (let depth = 0; depth < 16 && hit?.shadowRoot && typeof hit.shadowRoot.elementFromPoint === 'function'; depth += 1) {
      const nested = hit.shadowRoot.elementFromPoint(x, y)
      if (!nested || nested === hit) break
      hit = nested
    }
    return hit
  }
  const ownedHit = (element, hit) => {
    const hitHost = hit?.getRootNode?.()?.host
    return Boolean(hit && (hit === element || element.contains(hit) || hit.contains(element) || hitHost === element || element.contains(hitHost)))
  }
  const rectOf = element => {
    const rect = element.getBoundingClientRect()
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    }
  }
  const readSelection = element => {
    try {
      const selection = (element.ownerDocument ?? document).getSelection?.()
      if (!selection) return { measured: false }
      const text = String(selection)
      return {
        measured: true,
        collapsed: selection.isCollapsed !== false,
        signature: JSON.stringify({ length: text.length, text: text.slice(0, 100000), ranges: Number(selection.rangeCount) || 0 }),
        truncated: text.length > 100000,
      }
    } catch {
      return { measured: false }
    }
  }
  const sourceSnapshot = element => {
    const connected = element.isConnected === true
    let bounds = null
    if (connected) {
      try {
        bounds = rectOf(element)
      } catch {}
    }
    let value = { measured: false }
    let ariaValueNow = { measured: false }
    if (connected) {
      try {
        const tag = element.tagName.toLowerCase()
        const type = String(element.type ?? '').toLowerCase()
        if ('value' in element && tag !== 'button' && type !== 'password' && type !== 'file') {
          value = { measured: true, value: String(element.value ?? '') }
        }
      } catch {}
      try {
        ariaValueNow = { measured: true, value: element.getAttribute('aria-valuenow') }
      } catch {}
    }
    return {
      connected,
      parent: connected ? identity(element.parentElement) : null,
      index: connected && element.parentElement ? Array.from(element.parentElement.children).indexOf(element) : -1,
      bounds,
      value,
      ariaValueNow,
      selection: readSelection(element),
    }
  }
  const destinationSnapshot = element => {
    const connected = element.isConnected === true
    if (!connected) return { connected, children: { measured: false }, text: { measured: false } }
    try {
      const children = Array.from(element.children ?? [])
      const text = String(element.textContent ?? '').replace(/\s+/gu, ' ').trim()
      return {
        connected,
        children: {
          measured: true,
          signature: JSON.stringify(children.map(child => identity(child))),
          truncated: false,
        },
        text: {
          measured: true,
          signature: JSON.stringify({ length: text.length, text: text.slice(0, 100000) }),
          truncated: text.length > 100000,
        },
      }
    } catch {
      return { connected, children: { measured: false }, text: { measured: false } }
    }
  }
  if (request.phase === 'after') {
    const session = sessions.get(request.token)
    if (!session?.source && !session?.destination) return { ok: false, code: 'DRAG_MEASURE_STALE', message: 'The drag measurement session is no longer available.' }
    const source = session.source ? sourceSnapshot(session.source.element) : null
    return {
      ok: true,
      snapshot: source,
      source,
      destination: session.destination ? destinationSnapshot(session.destination.element) : { connected: false },
    }
  }
  if (request.phase === 'revalidate') {
    const entry = sessions.get(request.token)?.[request.side]
    if (!entry?.element || entry.element.isConnected !== true) {
      return { ok: false, code: 'DRAG_STALE_TARGET', message: `The ${request.side} element was replaced during the drag.` }
    }
    if (request.exact === true) {
      let rect
      try {
        rect = rectOf(entry.element)
      } catch {
        return { ok: false, code: 'DRAG_STALE_TARGET', message: `The ${request.side} element is no longer measurable.` }
      }
      const moved = ['left', 'top', 'right', 'bottom', 'width', 'height']
        .some(key => Math.abs(Number(rect[key]) - Number(entry.rect[key])) > 1)
      if (moved || !ownedHit(entry.element, deepHit(entry.x, entry.y))) {
        return { ok: false, code: 'DRAG_STALE_TARGET', message: `The ${request.side} element moved or became covered before input completed.` }
      }
    }
    return { ok: true }
  }
  if (request.phase !== 'prepare') return { ok: false, code: 'DRAG_PROBE', message: 'Unknown drag probe phase.' }
  let element
  if (request.localId !== undefined) {
    const state = globalThis.__crazyagent
    element = state?.byId?.get(request.localId)
    if (!element) return { ok: false, code: 'UNKNOWN_LABEL', message: `Label ${request.localId} is not in the current view. Take a fresh screenshot.` }
    if (!element.isConnected) return { ok: false, code: 'DETACHED', message: `Label ${request.localId} no longer exists. Take a fresh screenshot.` }
  } else {
    element = deepHit(request.x, request.y)
    if (!element) return { ok: false, code: 'DRAG_TARGET_NOT_FOUND', message: `No element exists at the ${request.side} coordinates.` }
  }
  if (element.disabled === true || element.getAttribute('aria-disabled') === 'true' || element.matches?.(':disabled')) {
    return { ok: false, code: 'DISABLED', message: `The ${request.side} target is disabled; no drag was dispatched.` }
  }
  let rect
  try {
    rect = rectOf(element)
  } catch {
    return { ok: false, code: 'NOT_VISIBLE', message: `The ${request.side} target has no measurable visible box; no drag was dispatched.` }
  }
  if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width < 1 || rect.height < 1) {
    return { ok: false, code: 'NOT_VISIBLE', message: `The ${request.side} target has no measurable visible box; no drag was dispatched.` }
  }
  const position = request.position ?? 'center'
  const insetX = Math.min(8, rect.width / 4)
  const insetY = Math.min(8, rect.height / 4)
  const labelledPoint = {
    x: position === 'left' ? rect.left + insetX : position === 'right' ? rect.right - insetX : rect.left + rect.width / 2,
    y: position === 'top' ? rect.top + insetY : position === 'bottom' ? rect.bottom - insetY : rect.top + rect.height / 2,
  }
  const point = request.localId === undefined ? { x: request.x, y: request.y } : labelledPoint
  if (![point.x, point.y].every(Number.isFinite) || point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom
    || point.x < 0 || point.y < 0 || point.x >= window.innerWidth || point.y >= window.innerHeight) {
    return { ok: false, code: 'DRAG_OFF_SCREEN', message: `The ${request.side} point is clipped or outside the current viewport. Take a fresh view; no drag was dispatched.` }
  }
  if (!ownedHit(element, deepHit(point.x, point.y))) {
    return { ok: false, code: 'OBSCURED', message: `Another element covers the ${request.side} point; no drag was dispatched.` }
  }
  const session = sessions.get(request.token) ?? {}
  session[request.side] = { element, x: point.x, y: point.y, rect: { ...rect } }
  sessions.set(request.token, session)
  const text = String(element.getAttribute('aria-label') ?? element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 120)
  let native = false
  if (request.side === 'source') {
    const draggable = element.closest?.('[draggable]')
    if (draggable) native = draggable.draggable === true
    else if (element.closest?.('a[href],img')) native = true
    else {
      const selection = (element.ownerDocument ?? document).getSelection?.()
      native = Boolean(selection && selection.isCollapsed === false && selection.containsNode?.(element, true))
    }
  }
  return {
    ok: true,
    x: point.x,
    y: point.y,
    coordinateSpace: window === window.top ? 'top' : 'frame',
    viewport: { width: window.innerWidth, height: window.innerHeight },
    target: { id: identity(element), tag: element.tagName.toLowerCase(), text, native },
    before: request.side === 'source' ? sourceSnapshot(element) : destinationSnapshot(element),
  }
}

let nextDragToken = 1

function labelTarget(tab, label, side, io) {
  if (typeof io.resolveLabelTarget !== 'function') {
    throw dragFailure('DRAG_DRIVER', 'Label drags require resolveLabelTarget', { mutationPossible: false })
  }
  const resolved = io.resolveLabelTarget(tab, label)
  if (Array.isArray(resolved)) {
    if (resolved.length === 0) throw dragFailure('DRAG_TARGET_NOT_FOUND', `The ${side} label ${label} was not found; take a fresh view.`, { mutationPossible: false })
    throw dragFailure('DRAG_TARGET_AMBIGUOUS', `The ${side} label ${label} resolved to ${resolved.length} targets; take a fresh view instead of choosing one.`, { mutationPossible: false })
  }
  if (!record(resolved) || !Number.isSafeInteger(resolved.frameId) || resolved.frameId < 0
    || !Number.isSafeInteger(resolved.localId) || resolved.localId <= 0) {
    throw dragFailure('DRAG_TARGET_NOT_FOUND', `The ${side} label ${label} is not in the current view; take a fresh screenshot.`, { mutationPossible: false })
  }
  return resolved
}

async function prepareTarget(tab, target, side, token, io) {
  const request = target.localId === undefined
    ? { phase: 'prepare', side, token, x: target.x, y: target.y }
    : { phase: 'prepare', side, token, localId: target.localId, position: target.position }
  const result = await io.runInFrame(tab.id, target.frameId, dragProbe, [request], 4_000)
  if (!result?.ok) {
    throw dragFailure(result?.code ?? 'DRAG_PROBE_FAILED', result?.message ?? `The ${side} target could not be resolved; no drag was dispatched.`, { mutationPossible: false })
  }
  return { ...result, frameId: target.frameId }
}

async function topPoint(prepared, point, io) {
  if (prepared.frameId === 0) return { x: point.x, y: point.y }
  if (typeof io.framePointToTop !== 'function') {
    throw dragFailure('DRAG_FRAME_UNSUPPORTED', 'This drag crosses a child frame, but no frame-to-top coordinate mapper is installed; no drag was dispatched.', { mutationPossible: false })
  }
  const mapped = await io.framePointToTop(prepared.frameId, point)
  if (!record(mapped) || !finite(mapped.x) || !finite(mapped.y)) {
    throw dragFailure('DRAG_FRAME_UNSUPPORTED', 'The child-frame drag point could not be mapped to top-frame CSS coordinates; no drag was dispatched.', { mutationPossible: false })
  }
  return { x: mapped.x, y: mapped.y }
}

function assertInsideViewport(point, viewport) {
  if (!finite(point.x) || !finite(point.y) || point.x < 0 || point.y < 0
    || point.x >= viewport.width || point.y >= viewport.height) {
    throw dragFailure('DRAG_OFF_SCREEN', 'A drag endpoint is outside the current viewport. Take a fresh view; no drag was dispatched.', { mutationPossible: false })
  }
}

async function revalidateTarget(tab, prepared, side, token, exact, mutationPossible, io) {
  const result = await io.runInFrame(tab.id, prepared.frameId, dragProbe, [{
    phase: 'revalidate', side, token, exact,
  }], 2_000)
  if (!result?.ok) {
    throw dragFailure(result?.code ?? 'DRAG_STALE_TARGET', result?.message ?? `The ${side} target changed before input completed.`, { mutationPossible })
  }
}

export async function executeDrag(args, io = {}) {
  const request = parseDragArgs(args)
  if (typeof io.getActiveTab !== 'function' || typeof io.runInFrame !== 'function'
    || typeof io.withDebugger !== 'function' || typeof io.sendCommand !== 'function'
    || typeof io.onDragIntercepted !== 'function' || typeof io.sleep !== 'function') {
    throw dragFailure('DRAG_DRIVER', 'executeDrag requires active-tab, frame probe, debugger, CDP, interception, and sleep dependencies', { mutationPossible: false })
  }
  const tab = await io.getActiveTab()
  await io.assertCapturable?.(tab)
  const docsError = docsDragError(tab.url)
  if (docsError) throw docsError
  const token = `drag-${Date.now()}-${nextDragToken++}`
  const cleanupFrames = new Set()
  let dispatch
  try {
    const sourceTarget = request.source.label === undefined
      ? { frameId: 0, x: request.source.x, y: request.source.y }
      : labelTarget(tab, request.source.label, 'source', io)
    cleanupFrames.add(sourceTarget.frameId)
    const source = await prepareTarget(tab, sourceTarget, 'source', token, io)
    const from = await topPoint(source, source, io)
    let destinationTarget
    if (request.destination.label !== undefined) {
      destinationTarget = {
        ...labelTarget(tab, request.destination.label, 'destination', io),
        position: request.destination.position,
      }
    } else if (request.destination.x !== undefined) {
      destinationTarget = { frameId: 0, x: request.destination.x, y: request.destination.y }
    } else {
      destinationTarget = {
        frameId: source.frameId,
        x: source.x + request.destination.dx,
        y: source.y + request.destination.dy,
      }
    }
    cleanupFrames.add(destinationTarget.frameId)
    const destination = await prepareTarget(tab, destinationTarget, 'destination', token, io)
    const to = await topPoint(destination, destination, io)
    const destinationDescription = destination.target?.text || destination.target?.tag || 'destination'
    assertInsideViewport(from, source.viewport)
    assertInsideViewport(to, source.viewport)
    const current = await io.getActiveTab()
    if (current.id !== tab.id || current.url !== tab.url) {
      throw dragFailure('DRAG_STALE_TAB', 'The active tab changed before drag input; no drag was dispatched.', { mutationPossible: false })
    }
    await io.withDebugger(tab.id, async () => {
      dispatch = await dispatchTrustedDrag({ from, to, holdMs: request.holdMs, intercept: source.target?.native === true }, {
        sendCommand: (method, params) => io.sendCommand(tab.id, method, params),
        onDragIntercepted: listener => io.onDragIntercepted(tab.id, listener),
        sleep: io.sleep,
        moveCursor: (point, options) => io.moveCursor?.(tab.id, point.x, point.y, options),
        beforeHover: async () => {
          await revalidateTarget(tab, source, 'source', token, true, false, io)
          await revalidateTarget(tab, destination, 'destination', token, true, false, io)
        },
        beforePress: async () => {
          await revalidateTarget(tab, source, 'source', token, true, true, io)
          await revalidateTarget(tab, destination, 'destination', token, true, true, io)
        },
        beforeDrop: async () => {
          const valueDriven = source.before.value?.measured === true || source.before.ariaValueNow?.value !== null
          await revalidateTarget(tab, source, 'source', token, !valueDriven, true, io)
          await revalidateTarget(tab, destination, 'destination', token, true, true, io)
        },
      })
    })
    await io.sleep(request.settleMs)
    const measuredSource = await io.runInFrame(tab.id, source.frameId, dragProbe, [{ phase: 'after', token }], 4_000)
    if (!measuredSource?.ok) {
      throw dragFailure(measuredSource?.code ?? 'DRAG_MEASURE_FAILED', measuredSource?.message ?? 'The drag outcome could not be measured; inspect the page before retrying.', {
        mutationPossible: true,
        dispatch,
      })
    }
    const measuredDestination = destination.frameId === source.frameId
      ? measuredSource
      : await io.runInFrame(tab.id, destination.frameId, dragProbe, [{ phase: 'after', token }], 4_000)
    if (!measuredDestination?.ok) {
      throw dragFailure(measuredDestination?.code ?? 'DRAG_MEASURE_FAILED', measuredDestination?.message ?? 'The destination outcome could not be measured; inspect the page before retrying.', {
        mutationPossible: true,
        dispatch,
      })
    }
    const sourceOutcome = evaluateDragOutcome(source.before, measuredSource.source)
    const destinationOutcome = evaluateDragDestinationOutcome(destination.before, measuredDestination.destination)
    const outcome = combineDragOutcomes(sourceOutcome, destinationOutcome)
    if (outcome.changed === false && outcome.complete) {
      throw dragFailure('DRAG_NO_EFFECT', 'The drag was dispatched, but every applicable source, destination, value, and selection check stayed unchanged. Drop dispatch is not success evidence; inspect the target or use a semantic control instead of repeating the same drag.', {
        mutationPossible: true,
        dispatch,
        outcome,
        sourceOutcome,
        destinationOutcome,
      })
    }
    return {
      op: 'drag',
      attempted: true,
      ok: outcome.changed === null ? null : true,
      changed: outcome.changed,
      signals: outcome.signals,
      mutationPossible: true,
      drag: {
        status: outcome.changed === true ? 'changed' : 'unknown',
        source: source.target,
        destination: destinationDescription,
        from,
        to,
        dispatch,
        outcome,
        sourceOutcome,
        destinationOutcome,
      },
    }
  } catch (error) {
    const failure = error instanceof Error ? error : dragFailure('DRAG_FAILED', String(error))
    if (failure.mutationPossible === undefined || dispatch) failure.mutationPossible = dispatch !== undefined
    throw failure
  } finally {
    await Promise.all([...cleanupFrames].map(frameId => io.runInFrame(
      tab.id,
      frameId,
      dragProbe,
      [{ phase: 'cleanup', token }],
      1_000,
    ).catch(() => {})))
  }
}
