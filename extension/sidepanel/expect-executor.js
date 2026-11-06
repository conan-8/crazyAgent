import {
  ACTION_EXPECT_BATCH_CHECKS,
  ACTION_EXPECT_DIRECT_CHECKS,
  ACTION_TOOLBAR_ATTRIBUTES,
  evaluateActionExpect,
  parseActionExpect,
} from './action-expect.js'
import { deriveObservedChange, summarizeActionEvidence, summarizeSemanticDelta } from './action-evidence.js'
import { docsDocumentId } from './docs-export.js'

const EVIDENCE_OPS = new Set(Object.keys(ACTION_EXPECT_DIRECT_CHECKS))

function unsupported(path, message) {
  const error = new Error(`${path} ${message}`)
  error.name = 'ActionExpectError'
  error.code = 'EXPECT_UNSUPPORTED'
  error.path = path
  return error
}

export function parseOperationExpect(op, value, url, options = {}) {
  if (value === undefined) return undefined
  const batch = options.batch === true
  const supportedChecks = (batch ? ACTION_EXPECT_BATCH_CHECKS : ACTION_EXPECT_DIRECT_CHECKS)[op] ?? []
  const path = options.path ?? 'expect'
  const expectation = parseActionExpect(value, { path, supportedChecks, supportedStyleAttributes: ACTION_TOOLBAR_ATTRIBUTES })
  const documentId = docsDocumentId(url)
  if (expectation.export_contains !== undefined && documentId === undefined) {
    throw unsupported(`${path}.export_contains`, 'requires an active Google Docs document export scope; no input was dispatched')
  }
  if (expectation.toolbar_style !== undefined && documentId === undefined) {
    throw unsupported(`${path}.toolbar_style`, 'requires an active Google Docs main-toolbar scope; no input was dispatched')
  }
  if (expectation.text_landed !== undefined && documentId !== undefined) {
    throw unsupported(`${path}.text_landed`, 'is not measurable from Docs canvas DOM text; use export_contains for this document')
  }
  return expectation
}

export function supportsActionEvidence(op) {
  return EVIDENCE_OPS.has(op) || op === 'drag'
}

function triState(value) {
  return value === true ? true : value === false ? false : null
}

function actionOutcome(result) {
  const derived = deriveObservedChange(result)
  const outcome = {
    op: result.op,
    attempted: result.attempted === undefined ? (result.ok === false ? null : true) : triState(result.attempted),
    ok: result.ok === undefined ? (result.error ? false : true) : triState(result.ok),
    mutationPossible: result.mutationPossible === undefined ? derived.mutationPossible : triState(result.mutationPossible),
  }
  if (Number.isSafeInteger(result.index)) outcome.index = result.index
  if (typeof result.status === 'string') outcome.status = result.status
  if (result.error && typeof result.error === 'object') {
    outcome.error = {
      ...typeof result.error.code === 'string' ? { code: result.error.code } : {},
      ...typeof result.error.message === 'string' ? { message: result.error.message } : {},
    }
  }
  return outcome
}

function combineObserved(left, right) {
  if (left === 'changed' || right === 'changed') return 'changed'
  if (left === 'unknown' || right === 'unknown') return 'unknown'
  return 'unchanged'
}

function notDeclaredExpectation() {
  return { status: 'unverified', diagnosticOnly: true, limits: ['not-declared'], checks: [] }
}

function semanticDelta(context, result) {
  if (context?.beforeView === undefined && result.semanticDelta !== undefined) return result.semanticDelta
  const before = context?.beforeView
  const newText = context?.newText ?? result.newText
  const after = {
    tab: result.tab,
    labels: result.labels,
    ...Array.isArray(newText) ? { newText } : {},
  }
  if (!Array.isArray(newText) && !(Array.isArray(before?.labels) && Array.isArray(result.labels))) return undefined
  return summarizeSemanticDelta(before, after)
}

export function finalizeActionEvidence(result, expectation) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const context = result._actionEvidence ?? {}
  delete result._actionEvidence
  const base = deriveObservedChange(result)
  const outcome = actionOutcome(result)
  const evaluated = expectation === undefined
    ? undefined
    : evaluateActionExpect(expectation, context.expectEvidence ?? result.expectEvidence ?? {}, outcome)
  const delta = semanticDelta(context, result)
  return {
    ...result,
    observed: combineObserved(base.observed, evaluated?.observed),
    outcome,
    mutationPossible: outcome.mutationPossible,
    expectation: evaluated?.expectation ?? notDeclaredExpectation(),
    ...expectation === undefined ? {} : { expect: expectation, expectEvidence: context.expectEvidence ?? result.expectEvidence ?? {} },
    ...delta ? { semanticDelta: delta } : {},
  }
}

function aggregateBatchExpectation(actions) {
  const checks = actions.flatMap((item, index) => {
    const actionIndex = Number.isSafeInteger(item?.index) ? item.index : index + 1
    return (Array.isArray(item?.expectation?.checks) ? item.expectation.checks : [])
      .map(check => ({ ...check, actionIndex }))
  })
  if (checks.length === 0) return notDeclaredExpectation()
  const status = checks.some(check => check.status === 'diverged') ? 'diverged'
    : checks.some(check => check.status === 'unverified') ? 'unverified' : 'verified'
  return {
    status,
    diagnosticOnly: checks.every(check => check.key === 'pixel_changed'),
    limits: [...new Set(checks.flatMap(check => Array.isArray(check.limits) ? check.limits : []))],
    checks,
  }
}

export function finalizeBatchEvidence(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.actions)) return result
  const context = result._actionEvidence ?? {}
  delete result._actionEvidence
  const summary = summarizeActionEvidence(result)
  const outcome = {
    op: 'batch',
    attempted: summary.attempted,
    ok: result.batch?.ok === undefined ? null : result.batch.ok,
    mutationPossible: summary.mutationPossible,
  }
  if (result.batch?.failedIndex !== undefined) outcome.index = result.batch.failedIndex
  const delta = semanticDelta(context, result)
  return {
    ...result,
    observed: summary.observed,
    outcome,
    mutationPossible: summary.mutationPossible,
    expectation: aggregateBatchExpectation(result.actions),
    ...delta ? { semanticDelta: delta } : {},
  }
}

/** Page probe for the same editable target that typing resolves. It never returns the value. */
export function expectLabelledTextProbe(label, expected) {
  const state = globalThis.__crazyagent
  const labelled = state?.byId?.get(label)
  if (!labelled || !labelled.isConnected) return { readable: false, target: 'stale' }
  const selector = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'
  const editable = node => {
    if (!node || node.nodeType !== 1) return null
    if (node.matches?.(selector) || node.isContentEditable === true) return node
    return null
  }
  let element = editable(labelled)
  if (!element) element = labelled.querySelector?.(selector) ?? null
  if (!element) {
    let ancestor = labelled.parentElement
    while (ancestor && !element) {
      element = editable(ancestor) ?? ancestor.querySelector?.(selector) ?? null
      ancestor = ancestor.parentElement
    }
  }
  if (!element) return { readable: false, target: 'not-applicable' }
  const tag = String(element.tagName ?? '').toLowerCase()
  const type = String(element.type ?? '').toLowerCase()
  if (tag === 'input' && type === 'password') return { readable: false, target: 'unique', tag, type, limits: ['password-unreadable'] }
  const path = []
  for (let node = element, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
    const nodeTag = node.tagName.toLowerCase()
    if (node.id) {
      path.unshift(`${nodeTag}#${node.id}`)
      break
    }
    const siblings = node.parentElement ? [...node.parentElement.children].filter(sibling => sibling.tagName === node.tagName) : [node]
    path.unshift(`${nodeTag}[${siblings.indexOf(node)}]`)
  }
  const field = tag === 'input' || tag === 'textarea'
  const value = field ? String(element.value ?? '') : String(element.innerText ?? element.textContent ?? '')
  return {
    readable: true,
    target: 'unique',
    tag,
    type,
    identity: path.join('/'),
    documentUrl: location.href,
    timeOrigin: performance.timeOrigin,
    contains: value.includes(expected),
    complete: true,
    chars: value.length,
  }
}

/** Page probe for one frame's focused readable field. It never returns the value. */
export function expectFocusedTextProbe(expected) {
  const element = document.activeElement
  if (!element) return { readable: false, hasFocus: false }
  const tag = String(element.tagName ?? '').toLowerCase()
  const type = String(element.type ?? '').toLowerCase()
  const field = tag === 'input' || tag === 'textarea'
  const editable = field || element.isContentEditable === true || element.getAttribute?.('contenteditable') === 'true'
  if (!editable) return { readable: false, hasFocus: true, tag, type }
  if (tag === 'input' && type === 'password') return { readable: false, hasFocus: true, tag, type, limits: ['password-unreadable'] }
  let rect
  try { rect = element.getBoundingClientRect() } catch { rect = undefined }
  if (!rect || rect.width < 8 || rect.height < 8) return { readable: false, hasFocus: true, tag, type, limits: ['target-not-measurable'] }
  const path = []
  for (let node = element, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
    const nodeTag = node.tagName.toLowerCase()
    if (node.id) {
      path.unshift(`${nodeTag}#${node.id}`)
      break
    }
    const siblings = node.parentElement ? [...node.parentElement.children].filter(sibling => sibling.tagName === node.tagName) : [node]
    path.unshift(`${nodeTag}[${siblings.indexOf(node)}]`)
  }
  const value = field ? String(element.value ?? '') : String(element.innerText ?? element.textContent ?? '')
  return {
    readable: true,
    hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : true,
    tag,
    type,
    identity: path.join('/'),
    documentUrl: location.href,
    timeOrigin: performance.timeOrigin,
    contains: value.includes(expected),
    complete: true,
    chars: value.length,
  }
}

function hasDocumentIdentity(value) {
  return typeof value?.documentUrl === 'string' && value.documentUrl.length > 0
    && Number.isFinite(value?.timeOrigin) && value.timeOrigin > 0
}

export function focusedTextSnapshot(frames) {
  const candidates = (Array.isArray(frames) ? frames : [])
    .filter(frame => frame?.result?.readable === true)
    .map(frame => ({ frameId: Number(frame.frameId) || 0, ...frame.result }))
  const focused = candidates.filter(candidate => candidate.hasFocus === true)
  const usable = focused.length > 0 ? focused : candidates
  if (usable.length !== 1 || !usable[0].identity || !hasDocumentIdentity(usable[0])) {
    return {
      scope: { kind: 'field', target: usable.length > 1 ? 'ambiguous' : 'unknown' },
      complete: null,
      limits: [usable.length === 1 && usable[0].identity ? 'document-identity-unavailable' : 'focused-target-unidentified'],
    }
  }
  const target = usable[0]
  return {
    scope: {
      kind: 'field',
      id: `${target.frameId}:${target.timeOrigin}:${target.identity}`,
      target: 'unique',
      detail: `${target.documentUrl}|${target.tag}${target.type ? `:${target.type}` : ''}`,
    },
    contains: target.contains,
    complete: target.complete === true,
    chars: target.chars,
  }
}

export function labelledTextSnapshot(probe, label, frameId) {
  const identified = probe?.readable !== true || hasDocumentIdentity(probe)
  const target = identified ? probe?.target : 'unknown'
  const scope = {
    kind: 'field',
    target: ['unique', 'stale', 'not-applicable', 'unknown'].includes(target) ? target : 'unknown',
    ...target === 'unique' ? {
      id: label,
      detail: `frame:${frameId};${probe.documentUrl};${probe.timeOrigin};${probe.identity}`,
    } : {},
  }
  const limits = [...(Array.isArray(probe?.limits) ? probe.limits : []), ...identified ? [] : ['document-identity-unavailable']]
  return {
    scope,
    ...probe?.readable === true && identified ? { contains: probe.contains, complete: probe.complete === true, chars: probe.chars } : { complete: null },
    ...(limits.length > 0 ? { limits } : {}),
  }
}

/** Count rendered DOM dialogs in one frame. */
export function expectDialogProbe() {
  const dialogs = [...document.querySelectorAll('dialog[open],[role="dialog"]:not([aria-hidden="true"]),[role="alertdialog"]:not([aria-hidden="true"])')]
  let visible = 0
  for (const element of dialogs) {
    if (element.closest('[inert]')) continue
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) visible += 1
  }
  return { visible }
}

export function docsExportTextSnapshot(body, expected, url, limits = []) {
  const id = docsDocumentId(url)
  return {
    scope: { kind: 'docs-export', id: id ?? 'unknown', target: id === undefined ? 'unknown' : 'unique', detail: 'plain-text' },
    ...typeof body === 'string' && id !== undefined
      ? { contains: body.includes(expected), complete: true, chars: body.length }
      : { complete: null },
    ...(limits.length > 0 ? { limits } : {}),
  }
}

export function docsToolbarSnapshot(probe, expected, url) {
  const id = docsDocumentId(url)
  const attributes = Object.keys(expected)
  const readable = probe?.ok === true && id !== undefined
  const style = {}
  if (readable) {
    for (const attribute of attributes) {
      if (attribute === 'paragraph_style') style[attribute] = probe.paragraphStyle
      else if (attribute === 'font_size') style[attribute] = probe.fontSize
      else style[attribute] = probe[attribute]
    }
  }
  return {
    scope: { kind: 'toolbar', id: id ?? 'unknown', target: readable ? 'unique' : 'unknown', detail: 'main-toolbar/current-selection' },
    ...(readable ? { style } : {}),
    limits: ['selection-identity-untracked', ...readable ? [] : ['toolbar-unreadable']],
  }
}

export function unknownToolbarBaseline(url) {
  const id = docsDocumentId(url)
  return {
    scope: { kind: 'toolbar', id: id ?? 'unknown', target: 'unknown', detail: 'pre-action-selection-untracked' },
    limits: ['selection-identity-untracked'],
  }
}
