import { normalizeDocsColor } from './docs-structure.js'

const PARAGRAPH_STYLES = new Map([
  ['Normal text', 'P'],
  ['Title', 'TITLE'],
  ['Subtitle', 'SUBTITLE'],
  ['Heading 1', 'H1'],
  ['Heading 2', 'H2'],
  ['Heading 3', 'H3'],
  ['Heading 4', 'H4'],
  ['Heading 5', 'H5'],
  ['Heading 6', 'H6'],
])
const ORDINARY_STYLES = new Set(PARAGRAPH_STYLES.values())
const EDIT_ATTRIBUTES = ['paragraph_style', 'font_size', 'bold', 'italic', 'underline', 'font', 'color', 'highlight']
const INLINE_ATTRIBUTES = EDIT_ATTRIBUTES.filter(attribute => attribute !== 'paragraph_style')
const RUN_MARKS = ['strike', 'font', 'font_size', 'color', 'highlight', 'bold', 'italic', 'underline', 'href']
const PARAGRAPH_STYLE_MARKS = ['font', 'font_size', 'bold']
const INLINE_BITS = new Map(INLINE_ATTRIBUTES.map(attribute => [attribute, 1 << RUN_MARKS.indexOf(attribute)]))
const NEWLINE = /[\r\n\u2028\u2029]/u

function formatError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function editError(code, index, message, details = {}) {
  return formatError(code, `edits[${index}]: ${message}`, { index, ...details })
}

function validateEdit(edit, index) {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw editError('DOCS_FORMAT_INVALID_EDIT', index, 'edit must be an object')
  const allowed = new Set(['text', 'occurrence', ...EDIT_ATTRIBUTES])
  if (Object.keys(edit).some(key => !allowed.has(key))) throw editError('DOCS_FORMAT_INVALID_EDIT', index, 'edit contains an unsupported field')
  if (typeof edit.text !== 'string' || edit.text.trim().length === 0 || edit.text.length > 1000) {
    throw editError('DOCS_FORMAT_INVALID_TEXT', index, 'text must be a nonblank string of at most 1000 characters')
  }
  if (NEWLINE.test(edit.text)) throw editError('DOCS_FORMAT_MULTILINE_TARGET', index, 'text cannot span paragraphs or contain internal newlines')
  const attributes = EDIT_ATTRIBUTES.filter(attribute => edit[attribute] !== undefined)
  if (attributes.length === 0) throw editError('DOCS_FORMAT_INVALID_EDIT', index, 'provide at least one desired format attribute')
  if (edit.occurrence !== undefined && edit.occurrence !== 'first' && edit.occurrence !== 'last'
    && (!Number.isInteger(edit.occurrence) || edit.occurrence < 1)) {
    throw editError('DOCS_FORMAT_INVALID_OCCURRENCE', index, 'occurrence must be "first", "last", or a positive integer', { occurrence: edit.occurrence })
  }
  if (edit.paragraph_style !== undefined && !PARAGRAPH_STYLES.has(edit.paragraph_style)) {
    throw editError('DOCS_FORMAT_INVALID_PARAGRAPH_STYLE', index, `paragraph_style must be one of: ${[...PARAGRAPH_STYLES.keys()].join(', ')}`)
  }
  if (edit.font_size !== undefined && (!Number.isInteger(edit.font_size) || edit.font_size < 1 || edit.font_size > 400)) {
    throw editError('DOCS_FORMAT_INVALID_FONT_SIZE', index, 'font_size must be an integer from 1 to 400')
  }
  for (const attribute of ['bold', 'italic', 'underline']) {
    if (edit[attribute] !== undefined && typeof edit[attribute] !== 'boolean') {
      throw editError('DOCS_FORMAT_INVALID_ATTRIBUTE', index, `${attribute} must be a boolean`, { attribute })
    }
  }
  if (edit.font !== undefined && (typeof edit.font !== 'string' || edit.font.trim().length === 0 || edit.font.length > 100)) {
    throw editError('DOCS_FORMAT_INVALID_ATTRIBUTE', index, 'font must be a non-empty string of at most 100 characters', { attribute: 'font' })
  }
  if (edit.color !== undefined && (typeof edit.color !== 'string' || !/^#[0-9a-f]{6}$/iu.test(edit.color))) {
    throw editError('DOCS_FORMAT_INVALID_ATTRIBUTE', index, 'color must be a six-digit hex color', { attribute: 'color' })
  }
  if (edit.highlight !== undefined && (typeof edit.highlight !== 'string'
    || edit.highlight !== 'none' && !/^#[0-9a-f]{6}$/iu.test(edit.highlight))) {
    throw editError('DOCS_FORMAT_INVALID_ATTRIBUTE', index, 'highlight must be "none" or a six-digit hex color', { attribute: 'highlight' })
  }
  return {
    ...edit,
    ...edit.font === undefined ? {} : { font: edit.font.trim() },
    ...edit.color === undefined ? {} : { color: edit.color.toLowerCase() },
    ...edit.highlight === undefined || edit.highlight === 'none' ? {} : { highlight: edit.highlight.toLowerCase() },
  }
}

export function validateDocsFormatEdits(edits) {
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > 50) {
    throw formatError('DOCS_FORMAT_INVALID_EDITS', 'edits must be an array of 1 to 50 formatting objects')
  }
  return edits.map(validateEdit)
}

const SIMPLE_BLOCKS = new Set(['pagebreak', 'image', 'hr'])

function supportedParagraph(block) {
  return block?.kind === 'para' && (ORDINARY_STYLES.has(block.style) || block.style === 'LI') && typeof block.text === 'string'
}

function supportedTable(block) {
  if (block?.kind !== 'table' || !Array.isArray(block.rows) || block.rows.length === 0) return false
  return block.rows.every(row => Array.isArray(row) && row.length > 0 && row.every(cell => {
    if (!cell || !Number.isInteger(cell.rowspan) || cell.rowspan < 1 || !Number.isInteger(cell.colspan) || cell.colspan < 1
      || !Array.isArray(cell.paragraphs) || cell.paragraphs.length === 0 || !cell.paragraphs.every(supportedParagraph)) return false
    return cell.text === cell.paragraphs.map(paragraph => paragraph.text).join('\n').replace(/\n+$/u, '')
  }))
}

function comparableParagraphs(blocks) {
  const paragraphs = []
  for (const block of blocks) {
    if (supportedParagraph(block)) paragraphs.push(block)
    else if (supportedTable(block)) {
      for (const row of block.rows) for (const cell of row) paragraphs.push(...cell.paragraphs)
    }
  }
  return paragraphs
}

function tableMetadata(table) {
  return table.rows.map(row => row.map(cell => ({
    rowspan: cell.rowspan,
    colspan: cell.colspan,
    paragraphs: cell.paragraphs.length,
  })))
}

function validateComparableBlocks(blocks) {
  if (!Array.isArray(blocks)) throw formatError('DOCS_FORMAT_UNSUPPORTED_STRUCTURE', 'blocks must be an array')
  for (const [paragraphIndex, block] of blocks.entries()) {
    if (supportedParagraph(block) || supportedTable(block) || SIMPLE_BLOCKS.has(block?.kind)) continue
    throw formatError('DOCS_FORMAT_UNSUPPORTED_STRUCTURE', `blocks[${paragraphIndex}] is unsupported or too opaque for complete collateral verification`, { paragraphIndex })
  }
  for (const [paragraphIndex, block] of comparableParagraphs(blocks).entries()) characterMarks(block, paragraphIndex, 'baseline')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function literalMatches(text, wanted) {
  const expression = new RegExp(escapeRegExp(wanted), 'giu')
  return [...text.matchAll(expression)].map(match => ({ start: match.index, end: match.index + match[0].length }))
}

export function planDocsFormatEdits(blocks, edits) {
  const normalizedEdits = validateDocsFormatEdits(edits)
  validateComparableBlocks(blocks)
  const paragraphs = comparableParagraphs(blocks)
  const plans = normalizedEdits.map((edit, index) => {
    const matches = []
    for (const [paragraphIndex, block] of paragraphs.entries()) {
      for (const range of literalMatches(block.text, edit.text)) matches.push({ paragraphIndex, ...range })
    }
    const matchCount = matches.length
    let occurrence
    if (edit.occurrence === undefined) {
      if (matchCount === 0) throw editError('DOCS_FORMAT_MATCH_NOT_FOUND', index, `found no literal case-insensitive matches for ${JSON.stringify(edit.text)}`, { matchCount })
      if (matchCount !== 1) throw editError('DOCS_FORMAT_MATCH_NOT_UNIQUE', index, `omitted occurrence requires exactly one match; found ${matchCount}`, { matchCount })
      occurrence = 1
    } else {
      if (matchCount === 0) throw editError('DOCS_FORMAT_MATCH_NOT_FOUND', index, `found no literal case-insensitive matches for ${JSON.stringify(edit.text)}`, { matchCount })
      occurrence = edit.occurrence === 'first' ? 1 : edit.occurrence === 'last' ? matchCount : edit.occurrence
      if (occurrence > matchCount) {
        throw editError('DOCS_FORMAT_OCCURRENCE_OUT_OF_RANGE', index, `occurrence ${occurrence} exceeds match count ${matchCount}`, { occurrence, matchCount })
      }
    }
    const match = matches[occurrence - 1]
    if (paragraphs[match.paragraphIndex].style === 'LI' && edit.paragraph_style !== undefined) {
      throw editError('DOCS_FORMAT_UNSUPPORTED_STRUCTURE', index, 'paragraph_style cannot be applied to a list item target', { paragraphIndex: match.paragraphIndex, attribute: 'paragraph_style' })
    }
    return { index, paragraphIndex: match.paragraphIndex, start: match.start, end: match.end, occurrence, matchCount, text: edit.text }
  })
  for (let right = 0; right < plans.length; right += 1) {
    for (let left = 0; left < right; left += 1) {
      if (plans[left].paragraphIndex === plans[right].paragraphIndex
        && plans[left].start < plans[right].end && plans[right].start < plans[left].end) {
        throw editError('DOCS_FORMAT_OVERLAPPING_EDITS', right, `target overlaps edits[${left}]`, { otherIndex: left })
      }
    }
  }
  const styleEdits = new Map()
  for (const plan of plans) {
    if (normalizedEdits[plan.index].paragraph_style === undefined) continue
    if (styleEdits.has(plan.paragraphIndex)) {
      const otherIndex = styleEdits.get(plan.paragraphIndex)
      throw editError('DOCS_FORMAT_PARAGRAPH_STYLE_CONFLICT', plan.index, `paragraph ${plan.paragraphIndex} already has a paragraph_style edit at edits[${otherIndex}]`, { otherIndex, paragraphIndex: plan.paragraphIndex })
    }
    styleEdits.set(plan.paragraphIndex, plan.index)
  }
  return plans
}

function resultsFor(edits, attemptedCount, failedIndex) {
  return edits.map((_, index) => ({
    index,
    status: index >= attemptedCount || failedIndex === -1 ? 'unverified'
      : failedIndex === undefined || index < failedIndex ? 'verified'
        : index === failedIndex ? 'failed' : 'unverified',
  }))
}

function verificationFailure(edits, attemptedCount, failure, failedIndex = -1) {
  return { ok: false, results: resultsFor(edits, attemptedCount, failedIndex), failure }
}

function collateralFailure(edits, attemptedCount, details) {
  return verificationFailure(edits, attemptedCount, {
    index: -1,
    code: 'DOCS_FORMAT_COLLATERAL',
    collateral: true,
    ...details,
  })
}

function actualValue(value) {
  return value === undefined ? null : value
}

function comparableRunMarks(run) {
  return {
    strike: run.strike === true,
    font: run.font ?? null,
    font_size: run.fontSize ?? null,
    color: normalizeDocsColor(run.color),
    highlight: normalizeDocsColor(run.highlight),
    bold: run.bold === true,
    italic: run.italic === true,
    underline: run.underline === true,
    href: run.href ?? null,
  }
}

function characterMarks(block, paragraphIndex, side) {
  if (!Array.isArray(block.runs)) {
    throw formatError('DOCS_FORMAT_RUN_MISMATCH', `${side} paragraph ${paragraphIndex} has no runs array`, {
      attribute: 'runs', expected: block.text, actual: null, paragraphIndex,
    })
  }
  const marks = []
  let text = ''
  for (const run of block.runs) {
    if (!run || typeof run.text !== 'string') {
      throw formatError('DOCS_FORMAT_RUN_MISMATCH', `${side} paragraph ${paragraphIndex} contains an invalid run`, {
        attribute: 'runs', expected: block.text, actual: null, paragraphIndex,
      })
    }
    text += run.text
    const current = comparableRunMarks(run)
    for (let offset = 0; offset < run.text.length; offset += 1) marks.push(current)
  }
  if (text !== block.text || marks.length !== block.text.length) {
    throw formatError('DOCS_FORMAT_RUN_MISMATCH', `${side} paragraph ${paragraphIndex} runs do not exactly cover its text`, {
      attribute: 'runs', expected: block.text, actual: text, paragraphIndex,
    })
  }
  return marks
}

function expectedMark(edit, attribute) {
  return attribute === 'color' || attribute === 'highlight' ? normalizeDocsColor(edit[attribute]) : edit[attribute]
}

function validPlanAtBaseline(plan, edit, index, baseline) {
  if (!plan || plan.index !== index || plan.text !== edit.text
    || !Number.isInteger(plan.paragraphIndex) || !Number.isInteger(plan.start) || !Number.isInteger(plan.end)
    || plan.paragraphIndex < 0 || plan.paragraphIndex >= baseline.length
    || !supportedParagraph(baseline[plan.paragraphIndex])
    || plan.start < 0 || plan.end <= plan.start || plan.end > baseline[plan.paragraphIndex].text.length
    || plan.end - plan.start !== edit.text.length
    || baseline[plan.paragraphIndex].style === 'LI' && edit.paragraph_style !== undefined) return false
  const selected = baseline[plan.paragraphIndex].text.slice(plan.start, plan.end)
  return new RegExp(`^(?:${escapeRegExp(edit.text)})$`, 'iu').test(selected)
}

function sameStructure(left, right) {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameStructure(value, right[index]))
  }
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return sameStructure(leftKeys, rightKeys) && leftKeys.every(key => sameStructure(left[key], right[key]))
}

function paragraphMetadata(block) {
  return Object.fromEntries(Object.entries(block).filter(([key]) => !['kind', 'style', 'text', 'marked', 'runs'].includes(key)))
}

function unsupportedVerification(edits, attemptedCount, block, paragraphIndex, side) {
  return verificationFailure(edits, attemptedCount, {
    index: -1,
    code: 'DOCS_FORMAT_UNSUPPORTED_STRUCTURE',
    attribute: 'kind',
    expected: 'ordinary/list paragraph or comparable non-text block',
    actual: actualValue(block?.kind),
    paragraphIndex,
    message: `Unsupported ${side} structure at paragraph/block ${paragraphIndex}`,
  })
}

export function verifyDocsFormatEdits(baselineBlocks, finalBlocks, plans, edits, attemptedCount) {
  if (!Array.isArray(baselineBlocks) || !Array.isArray(finalBlocks) || !Array.isArray(plans) || !Array.isArray(edits)) {
    throw formatError('DOCS_FORMAT_INVALID_VERIFICATION_INPUT', 'baselineBlocks, finalBlocks, plans, and edits must be arrays')
  }
  if (!Number.isInteger(attemptedCount) || attemptedCount < 0 || attemptedCount > edits.length) {
    throw formatError('DOCS_FORMAT_INVALID_ATTEMPTED_COUNT', `attemptedCount must be an integer from 0 to ${edits.length}`)
  }
  if (baselineBlocks.length !== finalBlocks.length) {
    return collateralFailure(edits, attemptedCount, {
      attribute: 'blockCount', expected: baselineBlocks.length, actual: finalBlocks.length,
      message: 'The final export has a different paragraph/block count',
    })
  }
  for (const [paragraphIndex, baseline] of baselineBlocks.entries()) {
    const final = finalBlocks[paragraphIndex]
    if (baseline?.kind !== final?.kind) {
      return collateralFailure(edits, attemptedCount, {
        attribute: 'kind', expected: actualValue(baseline?.kind), actual: actualValue(final?.kind), paragraphIndex,
        message: `Block kind changed unexpectedly at paragraph/block ${paragraphIndex}`,
      })
    }
    if (supportedParagraph(baseline)) {
      if (!supportedParagraph(final)) return unsupportedVerification(edits, attemptedCount, final, paragraphIndex, 'final')
      continue
    }
    if (supportedTable(baseline)) {
      if (!supportedTable(final)) return unsupportedVerification(edits, attemptedCount, final, paragraphIndex, 'final')
      const expected = tableMetadata(baseline)
      const actual = tableMetadata(final)
      if (!sameStructure(expected, actual)) {
        return collateralFailure(edits, attemptedCount, {
          attribute: 'tableStructure', expected, actual, paragraphIndex,
          message: `Table shape or cell paragraph counts changed unexpectedly at block ${paragraphIndex}`,
        })
      }
      continue
    }
    if (!SIMPLE_BLOCKS.has(baseline?.kind)) return unsupportedVerification(edits, attemptedCount, baseline, paragraphIndex, 'baseline')
    if (!SIMPLE_BLOCKS.has(final?.kind)) return unsupportedVerification(edits, attemptedCount, final, paragraphIndex, 'final')
    if (!sameStructure(baseline, final)) {
      return collateralFailure(edits, attemptedCount, {
        attribute: 'structure', expected: baseline, actual: final, paragraphIndex,
        message: `Non-text block changed unexpectedly at paragraph/block ${paragraphIndex}`,
      })
    }
  }

  const baselineParagraphs = comparableParagraphs(baselineBlocks)
  const finalParagraphs = comparableParagraphs(finalBlocks)
  if (baselineParagraphs.length !== finalParagraphs.length) {
    return collateralFailure(edits, attemptedCount, {
      attribute: 'paragraphCount', expected: baselineParagraphs.length, actual: finalParagraphs.length,
      message: 'The final export has a different flattened paragraph count',
    })
  }
  for (const [paragraphIndex, baseline] of baselineParagraphs.entries()) {
    const final = finalParagraphs[paragraphIndex]
    if (baseline.text !== final.text) {
      return collateralFailure(edits, attemptedCount, {
        attribute: 'text', expected: baseline.text, actual: actualValue(final.text), paragraphIndex,
        message: `Text changed unexpectedly at paragraph ${paragraphIndex}`,
      })
    }
  }
  baselineBlocks = baselineParagraphs
  finalBlocks = finalParagraphs

  const activePlans = plans.slice(0, attemptedCount)
  for (let index = 0; index < attemptedCount; index += 1) {
    if (!validPlanAtBaseline(activePlans[index], edits[index], index, baselineBlocks)) {
      return verificationFailure(edits, attemptedCount, {
        index, code: 'DOCS_FORMAT_INVALID_PLAN', attribute: 'plan',
        expected: edits[index]?.text ?? null, actual: activePlans[index] ?? null,
        message: `The target plan for edit ${index} does not match the baseline export`,
      }, index)
    }
  }

  let baselineMarks
  let finalMarks
  try {
    baselineMarks = baselineBlocks.map((block, index) => supportedParagraph(block) ? characterMarks(block, index, 'baseline') : undefined)
    finalMarks = finalBlocks.map((block, index) => supportedParagraph(block) ? characterMarks(block, index, 'final') : undefined)
  } catch (error) {
    return verificationFailure(edits, attemptedCount, {
      index: -1,
      code: error.code ?? 'DOCS_FORMAT_RUN_MISMATCH',
      attribute: error.attribute ?? 'runs',
      expected: actualValue(error.expected),
      actual: actualValue(error.actual),
      ...error.paragraphIndex !== undefined ? { paragraphIndex: error.paragraphIndex } : {},
      message: error.message,
    })
  }

  for (const [paragraphIndex, baseline] of baselineBlocks.entries()) {
    if (!supportedParagraph(baseline)) continue
    const expected = paragraphMetadata(baseline)
    const actual = paragraphMetadata(finalBlocks[paragraphIndex])
    if (!sameStructure(expected, actual)) {
      return collateralFailure(edits, attemptedCount, {
        attribute: 'metadata', expected, actual, paragraphIndex,
        message: `List or paragraph metadata changed unexpectedly at paragraph ${paragraphIndex}`,
      })
    }
  }

  let targetFailure
  for (let index = 0; index < attemptedCount; index += 1) {
    const edit = edits[index]
    const plan = activePlans[index]
    if (edit.paragraph_style !== undefined) {
      const expected = PARAGRAPH_STYLES.get(edit.paragraph_style)
      const actual = finalBlocks[plan.paragraphIndex].style
      if (actual !== expected && !targetFailure) {
        targetFailure = verificationFailure(edits, attemptedCount, {
          index, code: 'DOCS_FORMAT_VERIFY_FAILED', attribute: 'paragraph_style', expected, actual: actualValue(actual),
          paragraphIndex: plan.paragraphIndex,
          message: `Edit ${index} paragraph_style was not applied at paragraph ${plan.paragraphIndex}`,
        }, index)
      }
    }
    for (const attribute of INLINE_ATTRIBUTES) {
      if (edit[attribute] === undefined) continue
      const expected = expectedMark(edit, attribute)
      for (let offset = plan.start; offset < plan.end; offset += 1) {
        const actual = finalMarks[plan.paragraphIndex][offset][attribute]
        if (actual !== expected && !targetFailure) {
          targetFailure = verificationFailure(edits, attemptedCount, {
            index, code: 'DOCS_FORMAT_VERIFY_FAILED', attribute, expected, actual: actualValue(actual),
            paragraphIndex: plan.paragraphIndex, start: offset, end: offset + 1,
            message: `Edit ${index} attribute ${attribute} diverged at paragraph ${plan.paragraphIndex}, offset ${offset}`,
          }, index)
        }
      }
    }
  }

  const styleTargets = new Set(activePlans.filter((_, index) => edits[index].paragraph_style !== undefined).map(plan => plan.paragraphIndex))
  for (const [paragraphIndex, baseline] of baselineBlocks.entries()) {
    if (!supportedParagraph(baseline)) continue
    if (!styleTargets.has(paragraphIndex) && finalBlocks[paragraphIndex].style !== baseline.style) {
      return collateralFailure(edits, attemptedCount, {
        attribute: 'paragraph_style', expected: baseline.style, actual: actualValue(finalBlocks[paragraphIndex].style), paragraphIndex,
        message: `Paragraph style changed without an attempted paragraph_style edit at paragraph ${paragraphIndex}`,
      })
    }
  }

  const allowed = baselineBlocks.map(block => Array(supportedParagraph(block) ? block.text.length : 0).fill(0))
  for (let index = 0; index < attemptedCount; index += 1) {
    const edit = edits[index]
    const plan = activePlans[index]
    for (const attribute of INLINE_ATTRIBUTES) {
      if (edit[attribute] === undefined) continue
      const bit = INLINE_BITS.get(attribute)
      for (let offset = plan.start; offset < plan.end; offset += 1) allowed[plan.paragraphIndex][offset] |= bit
    }
  }
  const uniformStyleMarks = new Map()
  for (const paragraphIndex of styleTargets) {
    const uniform = new Set()
    for (const attribute of PARAGRAPH_STYLE_MARKS) {
      const bit = INLINE_BITS.get(attribute)
      const marks = finalMarks[paragraphIndex].filter((_, offset) => (allowed[paragraphIndex][offset] & bit) === 0)
      if (marks.length > 0 && marks.every(mark => mark[attribute] === marks[0][attribute])) uniform.add(attribute)
    }
    uniformStyleMarks.set(paragraphIndex, uniform)
  }
  for (const [paragraphIndex, baseline] of baselineBlocks.entries()) {
    if (!supportedParagraph(baseline)) continue
    for (let offset = 0; offset < baseline.text.length; offset += 1) {
      for (const [markIndex, attribute] of RUN_MARKS.entries()) {
        if ((allowed[paragraphIndex][offset] & (1 << markIndex)) !== 0 || uniformStyleMarks.get(paragraphIndex)?.has(attribute)) continue
        const expected = baselineMarks[paragraphIndex][offset][attribute]
        const actual = finalMarks[paragraphIndex][offset][attribute]
        if (actual !== expected) {
          return collateralFailure(edits, attemptedCount, {
            attribute, expected: actualValue(expected), actual: actualValue(actual), paragraphIndex, start: offset, end: offset + 1,
            message: `Unrequested ${attribute} change at paragraph ${paragraphIndex}, offset ${offset}`,
          })
        }
      }
    }
  }
  return targetFailure ?? { ok: true, results: resultsFor(edits, attemptedCount) }
}
