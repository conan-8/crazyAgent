import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveObservedChange,
  evaluateExpectationEvidence,
  summarizeActionEvidence,
  summarizeSemanticDelta,
} from '../sidepanel/action-evidence.js'

const label = (id, text, extra = {}) => ({ id, tag: 'button', role: 'button', text, disabled: false, ...extra })
const scope = { tabId: 7, frameId: 0, label: 2 }

test('missing and malformed results stay unknown without inventing mutation safety', () => {
  for (const result of [undefined, null, false, 'changed', []]) {
    const evidence = deriveObservedChange(result)
    assert.equal(evidence.observed, 'unknown')
    assert.deepEqual(evidence.reasons, ['RESULT_MISSING'])
    assert.equal(evidence.mutationPossible, null)
    assert.equal(evidence.diagnosticOnly, true)
  }
  assert.equal(deriveObservedChange({ op: 'custom', changed: false, signals: [] }).observed, 'unknown')
  assert.equal(deriveObservedChange({ op: 'custom', changed: null, signals: [] }).reasons.includes('EXECUTOR_UNKNOWN'), true)
})

test('DOM click mutations are observed changes, while a measured no-op is unchanged', () => {
  const changed = deriveObservedChange({
    op: 'click', ok: true, changed: true, signals: ['dom-mutations:2', 'text-change'], mutations: 2,
  })
  assert.equal(changed.observed, 'changed')
  assert.deepEqual(changed.signals.sort(), ['dom-mutations:2', 'dom-mutations', 'text-change'].sort())
  assert.equal(changed.mutationPossible, true)

  const unchanged = deriveObservedChange({ op: 'click', ok: true, changed: false, signals: [], mutations: 0 })
  assert.equal(unchanged.observed, 'unchanged')
  assert.equal(unchanged.mutationPossible, true, 'dispatch remains distinct from observed effect')
  assert.deepEqual(unchanged.reasons, ['MEASURED_UNCHANGED'])
})

test('state-only click signals and possible navigation do not fabricate transitions', () => {
  const state = deriveObservedChange({ op: 'click', changed: true, signals: ['checked:false'] })
  assert.equal(state.observed, 'unknown')
  assert.deepEqual(state.reasons, ['STATE_WITHOUT_BEFORE'])
  assert.deepEqual(state.diagnostics, ['checked:false'])

  for (const changed of [true, false]) {
    const navigation = deriveObservedChange({ op: 'click', changed, signals: ['navigation-possible'], navigated: false })
    assert.equal(navigation.observed, 'unknown')
    assert.equal(navigation.reasons.includes('NAVIGATION_UNCONFIRMED'), true)
  }
  const navigated = deriveObservedChange({ op: 'click', changed: true, signals: ['navigation-possible'], navigated: true })
  assert.equal(navigated.observed, 'changed')
  assert.equal(navigated.signals.includes('navigation'), true)
  assert.equal(navigated.reasons.includes('NAVIGATION_UNCONFIRMED'), false)
})

test('pixel evidence distinguishes measured no-change from missing captures and partial bursts', () => {
  assert.equal(deriveObservedChange({ op: 'click_at', changed: false, pixelsChanged: 0 }).observed, 'unchanged')
  assert.equal(deriveObservedChange({ op: 'click_at', changed: true, pixelsChanged: 4.2 }).observed, 'changed')
  const skipped = deriveObservedChange({ op: 'click_at', changed: null, pixelsChanged: null })
  assert.equal(skipped.observed, 'unknown')
  assert.equal(skipped.reasons.includes('EXECUTOR_UNKNOWN'), true)

  const partial = deriveObservedChange({
    op: 'click_at',
    points: [{ changed: true }, { changed: null, offScreen: true }],
  })
  assert.equal(partial.observed, 'changed')
  assert.deepEqual(partial.reasons, ['PIXELS_UNMEASURED'])
  const unmeasured = deriveObservedChange({ op: 'click_at', points: [{ changed: false }, { changed: null }] })
  assert.equal(unmeasured.observed, 'unknown')
  const allUnchanged = deriveObservedChange({ op: 'click_at', points: [{ changed: false }, { changed: false }] })
  assert.equal(allUnchanged.observed, 'unchanged')
})

test('label and layout deltas are positive evidence but zero labels alone are not a global no-op', () => {
  const labels = deriveObservedChange({ op: 'hover', labelsDelta: { addedCount: 2, removedCount: 1 } })
  assert.equal(labels.observed, 'changed')
  assert.deepEqual(labels.signals.sort(), ['labels-added', 'labels-removed'].sort())
  assert.equal(deriveObservedChange({ op: 'hover', changed: false, signals: [], labelsDelta: { addedCount: 0, removedCount: 0 } }).observed, 'unknown')
  assert.equal(deriveObservedChange({ op: 'click', changed: false, signals: [], labelsDelta: { addedCount: 0, removedCount: 0 } }).observed, 'unchanged')
  assert.equal(deriveObservedChange({ op: 'click', layoutChanged: true }).observed, 'changed')
  assert.equal(deriveObservedChange({ op: 'hover', labelsDelta: { addedCount: 'many' } }).observed, 'unknown')
})

test('new dialog reports are transitions; a dialog snapshot alone is not', () => {
  const reported = deriveObservedChange({ op: 'click', dialogs: [{ id: 1, status: 'resolved' }] })
  assert.equal(reported.observed, 'changed')
  assert.deepEqual(reported.signals, ['dialog-reported'])
  const pending = deriveObservedChange({ op: 'click', changed: false, signals: [], dialog: { status: 'pending' } })
  assert.equal(pending.observed, 'unknown')
  assert.equal(pending.reasons.includes('DIALOG_TRANSITION_UNCONFIRMED'), true)
  assert.equal(deriveObservedChange({ op: 'dialog', dialog: { status: 'resolved' } }).observed, 'changed')
})

test('typing uses the measured field or value, never unrelated page mutations', () => {
  const field = deriveObservedChange({
    op: 'type', ok: true, changed: false, signals: [],
    typed: { measured: 'field', canvasEditor: false, pageChanged: true, beforeChars: 3, afterChars: 3, charsAdded: 0 },
  })
  assert.equal(field.observed, 'unchanged')

  const unknown = deriveObservedChange({
    op: 'type', changed: null, signals: [],
    typed: { measured: 'field', canvasEditor: false, pageChanged: true, beforeChars: 3, afterChars: 3, charsAdded: 0 },
  })
  assert.equal(unknown.observed, 'unknown')

  const canvas = deriveObservedChange({
    op: 'type', changed: null, signals: [],
    typed: { measured: 'none', canvasEditor: true, pageChanged: true, dispatched: true },
  })
  assert.equal(canvas.observed, 'unknown')
  assert.equal(canvas.reasons.includes('TARGET_UNMEASURED'), true)
  assert.deepEqual(canvas.diagnostics, ['unrelated-page-change-possible'])
})

test('direct typing detects length and same-length preview transitions', () => {
  const length = deriveObservedChange({
    op: 'type', changed: true, signals: ['text-changed'],
    typed: { method: 'dom', beforeChars: 1, afterChars: 4, beforePreview: 'a', valuePreview: 'abcd' },
  })
  assert.equal(length.observed, 'changed')
  const sameLength = deriveObservedChange({
    op: 'type', changed: true, signals: ['text-changed'],
    typed: { method: 'trusted', beforeChars: 3, afterChars: 3, beforePreview: 'old', valuePreview: 'new' },
  })
  assert.equal(sameLength.observed, 'changed')
  const unchanged = deriveObservedChange({
    op: 'type', changed: false, signals: [],
    typed: { method: 'trusted', beforeChars: 3, afterChars: 3, beforePreview: 'same', valuePreview: 'same' },
  })
  assert.equal(unchanged.observed, 'unchanged')
})

test('drag evidence separates scoped effects, measured no-op, and unknown rerender', () => {
  const clone = deriveObservedChange({
    op: 'drag', attempted: true, ok: true, changed: true, mutationPossible: true,
    signals: ['destination-children-changed'],
    drag: { outcome: { complete: true } },
  })
  assert.equal(clone.observed, 'changed')
  assert.equal(clone.mutationPossible, true)

  const noop = deriveObservedChange({
    op: 'drag', attempted: true, ok: false, changed: false, mutationPossible: true,
    signals: [], drag: { outcome: { complete: true } },
  })
  assert.equal(noop.observed, 'unchanged')
  assert.deepEqual(noop.signals, ['drag-unchanged'])
  assert.equal(noop.mutationPossible, true)

  const unknown = deriveObservedChange({
    op: 'drag', attempted: true, ok: null, changed: null, mutationPossible: true,
    signals: [], drag: { outcome: { complete: false } },
  })
  assert.equal(unknown.observed, 'unknown')
  assert.equal(unknown.mutationPossible, true)
})

test('batch summaries preserve guard failures, attempted state, and mutation possibility per step', () => {
  const result = summarizeActionEvidence({
    op: 'batch',
    batch: { ok: false, stoppedEarly: true },
    actions: [
      { index: 1, op: 'click', ok: true, attempted: true, mutationPossible: true, changed: true, signals: ['dom-mutations:1'] },
      { index: 2, op: 'type', ok: false, attempted: true, mutationPossible: true, changed: false, signals: [], typed: { measured: 'field' }, error: { code: 'BATCH_POSTCONDITION_FAILED' } },
      { index: 3, op: 'click', ok: false, attempted: false, mutationPossible: false, error: { code: 'BATCH_PRECONDITION_FAILED' } },
    ],
  })
  assert.equal(result.observed, 'changed')
  assert.equal(result.attempted, true)
  assert.equal(result.mutationPossible, true)
  assert.equal(result.steps[0].observed, 'changed')
  assert.equal(result.steps[1].observed, 'unchanged', 'guard failure does not erase a measured no-op')
  assert.equal(result.steps[1].mutationPossible, true)
  assert.equal(result.steps[2].observed, 'unknown')
  assert.equal(result.steps[2].attempted, false)
  assert.equal(result.steps[2].mutationPossible, false)
})

test('batch aggregation does not confuse successful waits, failures, or empty steps with no change', () => {
  const unchanged = summarizeActionEvidence({
    op: 'batch',
    actions: [
      { index: 1, op: 'wait_for', ok: true, attempted: false, mutationPossible: false },
      { index: 2, op: 'click', ok: true, changed: false, signals: [] },
    ],
  })
  assert.equal(unchanged.mutationPossible, true)
  assert.equal(unchanged.steps[0].observed, 'unknown', 'a successful wait is not change evidence')
  assert.equal(unchanged.steps[1].observed, 'unchanged')
  assert.equal(unchanged.observed, 'unknown')

  const safeFailure = summarizeActionEvidence({
    op: 'batch',
    actions: [{ index: 1, op: 'click', ok: false, attempted: false, mutationPossible: false }],
  })
  assert.equal(safeFailure.observed, 'unknown')
  assert.equal(safeFailure.attempted, false)
  assert.equal(safeFailure.mutationPossible, false)

  const allUnchanged = summarizeActionEvidence({
    op: 'batch',
    actions: [
      { index: 1, op: 'click', ok: true, changed: false, signals: [] },
      { index: 2, op: 'click_at', ok: true, points: [{ changed: false }] },
    ],
  })
  assert.equal(allUnchanged.observed, 'unchanged')
  assert.equal(allUnchanged.mutationPossible, true)

  const unknownFailure = summarizeActionEvidence({ op: 'batch', actions: [{ index: 1, op: 'click', ok: false }] })
  assert.equal(unknownFailure.mutationPossible, null)
  assert.equal(summarizeActionEvidence({ op: 'batch', actions: [] }).observed, 'unknown')
})

test('semantic deltas summarize new controls, changed state, new text, and removals', () => {
  const before = {
    scope,
    labels: [label(1, 'Save'), label(2, 'Open'), label(3, 'Leave')],
  }
  const after = {
    scope,
    labels: [label(1, 'Save', { disabled: true }), label(2, 'Open now'), label(4, 'Created')],
    newText: ['  Document   created  ', 'Document created', 'Saved locally'],
  }
  const delta = summarizeSemanticDelta(before, after)
  assert.equal(delta.status, 'complete')
  assert.deepEqual(delta.newOnScreen.map(entry => entry.id), [4])
  assert.deepEqual(delta.changed.map(entry => [entry.id, entry.fields]), [[1, ['disabled']], [2, ['text']]])
  assert.deepEqual(delta.newText, ['Document created', 'Saved locally'])
  assert.equal(delta.removedCount, 1)
  assert.deepEqual(delta.counts, { before: 3, after: 3, newOnScreen: 1, changed: 2, removed: 1, newText: 2 })
  assert.match(delta.text, /New on screen:\n· \[4\] button "Created"/u)
  assert.match(delta.text, /Changed:/u)
  assert.match(delta.text, /New text:\n· Document created/u)
  assert.equal(delta.diagnosticOnly, true)
})

test('semantic deltas distinguish a measured empty scope from missing observations', () => {
  const empty = summarizeSemanticDelta({ scope, labels: [] }, { scope, labels: [], newText: [] })
  assert.equal(empty.status, 'complete')
  assert.equal(empty.removedCount, 0)
  assert.deepEqual(empty.newOnScreen, [])

  for (const [before, after] of [
    [undefined, { scope, labels: [label(1, 'New')] }],
    [{ scope, labels: [label(1, 'Old')] }, undefined],
    [{ scope }, { scope, labels: [] }],
  ]) {
    const delta = summarizeSemanticDelta(before, after)
    assert.equal(delta.status, 'unknown')
    assert.equal(delta.removedCount, null)
    assert.deepEqual(delta.newOnScreen, [])
  }
})

test('semantic label matching fails closed across scopes and duplicate identities', () => {
  const mismatch = summarizeSemanticDelta(
    { scope: { ...scope, tabId: 7 }, labels: [label(1, 'Old')] },
    { scope: { ...scope, tabId: 8 }, labels: [label(1, 'New')] },
  )
  assert.equal(mismatch.status, 'unknown')
  assert.deepEqual(mismatch.reasons, ['SCOPE_MISMATCH'])
  assert.deepEqual(mismatch.changed, [])

  const duplicate = summarizeSemanticDelta(
    { scope, labels: [label(1, 'Old'), label(1, 'Old duplicate'), label(2, 'Gone')] },
    { scope, labels: [label(1, 'New'), label(2, 'Gone')] },
  )
  assert.equal(duplicate.status, 'partial')
  assert.equal(duplicate.ambiguousCount, 1)
  assert.equal(duplicate.reasons.includes('AMBIGUOUS_LABEL_ID'), true)
  assert.deepEqual(duplicate.changed, [])
  assert.equal(duplicate.removedCount, 0, 'an ambiguous before id is not declared removed')

  const afterDuplicate = summarizeSemanticDelta(
    { scope, labels: [label(1, 'Old')] },
    { scope, labels: [label(1, 'New'), label(1, 'Other')] },
  )
  assert.equal(afterDuplicate.removedCount, 0, 'an ambiguous after id is not declared a confirmed removal')
  assert.deepEqual(afterDuplicate.changed, [])
})

test('semantic deltas bound every list and the formatted summary', () => {
  const before = { scope, labels: [] }
  const after = {
    scope,
    labels: Array.from({ length: 8 }, (_, index) => label(index + 1, `Control ${index}`)),
    addedText: Array.from({ length: 8 }, (_, index) => `Message ${index}`),
  }
  const delta = summarizeSemanticDelta(before, after, { limit: 2, maxChars: 45 })
  assert.equal(delta.newOnScreen.length, 2)
  assert.equal(delta.newText.length, 2)
  assert.equal(delta.counts.newOnScreen, 8)
  assert.equal(delta.counts.newText, 8)
  assert.equal(delta.truncated, true)
  assert.equal(delta.status, 'partial')
  assert.equal(delta.reasons.includes('SUMMARY_TRUNCATED'), true)
  assert.ok(delta.text.length <= 45)
})

test('new text requires actual addition evidence and tolerates malformed entries', () => {
  const bodyOnly = summarizeSemanticDelta(
    { scope, labels: [], textLen: 2 },
    { scope, labels: [], textLen: 200, text: 'A whole page of replacement text' },
  )
  assert.deepEqual(bodyOnly.newText, [])
  assert.equal(bodyOnly.status, 'complete')

  const malformed = summarizeSemanticDelta(
    { scope, labels: [{ noId: true }] },
    { scope, labels: [label(1, 'Valid')], newText: [{ text: 'Visible', related: true }, { text: 'Elsewhere', related: false }, { ambiguous: true }, 42] },
  )
  assert.deepEqual(malformed.newText, ['Visible'])
  assert.equal(malformed.ambiguousCount, 1)
  assert.equal(malformed.invalidCount, 2)
  assert.equal(malformed.status, 'partial')
})

const expectation = (extra = {}) => ({ kind: 'value', scope, transition: 'changed', ...extra })
const evidence = (extra = {}) => ({ kind: 'value', scope, before: 'old', after: 'new', ...extra })

test('expectations require the requested before/after transition in the same target scope', () => {
  const met = evaluateExpectationEvidence(
    expectation({ before: 'old', after: 'new' }),
    evidence(),
  )
  assert.equal(met.status, 'met')
  assert.equal(met.reason, 'EVIDENCE_MATCHED')
  assert.deepEqual(met.scope, scope)
  assert.equal(met.diagnosticOnly, true)

  assert.equal(evaluateExpectationEvidence(expectation({ after: 'other' }), evidence()).status, 'unmet')
  assert.equal(evaluateExpectationEvidence(expectation({ before: 'wrong' }), evidence()).reason, 'BEFORE_MISMATCH')
  assert.equal(evaluateExpectationEvidence(expectation(), evidence({ before: 'same', after: 'same' })).reason, 'TRANSITION_NOT_OBSERVED')
})

test('unchanged and current-state expectations are explicit and independently evaluated', () => {
  const unchanged = expectation({ transition: 'unchanged', after: 'same' })
  assert.equal(evaluateExpectationEvidence(unchanged, evidence({ before: 'same', after: 'same' })).status, 'met')
  assert.equal(evaluateExpectationEvidence(unchanged, evidence()).reason, 'AFTER_MISMATCH')
  assert.equal(evaluateExpectationEvidence(expectation({ transition: 'unchanged' }), evidence()).reason, 'UNEXPECTED_TRANSITION')

  const current = expectation({ kind: 'text', transition: 'any', after: { includes: 'created' } })
  assert.equal(evaluateExpectationEvidence(current, evidence({ kind: 'text', before: undefined, after: 'Document created' })).status, 'met')
  assert.equal(evaluateExpectationEvidence(current, evidence({ kind: 'text', before: undefined, after: 'Nothing here' })).reason, 'AFTER_MISMATCH')
})

test('missing before/after observations stay unknown rather than becoming unmet or unchanged', () => {
  assert.equal(evaluateExpectationEvidence(expectation(), evidence({ before: undefined })).reason, 'BEFORE_MISSING')
  assert.equal(evaluateExpectationEvidence(expectation(), evidence({ after: undefined })).reason, 'AFTER_MISSING')
  assert.equal(evaluateExpectationEvidence(expectation(), evidence({ before: { observed: false } })).reason, 'BEFORE_MISSING')
  assert.equal(evaluateExpectationEvidence(expectation(), evidence({ after: { status: 'unknown' } })).reason, 'AFTER_MISSING')
  assert.equal(evaluateExpectationEvidence(expectation(), evidence({ after: { status: 'ambiguous' } })).reason, 'AMBIGUOUS_OBSERVATION')
  assert.equal(evaluateExpectationEvidence(expectation(), evidence({ before: { status: 'ambiguous' } })).reason, 'AMBIGUOUS_OBSERVATION')
})

test('scope, kind, relatedness, and target ambiguity fail closed', () => {
  const cases = [
    [evidence({ scope: { ...scope, label: 3 } }), 'SCOPE_MISMATCH'],
    [evidence({ kind: 'pixels' }), 'KIND_MISMATCH'],
    [evidence({ related: false }), 'UNRELATED_EVIDENCE'],
    [evidence({ ambiguous: true }), 'AMBIGUOUS_TARGET'],
    [evidence({ scope: undefined }), 'SCOPE_REQUIRED'],
    [undefined, 'EVIDENCE_MISSING'],
  ]
  for (const [input, reason] of cases) {
    assert.equal(evaluateExpectationEvidence(expectation(), input).reason, reason)
  }
})

test('expectation definitions require kind, scope, transition, and valid matchers', () => {
  const invalid = [
    [expectation({ kind: 'other' }), 'KIND_REQUIRED'],
    [expectation({ scope: {} }), 'SCOPE_REQUIRED'],
    [expectation({ scope: { nested: { label: 2 } } }), 'SCOPE_REQUIRED'],
    [expectation({ transition: undefined }), 'TRANSITION_REQUIRED'],
    [expectation({ transition: 'eventually' }), 'TRANSITION_REQUIRED'],
    [expectation({ after: { includes: '' } }), 'EXPECTATION_INVALID'],
    [expectation({ after: { includes: 'new', present: true } }), 'EXPECTATION_INVALID'],
  ]
  for (const [input, reason] of invalid) {
    assert.equal(evaluateExpectationEvidence(input, evidence()).reason, reason)
  }
  assert.equal(evaluateExpectationEvidence(null, evidence()).reason, 'EXPECTATION_INVALID')
})

test('false, zero, null, and observed-undefined remain real values with explicit observation wrappers', () => {
  assert.equal(evaluateExpectationEvidence(
    expectation({ kind: 'state', before: false, after: true }),
    evidence({ kind: 'state', before: false, after: true }),
  ).status, 'met')
  assert.equal(evaluateExpectationEvidence(
    expectation({ kind: 'value', before: 0, after: 1 }),
    evidence({ before: 0, after: 1 }),
  ).status, 'met')
  assert.equal(evaluateExpectationEvidence(
    expectation({ kind: 'label', before: { present: true }, after: { present: false } }),
    evidence({ kind: 'label', before: { id: 2 }, after: null }),
  ).status, 'met')
  assert.equal(evaluateExpectationEvidence(
    expectation({ kind: 'state', transition: 'unchanged', after: { present: false } }),
    evidence({ kind: 'state', before: { observed: true, value: undefined }, after: { observed: true, value: undefined } }),
  ).status, 'met')
})

test('all helper verdicts are diagnostic, never application-success claims', () => {
  const observed = deriveObservedChange({ op: 'click', changed: true, signals: ['pixels-changed'] })
  const delta = summarizeSemanticDelta([], [])
  const matched = evaluateExpectationEvidence(expectation(), evidence())
  const batch = summarizeActionEvidence({ op: 'batch', actions: [] })
  for (const value of [observed, delta, matched, batch]) {
    assert.equal(value.diagnosticOnly, true)
    assert.equal('success' in value, false)
    assert.equal('verified' in value, false)
  }
})

test('one-sided semantic scopes mismatch in both directions', () => {
  const scoped = { scope, labels: [label(1, 'Before')] }
  const unscoped = { labels: [label(1, 'After')] }
  for (const [before, after] of [[scoped, unscoped], [unscoped, scoped]]) {
    const delta = summarizeSemanticDelta(before, after)
    assert.equal(delta.status, 'unknown')
    assert.ok(delta.reasons.includes('SCOPE_MISMATCH'))
    assert.deepEqual(delta.changed, [])
    assert.deepEqual(delta.newOnScreen, [])
    assert.equal(delta.removedCount, null)
  }
  assert.equal(summarizeSemanticDelta(unscoped, unscoped).status, 'complete')
})

test('explicit null mutation and attempted states survive direct and batch derivation', () => {
  assert.equal(deriveObservedChange({ op: 'click', ok: true, mutationPossible: null }).mutationPossible, null)
  const summary = summarizeActionEvidence({
    actions: [{ index: 1, op: 'click', ok: true, attempted: null, mutationPossible: null, changed: null }],
  })
  assert.equal(summary.attempted, null)
  assert.equal(summary.mutationPossible, null)
  assert.equal(summary.steps[0].attempted, null)
  assert.equal(summary.steps[0].mutationPossible, null)
})
