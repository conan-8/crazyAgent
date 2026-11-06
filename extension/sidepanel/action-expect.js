const EXPECT_KEYS = ['export_contains', 'toolbar_style', 'dialog', 'text_landed', 'pixel_changed']
const STYLE_KEYS = ['paragraph_style', 'font_size', 'bold', 'italic', 'underline', 'font']
const PARAGRAPH_STYLES = ['Normal text', 'Title', 'Subtitle', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6']
const TARGET_STATES = ['unique', 'ambiguous', 'missing', 'stale', 'unknown', 'not-applicable']
const MAX_EXPECT_TEXT = 20_000
const NON_WHITESPACE = '\\S'

export const ACTION_EXPECT_DIRECT_CHECKS = Object.freeze({
  click: Object.freeze(['dialog', 'pixel_changed', 'export_contains', 'toolbar_style']),
  click_at: Object.freeze(['dialog', 'pixel_changed']),
  type: Object.freeze(['text_landed', 'dialog', 'pixel_changed', 'export_contains']),
  press_key: Object.freeze(['text_landed', 'dialog', 'pixel_changed', 'export_contains', 'toolbar_style']),
})
export const ACTION_EXPECT_BATCH_CHECKS = Object.freeze({
  click: Object.freeze(['dialog']),
  click_at: Object.freeze(['dialog']),
  type: Object.freeze(['text_landed', 'dialog']),
  press_key: Object.freeze(['text_landed', 'dialog']),
})
export const ACTION_TOOLBAR_ATTRIBUTES = Object.freeze([...STYLE_KEYS])
const BATCH_UNSUPPORTED_OPS = ['hover', 'select_option', 'scroll', 'wait_for', 'navigate', 'select']

const TOOLBAR_STYLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  description: 'Desired style at one uniquely resolved toolbar/selection scope.',
  properties: {
    paragraph_style: { type: 'string', enum: PARAGRAPH_STYLES },
    font_size: { type: 'integer', minimum: 1, maximum: 400 },
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
    underline: { type: 'boolean' },
    font: { type: 'string', minLength: 1, maxLength: 100, pattern: NON_WHITESPACE },
  },
}

/** JSON Schema for an `expect` tool property. Runtime parsing is also required. */
export const ACTION_EXPECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  description: 'Observed facts expected after dispatch. Text/export checks require an absent-to-present transition. Pixel change is diagnostic, never action-outcome proof.',
  properties: {
    export_contains: {
      type: 'string', minLength: 1, maxLength: MAX_EXPECT_TEXT, pattern: NON_WHITESPACE,
      description: 'Exact case-sensitive substring that was absent in the complete scoped baseline export and present after dispatch.',
    },
    toolbar_style: TOOLBAR_STYLE_SCHEMA,
    dialog: { type: 'string', enum: ['open', 'closed'], description: 'Desired final dialog state in the same identified scope.' },
    text_landed: {
      type: 'string', minLength: 1, maxLength: MAX_EXPECT_TEXT, pattern: NON_WHITESPACE,
      description: 'Exact case-sensitive substring that newly appeared at the scoped target; pre-existing text cannot verify input.',
    },
    pixel_changed: {
      type: 'boolean', const: true,
      description: 'Require compared pixels in one unchanged viewport/region scope to differ. Diagnostic only.',
    },
  },
}

export function actionExpectSchemaForOperation(op, options = {}) {
  const capabilities = options.batch === true ? ACTION_EXPECT_BATCH_CHECKS : ACTION_EXPECT_DIRECT_CHECKS
  const supported = capabilities[op] ?? []
  return {
    ...ACTION_EXPECT_SCHEMA,
    properties: Object.fromEntries(supported.map(key => [key, ACTION_EXPECT_SCHEMA.properties[key]])),
  }
}

function actionExpectBatchArgsSchema(op) {
  return {
    type: 'object',
    properties: { expect: actionExpectSchemaForOperation(op, { batch: true }) },
  }
}

export function actionExpectBatchItemConditions() {
  const conditions = Object.keys(ACTION_EXPECT_BATCH_CHECKS).map(op => ({
    if: { properties: { op: { const: op } }, required: ['op'] },
    then: {
      properties: {
        expect: actionExpectSchemaForOperation(op, { batch: true }),
        args: actionExpectBatchArgsSchema(op),
      },
    },
  }))
  conditions.push({
    if: { properties: { op: { enum: BATCH_UNSUPPORTED_OPS } }, required: ['op'] },
    then: {
      properties: {
        expect: false,
        args: { type: 'object', properties: { expect: false } },
      },
    },
  })
  return conditions
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validationIssue(errors, path, message, code = 'BAD_EXPECT') {
  errors.push({ code, path, message: `${path} ${message}` })
}

function expectedText(value, path, errors) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_EXPECT_TEXT) {
    validationIssue(errors, path, `must be a non-whitespace string of at most ${MAX_EXPECT_TEXT} characters`)
    return undefined
  }
  return value
}

function expectedStyle(value, path, errors) {
  if (!isRecord(value)) {
    validationIssue(errors, path, 'must be an object with at least one supported style attribute')
    return undefined
  }
  for (const key of Object.keys(value)) {
    if (!STYLE_KEYS.includes(key)) validationIssue(errors, `${path}.${key}`, 'is not a supported toolbar style attribute')
  }
  if (Object.keys(value).length === 0) validationIssue(errors, path, 'must contain at least one style attribute')
  const style = {}
  for (const key of STYLE_KEYS) {
    if (!Object.hasOwn(value, key)) continue
    const attributePath = `${path}.${key}`
    const attribute = value[key]
    if (key === 'paragraph_style') {
      if (!PARAGRAPH_STYLES.includes(attribute)) validationIssue(errors, attributePath, `must be one of ${PARAGRAPH_STYLES.join(', ')}`)
      else style[key] = attribute
    } else if (key === 'font_size') {
      if (!Number.isInteger(attribute) || attribute < 1 || attribute > 400) validationIssue(errors, attributePath, 'must be an integer from 1 to 400')
      else style[key] = attribute
    } else if (['bold', 'italic', 'underline'].includes(key)) {
      if (typeof attribute !== 'boolean') validationIssue(errors, attributePath, 'must be a boolean')
      else style[key] = attribute
    } else if (key === 'font') {
      if (typeof attribute !== 'string' || attribute.trim().length === 0 || attribute.length > 100) {
        validationIssue(errors, attributePath, 'must be a non-empty string of at most 100 characters')
      } else style[key] = attribute.trim()
    }
  }
  return style
}

function supportedCheckSet(options) {
  if (options?.supportedChecks === undefined) return undefined
  if (!Array.isArray(options.supportedChecks) && !(options.supportedChecks instanceof Set)) {
    throw new TypeError('supportedChecks must be an array or Set')
  }
  return new Set(options.supportedChecks)
}

function supportedStyleSet(options) {
  if (options?.supportedStyleAttributes === undefined) return undefined
  if (!Array.isArray(options.supportedStyleAttributes) && !(options.supportedStyleAttributes instanceof Set)) {
    throw new TypeError('supportedStyleAttributes must be an array or Set')
  }
  return new Set(options.supportedStyleAttributes)
}

/**
 * Validate without throwing for model input. `supportedChecks` is the executor's
 * evidence capability list for this action; omit it only when all five probes
 * are available. An invalid capability list is a programmer error and throws.
 */
export function validateActionExpect(value, options = {}) {
  const path = typeof options?.path === 'string' && options.path.length > 0 ? options.path : 'expect'
  const supported = supportedCheckSet(options)
  const supportedStyles = supportedStyleSet(options)
  const errors = []
  if (!isRecord(value)) {
    validationIssue(errors, path, 'must be an object with at least one expectation')
    return { ok: false, errors }
  }
  const keys = Object.keys(value)
  if (keys.length === 0) validationIssue(errors, path, 'must contain at least one expectation')
  const normalized = {}
  for (const key of keys) {
    if (!EXPECT_KEYS.includes(key)) {
      validationIssue(errors, `${path}.${key}`, 'is an unknown expectation key')
      continue
    }
    if (supported !== undefined && !supported.has(key)) {
      validationIssue(errors, `${path}.${key}`, 'is incompatible with this action\'s available evidence; reject it before dispatch', 'EXPECT_UNSUPPORTED')
      continue
    }
    const itemPath = `${path}.${key}`
    const item = value[key]
    if (key === 'export_contains' || key === 'text_landed') {
      const text = expectedText(item, itemPath, errors)
      if (text !== undefined) normalized[key] = text
    } else if (key === 'toolbar_style') {
      const style = expectedStyle(item, itemPath, errors)
      if (style !== undefined) {
        for (const attribute of Object.keys(style)) {
          if (supportedStyles !== undefined && !supportedStyles.has(attribute)) {
            validationIssue(errors, `${itemPath}.${attribute}`, 'is incompatible with this action\'s available toolbar evidence; reject it before dispatch', 'EXPECT_UNSUPPORTED')
          }
        }
        normalized[key] = style
      }
    } else if (key === 'dialog') {
      if (item !== 'open' && item !== 'closed') validationIssue(errors, itemPath, 'must be "open" or "closed"')
      else normalized[key] = item
    } else if (key === 'pixel_changed') {
      if (item !== true) validationIssue(errors, itemPath, 'must be true; unchanged pixels cannot prove an action outcome')
      else normalized[key] = true
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: normalized }
}

/** Parse and normalize before dispatch, throwing a coded error on the first issue. */
export function parseActionExpect(value, options = {}) {
  const checked = validateActionExpect(value, options)
  if (checked.ok) return checked.value
  const first = checked.errors[0]
  const error = new Error(first.message)
  error.name = 'ActionExpectError'
  error.code = first.code
  error.path = first.path
  error.issues = checked.errors
  throw error
}

export function assertBatchExpectSequence(actions, options = {}) {
  const prefix = typeof options.pathPrefix === 'string' && options.pathPrefix.length > 0 ? options.pathPrefix : 'actions'
  let documentMayChange = false
  for (const [index, action] of (Array.isArray(actions) ? actions : []).entries()) {
    const expectation = action?.args?.expect
    const sensitive = ['text_landed', 'export_contains', 'toolbar_style'].find(key => Object.hasOwn(expectation ?? {}, key))
    if (documentMayChange && sensitive !== undefined) {
      const path = `${prefix}[${index}].expect.${sensitive}`
      const error = new Error(`${path} cannot be verified after an earlier batch step that may navigate or replace the document; move it before those steps or use a separate call after a fresh view`)
      error.name = 'ActionExpectError'
      error.code = 'EXPECT_UNSUPPORTED'
      error.path = path
      throw error
    }
    if (action?.op !== 'wait_for') documentMayChange = true
  }
}

function triState(value) {
  return value === true ? true : value === false ? false : null
}

function actionOutcome(value) {
  const action = isRecord(value) ? value : {}
  const result = {
    attempted: triState(action.attempted),
    ok: triState(action.ok),
    mutationPossible: triState(action.mutationPossible),
  }
  if (typeof action.op === 'string') result.op = action.op
  if (Number.isSafeInteger(action.index)) result.index = action.index
  if (typeof action.status === 'string') result.status = action.status
  if (isRecord(action.error)) {
    result.error = {
      ...typeof action.error.code === 'string' ? { code: action.error.code } : {},
      ...typeof action.error.message === 'string' ? { message: action.error.message } : {},
    }
  }
  return result
}

function evidenceLimits(...values) {
  const limits = []
  for (const value of values) {
    if (!Array.isArray(value)) continue
    for (const limit of value) {
      if (typeof limit === 'string' && limit.length > 0 && !limits.includes(limit)) limits.push(limit)
    }
  }
  return limits
}

function readScope(value, allowNotApplicable) {
  if (!isRecord(value)) return { value: null, usable: false, reason: 'scope-unavailable' }
  const allowed = ['kind', 'id', 'target', 'detail']
  if (Object.keys(value).some(key => !allowed.includes(key))
    || typeof value.kind !== 'string' || value.kind.trim().length === 0 || value.kind.trim() !== value.kind
    || !TARGET_STATES.includes(value.target)
    || (value.id !== undefined && typeof value.id !== 'string' && !Number.isSafeInteger(value.id))
    || (typeof value.id === 'string' && value.id.length === 0)
    || (value.detail !== undefined && (typeof value.detail !== 'string' || value.detail.length === 0))) {
    return { value: null, usable: false, reason: 'scope-invalid' }
  }
  const scope = {
    kind: value.kind,
    target: value.target,
    ...value.id === undefined ? {} : { id: value.id },
    ...value.detail === undefined ? {} : { detail: value.detail },
  }
  if (['ambiguous', 'missing', 'stale', 'unknown'].includes(scope.target)) {
    return { value: scope, usable: false, reason: `target-${scope.target}` }
  }
  if (scope.target === 'not-applicable') {
    return allowNotApplicable
      ? { value: scope, usable: true, reason: undefined }
      : { value: scope, usable: false, reason: 'target-required' }
  }
  if (scope.id === undefined) return { value: scope, usable: false, reason: 'target-unidentified' }
  return { value: scope, usable: true, reason: undefined }
}

function compareScopes(before, after) {
  if (!before.usable) return { same: false, reason: before.reason ?? 'baseline-unavailable' }
  if (!after.usable) return { same: false, reason: after.reason ?? 'after-unavailable' }
  if (JSON.stringify(before.value) !== JSON.stringify(after.value)) return { same: false, reason: 'scope-mismatch' }
  return { same: true, reason: undefined }
}

function scopeResult(before, after) {
  return { before: before.value, after: after.value }
}

function scopeLimits(result, before, after, pair) {
  for (const reason of [before.reason, after.reason, pair.reason]) {
    if (reason !== undefined && !result.limits.includes(reason)) result.limits.push(reason)
  }
}

function textSnapshot(value) {
  const snapshot = isRecord(value) ? value : {}
  return {
    scope: readScope(snapshot.scope, false),
    text: typeof snapshot.text === 'string' ? snapshot.text : null,
    contains: typeof snapshot.contains === 'boolean' ? snapshot.contains : null,
    complete: triState(snapshot.complete),
    chars: Number.isSafeInteger(snapshot.chars) && snapshot.chars >= 0 ? snapshot.chars : null,
  }
}

function textActual(snapshot, expected) {
  return {
    contains: snapshot.contains ?? (snapshot.text === null ? null : snapshot.text.includes(expected)),
    complete: snapshot.complete,
    chars: snapshot.chars ?? (snapshot.text === null ? null : snapshot.text.length),
  }
}

function evaluateTextTransition(key, expected, evidence) {
  const check = isRecord(evidence) ? evidence : {}
  const before = textSnapshot(check.before)
  const after = textSnapshot(check.after)
  const pair = compareScopes(before.scope, after.scope)
  const beforeContains = before.contains ?? (before.text === null ? null : before.text.includes(expected))
  const afterContains = after.contains ?? (after.text === null ? null : after.text.includes(expected))
  const beforeReadable = (before.text !== null || before.contains !== null) && before.scope.usable
  const afterReadable = (after.text !== null || after.contains !== null) && after.scope.usable
  const beforePresenceKnown = pair.same && beforeReadable && (beforeContains === true || before.complete === true)
  const afterPresenceKnown = afterReadable && (afterContains === true || after.complete === true)
  let observed = 'unknown'
  if (pair.same && before.text !== null && after.text !== null && before.complete === true && after.complete === true) {
    observed = before.text === after.text ? 'unchanged' : 'changed'
  } else if (beforePresenceKnown && pair.same && afterPresenceKnown && beforeContains !== afterContains) {
    observed = 'changed'
  }

  let status = 'unverified'
  let reason
  if (afterReadable && afterContains === true) {
    if (beforePresenceKnown && beforeContains === false) {
      status = 'verified'
      reason = 'appeared'
      observed = 'changed'
    } else if (pair.same && beforeReadable && beforeContains === true) {
      reason = 'preexisting-text'
    } else {
      reason = pair.same ? 'baseline-unavailable' : pair.reason
    }
  } else if (afterReadable && afterContains === false && after.complete === true) {
    status = 'diverged'
    reason = 'missing-after'
  } else {
    reason = afterReadable ? 'after-incomplete' : after.scope.reason ?? 'after-unavailable'
  }
  const result = {
    key,
    expected,
    status,
    observed,
    reason,
    actual: { before: textActual(before, expected), after: textActual(after, expected) },
    scope: scopeResult(before.scope, after.scope),
    limits: evidenceLimits(check.limits, isRecord(check.before) ? check.before.limits : undefined, isRecord(check.after) ? check.after.limits : undefined),
    transitionRequired: 'absent-to-present',
  }
  if ((before.text !== null || before.contains !== null) && before.complete !== true) result.limits.push('partial-before')
  if ((after.text !== null || after.contains !== null) && after.complete !== true) result.limits.push('partial-after')
  scopeLimits(result, before.scope, after.scope, pair)
  return result
}

function actualStyleValue(attribute, value) {
  if (attribute === 'paragraph_style') return PARAGRAPH_STYLES.includes(value) ? value : null
  if (attribute === 'font_size') return Number.isInteger(value) && value >= 1 && value <= 400 ? value : null
  if (['bold', 'italic', 'underline'].includes(attribute)) return typeof value === 'boolean' ? value : null
  if (attribute === 'font') return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
  return null
}

function styleSnapshot(value, expected) {
  const snapshot = isRecord(value) ? value : {}
  const style = isRecord(snapshot.style) ? snapshot.style : {}
  const actual = {}
  for (const key of Object.keys(expected)) actual[key] = actualStyleValue(key, style[key])
  return { scope: readScope(snapshot.scope, false), actual, readable: isRecord(snapshot.style) }
}

function evaluateToolbarStyle(expected, evidence) {
  const check = isRecord(evidence) ? evidence : {}
  const before = styleSnapshot(check.before, expected)
  const after = styleSnapshot(check.after, expected)
  const pair = compareScopes(before.scope, after.scope)
  const mismatches = []
  const unmeasured = []
  for (const [attribute, wanted] of Object.entries(expected)) {
    if (!after.readable || !after.scope.usable || after.actual[attribute] === null) unmeasured.push(attribute)
    else if (after.actual[attribute] !== wanted) mismatches.push({ attribute, expected: wanted, actual: after.actual[attribute] })
  }
  let status = 'unverified'
  let reason = 'style-unmeasured'
  if (mismatches.length > 0) {
    status = 'diverged'
    reason = 'style-mismatch'
  } else if (unmeasured.length === 0) {
    status = 'verified'
    reason = 'style-matched'
  } else if (!after.scope.usable) reason = after.scope.reason
  let observed = 'unknown'
  if (pair.same && before.readable && after.readable) {
    const comparable = Object.keys(expected).filter(attribute => before.actual[attribute] !== null && after.actual[attribute] !== null)
    if (comparable.some(attribute => before.actual[attribute] !== after.actual[attribute])) observed = 'changed'
    else if (comparable.length === Object.keys(expected).length) observed = 'unchanged'
  }
  const result = {
    key: 'toolbar_style',
    expected,
    status,
    observed,
    reason,
    actual: { before: before.actual, after: after.actual },
    scope: scopeResult(before.scope, after.scope),
    limits: evidenceLimits(check.limits, isRecord(check.before) ? check.before.limits : undefined, isRecord(check.after) ? check.after.limits : undefined),
    ...mismatches.length > 0 ? { mismatches } : {},
    ...unmeasured.length > 0 ? { unmeasured } : {},
  }
  scopeLimits(result, before.scope, after.scope, pair)
  return result
}

function dialogSnapshot(value) {
  const snapshot = isRecord(value) ? value : {}
  return {
    scope: readScope(snapshot.scope, true),
    open: typeof snapshot.open === 'boolean' ? snapshot.open : null,
  }
}

function evaluateDialog(expected, evidence) {
  const check = isRecord(evidence) ? evidence : {}
  const before = dialogSnapshot(check.before)
  const after = dialogSnapshot(check.after)
  const pair = compareScopes(before.scope, after.scope)
  const afterKnown = after.open !== null && after.scope.usable
  const wanted = expected === 'open'
  const status = !afterKnown ? 'unverified' : after.open === wanted ? 'verified' : 'diverged'
  const reason = !afterKnown ? after.scope.reason ?? 'dialog-unmeasured'
    : status === 'verified' ? 'dialog-matched' : 'dialog-mismatch'
  const observed = pair.same && before.open !== null && after.open !== null
    ? before.open === after.open ? 'unchanged' : 'changed'
    : 'unknown'
  const result = {
    key: 'dialog', expected, status, observed, reason,
    actual: { before: { open: before.open }, after: { open: after.open } },
    scope: scopeResult(before.scope, after.scope),
    limits: evidenceLimits(check.limits, isRecord(check.before) ? check.before.limits : undefined, isRecord(check.after) ? check.after.limits : undefined),
  }
  scopeLimits(result, before.scope, after.scope, pair)
  return result
}

function pixelSnapshot(value) {
  const snapshot = isRecord(value) ? value : {}
  return { scope: readScope(snapshot.scope, true), captured: snapshot.captured === true }
}

function evaluatePixelChanged(evidence) {
  const check = isRecord(evidence) ? evidence : {}
  const before = pixelSnapshot(check.before)
  const after = pixelSnapshot(check.after)
  const pair = compareScopes(before.scope, after.scope)
  const changed = typeof check.changed === 'boolean' ? check.changed : null
  const measured = changed !== null && before.captured && after.captured && pair.same
  const observed = !measured ? 'unknown' : changed ? 'changed' : 'unchanged'
  const status = !measured ? 'unverified' : changed ? 'verified' : 'diverged'
  const reason = !measured ? pair.reason ?? 'pixels-unmeasured' : changed ? 'pixels-changed' : 'pixels-unchanged'
  const result = {
    key: 'pixel_changed', expected: true, status, observed, reason,
    actual: { before: { captured: before.captured }, after: { captured: after.captured }, changed },
    scope: scopeResult(before.scope, after.scope),
    limits: evidenceLimits(check.limits, isRecord(check.before) ? check.before.limits : undefined, isRecord(check.after) ? check.after.limits : undefined),
  }
  result.limits.push('diagnostic-only')
  scopeLimits(result, before.scope, after.scope, pair)
  return result
}

/**
 * Evaluate scoped executor evidence without mutating inputs or repairing actions.
 *
 * Evidence is keyed like the expectation. Text/export snapshots are
 * `{scope,text,complete,limits?}`; toolbar snapshots are `{scope,style,limits?}`;
 * dialog snapshots are `{scope,open,limits?}`. Pixel checks use
 * `{before,after,changed,limits?}` with `{scope,captured:true}` snapshots.
 * `complete:false` means absence is unknown, while present text remains measured.
 *
 * A scope is `{kind,target,id?,detail?}`. Target is unique, ambiguous, missing,
 * stale, unknown, or not-applicable. Text/export/toolbar scopes must identify a
 * unique target. Dialog/pixel scopes may use not-applicable for a global dialog
 * or viewport. Before/after scopes must match for transition/change claims.
 */
export function evaluateActionExpect(expectation, evidence = {}, action = {}) {
  const expected = parseActionExpect(expectation)
  const source = isRecord(evidence) ? evidence : {}
  const checks = []
  for (const key of EXPECT_KEYS) {
    if (!Object.hasOwn(expected, key)) continue
    if (key === 'export_contains' || key === 'text_landed') checks.push(evaluateTextTransition(key, expected[key], source[key]))
    else if (key === 'toolbar_style') checks.push(evaluateToolbarStyle(expected[key], source[key]))
    else if (key === 'dialog') checks.push(evaluateDialog(expected[key], source[key]))
    else if (key === 'pixel_changed') checks.push(evaluatePixelChanged(source[key]))
  }
  const observed = checks.some(check => check.observed === 'changed') ? 'changed'
    : checks.some(check => check.observed === 'unknown') ? 'unknown' : 'unchanged'
  const status = checks.some(check => check.status === 'diverged') ? 'diverged'
    : checks.some(check => check.status === 'unverified') ? 'unverified' : 'verified'
  const diagnosticOnly = checks.every(check => check.key === 'pixel_changed')
  return {
    action: actionOutcome(action),
    observed,
    expectation: {
      status,
      diagnosticOnly,
      limits: evidenceLimits(...checks.map(check => check.limits)),
      checks,
    },
  }
}

function shortJson(value, limit = 240) {
  let text
  try { text = JSON.stringify(value) ?? 'null' } catch { text = '"[unserializable]"' }
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function flag(value) {
  return value === true ? 'true' : value === false ? 'false' : 'unknown'
}

function scopeText(scope) {
  if (!isRecord(scope)) return 'unknown'
  const id = scope.id === undefined ? '' : `=${typeof scope.id === 'string' ? scope.id : String(scope.id)}`
  const detail = typeof scope.detail === 'string' ? ` (${scope.detail})` : ''
  return `${scope.kind}${id}[${scope.target}]${detail}`
}

function checkScopeText(scope) {
  const before = scopeText(scope?.before)
  const after = scopeText(scope?.after)
  if (before === after) return `scope=${before}`
  return `scope.before=${before} scope.after=${after}`
}

/** Format an evaluated result as compact model-facing lines. */
export function formatActionExpect(result) {
  const expectation = isRecord(result?.expectation) ? result.expectation : {}
  const status = ['verified', 'diverged', 'unverified'].includes(expectation.status) ? expectation.status : 'unverified'
  const observed = ['changed', 'unchanged', 'unknown'].includes(result?.observed) ? result.observed : 'unknown'
  const action = isRecord(result?.action) ? result.action : {}
  const lines = [
    `expectation: ${status.toUpperCase()} · observed=${observed} · evidence=${expectation.diagnosticOnly === true ? 'diagnostic-only' : 'scoped-observations'}`,
    `action: attempted=${flag(action.attempted)} · ok=${flag(action.ok)} · mutationPossible=${flag(action.mutationPossible)}${typeof action.status === 'string' ? ` · status=${action.status}` : ''}${typeof action.error?.code === 'string' ? ` · error=${action.error.code}` : ''}`,
  ]
  const checks = Array.isArray(expectation.checks) ? expectation.checks : []
  for (const check of checks) {
    if (!isRecord(check)) continue
    const checkStatus = ['verified', 'diverged', 'unverified'].includes(check.status) ? check.status.toUpperCase() : 'UNVERIFIED'
    const checkObserved = ['changed', 'unchanged', 'unknown'].includes(check.observed) ? check.observed : 'unknown'
    const limits = Array.isArray(check.limits) && check.limits.length > 0 ? check.limits.join(',') : 'none'
    lines.push(`  ${check.key ?? 'unknown'}: ${checkStatus} · observed=${checkObserved} · reason=${check.reason ?? 'unmeasured'} · expected=${shortJson(check.expected)} · ${checkScopeText(check.scope)} · limits=${limits}`)
    if (Array.isArray(check.mismatches) && check.mismatches.length > 0) lines.push(`    mismatches=${shortJson(check.mismatches)}`)
    if (Array.isArray(check.unmeasured) && check.unmeasured.length > 0) lines.push(`    unmeasured=${shortJson(check.unmeasured)}`)
  }
  lines.push('evidence: only the declared scopes were measured; expectation evidence never rewrites action.ok, attempted, or mutationPossible.')
  if (expectation.diagnosticOnly === true || checks.some(check => check?.key === 'pixel_changed')) {
    lines.push('diagnostic: pixel/DOM change alone cannot prove the requested action outcome, correct target, or persistence.')
  }
  return lines.join('\n')
}
