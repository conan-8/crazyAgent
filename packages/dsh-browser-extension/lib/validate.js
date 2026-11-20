/**
 * Tool-argument validation, split out of index.js for D1 (2026-11-16): a pure
 * move with no behavior change. The shared unknown-argument wording (B4),
 * record/positive-integer predicates, view/modifier/key-chord/point/wait
 * checks, and the guarded Docs argument validators. The provider runs these
 * before any bridge traffic; the executor mirrors the unknown-argument
 * wording in extension/sidepanel/arg-errors.js.
 */

import {
  ACTION_EXPECT_BATCH_CHECKS,
  ACTION_EXPECT_DIRECT_CHECKS,
  ACTION_TOOLBAR_ATTRIBUTES,
  parseActionExpect,
} from './action-expect.js'

const DOCS_FONT_MAX_CHARS = 100
const DOCS_PARAGRAPH_STYLES = ['Normal text', 'Title', 'Subtitle', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6']
const DOCS_FORMAT_ATTRIBUTES = ['paragraph_style', 'font_size', 'bold', 'italic', 'underline', 'font']
const DOCS_FORMAT_MANY_ATTRIBUTES = [...DOCS_FORMAT_ATTRIBUTES, 'color', 'highlight']

function checkedActionExpect(value, op, path, batch = false) {
  if (value === undefined) return undefined
  const supportedChecks = (batch ? ACTION_EXPECT_BATCH_CHECKS : ACTION_EXPECT_DIRECT_CHECKS)[op] ?? []
  return parseActionExpect(value, { path, supportedChecks, supportedStyleAttributes: ACTION_TOOLBAR_ATTRIBUTES })
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const VIEW_MODES = ['auto', 'full', 'compact', 'none']
const CLICK_AT_VIEW_MODES = ['full', 'compact', 'none', 'fresh', 'auto']

/**
 * Validate a model-supplied view mode. Returns undefined when the caller did
 * not send one; the executor owns the default.
 * @param {unknown} view
 * @param {string[]} [allowed]
 * @returns {unknown}
 */
function checkedView(view, allowed = VIEW_MODES) {
  if (view === undefined) return undefined
  if (typeof view !== 'string' || !allowed.includes(view)) {
    throw new Error(`view must be one of ${allowed.join(', ')}`)
  }
  return view
}

/** Modifier names the composer maps to held keys. */
const KEY_MODIFIERS = ['ctrl', 'alt', 'shift', 'meta']

/**
 * Validate and lowercase a modifier list. Case-insensitive so a model can send
 * either `ctrl` or `Ctrl`.
 * @param {unknown} value
 * @param {string} context error prefix
 * @returns {string[]}
 */
function checkedModifiers(value, context) {
  if (!Array.isArray(value)) throw new Error(`${context}modifiers must be an array of ctrl, alt, shift, meta`)
  const modifiers = []
  for (const modifier of value) {
    const name = typeof modifier === 'string' ? modifier.trim().toLowerCase() : modifier
    if (!KEY_MODIFIERS.includes(name)) {
      throw new Error(`${context}modifier ${JSON.stringify(modifier)} is not one of ctrl, alt, shift, meta`)
    }
    if (!modifiers.includes(name)) modifiers.push(name)
  }
  return modifiers
}

/**
 * Normalize a press-key request. `key` may be a plain key name (`Tab`), a
 * composite chord (`shift+Tab`, `ctrl+Shift+ArrowLeft`) whose leading tokens
 * are modifiers and whose last token is the key, or the literal key `"+"`.
 * Explicit `modifiers` are merged in and deduped. The final key token keeps
 * its original casing.
 * @param {unknown} key
 * @param {unknown} modifiers
 * @param {string} [context] error prefix
 * @returns {{key: string, modifiers: string[] | undefined}}
 */
function normalizeKeyChord(key, modifiers, context = 'browser_press_key ') {
  if (typeof key !== 'string' || key.length === 0) throw new Error(`${context}requires a non-empty key name`)
  const explicit = modifiers === undefined ? undefined : checkedModifiers(modifiers, context)
  /** @type {string[]} */
  const chordModifiers = []
  let finalKey = key
  if (key !== '+' && key.includes('+')) {
    const parts = key.split('+')
    let head = parts.pop()
    // `ctrl++` means ctrl held while pressing the literal plus key.
    if (head === '' && parts.at(-1) === '') {
      parts.pop()
      head = '+'
    }
    if (head === undefined || head.trim().length === 0) {
      throw new Error(`${context}key ${JSON.stringify(key)} must end with exactly one key name after the modifiers (e.g. "shift+Tab")`)
    }
    for (const token of parts) {
      const name = token.trim().toLowerCase()
      if (name.length === 0) {
        throw new Error(`${context}key ${JSON.stringify(key)} must end with exactly one key name after the modifiers (e.g. "shift+Tab")`)
      }
      if (!KEY_MODIFIERS.includes(name)) {
        throw new Error(`${context}key ${JSON.stringify(key)} has unknown modifier ${JSON.stringify(token)}; modifiers are ctrl, alt, shift, meta`)
      }
      if (!chordModifiers.includes(name)) chordModifiers.push(name)
    }
    finalKey = head.trim()
  }
  const merged = [...chordModifiers]
  for (const modifier of explicit ?? []) {
    if (!merged.includes(modifier)) merged.push(modifier)
  }
  // Ctrl/Cmd+W is the one browser-level shortcut that destroys the user's tab,
  // and the guidance forbids it twice. Prose is not a guard: a model that reads
  // "close" as the shortcut can erase an unsaved page, so refuse the chord
  // before any bridge traffic (batch normalization runs through this helper too).
  const closesUserTab = merged.some(modifier => modifier === 'ctrl' || modifier === 'meta')
    && (/^[wW]$/u.test(finalKey) || /^key[wW]$/iu.test(finalKey))
  if (closesUserTab) {
    throw new Error(`${context}refuses ${[...merged, finalKey].join('+')}: ctrl/cmd+W closes the user's tab or window and must never be pressed. Do not close tabs; use browser_tabs to inspect them, and ask the user to close one.`)
  }
  return {
    key: finalKey,
    modifiers: merged.length > 0 || explicit !== undefined ? merged : undefined,
  }
}

/**
 * @param {number} value
 * @returns {boolean}
 */
function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0
}

/**
 * Validate one selection point {x, y}.
 * @param {unknown} value
 * @param {string} name
 * @returns {{x: number, y: number}}
 */
function selectPoint(value, name) {
  if (!isRecord(value)) throw new Error(`browser_select requires a ${name} point {x, y}. Example: {"from":{"x":100,"y":200},"to":{"x":300,"y":200}}`)
  const x = Number(value.x)
  const y = Number(value.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`browser_select ${name} requires finite x and y`)
  return { x, y }
}

/**
 * One wording for every unknown-argument rejection: name the offending key and
 * list what is accepted, so the next call can be corrected without guessing.
 * @param {string} context tool name or argument path
 * @param {string} key
 * @param {Iterable<string>} allowed
 */
export function unknownArgumentMessage(context, key, allowed) {
  return `${context} received unknown argument ${JSON.stringify(key)}. Allowed: ${[...allowed].join(', ')}`
}

/**
 * Throw the shared unknown-argument error for the first key outside `allowed`.
 * @param {string} context
 * @param {Record<string, unknown>} value
 * @param {Iterable<string>} allowed
 */
function rejectUnknownArguments(context, value, allowed) {
  const list = [...allowed]
  const unknown = Object.keys(value).find(key => !list.includes(key))
  if (unknown !== undefined) throw new Error(unknownArgumentMessage(context, unknown, list))
}

const TOOL_ARGUMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Reject parser/model corruption in argument names without inspecting string
 * values, which may legitimately contain serialized or DSML-looking content.
 * @param {unknown} value
 * @param {string} path
 */
function assertBatchArgumentNames(value, path) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertBatchArgumentNames(item, `${path}[${index}]`)
    return
  }
  if (!isRecord(value)) return
  for (const [key, nested] of Object.entries(value)) {
    if (!TOOL_ARGUMENT_NAME.test(key)) {
      throw new Error(`browser_batch arguments are malformed at ${path}: invalid argument name ${JSON.stringify(key)}; no actions ran`)
    }
    assertBatchArgumentNames(nested, `${path}.${key}`)
  }
}

/**
 * Validate and normalize standalone waits and batch guard conditions. The
 * executor owns all defaults, including the standalone full view.
 * @param {unknown} value
 * @param {string} context
 * @param {boolean} [allowView]
 * @returns {Record<string, unknown>}
 */
function normalizeWaitConditions(value, context, allowView = false) {
  if (!isRecord(value)) throw new Error(`${context} must be an object`)
  const allowed = ['text', 'url', 'idle', 'ms', 'timeout_ms', ...allowView ? ['view'] : []]
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown !== undefined) {
    if (unknown === 'view') throw new Error(`${context} does not accept a view field`)
    throw new Error(unknownArgumentMessage(context, unknown, allowed))
  }
  /** @type {Record<string, unknown>} */
  const forward = {}
  if (value.text !== undefined) {
    if (typeof value.text !== 'string' || value.text.length === 0) throw new Error(`${context} text must be a non-empty string`)
    forward.text = value.text
  }
  if (value.url !== undefined) {
    if (typeof value.url !== 'string' || value.url.length === 0) throw new Error(`${context} url must be a non-empty string`)
    forward.url = value.url
  }
  if (value.idle !== undefined) {
    if (typeof value.idle !== 'boolean') throw new Error(`${context} idle must be true or false`)
    if (value.idle === true) forward.idle = true
  }
  if (value.ms !== undefined) {
    const ms = Number(value.ms)
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > 30000) throw new Error(`${context} ms must be an integer between 0 and 30000`)
    forward.ms = ms
  }
  if (Object.keys(forward).length === 0) throw new Error(`${context} requires at least one condition: text, url, idle, or ms`)
  if (value.timeout_ms !== undefined) {
    const timeout = Number(value.timeout_ms)
    if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 30000) {
      throw new Error(`${context} timeout_ms must be an integer between 1000 and 30000`)
    }
    if (timeout < (forward.ms ?? 0)) throw new Error(`${context} timeout_ms must be greater than or equal to ms`)
    forward.timeout_ms = timeout
  }
  if (allowView) {
    const view = checkedView(value.view)
    if (view !== undefined) forward.view = view
  }
  return forward
}

function validateDocsWriteColor(value, allowNone, path) {
  if (!(allowNone && value === 'none') && (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value))) {
    throw new Error(`${path} must be ${allowNone ? '"none" or ' : ''}a six-digit hex color`)
  }
}

function checkedDocsOccurrence(value, path) {
  if (value === undefined) return undefined
  if (value === 'first' || value === 'last' || (Number.isInteger(value) && value > 0)) return value
  throw new Error(`${path} occurrence must be "first", "last", or a positive integer`)
}

function normalizeDocsFormatAttributes(entry, path, requested) {
  if (entry.paragraph_style !== undefined && !DOCS_PARAGRAPH_STYLES.includes(entry.paragraph_style)) {
    throw new Error(`${path} paragraph_style must be one of: ${DOCS_PARAGRAPH_STYLES.join(', ')}`)
  }
  if (entry.font_size !== undefined && (!Number.isInteger(entry.font_size) || entry.font_size < 1 || entry.font_size > 400)) {
    throw new Error(`${path} font_size must be an integer from 1 to 400`)
  }
  for (const attribute of ['bold', 'italic', 'underline']) {
    if (entry[attribute] !== undefined && typeof entry[attribute] !== 'boolean') throw new Error(`${path} ${attribute} must be a boolean`)
  }
  if (entry.font !== undefined && (typeof entry.font !== 'string' || entry.font.trim().length === 0 || entry.font.length > DOCS_FONT_MAX_CHARS)) {
    throw new Error(`${path} font must be a non-empty string of at most ${DOCS_FONT_MAX_CHARS} characters`)
  }
  if (entry.color !== undefined) validateDocsWriteColor(entry.color, false, `${path} color`)
  if (entry.highlight !== undefined) validateDocsWriteColor(entry.highlight, true, `${path} highlight`)
  const normalized = {}
  for (const attribute of requested) {
    normalized[attribute] = attribute === 'font' ? entry.font.trim()
      : attribute === 'color' || attribute === 'highlight' ? entry[attribute].toLowerCase()
        : entry[attribute]
  }
  return normalized
}

function normalizeDocsTableArgs(args) {
  if (!isRecord(args)) throw new Error('browser_docs_table arguments must be an object')
  const actions = ['read', 'create', 'write', 'format', 'insert_rows', 'insert_columns', 'delete_rows', 'delete_columns', 'merge', 'unmerge', 'delete_table']
  if (!actions.includes(args.action)) throw new Error(`browser_docs_table action must be one of ${actions.join(', ')}`)
  const allowed = new Set(['action', 'table', 'rows', 'columns', 'values', 'edits', 'row', 'column', 'position', 'count'])
  rejectUnknownArguments('browser_docs_table', args, allowed)
  const forward = { action: 'table', tableAction: args.action }
  const positive = (value, label, maximum = 1_000) => {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${label} must be a positive one-based index no greater than ${maximum}`)
    return value
  }
  if (args.table !== undefined) forward.table = positive(args.table, 'browser_docs_table table')
  const only = keys => {
    rejectUnknownArguments(`browser_docs_table ${args.action}`, args, ['action', ...keys])
  }
  const value = (entry, path) => {
    if (typeof entry !== 'string' || entry.length > 2_000 || /[\r\n\t]/u.test(entry)) throw new Error(`${path} must be a single-line string of at most 2000 characters without tabs`)
    return entry
  }
  if (args.action === 'merge' || args.action === 'unmerge') {
    if (args.action === 'unmerge' && args.count !== undefined) {
      throw new Error('browser_docs_table unmerge does not accept count: it splits one merged cell and verifies exactly two horizontal cells')
    }
    only(['table', 'row', 'column', ...args.action === 'merge' ? ['count'] : []])
    if (args.row === undefined || args.column === undefined) {
      throw new Error(`browser_docs_table ${args.action} requires row and column: the one-based row and the left cell's one-based column of the two horizontal cells`)
    }
    forward.row = positive(args.row, 'browser_docs_table row', 100)
    forward.column = positive(args.column, 'browser_docs_table column', 20)
    if (args.action === 'merge') {
      if (args.count !== undefined && args.count !== 2) throw new Error('browser_docs_table merge currently requires exactly two horizontal cells')
      forward.count = 2
    }
    return forward
  }
  if (args.action === 'read' || args.action === 'delete_table') {
    only(['table'])
    return forward
  }
  if (args.action === 'create') {
    only(['rows', 'columns', 'values'])
    forward.rows = positive(args.rows, 'browser_docs_table rows', 100)
    forward.columns = positive(args.columns, 'browser_docs_table columns', 20)
    let total = 0
    if (args.values !== undefined) {
      if (!Array.isArray(args.values) || args.values.length !== forward.rows || args.values.some(row => !Array.isArray(row) || row.length !== forward.columns)) {
        throw new Error(`browser_docs_table values must be a ${forward.rows} by ${forward.columns} matrix`)
      }
      forward.values = args.values.map((row, rowIndex) => row.map((entry, columnIndex) => {
        const checked = value(entry, `browser_docs_table values[${rowIndex}][${columnIndex}]`)
        total += checked.length
        return checked
      }))
    }
    if (total > 20_000) throw new Error('browser_docs_table values may contain at most 20000 characters in total')
    return forward
  }
  if (args.action === 'write' || args.action === 'format') {
    only(['table', 'edits'])
    const maximum = args.action === 'write' ? 100 : 50
    if (!Array.isArray(args.edits) || args.edits.length < 1 || args.edits.length > maximum) throw new Error(`browser_docs_table ${args.action} requires 1 to ${maximum} edits`)
    let total = 0
    forward.edits = args.edits.map((edit, index) => {
      if (!isRecord(edit)) throw new Error(`browser_docs_table edits[${index}] must be an object`)
      const path = `browser_docs_table edits[${index}]`
      if (args.action === 'write') {
        rejectUnknownArguments(path, edit, ['row', 'column', 'value'])
        const checked = value(edit.value, `${path}.value`)
        total += checked.length
        return { row: positive(edit.row, `${path}.row`, 100), column: positive(edit.column, `${path}.column`, 20), value: checked }
      }
      const editAllowed = new Set(['row', 'column', ...DOCS_FORMAT_MANY_ATTRIBUTES, 'cell_background'])
      rejectUnknownArguments(path, edit, editAllowed)
      const requested = DOCS_FORMAT_MANY_ATTRIBUTES.filter(attribute => edit[attribute] !== undefined)
      const background = edit.cell_background !== undefined
      if (requested.length === 0 && !background) throw new Error(`${path} requires at least one formatting attribute`)
      if (background && requested.length > 0) throw new Error(`${path}.cell_background requires a dedicated format call without text attributes`)
      if (background && (typeof edit.cell_background !== 'string' || !/^#[0-9a-f]{6}$/iu.test(edit.cell_background))) throw new Error(`${path}.cell_background must be a six-digit hex color`)
      return {
        ...edit.row === undefined ? {} : { row: positive(edit.row, `${path}.row`, 100) },
        ...edit.column === undefined ? {} : { column: positive(edit.column, `${path}.column`, 20) },
        ...normalizeDocsFormatAttributes(edit, path, requested),
        ...background ? { cell_background: edit.cell_background.toLowerCase() } : {},
      }
    })
    if (args.action === 'format' && forward.edits.some(edit => edit.cell_background !== undefined) && forward.edits.some(edit => edit.cell_background === undefined)) {
      throw new Error('browser_docs_table cell_background requires a dedicated format call without text-formatting edits')
    }
    if (total > 20_000) throw new Error('browser_docs_table write values may contain at most 20000 characters in total')
    return forward
  }
  if (args.action === 'insert_rows' || args.action === 'insert_columns') {
    const key = args.action === 'insert_rows' ? 'row' : 'column'
    only(['table', key, 'position', 'count'])
    if (args[key] !== undefined) forward[key] = positive(args[key], `browser_docs_table ${key}`, key === 'row' ? 100 : 20)
    if (args.position !== undefined && !['before', 'after'].includes(args.position)) throw new Error('browser_docs_table position must be before or after')
    forward.position = args.position ?? 'after'
    forward.count = args.count === undefined ? 1 : positive(args.count, 'browser_docs_table count', 20)
    return forward
  }
  const key = args.action === 'delete_rows' ? 'rows' : 'columns'
  only(['table', key])
  const maximum = key === 'rows' ? 100 : 20
  if (!Array.isArray(args[key]) || args[key].length < 1 || args[key].length > maximum) throw new Error(`browser_docs_table ${key} must be a non-empty array`)
  forward[key] = args[key].map((entry, index) => positive(entry, `browser_docs_table ${key}[${index}]`, maximum))
  if (new Set(forward[key]).size !== forward[key].length) throw new Error(`browser_docs_table ${key} contains a duplicate index`)
  return forward
}

function validateDocsWriteBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > 50) throw new Error('browser_docs_write blocks must be an array of 1 to 50 blocks')
  const formatFields = ['paragraph_style', 'font_size', 'font', 'bold', 'italic', 'underline', 'color', 'highlight']
  const validateFormat = (entry, path, allowParagraph = true) => {
    if (entry.font !== undefined && (typeof entry.font !== 'string' || entry.font.trim().length === 0 || entry.font.length > DOCS_FONT_MAX_CHARS)) {
      throw new Error(`${path}.font must be a non-empty string of at most ${DOCS_FONT_MAX_CHARS} characters`)
    }
    if (entry.font_size !== undefined && (!Number.isInteger(entry.font_size) || entry.font_size < 1 || entry.font_size > 400)) {
      throw new Error(`${path}.font_size must be an integer from 1 to 400`)
    }
    for (const attribute of ['bold', 'italic', 'underline']) {
      if (entry[attribute] !== undefined && typeof entry[attribute] !== 'boolean') throw new Error(`${path}.${attribute} must be a boolean`)
    }
    if (allowParagraph && entry.paragraph_style !== undefined && !DOCS_PARAGRAPH_STYLES.includes(entry.paragraph_style)) {
      throw new Error(`${path}.paragraph_style is unsupported`)
    }
    if (entry.color !== undefined) validateDocsWriteColor(entry.color, false, `${path}.color`)
    if (entry.highlight !== undefined) validateDocsWriteColor(entry.highlight, true, `${path}.highlight`)
  }
  let totalChars = 0
  for (const [index, block] of blocks.entries()) {
    if (!isRecord(block)) throw new Error(`browser_docs_write blocks[${index}] must be an object`)
    const allowed = new Set(['text', 'runs', 'items', 'list', 'blank', 'page_break', ...formatFields])
    rejectUnknownArguments(`browser_docs_write blocks[${index}]`, block, allowed)
    if (block.blank !== undefined && block.blank !== true) throw new Error(`browser_docs_write blocks[${index}].blank must be true when present`)
    if (block.page_break !== undefined && block.page_break !== true) throw new Error(`browser_docs_write blocks[${index}].page_break must be true when present`)
    const kinds = [block.text !== undefined, block.runs !== undefined, block.items !== undefined, block.blank === true, block.page_break === true].filter(Boolean).length
    if (kinds !== 1) throw new Error(`browser_docs_write blocks[${index}] must contain exactly one of text, runs, items, blank:true, or page_break:true. Put paragraph_style and other defaults in the SAME block as runs: {"paragraph_style":"Subtitle","runs":[{"text":"date"}]}; a formatting-only block is invalid. Other examples: {"text":"Section One","paragraph_style":"Heading 1"} or {"blank":true}`)
    if (block.blank === true || block.page_break === true) {
      const kind = block.blank === true ? 'blank' : 'page_break'
      if (Object.keys(block).some(key => key !== kind)) throw new Error(`browser_docs_write blocks[${index}] ${kind} cannot have text, list, or formatting attributes`)
      continue
    }
    validateFormat(block, `browser_docs_write blocks[${index}]`)
    if (block.text !== undefined) {
      if (typeof block.text !== 'string' || block.text.trim().length === 0 || /[\r\n]/u.test(block.text)) {
        throw new Error(`browser_docs_write blocks[${index}].text must be one non-empty single-line paragraph`)
      }
      if (block.list !== undefined) throw new Error(`browser_docs_write blocks[${index}] paragraph text cannot have a list type`)
      totalChars += block.text.length
    } else if (block.runs !== undefined) {
      if (block.list !== undefined) throw new Error(`browser_docs_write blocks[${index}] inline runs cannot have a list type`)
      if (!Array.isArray(block.runs) || block.runs.length === 0 || block.runs.length > 100) {
        throw new Error(`browser_docs_write blocks[${index}].runs must contain 1 to 100 runs`)
      }
      for (const [runIndex, run] of block.runs.entries()) {
        const path = `browser_docs_write blocks[${index}].runs[${runIndex}]`
        if (!isRecord(run)) throw new Error(`${path} must be an object`)
        const runAllowed = new Set(['text', 'font_size', 'font', 'bold', 'italic', 'underline', 'color', 'highlight'])
        rejectUnknownArguments(path, run, runAllowed)
        if (typeof run.text !== 'string' || run.text.trim().length === 0 || /[\r\n]/u.test(run.text)) {
          throw new Error(`${path}.text must be one non-empty single-line string`)
        }
        validateFormat(run, path, false)
        totalChars += run.text.length
      }
    } else {
      if (!['numbered', 'bulleted', 'checklist'].includes(block.list)) throw new Error(`browser_docs_write blocks[${index}].list must be numbered, bulleted, or checklist`)
      if (block.paragraph_style !== undefined) throw new Error(`browser_docs_write blocks[${index}] list groups cannot set paragraph_style`)
      if (!Array.isArray(block.items) || block.items.length === 0 || block.items.length > 100) {
        throw new Error(`browser_docs_write blocks[${index}].items must contain 1 to 100 items`)
      }
      for (const [itemIndex, item] of block.items.entries()) {
        const path = `browser_docs_write blocks[${index}].items[${itemIndex}]`
        const structured = block.list === 'checklist' && isRecord(item)
        if (structured && (Object.keys(item).some(key => !['text', 'checked'].includes(key)) || (item.checked !== undefined && typeof item.checked !== 'boolean'))) {
          throw new Error(`${path} accepts only text and an optional boolean checked state`)
        }
        const text = structured ? item.text : item
        if (typeof text !== 'string' || text.trim().length === 0 || text.length > 1000 || /[\r\n]/u.test(text)) {
          throw new Error(`${path} must be one non-empty single-line string of at most 1000 characters${block.list === 'checklist' ? ' or a {text,checked} object' : ''}`)
        }
        totalChars += text.length
      }
      totalChars += block.items.length - 1
    }
  }
  if (totalChars > 20_000) throw new Error('browser_docs_write blocks contain more than 20000 characters')
}

export {
  CLICK_AT_VIEW_MODES,
  DOCS_FONT_MAX_CHARS,
  DOCS_FORMAT_MANY_ATTRIBUTES,
  DOCS_PARAGRAPH_STYLES,
  VIEW_MODES,
  assertBatchArgumentNames,
  checkedActionExpect,
  checkedDocsOccurrence,
  checkedView,
  isPositiveSafeInteger,
  isRecord,
  normalizeDocsFormatAttributes,
  normalizeDocsTableArgs,
  normalizeKeyChord,
  normalizeWaitConditions,
  rejectUnknownArguments,
  selectPoint,
  validateDocsWriteBlocks,
}
