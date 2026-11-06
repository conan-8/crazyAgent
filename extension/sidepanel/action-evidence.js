const POSITIVE_SIGNALS = new Set([
  'url-change',
  'title-change',
  'scroll-change',
  'text-change',
  'text-changed',
  'value-changed',
  'parent-changed',
  'index-changed',
  'bounds-changed',
  'aria-valuenow-changed',
  'selection-changed',
  'destination-children-changed',
  'destination-text-changed',
  'dialog-change',
  'fingerprint-changed',
  'labels-added',
  'labels-removed',
  'layout-changed',
  'pixels-changed',
  'navigation',
])
const STATE_SIGNAL = /^(?:checked|expanded|selected):/u
const DOM_MUTATION_SIGNAL = /^dom-mutations:(\d+)$/u
const MUTATION_OPS = new Set([
  'click', 'click_at', 'click_role', 'hover', 'select_option', 'type', 'press_key',
  'scroll', 'navigate', 'select', 'dialog', 'table', 'find', 'download', 'upload', 'docs', 'drag',
])
const READ_ONLY_OPS = new Set(['snapshot', 'auto_view', 'tabs.list', 'places.search', 'wait_for', 'labels.clear', 'read_text', 'clipboard'])
const EXPECTATION_KINDS = new Set(['label', 'text', 'value', 'dialog', 'pixels', 'url', 'state'])
const TRANSITIONS = new Set(['changed', 'unchanged', 'any'])
const LABEL_STATE_FIELDS = ['value', 'checked', 'expanded', 'selected']

function unique(values) {
  return [...new Set(values)]
}

function mutationPossibility(result) {
  if (result?.mutationPossible !== undefined) return result.mutationPossible === true ? true : result.mutationPossible === false ? false : null
  if (result?.attempted === false) return false
  if (result?.attempted === null || result?.ok === false || result?.error) return null
  const op = String(result?.op ?? '')
  if (result?.ok === true || (result?.ok === undefined && result?.dialog?.status !== 'pending')) {
    if (MUTATION_OPS.has(op)) return true
    if (READ_ONLY_OPS.has(op)) return false
  }
  return null
}

function unknownEvidence(reasons, result, signals = []) {
  return {
    observed: 'unknown',
    signals: unique(signals),
    reasons: unique(reasons.length > 0 ? reasons : ['NO_MEASUREMENT']),
    mutationPossible: mutationPossibility(result),
    diagnosticOnly: true,
  }
}

/**
 * Derive what the executor actually measured. A true change is diagnostic page
 * evidence, not proof of the requested application outcome.
 * @param {Record<string, any> | null | undefined} result
 * @returns {{observed: 'changed'|'unchanged'|'unknown', signals: string[], reasons: string[], mutationPossible: boolean|null, diagnosticOnly: true}}
 */
export function deriveObservedChange(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return unknownEvidence(['RESULT_MISSING'], result)
  }

  const positive = new Set()
  const negative = new Set()
  const unknown = new Set()
  const diagnostics = new Set()
  const rawSignals = Array.isArray(result.signals) ? result.signals : []
  for (const raw of rawSignals) {
    const signal = String(raw ?? '')
    if (POSITIVE_SIGNALS.has(signal)) positive.add(signal)
    else if (signal === 'navigation-possible') unknown.add('NAVIGATION_UNCONFIRMED')
    else if (STATE_SIGNAL.test(signal)) diagnostics.add(signal)
    else {
      const mutation = DOM_MUTATION_SIGNAL.exec(signal)
      if (mutation) {
        if (Number(mutation[1]) > 0) positive.add(signal)
        else negative.add('dom-unchanged')
      } else if (signal.length > 0) diagnostics.add(signal)
    }
  }

  if (result.navigated === true) {
    positive.add('navigation')
    unknown.delete('NAVIGATION_UNCONFIRMED')
  }
  if (Number(result.mutations) > 0) positive.add('dom-mutations')
  else if (result.mutations === 0) negative.add('dom-unchanged')
  if (result.layoutChanged === true) positive.add('layout-changed')

  const labelsDelta = result.labelsDelta
  if (labelsDelta !== undefined) {
    const added = Number(labelsDelta?.addedCount)
    const removed = Number(labelsDelta?.removedCount)
    if (Number.isFinite(added) && Number.isFinite(removed) && added >= 0 && removed >= 0) {
      if (added > 0) positive.add('labels-added')
      if (removed > 0) positive.add('labels-removed')
      if (added === 0 && removed === 0) negative.add('labels-unchanged')
    } else unknown.add('LABEL_DELTA_INVALID')
  }

  if (Array.isArray(result.points)) {
    if (result.points.length === 0) unknown.add('PIXELS_UNMEASURED')
    for (const point of result.points) {
      if (point?.changed === true) positive.add('pixels-changed')
      else if (point?.changed === false && point?.offScreen !== true) negative.add('pixels-unchanged')
      else unknown.add('PIXELS_UNMEASURED')
    }
  } else if (typeof result.pixelsChanged === 'number' && Number.isFinite(result.pixelsChanged)) {
    if (result.changed === true) positive.add('pixels-changed')
    else if (result.changed === false) negative.add('pixels-unchanged')
  }

  const typed = result.typed
  if (typed && typeof typed === 'object') {
    if (typed.canvasEditor === true || typed.measured === 'none') {
      unknown.add('TARGET_UNMEASURED')
      if (typed.pageChanged === true) diagnostics.add('unrelated-page-change-possible')
    } else if (typed.measured === 'field') {
      if (result.changed === true) positive.add('value-changed')
      else if (result.changed === false) negative.add('value-unchanged')
      else unknown.add('TARGET_UNMEASURED')
    } else {
      const beforeChars = Number(typed.beforeChars)
      const afterChars = Number(typed.afterChars)
      const countsMeasured = Number.isFinite(beforeChars) && Number.isFinite(afterChars)
      const charsAdded = Number(typed.charsAdded)
      if (Number.isFinite(charsAdded) && charsAdded !== 0) positive.add('value-changed')
      else if (countsMeasured && beforeChars !== afterChars) positive.add('value-changed')

      const hasBeforePreview = typeof typed.beforePreview === 'string' || typeof typed.beforeValue === 'string'
      const beforePreview = typed.beforePreview ?? typed.beforeValue
      const afterPreview = typed.valuePreview ?? typed.afterPreview
      const previewsMeasured = hasBeforePreview && typeof afterPreview === 'string'
      if (previewsMeasured) {
        if (beforePreview !== afterPreview) positive.add('value-changed')
        else negative.add('value-unchanged')
      }
      if (result.changed === false && (previewsMeasured || (typed.method === 'dom' && countsMeasured))) {
        negative.add('value-unchanged')
      }
      if (result.changed === null) unknown.add('TARGET_UNMEASURED')
    }
  }

  if (Array.isArray(result.dialogs) && result.dialogs.length > 0) positive.add('dialog-reported')
  else if (result.op === 'dialog' && result.dialog?.status === 'resolved') positive.add('dialog-resolved')
  else if (result.dialog) unknown.add('DIALOG_TRANSITION_UNCONFIRMED')

  if (result.changed === null) unknown.add('EXECUTOR_UNKNOWN')
  if (result.changed === true && positive.size === 0) {
    unknown.add(diagnostics.size > 0 ? 'STATE_WITHOUT_BEFORE' : 'UNATTRIBUTED_CHANGE')
  }

  if (positive.size > 0) {
    return {
      observed: 'changed',
      signals: [...positive],
      reasons: [...unknown],
      mutationPossible: mutationPossibility(result),
      diagnosticOnly: true,
      ...(diagnostics.size > 0 ? { diagnostics: [...diagnostics] } : {}),
    }
  }

  const clickMeasured = result.op === 'click' && result.changed === false
    && Array.isArray(result.signals) && !unknown.has('NAVIGATION_UNCONFIRMED')
  const selectMeasured = result.op === 'select_option' && result.changed === false && result.selected !== undefined
  const dragMeasured = result.op === 'drag' && result.changed === false && result.drag?.outcome?.complete === true
  if (dragMeasured) negative.add('drag-unchanged')
  if (unknown.size === 0 && (negative.has('pixels-unchanged') || negative.has('value-unchanged') || negative.has('drag-unchanged') || clickMeasured || selectMeasured)) {
    return {
      observed: 'unchanged',
      signals: [...negative],
      reasons: ['MEASURED_UNCHANGED'],
      mutationPossible: mutationPossibility(result),
      diagnosticOnly: true,
      ...(diagnostics.size > 0 ? { diagnostics: [...diagnostics] } : {}),
    }
  }
  if (result.changed === false && negative.size === 0 && unknown.size === 0) unknown.add('NO_MEASUREMENT')
  return {
    ...unknownEvidence([...unknown], result),
    ...(diagnostics.size > 0 ? { diagnostics: [...diagnostics] } : {}),
  }
}

function attemptedState(item) {
  if (item?.attempted !== undefined) return item.attempted === true ? true : item.attempted === false ? false : null
  if (item?.ok === true) return true
  return null
}

/**
 * Summarize one action or every per-step result in a browser batch. Batch guard
 * success is kept separate from observation and mutation possibility.
 * @param {Record<string, any> | null | undefined} result
 */
export function summarizeActionEvidence(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.actions)) {
    return deriveObservedChange(result)
  }
  const steps = result.actions.map((item, index) => {
    const derived = deriveObservedChange(item)
    return {
      index: Number.isSafeInteger(item?.index) ? item.index : index + 1,
      op: typeof item?.op === 'string' ? item.op : '',
      ok: typeof item?.ok === 'boolean' ? item.ok : null,
      attempted: attemptedState(item),
      ...derived,
      observed: ['changed', 'unchanged', 'unknown'].includes(item?.observed) ? item.observed : derived.observed,
      mutationPossible: typeof item?.mutationPossible === 'boolean' || item?.mutationPossible === null
        ? item.mutationPossible
        : derived.mutationPossible,
      ...item?.expectation ? { expectation: item.expectation } : {},
    }
  })
  const observed = steps.some(step => step.observed === 'changed')
    ? 'changed'
    : steps.length === 0 || steps.some(step => step.observed === 'unknown')
      ? 'unknown'
      : 'unchanged'
  const attempted = steps.some(step => step.attempted === true)
    ? true
    : steps.length > 0 && steps.every(step => step.attempted === false) ? false : null
  const mutationPossible = steps.some(step => step.mutationPossible === true)
    ? true
    : steps.length === 0 || steps.some(step => step.mutationPossible === null) ? null : false
  return {
    observed,
    attempted,
    mutationPossible,
    signals: unique(steps.flatMap(step => step.signals)),
    reasons: unique(steps.flatMap(step => step.reasons)),
    steps,
    diagnosticOnly: true,
  }
}

function sameValue(left, right, depth = 0) {
  if (Object.is(left, right)) return true
  if (depth > 50 || !left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => sameValue(value, right[index], depth + 1))
  }
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key], depth + 1))
}

function normalizedScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return undefined
  const entries = Object.entries(scope)
  if (entries.length === 0) return undefined
  const normalized = {}
  for (const [key, value] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!key || value === undefined || (typeof value === 'number' && !Number.isFinite(value))
      || !['string', 'number', 'boolean'].includes(typeof value)) return undefined
    if (typeof value === 'string' && value.length === 0) return undefined
    normalized[key] = value
  }
  return normalized
}

function scopeKey(scope) {
  const normalized = normalizedScope(scope)
  return normalized ? JSON.stringify(normalized) : undefined
}

function observationScope(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return {}
  if (observation.scope !== undefined) return { key: scopeKey(observation.scope), invalid: scopeKey(observation.scope) === undefined }
  if (observation.tab && typeof observation.tab === 'object') {
    const scope = {}
    if (observation.tab.id !== undefined) scope.tabId = observation.tab.id
    if (observation.tab.url !== undefined) scope.url = observation.tab.url
    if (Object.keys(scope).length > 0) return { key: scopeKey(scope), invalid: scopeKey(scope) === undefined }
  }
  return {}
}

function labelList(observation) {
  if (Array.isArray(observation)) return observation
  if (Array.isArray(observation?.labels)) return observation.labels
  return undefined
}

function labelMap(labels) {
  const map = new Map()
  const duplicates = new Set()
  let invalid = 0
  for (const label of labels) {
    const id = Number(label?.id)
    const frame = Number(label?.frame ?? label?.frameId ?? 0)
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(frame) || frame < 0) {
      invalid += 1
      continue
    }
    const key = `${frame}:${id}`
    if (map.has(key) || duplicates.has(key)) {
      duplicates.add(key)
      map.delete(key)
    } else map.set(key, label)
  }
  return { map, duplicates, invalid }
}

function publicLabel(label) {
  const frame = Number(label?.frame ?? label?.frameId ?? 0)
  const result = {
    id: Number(label.id),
    tag: String(label.tag ?? ''),
    role: String(label.role ?? ''),
    text: String(label.text ?? '').replace(/\s+/gu, ' ').trim(),
    disabled: label.disabled === true,
    ...(frame > 0 ? { frame } : {}),
  }
  for (const field of LABEL_STATE_FIELDS) {
    if (label[field] !== undefined) result[field] = label[field]
  }
  return result
}

function changedLabelFields(before, after) {
  return ['tag', 'role', 'text', 'disabled', ...LABEL_STATE_FIELDS]
    .filter(field => !sameValue(before[field], after[field]))
}

function boundedInteger(value, fallback, maximum) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(0, Math.min(maximum, Math.floor(number)))
}

function newTextCandidates(after) {
  const raw = after && !Array.isArray(after) ? after.newText ?? after.addedText : undefined
  if (raw === undefined) return { present: false, items: [], invalid: 0, ambiguous: 0 }
  const input = Array.isArray(raw) ? raw : [raw]
  const items = []
  const seen = new Set()
  let invalid = 0
  let ambiguous = 0
  for (const entry of input) {
    if (entry && typeof entry === 'object' && entry.related === false) continue
    if (entry && typeof entry === 'object' && entry.ambiguous === true) {
      ambiguous += 1
      continue
    }
    const value = typeof entry === 'string' ? entry : entry?.text
    if (typeof value !== 'string') {
      invalid += 1
      continue
    }
    const text = value.replace(/\s+/gu, ' ').trim().slice(0, 300)
    if (!text || seen.has(text)) continue
    seen.add(text)
    items.push(text)
  }
  return { present: true, items, invalid, ambiguous }
}

function shortText(value, maximum = 80) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`
}

function labelLine(label) {
  const frame = label.frame === undefined ? '' : ` frame:${label.frame}`
  const role = label.role || label.tag || 'element'
  const text = label.text ? ` ${JSON.stringify(shortText(label.text))}` : ''
  return `[${label.id}${frame}] ${role}${text}${label.disabled ? ' (disabled)' : ''}`
}

/**
 * Compare same-scope labelled observations and mutation-derived visible text.
 * `after.newText`/`after.addedText` must contain actual additions; aggregate
 * text lengths and full-page text are deliberately not treated as additions.
 * @param {Record<string, any>|Array<Record<string, any>>|null|undefined} before
 * @param {Record<string, any>|Array<Record<string, any>>|null|undefined} after
 * @param {{limit?: number, maxChars?: number}} [options]
 */
export function summarizeSemanticDelta(before, after, options = {}) {
  const limit = boundedInteger(options.limit, 12, 50)
  const maxChars = boundedInteger(options.maxChars, 2_400, 6_000)
  const reasons = []
  const beforeLabels = labelList(before)
  const afterLabels = labelList(after)
  const beforeScope = observationScope(before)
  const afterScope = observationScope(after)
  let comparable = beforeLabels !== undefined && afterLabels !== undefined
  if (!beforeLabels) reasons.push('BEFORE_LABELS_MISSING')
  if (!afterLabels) reasons.push('AFTER_LABELS_MISSING')
  if (beforeScope.invalid || afterScope.invalid) {
    comparable = false
    reasons.push('SCOPE_INVALID')
  } else if ((beforeScope.key || afterScope.key) && beforeScope.key !== afterScope.key) {
    comparable = false
    reasons.push('SCOPE_MISMATCH')
  }

  let newOnScreen = []
  let changed = []
  let removedCount = null
  let ambiguousCount = 0
  let invalidCount = 0
  let counts = { before: 0, after: 0, newOnScreen: 0, changed: 0, removed: 0, newText: 0 }
  if (comparable) {
    const previous = labelMap(beforeLabels)
    const current = labelMap(afterLabels)
    const blocked = new Set([...previous.duplicates, ...current.duplicates])
    ambiguousCount = blocked.size
    invalidCount = previous.invalid + current.invalid
    const added = []
    const changedAll = []
    let removed = 0
    for (const [key, label] of current.map) {
      if (blocked.has(key)) continue
      if (!previous.map.has(key)) added.push(publicLabel(label))
      else {
        const beforeLabel = publicLabel(previous.map.get(key))
        const afterLabel = publicLabel(label)
        const fields = changedLabelFields(beforeLabel, afterLabel)
        if (fields.length > 0) changedAll.push({ id: afterLabel.id, ...(afterLabel.frame === undefined ? {} : { frame: afterLabel.frame }), fields, before: beforeLabel, after: afterLabel })
      }
    }
    for (const key of previous.map.keys()) {
      if (!blocked.has(key) && !current.map.has(key)) removed += 1
    }
    counts = { ...counts, before: previous.map.size, after: current.map.size, newOnScreen: added.length, changed: changedAll.length, removed }
    newOnScreen = added.slice(0, limit)
    changed = changedAll.slice(0, limit)
    removedCount = removed
    if (ambiguousCount > 0) reasons.push('AMBIGUOUS_LABEL_ID')
    if (invalidCount > 0) reasons.push('INVALID_LABEL')
  }

  const text = newTextCandidates(after)
  ambiguousCount += text.ambiguous
  invalidCount += text.invalid
  if (text.ambiguous > 0) reasons.push('AMBIGUOUS_NEW_TEXT')
  if (text.invalid > 0) reasons.push('INVALID_NEW_TEXT')
  counts.newText = text.items.length
  const newText = text.items.slice(0, limit)
  let truncated = newOnScreen.length < counts.newOnScreen || changed.length < counts.changed || newText.length < counts.newText

  const lines = []
  const appendSection = (title, entries, format) => {
    if (entries.length === 0) return
    lines.push(`${title}:`)
    for (const entry of entries) lines.push(`· ${format(entry)}`)
  }
  appendSection('New on screen', newOnScreen, labelLine)
  appendSection('Changed', changed, entry => `${labelLine(entry.after)} (${entry.fields.join(', ')}; was ${JSON.stringify(shortText(entry.before.text))})`)
  appendSection('New text', newText, entry => shortText(entry, 300))
  if (removedCount > 0) lines.push(`(${removedCount} element${removedCount === 1 ? '' : 's'} left the screen)`)

  const boundedLines = []
  let used = 0
  for (const line of lines) {
    const next = boundedLines.length === 0 ? line.length : line.length + 1
    if (used + next > maxChars) {
      truncated = true
      break
    }
    boundedLines.push(line)
    used += next
  }
  if (truncated) reasons.push('SUMMARY_TRUNCATED')
  const hasEvidence = comparable || text.present
  const status = !hasEvidence ? 'unknown' : reasons.length > 0 ? 'partial' : 'complete'
  return {
    status,
    newOnScreen,
    changed,
    newText,
    removedCount,
    counts,
    ambiguousCount,
    invalidCount,
    truncated,
    reasons: unique(reasons),
    text: boundedLines.join('\n'),
    diagnosticOnly: true,
  }
}

function readObservation(raw) {
  if (raw === undefined) return { state: 'missing' }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.ambiguous === true || raw.status === 'ambiguous') return { state: 'ambiguous' }
    if (raw.observed === false || raw.status === 'missing' || raw.status === 'unknown') return { state: 'missing' }
    if (raw.observed === true || raw.status === 'observed') return { state: 'observed', value: raw.value }
  }
  return { state: 'observed', value: raw }
}

function matchExpected(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    const keys = Object.keys(expected)
    if (keys.length === 1 && keys[0] === 'equals') return { valid: true, matches: sameValue(actual, expected.equals) }
    if (keys.length === 1 && keys[0] === 'includes') {
      return {
        valid: typeof expected.includes === 'string' && expected.includes.length > 0,
        matches: typeof actual === 'string' && typeof expected.includes === 'string' && expected.includes.length > 0 && actual.includes(expected.includes),
      }
    }
    if (keys.length === 1 && keys[0] === 'present') {
      return {
        valid: typeof expected.present === 'boolean',
        matches: typeof expected.present === 'boolean' && (actual !== null && actual !== undefined) === expected.present,
      }
    }
    if (keys.some(key => ['equals', 'includes', 'present'].includes(key))) return { valid: false, matches: false }
  }
  return { valid: true, matches: sameValue(actual, expected) }
}

function expectationResult(status, reason, expectation, scope) {
  return {
    status,
    reason,
    kind: typeof expectation?.kind === 'string' ? expectation.kind : null,
    scope: scope ?? null,
    transition: typeof expectation?.transition === 'string' ? expectation.transition : null,
    diagnosticOnly: true,
  }
}

/**
 * Evaluate caller-supplied evidence for one explicitly scoped expectation.
 * `before`/`after` are raw observed values or `{observed, value}` wrappers;
 * `{observed:false}` and `{status:'unknown'|'missing'|'ambiguous'}` fail closed.
 * Expected values are exact by default, or `{equals}`, `{includes}`, `{present}`.
 * @param {{kind: string, scope: Record<string, string|number|boolean>, transition: 'changed'|'unchanged'|'any', before?: any, after?: any}} expectation
 * @param {{kind: string, scope: Record<string, string|number|boolean>, before?: any, after?: any, related?: boolean, ambiguous?: boolean}} evidence
 */
export function evaluateExpectationEvidence(expectation, evidence) {
  const scope = normalizedScope(expectation?.scope)
  if (!expectation || typeof expectation !== 'object' || Array.isArray(expectation)) {
    return expectationResult('unknown', 'EXPECTATION_INVALID', expectation)
  }
  if (!EXPECTATION_KINDS.has(expectation.kind)) return expectationResult('unknown', 'KIND_REQUIRED', expectation, scope)
  if (!scope) return expectationResult('unknown', 'SCOPE_REQUIRED', expectation)
  if (!TRANSITIONS.has(expectation.transition)) return expectationResult('unknown', 'TRANSITION_REQUIRED', expectation, scope)
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return expectationResult('unknown', 'EVIDENCE_MISSING', expectation, scope)
  }
  if (evidence.ambiguous === true) return expectationResult('unknown', 'AMBIGUOUS_TARGET', expectation, scope)
  if (evidence.kind !== expectation.kind) return expectationResult('unknown', 'KIND_MISMATCH', expectation, scope)
  const evidenceScope = normalizedScope(evidence.scope)
  if (!evidenceScope) return expectationResult('unknown', 'SCOPE_REQUIRED', expectation, scope)
  if (JSON.stringify(scope) !== JSON.stringify(evidenceScope)) return expectationResult('unknown', 'SCOPE_MISMATCH', expectation, scope)
  if (evidence.related === false) return expectationResult('unknown', 'UNRELATED_EVIDENCE', expectation, scope)

  const before = readObservation(evidence.before)
  const after = readObservation(evidence.after)
  if (after.state === 'ambiguous' || before.state === 'ambiguous') return expectationResult('unknown', 'AMBIGUOUS_OBSERVATION', expectation, scope)
  if (after.state !== 'observed') return expectationResult('unknown', 'AFTER_MISSING', expectation, scope)
  const needsBefore = expectation.transition !== 'any' || Object.hasOwn(expectation, 'before')
  if (needsBefore && before.state !== 'observed') return expectationResult('unknown', 'BEFORE_MISSING', expectation, scope)

  for (const phase of ['before', 'after']) {
    if (!Object.hasOwn(expectation, phase)) continue
    if (phase === 'before' && !needsBefore) continue
    const actual = phase === 'before' ? before.value : after.value
    const match = matchExpected(actual, expectation[phase])
    if (!match.valid) return expectationResult('unknown', 'EXPECTATION_INVALID', expectation, scope)
    if (!match.matches) return expectationResult('unmet', `${phase.toUpperCase()}_MISMATCH`, expectation, scope)
  }

  if (expectation.transition !== 'any') {
    const changed = !sameValue(before.value, after.value)
    if (expectation.transition === 'changed' && !changed) return expectationResult('unmet', 'TRANSITION_NOT_OBSERVED', expectation, scope)
    if (expectation.transition === 'unchanged' && changed) return expectationResult('unmet', 'UNEXPECTED_TRANSITION', expectation, scope)
  }
  return expectationResult('met', 'EVIDENCE_MATCHED', expectation, scope)
}
