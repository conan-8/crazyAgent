import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTION_EXPECT_SCHEMA,
  evaluateActionExpect,
  formatActionExpect,
  parseActionExpect,
  validateActionExpect,
} from '../lib/action-expect.js'

const DOC = { kind: 'docs-export', id: 'doc-1', target: 'unique', detail: 'plain-text' }
const FIELD = { kind: 'field', id: 7, target: 'unique', detail: 'Email' }
const TOOLBAR = { kind: 'toolbar', id: 'selection-1', target: 'unique' }
const DIALOG = { kind: 'native-dialog', target: 'not-applicable' }
const PIXELS = { kind: 'viewport-region', target: 'not-applicable', detail: '0,0,640,360' }

function textSnapshot(text, options = {}) {
  return {
    scope: options.scope ?? FIELD,
    text,
    complete: options.complete ?? true,
    ...options.limits ? { limits: options.limits } : {},
  }
}

function pixelEvidence(changed, options = {}) {
  return {
    before: { scope: options.beforeScope ?? PIXELS, captured: options.beforeCaptured ?? true },
    after: { scope: options.afterScope ?? PIXELS, captured: options.afterCaptured ?? true },
    changed,
  }
}

test('schema exposes only the five strict expectation checks', () => {
  assert.equal(ACTION_EXPECT_SCHEMA.type, 'object')
  assert.equal(ACTION_EXPECT_SCHEMA.additionalProperties, false)
  assert.equal(ACTION_EXPECT_SCHEMA.minProperties, 1)
  assert.deepEqual(Object.keys(ACTION_EXPECT_SCHEMA.properties).sort(), [
    'dialog', 'export_contains', 'pixel_changed', 'text_landed', 'toolbar_style',
  ])
  assert.equal(ACTION_EXPECT_SCHEMA.properties.pixel_changed.const, true)
  assert.equal(ACTION_EXPECT_SCHEMA.properties.toolbar_style.additionalProperties, false)
  assert.equal(ACTION_EXPECT_SCHEMA.properties.toolbar_style.minProperties, 1)
  assert.deepEqual(Object.keys(ACTION_EXPECT_SCHEMA.properties.toolbar_style.properties).sort(), [
    'bold', 'font', 'font_size', 'italic', 'paragraph_style', 'underline',
  ])
  assert.equal(ACTION_EXPECT_SCHEMA.properties.toolbar_style.properties.color, undefined)
  assert.equal(ACTION_EXPECT_SCHEMA.properties.toolbar_style.properties.highlight, undefined)
  assert.equal(ACTION_EXPECT_SCHEMA.properties.text_landed.pattern, '\\S')
  assert.equal(ACTION_EXPECT_SCHEMA.properties.export_contains.pattern, '\\S')
})

test('parse normalizes a complete expectation without mutating model input', () => {
  const input = {
    export_contains: 'Exported marker',
    toolbar_style: {
      paragraph_style: 'Heading 2', font_size: 18, bold: true, italic: false,
      underline: true, font: '  Syne  ',
    },
    dialog: 'closed',
    text_landed: 'hello\nworld',
    pixel_changed: true,
  }
  const copy = structuredClone(input)
  const checked = validateActionExpect(input)
  assert.equal(checked.ok, true)
  const parsed = parseActionExpect(input)
  assert.deepEqual(parsed, {
    ...input,
    toolbar_style: { ...input.toolbar_style, font: 'Syne' },
  })
  assert.deepEqual(input, copy)
  assert.notEqual(parsed.toolbar_style, input.toolbar_style)
})

test('validation rejects unknown, empty, and meaningless shapes before dispatch', () => {
  const invalid = [
    undefined, null, [], 'text', 1,
    {},
    { surprise: true },
    { text_landed: '' },
    { text_landed: '   \n ' },
    { text_landed: 42 },
    { text_landed: 'x'.repeat(20_001) },
    { export_contains: null },
    { export_contains: false },
    { dialog: 'gone' },
    { dialog: true },
    { pixel_changed: false },
    { pixel_changed: null },
    { toolbar_style: null },
    { toolbar_style: [] },
    { toolbar_style: {} },
    { toolbar_style: { width: 12 } },
    { toolbar_style: { bold: 'true' } },
    { toolbar_style: { italic: undefined } },
    { toolbar_style: { font_size: 0 } },
    { toolbar_style: { font_size: 1.5 } },
    { toolbar_style: { font_size: 401 } },
    { toolbar_style: { font: '  ' } },
    { toolbar_style: { paragraph_style: 'Huge heading' } },
    { toolbar_style: { color: 'red' } },
    { toolbar_style: { highlight: 'NONE' } },
  ]
  for (const value of invalid) {
    const checked = validateActionExpect(value)
    assert.equal(checked.ok, false, JSON.stringify(value))
    assert.ok(checked.errors.length > 0)
    assert.throws(() => parseActionExpect(value), error => {
      assert.equal(error.name, 'ActionExpectError')
      assert.equal(error.code, 'BAD_EXPECT')
      assert.ok(error.path.startsWith('expect'))
      assert.ok(error.issues.length > 0)
      return true
    }, JSON.stringify(value))
  }
})

test('validation reports every issue with a precise path and custom prefix', () => {
  const checked = validateActionExpect({ unknown: 1, dialog: 'gone', toolbar_style: { bold: 'yes' } }, { path: 'browser_batch.actions[0].expect' })
  assert.equal(checked.ok, false)
  assert.deepEqual(checked.errors.map(issue => issue.path), [
    'browser_batch.actions[0].expect.unknown',
    'browser_batch.actions[0].expect.dialog',
    'browser_batch.actions[0].expect.toolbar_style.bold',
  ])
})

test('executor capabilities reject incompatible evidence before dispatch', () => {
  const input = { export_contains: 'marker', pixel_changed: true }
  const checked = validateActionExpect(input, { supportedChecks: ['pixel_changed'] })
  assert.equal(checked.ok, false)
  assert.equal(checked.errors[0].code, 'EXPECT_UNSUPPORTED')
  assert.equal(checked.errors[0].path, 'expect.export_contains')
  assert.throws(() => parseActionExpect(input, { supportedChecks: new Set(['dialog']) }), error => error.code === 'EXPECT_UNSUPPORTED')
  assert.deepEqual(parseActionExpect({ pixel_changed: true }, { supportedChecks: ['pixel_changed'] }), { pixel_changed: true })
  assert.throws(() => validateActionExpect(input, { supportedChecks: 'pixel_changed' }), TypeError)
})

test('text_landed verifies only a scoped absent-to-present transition', () => {
  const expectation = { text_landed: 'new marker' }
  const evidence = {
    text_landed: {
      before: textSnapshot('old value'),
      after: textSnapshot('old value new marker'),
    },
  }
  const evidenceCopy = structuredClone(evidence)
  const action = { op: 'type', attempted: true, ok: false, mutationPossible: true, error: { code: 'READBACK_CLOSED', message: 'readback closed' } }
  const actionCopy = structuredClone(action)
  const result = evaluateActionExpect(expectation, evidence, action)
  assert.equal(result.observed, 'changed')
  assert.equal(result.expectation.status, 'verified')
  assert.equal(result.expectation.diagnosticOnly, false)
  assert.equal(result.expectation.checks[0].reason, 'appeared')
  assert.equal(result.expectation.checks[0].transitionRequired, 'absent-to-present')
  assert.deepEqual(result.action, action)
  assert.deepEqual(evidence, evidenceCopy)
  assert.deepEqual(action, actionCopy)
  assert.doesNotThrow(() => JSON.stringify(result))
})

test('pre-existing text alone remains unverified even when dispatch succeeded', () => {
  const result = evaluateActionExpect({ text_landed: 'already here' }, {
    text_landed: {
      before: textSnapshot('already here'),
      after: textSnapshot('already here'),
    },
  }, { attempted: true, ok: true, mutationPossible: true })
  const check = result.expectation.checks[0]
  assert.equal(result.observed, 'unchanged')
  assert.equal(result.expectation.status, 'unverified')
  assert.equal(check.reason, 'preexisting-text')
  assert.equal(result.action.ok, true)
})

test('unrelated text change cannot make pre-existing target text proof of landing', () => {
  const result = evaluateActionExpect({ text_landed: 'marker' }, {
    text_landed: {
      before: textSnapshot('marker and old text'),
      after: textSnapshot('marker and unrelated new text'),
      changed: true,
    },
  })
  assert.equal(result.observed, 'changed')
  assert.equal(result.expectation.status, 'unverified')
  assert.equal(result.expectation.checks[0].reason, 'preexisting-text')
})

test('missing or truncated baselines preserve unknown instead of proving a transition', () => {
  for (const before of [
    undefined,
    null,
    textSnapshot('unrelated', { complete: false }),
    { scope: FIELD },
  ]) {
    const result = evaluateActionExpect({ text_landed: 'marker' }, {
      text_landed: { before, after: textSnapshot('marker') },
    })
    assert.equal(result.observed, 'unknown')
    assert.equal(result.expectation.status, 'unverified')
    assert.notEqual(result.expectation.checks[0].reason, 'appeared')
  }
})

test('a partial after-read can prove presence but cannot prove absence', () => {
  const appeared = evaluateActionExpect({ text_landed: 'marker' }, {
    text_landed: {
      before: textSnapshot('prefix'),
      after: textSnapshot('prefix marker suffix', { complete: false, limits: ['export-truncated'] }),
    },
  })
  assert.equal(appeared.expectation.status, 'verified')
  assert.equal(appeared.observed, 'changed')
  assert.ok(appeared.expectation.checks[0].limits.includes('partial-after'))
  assert.ok(appeared.expectation.checks[0].limits.includes('export-truncated'))

  const missing = evaluateActionExpect({ text_landed: 'marker' }, {
    text_landed: {
      before: textSnapshot('prefix'),
      after: textSnapshot('prefix', { complete: false }),
    },
  })
  assert.equal(missing.expectation.status, 'unverified')
  assert.equal(missing.observed, 'unknown')
  assert.equal(missing.expectation.checks[0].reason, 'after-incomplete')
})

test('complete after-read absence diverges; unmeasured after-read stays unverified', () => {
  const missing = evaluateActionExpect({ text_landed: 'marker' }, {
    text_landed: { before: textSnapshot('same'), after: textSnapshot('same') },
  })
  assert.equal(missing.expectation.status, 'diverged')
  assert.equal(missing.observed, 'unchanged')
  assert.equal(missing.expectation.checks[0].reason, 'missing-after')

  for (const after of [undefined, null, { scope: FIELD, complete: true }]) {
    const result = evaluateActionExpect({ text_landed: 'marker' }, {
      text_landed: { before: textSnapshot('same'), after },
    })
    assert.equal(result.expectation.status, 'unverified')
    assert.equal(result.observed, 'unknown')
  }
})

test('text checks fail closed on scope mismatch and target ambiguity', () => {
  const mismatch = evaluateActionExpect({ text_landed: 'marker' }, {
    text_landed: {
      before: textSnapshot('none', { scope: FIELD }),
      after: textSnapshot('marker', { scope: { ...FIELD, id: 8 } }),
    },
  })
  assert.equal(mismatch.observed, 'unknown')
  assert.equal(mismatch.expectation.status, 'unverified')
  assert.equal(mismatch.expectation.checks[0].reason, 'scope-mismatch')
  assert.ok(mismatch.expectation.checks[0].limits.includes('scope-mismatch'))

  const ambiguousScope = { ...FIELD, target: 'ambiguous' }
  const ambiguous = evaluateActionExpect({ text_landed: 'marker' }, {
    text_landed: {
      before: textSnapshot('none', { scope: ambiguousScope }),
      after: textSnapshot('marker', { scope: ambiguousScope }),
    },
  })
  assert.equal(ambiguous.observed, 'unknown')
  assert.equal(ambiguous.expectation.status, 'unverified')
  assert.equal(ambiguous.expectation.checks[0].reason, 'target-ambiguous')
  assert.equal(ambiguous.expectation.checks[0].scope.after.target, 'ambiguous')
})

test('text matching is exact and case-sensitive', () => {
  const result = evaluateActionExpect({ text_landed: 'Marker' }, {
    text_landed: { before: textSnapshot('none'), after: textSnapshot('marker') },
  })
  assert.equal(result.expectation.status, 'diverged')
  assert.equal(result.expectation.checks[0].actual.after.contains, false)
})

test('export_contains requires the same transition and preserves export scope', () => {
  const verified = evaluateActionExpect({ export_contains: '<b>new</b>' }, {
    export_contains: {
      before: textSnapshot('<p>old</p>', { scope: { ...DOC, detail: 'html' } }),
      after: textSnapshot('<p>old</p><b>new</b>', { scope: { ...DOC, detail: 'html' } }),
    },
  })
  assert.equal(verified.expectation.status, 'verified')
  assert.equal(verified.expectation.checks[0].scope.before.kind, 'docs-export')
  assert.equal(verified.expectation.checks[0].scope.after.detail, 'html')

  const preexisting = evaluateActionExpect({ export_contains: 'old' }, {
    export_contains: {
      before: textSnapshot('old', { scope: DOC }),
      after: textSnapshot('old newly changed elsewhere', { scope: DOC }),
    },
  })
  assert.equal(preexisting.observed, 'changed')
  assert.equal(preexisting.expectation.status, 'unverified')
  assert.equal(preexisting.expectation.checks[0].reason, 'preexisting-text')
})

test('toolbar final state can verify with no baseline while observed stays unknown', () => {
  const result = evaluateActionExpect({ toolbar_style: { bold: true, italic: true } }, {
    toolbar_style: {
      after: { scope: TOOLBAR, style: { bold: true, italic: true } },
    },
  }, { attempted: true, ok: false, mutationPossible: true, status: 'failed' })
  assert.equal(result.expectation.status, 'verified')
  assert.equal(result.observed, 'unknown')
  assert.equal(result.action.ok, false)
  assert.equal(result.action.mutationPossible, true)
  assert.equal(result.action.status, 'failed')
})

test('toolbar style reports before/after state and precise mismatches', () => {
  const expectation = { toolbar_style: { bold: true, font: 'Syne', font_size: 18 } }
  const result = evaluateActionExpect(expectation, {
    toolbar_style: {
      before: { scope: TOOLBAR, style: { bold: false, font: 'Arial', font_size: 18 } },
      after: { scope: TOOLBAR, style: { bold: true, font: 'Arial', font_size: 18 } },
    },
  })
  const check = result.expectation.checks[0]
  assert.equal(result.observed, 'changed')
  assert.equal(result.expectation.status, 'diverged')
  assert.deepEqual(check.mismatches, [{ attribute: 'font', expected: 'Syne', actual: 'Arial' }])
  assert.deepEqual(check.actual.before, { bold: false, font: 'Arial', font_size: 18 })
})

test('toolbar unmeasured attributes are unknown, not unchanged or mismatches', () => {
  const result = evaluateActionExpect({ toolbar_style: { bold: true, italic: true } }, {
    toolbar_style: {
      before: { scope: TOOLBAR, style: { bold: true } },
      after: { scope: TOOLBAR, style: { bold: true, italic: null }, limits: ['mixed-selection'] },
    },
  })
  const check = result.expectation.checks[0]
  assert.equal(result.expectation.status, 'unverified')
  assert.equal(result.observed, 'unknown')
  assert.deepEqual(check.unmeasured, ['italic'])
  assert.equal(check.mismatches, undefined)
  assert.ok(check.limits.includes('mixed-selection'))
})

test('toolbar evidence requires a uniquely identified after-target', () => {
  for (const scope of [
    { ...TOOLBAR, target: 'ambiguous' },
    { ...TOOLBAR, target: 'stale' },
    { kind: 'toolbar', target: 'unique' },
    { ...TOOLBAR, target: 'not-applicable' },
  ]) {
    const result = evaluateActionExpect({ toolbar_style: { bold: true } }, {
      toolbar_style: { after: { scope, style: { bold: true } } },
    })
    assert.equal(result.expectation.status, 'unverified')
    assert.equal(result.observed, 'unknown')
  }
})

test('dialog verifies final state independently of dispatch and reports transitions', () => {
  const opened = evaluateActionExpect({ dialog: 'open' }, {
    dialog: {
      before: { scope: DIALOG, open: false },
      after: { scope: DIALOG, open: true },
    },
  }, { attempted: false, ok: false, mutationPossible: false })
  assert.equal(opened.expectation.status, 'verified')
  assert.equal(opened.observed, 'changed')
  assert.deepEqual(opened.action, { attempted: false, ok: false, mutationPossible: false })

  const alreadyClosed = evaluateActionExpect({ dialog: 'closed' }, {
    dialog: { before: { scope: DIALOG, open: false }, after: { scope: DIALOG, open: false } },
  })
  assert.equal(alreadyClosed.expectation.status, 'verified')
  assert.equal(alreadyClosed.observed, 'unchanged')
})

test('dialog mismatch and unknown states remain distinct', () => {
  const mismatch = evaluateActionExpect({ dialog: 'closed' }, {
    dialog: { before: { scope: DIALOG, open: true }, after: { scope: DIALOG, open: true } },
  })
  assert.equal(mismatch.expectation.status, 'diverged')
  assert.equal(mismatch.observed, 'unchanged')

  const unknown = evaluateActionExpect({ dialog: 'closed' }, {
    dialog: { before: { scope: DIALOG, open: true }, after: { scope: DIALOG } },
  })
  assert.equal(unknown.expectation.status, 'unverified')
  assert.equal(unknown.observed, 'unknown')
  assert.equal(unknown.expectation.checks[0].actual.after.open, null)
})

test('pixel change is measured but explicitly diagnostic-only', () => {
  const action = { attempted: true, ok: false, mutationPossible: true }
  const result = evaluateActionExpect({ pixel_changed: true }, { pixel_changed: pixelEvidence(true) }, action)
  assert.equal(result.observed, 'changed')
  assert.equal(result.expectation.status, 'verified')
  assert.equal(result.expectation.diagnosticOnly, true)
  assert.deepEqual(result.action, action)
  assert.ok(result.expectation.checks[0].limits.includes('diagnostic-only'))

  const unchanged = evaluateActionExpect({ pixel_changed: true }, { pixel_changed: pixelEvidence(false) })
  assert.equal(unchanged.observed, 'unchanged')
  assert.equal(unchanged.expectation.status, 'diverged')
})

test('uncompared pixels and generic DOM change claims stay unknown', () => {
  for (const evidence of [
    pixelEvidence(null),
    pixelEvidence(true, { beforeCaptured: false }),
    pixelEvidence(true, { afterCaptured: false }),
    { ...pixelEvidence(true), after: { scope: { ...PIXELS, detail: 'different' }, captured: true } },
    { changed: true, domMutations: 12 },
  ]) {
    const result = evaluateActionExpect({ pixel_changed: true }, { pixel_changed: evidence })
    assert.equal(result.observed, 'unknown')
    assert.equal(result.expectation.status, 'unverified')
    assert.equal(result.expectation.diagnosticOnly, true)
  }
})

test('aggregate divergence and observed change take precedence without hiding unknown checks', () => {
  const result = evaluateActionExpect({ dialog: 'closed', pixel_changed: true, text_landed: 'marker' }, {
    dialog: { after: { scope: DIALOG, open: true } },
    pixel_changed: pixelEvidence(true),
    text_landed: { after: textSnapshot('marker', { complete: false }) },
  })
  assert.equal(result.observed, 'changed')
  assert.equal(result.expectation.status, 'diverged')
  assert.deepEqual(result.expectation.checks.map(check => [check.key, check.status]), [
    ['dialog', 'diverged'], ['text_landed', 'unverified'], ['pixel_changed', 'verified'],
  ])
  assert.equal(result.expectation.diagnosticOnly, false)
})

test('all-measured no-change observations aggregate to unchanged, never unknown', () => {
  const result = evaluateActionExpect({ dialog: 'closed', pixel_changed: true }, {
    dialog: { before: { scope: DIALOG, open: true }, after: { scope: DIALOG, open: true } },
    pixel_changed: pixelEvidence(false),
  })
  assert.equal(result.observed, 'unchanged')
  assert.equal(result.expectation.status, 'diverged')
})

test('precondition and postcondition action outcomes remain separate from evidence', () => {
  const precondition = evaluateActionExpect({ dialog: 'open' }, {}, {
    attempted: false, ok: false, mutationPossible: false,
    error: { code: 'BATCH_PRECONDITION_FAILED', message: 'not dispatched' },
  })
  assert.deepEqual(precondition.action, {
    attempted: false, ok: false, mutationPossible: false,
    error: { code: 'BATCH_PRECONDITION_FAILED', message: 'not dispatched' },
  })
  assert.equal(precondition.expectation.status, 'unverified')

  const postcondition = evaluateActionExpect({ dialog: 'open' }, {}, {
    attempted: true, ok: false, mutationPossible: true,
    error: { code: 'BATCH_POSTCONDITION_FAILED', message: 'dispatched' },
  })
  assert.equal(postcondition.action.attempted, true)
  assert.equal(postcondition.action.mutationPossible, true)
  assert.equal(postcondition.action.ok, false)
  assert.equal(postcondition.expectation.status, 'unverified')

  const unmeasuredAction = evaluateActionExpect({ dialog: 'open' }, {})
  assert.deepEqual(unmeasuredAction.action, { attempted: null, ok: null, mutationPossible: null })
})

test('format keeps expectation, observation, action, scope, and limits explicit', () => {
  const result = evaluateActionExpect({ text_landed: 'already here', pixel_changed: true }, {
    text_landed: { before: textSnapshot('already here'), after: textSnapshot('already here') },
    pixel_changed: pixelEvidence(true, { beforeScope: { ...PIXELS, detail: '0,0,640,360' } }),
  }, { attempted: true, ok: false, mutationPossible: true, status: 'partial', error: { code: 'POSTCONDITION_FAILED' } })
  const text = formatActionExpect(result)
  assert.match(text, /expectation: UNVERIFIED · observed=changed/)
  assert.match(text, /action: attempted=true · ok=false · mutationPossible=true · status=partial · error=POSTCONDITION_FAILED/)
  assert.match(text, /text_landed: UNVERIFIED · observed=unchanged · reason=preexisting-text/)
  assert.match(text, /pixel_changed: VERIFIED · observed=changed/)
  assert.match(text, /scope=field=7\[unique\] \(Email\)/)
  assert.match(text, /limits=diagnostic-only/)
  assert.match(text, /expectation evidence never rewrites action\.ok, attempted, or mutationPossible/)
  assert.match(text, /pixel\/DOM change alone cannot prove/)
  assert.doesNotMatch(text, /action: APPLIED|text landed successfully|mutation repaired/)
})

test('format is fail-closed for malformed results and does not invent action success', () => {
  const text = formatActionExpect({})
  assert.match(text, /expectation: UNVERIFIED · observed=unknown/)
  assert.match(text, /action: attempted=unknown · ok=unknown · mutationPossible=unknown/)
})

test('evaluate validates the expectation before touching executor evidence', () => {
  const evidence = new Proxy({}, { get: () => { throw new Error('evidence must not be read') } })
  assert.throws(() => evaluateActionExpect({ pixel_changed: false }, evidence), error => error.code === 'BAD_EXPECT')
})
