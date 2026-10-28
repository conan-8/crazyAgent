import test from 'node:test'
import assert from 'node:assert/strict'
import { planDocsFormatEdits, verifyDocsFormatEdits } from '../sidepanel/docs-format.js'

const NORMAL = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  font: 'Arial',
  fontSize: 11,
  color: '#000000',
  highlight: 'none',
}
const run = (text, marks = {}) => ({ text, ...NORMAL, ...marks })
const para = (text, style = 'P', marks = {}) => ({ kind: 'para', style, text, runs: text ? [run(text, marks)] : [] })
const composed = (runs, style = 'P') => ({ kind: 'para', style, text: runs.map(part => part.text).join(''), runs })
const clone = value => structuredClone(value)

function verify(baseline, final, edits, attemptedCount = edits.length) {
  const plans = planDocsFormatEdits(baseline, edits)
  return verifyDocsFormatEdits(baseline, final, plans, edits, attemptedCount)
}

test('Docs format planning resolves literal ordinal matches across paragraphs', () => {
  const blocks = [para('Alpha alpha ALPHA alpha'), para('alpha')]
  const edits = [
    { text: 'alpha', occurrence: 'first', bold: true },
    { text: 'ALPHA', occurrence: 2, italic: true },
    { text: 'AlPhA', occurrence: 'last', underline: true },
  ]
  assert.deepEqual(planDocsFormatEdits(blocks, edits), [
    { index: 0, paragraphIndex: 0, start: 0, end: 5, occurrence: 1, matchCount: 5, text: 'alpha' },
    { index: 1, paragraphIndex: 0, start: 6, end: 11, occurrence: 2, matchCount: 5, text: 'ALPHA' },
    { index: 2, paragraphIndex: 1, start: 0, end: 5, occurrence: 5, matchCount: 5, text: 'AlPhA' },
  ])
  assert.deepEqual(planDocsFormatEdits([para('only Target')], [{ text: 'target', bold: true }]), [
    { index: 0, paragraphIndex: 0, start: 5, end: 11, occurrence: 1, matchCount: 1, text: 'target' },
  ])
})

test('Docs format planning uses non-overlapping literal matches', () => {
  const [plan] = planDocsFormatEdits([para('aaaaa a.b')], [{ text: 'aa', occurrence: 'last', bold: true }])
  assert.equal(plan.matchCount, 2)
  assert.deepEqual([plan.start, plan.end], [2, 4])
  const [literal] = planDocsFormatEdits([para('aXb a.b')], [{ text: 'a.b', bold: true }])
  assert.deepEqual([literal.start, literal.end, literal.matchCount], [4, 7, 1])
})

test('Docs format planning rejects invalid and out-of-range occurrences', () => {
  for (const occurrence of [0, -1, 1.5, '1', null]) {
    assert.throws(
      () => planDocsFormatEdits([para('target')], [{ text: 'target', occurrence, bold: true }]),
      error => error.code === 'DOCS_FORMAT_INVALID_OCCURRENCE' && error.index === 0 && /occurrence/u.test(error.message),
    )
  }
  assert.throws(
    () => planDocsFormatEdits([para('one one')], [{ text: 'one', occurrence: 3, bold: true }]),
    error => error.code === 'DOCS_FORMAT_OCCURRENCE_OUT_OF_RANGE' && error.matchCount === 2 && /occurrence 3/u.test(error.message),
  )
})

test('Docs format planning rejects missing and ambiguous targets', () => {
  assert.throws(
    () => planDocsFormatEdits([para('present')], [{ text: 'missing', bold: true }]),
    error => error.code === 'DOCS_FORMAT_MATCH_NOT_FOUND' && error.matchCount === 0,
  )
  assert.throws(
    () => planDocsFormatEdits([para('same'), para('SAME')], [{ text: 'same', bold: true }]),
    error => error.code === 'DOCS_FORMAT_MATCH_NOT_UNIQUE' && error.matchCount === 2 && /omitted occurrence/u.test(error.message),
  )
})

test('Docs format planning rejects multiline targets and opaque structures', () => {
  assert.throws(
    () => planDocsFormatEdits([para('first'), para('second')], [{ text: 'first\nsecond', bold: true }]),
    error => error.code === 'DOCS_FORMAT_MULTILINE_TARGET',
  )
  assert.throws(
    () => planDocsFormatEdits([{ kind: 'table', rows: [[{ text: 'target', colspan: 1, rowspan: 1 }]] }], [{ text: 'target', bold: true }]),
    error => error.code === 'DOCS_FORMAT_UNSUPPORTED_STRUCTURE' && error.paragraphIndex === 0,
  )
})

test('Docs format planning and verification allow inline list targets and unrelated blocks', () => {
  const list = { ...para('List target', 'LI'), listLevel: 1, ordered: true, number: 3 }
  const baseline = [
    { kind: 'pagebreak' },
    list,
    { kind: 'image' },
    para('before\nafter'),
    para(''),
    para('sentinel'),
  ]
  const final = clone(baseline)
  final[1].runs = [run('List ', { bold: true }), run('target', { bold: true })]
  const result = verify(baseline, final, [{ text: 'List target', bold: true }])
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.throws(
    () => planDocsFormatEdits(baseline, [{ text: 'List target', paragraph_style: 'Title' }]),
    error => error.code === 'DOCS_FORMAT_UNSUPPORTED_STRUCTURE' && error.attribute === 'paragraph_style',
  )
})

test('Docs format planning rejects overlapping ranges before mutation', () => {
  assert.throws(
    () => planDocsFormatEdits([para('alpha alpha')], [
      { text: 'alpha', occurrence: 'first', bold: true },
      { text: 'pha', occurrence: 'first', italic: true },
    ]),
    error => error.code === 'DOCS_FORMAT_OVERLAPPING_EDITS' && error.index === 1 && error.otherIndex === 0,
  )
})

test('Docs format planning rejects multiple paragraph styles on one paragraph', () => {
  assert.throws(
    () => planDocsFormatEdits([para('one two')], [
      { text: 'one', paragraph_style: 'Title' },
      { text: 'two', paragraph_style: 'Heading 1' },
    ]),
    error => error.code === 'DOCS_FORMAT_PARAGRAPH_STYLE_CONFLICT' && error.index === 1 && error.otherIndex === 0,
  )
  assert.equal(planDocsFormatEdits([para('one'), para('two')], [
    { text: 'one', paragraph_style: 'Title' },
    { text: 'two', paragraph_style: 'Title' },
  ]).length, 2)
})

test('Docs format verification accepts all eight attributes across split runs', () => {
  const baseline = [composed([
    run('Keep '),
    run('target', { color: '#111111' }),
    run(' sentinel'),
  ]), para('Untouched', 'SUBTITLE', { italic: true })]
  const edits = [{
    text: 'target',
    paragraph_style: 'Heading 2',
    font_size: 28,
    bold: true,
    italic: true,
    underline: true,
    font: 'Roboto',
    color: '#A1B2C3',
    highlight: '#FFFF00',
  }]
  const wanted = {
    fontSize: 28,
    bold: true,
    italic: true,
    underline: true,
    font: 'Roboto',
    color: 'rgb(161,178,195)',
    highlight: '#ff0',
  }
  const final = [composed([
    run('K'), run('eep '),
    run('ta', wanted), run('r', wanted), run('get', wanted),
    run(' sentinel'),
  ], 'H2'), clone(baseline[1])]
  const result = verify(baseline, final, edits)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.results, [{ index: 0, status: 'verified' }])
  assert.equal(result.failure, undefined)
})

test('Docs format verification maps every supported paragraph style', () => {
  const styles = [
    ['Normal text', 'P'], ['Title', 'TITLE'], ['Subtitle', 'SUBTITLE'],
    ['Heading 1', 'H1'], ['Heading 2', 'H2'], ['Heading 3', 'H3'],
    ['Heading 4', 'H4'], ['Heading 5', 'H5'], ['Heading 6', 'H6'],
  ]
  for (const [paragraph_style, code] of styles) {
    const baseline = [para('Heading', code === 'P' ? 'H1' : 'P')]
    const final = [para('Heading', code)]
    const result = verify(baseline, final, [{ text: 'Heading', paragraph_style }])
    assert.equal(result.ok, true, `${paragraph_style}: ${JSON.stringify(result)}`)
  }
})

test('Docs format verification honors false toggles and highlight none', () => {
  const baseline = [para('target', 'P', { bold: true, italic: true, underline: true, highlight: '#ffff00' })]
  const final = [composed([
    run('tar', { bold: false, italic: false, underline: false, highlight: 'transparent' }),
    run('get', { bold: false, italic: false, underline: false, highlight: undefined }),
  ])]
  const result = verify(baseline, final, [{ text: 'target', bold: false, italic: false, underline: false, highlight: 'none' }])
  assert.equal(result.ok, true, JSON.stringify(result))
})

test('Docs format verification requires a requested mark on every target character', () => {
  const baseline = [para('a target z')]
  const final = [composed([
    run('a '), run('ta', { bold: true }), run('r'), run('get', { bold: true }), run(' z'),
  ])]
  const result = verify(baseline, final, [{ text: 'target', bold: true }])
  assert.equal(result.ok, false)
  assert.equal(result.failure.index, 0)
  assert.equal(result.failure.attribute, 'bold')
  assert.equal(result.failure.expected, true)
  assert.equal(result.failure.actual, false)
  assert.equal(result.failure.start, 4)
  assert.deepEqual(result.results, [{ index: 0, status: 'failed' }])
})

test('Docs format verification formats only the selected duplicate occurrence', () => {
  const baseline = [para('foo foo')]
  const edits = [{ text: 'foo', occurrence: 2, bold: true }]
  const final = [composed([run('foo '), run('foo', { bold: true })])]
  assert.equal(verify(baseline, final, edits).ok, true)
  const collateral = [composed([run('foo', { bold: true }), run(' '), run('foo', { bold: true })])]
  const result = verify(baseline, collateral, edits)
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'DOCS_FORMAT_COLLATERAL')
  assert.equal(result.failure.attribute, 'bold')
  assert.equal(result.failure.start, 0)
})

test('Docs format verification preserves unchanged sentinels across run resegmentation', () => {
  const baseline = [composed([
    run('Sentinel ', { strike: true }), run('target'), run(' end', { font: 'Serif' }),
  ]), para('Do not change', 'TITLE', { italic: true, color: '#123456' })]
  const final = [composed([
    run('Sent', { strike: true }), run('inel ', { strike: true }),
    run('tar', { underline: true }), run('get', { underline: true }),
    run(' e', { font: 'Serif' }), run('nd', { font: 'Serif' }),
  ]), clone(baseline[1])]
  const result = verify(baseline, final, [{ text: 'target', underline: true }])
  assert.equal(result.ok, true, JSON.stringify(result))
})

test('Docs format verification detects collateral changes to every comparable run mark', () => {
  const cases = [
    ['strike', 'strike', true],
    ['font', 'font', 'Other'],
    ['font_size', 'fontSize', 99],
    ['color', 'color', '#ff0000'],
    ['highlight', 'highlight', '#ffff00'],
    ['bold', 'bold', true],
    ['italic', 'italic', true],
    ['underline', 'underline', true],
  ]
  for (const [attribute, mark, value] of cases) {
    const baseline = [composed([run('target'), run(' sentinel')])]
    const final = [composed([run('target', { bold: true }), run(' sentinel', { [mark]: value })])]
    const result = verify(baseline, final, [{ text: 'target', bold: true }])
    assert.equal(result.ok, false, attribute)
    assert.equal(result.failure.code, 'DOCS_FORMAT_COLLATERAL', attribute)
    assert.equal(result.failure.index, -1, attribute)
    assert.equal(result.failure.attribute, attribute)
    assert.equal(result.failure.actual, value)
    assert.equal(result.failure.paragraphIndex, 0)
    assert.equal(result.failure.start, 6)
  }
})

test('Docs format verification normalizes colors during collateral comparison', () => {
  const baseline = [composed([run('target'), run(' sentinel', { color: '#fff', highlight: 'transparent' })])]
  const final = [composed([run('target', { bold: true }), run(' sentinel', { color: 'rgb(255,255,255)', highlight: 'none' })])]
  const result = verify(baseline, final, [{ text: 'target', bold: true }])
  assert.equal(result.ok, true, JSON.stringify(result))
})

test('Docs format verification rejects unrequested marks and styles inside a target', () => {
  const baseline = [para('target')]
  const edits = [{ text: 'target', bold: true }]
  const struck = verify(baseline, [para('target', 'P', { bold: true, strike: true })], edits)
  assert.equal(struck.ok, false)
  assert.equal(struck.failure.code, 'DOCS_FORMAT_COLLATERAL')
  assert.equal(struck.failure.attribute, 'strike')
  const styled = verify(baseline, [para('target', 'H1', { bold: true })], edits)
  assert.equal(styled.ok, false)
  assert.equal(styled.failure.attribute, 'paragraph_style')
  assert.equal(styled.failure.expected, 'P')
  assert.equal(styled.failure.actual, 'H1')
})

test('Docs format verification rejects collateral text, count, kind, and sentinel style changes', () => {
  const baseline = [para('target'), para('sentinel')]
  const edits = [{ text: 'target', bold: true }]
  const text = verify(baseline, [para('target', 'P', { bold: true }), para('changed')], edits)
  assert.equal(text.failure.attribute, 'text')
  assert.equal(text.failure.expected, 'sentinel')
  assert.equal(text.failure.actual, 'changed')
  const count = verify(baseline, [para('target', 'P', { bold: true })], edits)
  assert.equal(count.failure.attribute, 'blockCount')
  assert.equal(count.failure.expected, 2)
  assert.equal(count.failure.actual, 1)
  const kind = verify(baseline, [{ ...para('target', 'P', { bold: true }), kind: 'image' }, para('sentinel')], edits)
  assert.equal(kind.failure.attribute, 'kind')
  const style = verify(baseline, [para('target', 'P', { bold: true }), para('sentinel', 'TITLE')], edits)
  assert.equal(style.failure.attribute, 'paragraph_style')
  assert.equal(style.failure.paragraphIndex, 1)
})

test('Docs format verification fails closed for missing runs and run length mismatches', () => {
  const edits = [{ text: 'target', bold: true }]
  for (const final of [
    [{ kind: 'para', style: 'P', text: 'target' }],
    [{ kind: 'para', style: 'P', text: 'target', runs: [run('targe', { bold: true })] }],
    [{ kind: 'para', style: 'P', text: 'target', runs: [null] }],
  ]) {
    const result = verify([para('target')], final, edits)
    assert.equal(result.ok, false)
    assert.equal(result.failure.code, 'DOCS_FORMAT_RUN_MISMATCH')
    assert.equal(result.failure.attribute, 'runs')
    assert.ok(Object.hasOwn(result.failure, 'expected'))
    assert.ok(Object.hasOwn(result.failure, 'actual'))
  }
  const malformedBaseline = [{ kind: 'para', style: 'P', text: 'target', runs: [] }]
  const plans = [{ index: 0, paragraphIndex: 0, start: 0, end: 6, occurrence: 1, matchCount: 1, text: 'target' }]
  const result = verifyDocsFormatEdits(malformedBaseline, [para('target', 'P', { bold: true })], plans, edits, 1)
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'DOCS_FORMAT_RUN_MISMATCH')
  assert.throws(() => planDocsFormatEdits(malformedBaseline, edits), error => error.code === 'DOCS_FORMAT_RUN_MISMATCH')
})

test('Docs format verification reports target attribute, expected and actual values', () => {
  const baseline = [para('first second')]
  const edits = [{ text: 'first', bold: true }, { text: 'second', italic: true }]
  const final = [composed([run('first', { bold: true }), run(' '), run('second')])]
  const result = verify(baseline, final, edits)
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'DOCS_FORMAT_VERIFY_FAILED')
  assert.equal(result.failure.index, 1)
  assert.equal(result.failure.attribute, 'italic')
  assert.equal(result.failure.expected, true)
  assert.equal(result.failure.actual, false)
  assert.deepEqual(result.results, [{ index: 0, status: 'verified' }, { index: 1, status: 'failed' }])
})

test('Docs format verification limits requirements and permissions to attempted edits', () => {
  const baseline = [para('first second')]
  const edits = [{ text: 'first', bold: true }, { text: 'second', italic: true }]
  const final = [composed([run('first', { bold: true }), run(' '), run('second')])]
  const partial = verify(baseline, final, edits, 1)
  assert.equal(partial.ok, true, JSON.stringify(partial))
  assert.deepEqual(partial.results, [{ index: 0, status: 'verified' }, { index: 1, status: 'unverified' }])
  const complete = verify(baseline, final, edits, 2)
  assert.equal(complete.ok, false)
  assert.equal(complete.failure.index, 1)
  const earlyMutation = [composed([run('first', { bold: true }), run(' '), run('second', { italic: true })])]
  const collateral = verify(baseline, earlyMutation, edits, 1)
  assert.equal(collateral.ok, false)
  assert.equal(collateral.failure.code, 'DOCS_FORMAT_COLLATERAL')
  assert.equal(collateral.failure.attribute, 'italic')
  const none = verify(baseline, clone(baseline), edits, 0)
  assert.equal(none.ok, true)
  assert.deepEqual(none.results.map(result => result.status), ['unverified', 'unverified'])
})

test('Docs format verification accepts uniform inherited marks from requested Normal and Heading styles', () => {
  const heading = { font: 'Roboto', fontSize: 20, bold: true }
  for (const [fromStyle, toStyle, paragraph_style, fromMarks, toMarks] of [
    ['P', 'H1', 'Heading 1', {}, heading],
    ['H1', 'P', 'Normal text', heading, {}],
  ]) {
    const baseline = [
      composed([run('Before '), run('target', fromMarks), run(' after', fromMarks)], fromStyle),
      para('Unrelated sentinel'),
    ]
    const final = [
      composed([run('Before ', toMarks), run('target', toMarks), run(' after', toMarks)], toStyle),
      clone(baseline[1]),
    ]
    const result = verify(baseline, final, [{ text: 'target', paragraph_style }])
    assert.equal(result.ok, true, `${fromStyle} -> ${toStyle}: ${JSON.stringify(result)}`)
  }
})

test('Docs format verification still rejects non-target span and other-paragraph damage during a style edit', () => {
  const heading = { font: 'Roboto', fontSize: 20, bold: true }
  const baseline = [composed([run('Before '), run('target'), run(' after')])]
  const final = [composed([
    run('Before ', heading),
    run('target', heading),
    run(' after', { ...heading, italic: true }),
  ], 'H1')]
  const result = verify(baseline, final, [{ text: 'target', paragraph_style: 'Heading 1' }])
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'DOCS_FORMAT_COLLATERAL')
  assert.equal(result.failure.attribute, 'italic')
  assert.equal(result.failure.expected, false)
  assert.equal(result.failure.actual, true)
  assert.equal(result.failure.start, 13)

  const otherBaseline = [para('target'), para('sentinel')]
  const otherFinal = [para('target', 'H1', heading), para('sentinel', 'P', heading)]
  const otherResult = verify(otherBaseline, otherFinal, [{ text: 'target', paragraph_style: 'Heading 1' }])
  assert.equal(otherResult.ok, false)
  assert.equal(otherResult.failure.code, 'DOCS_FORMAT_COLLATERAL')
  assert.equal(otherResult.failure.attribute, 'font')
  assert.equal(otherResult.failure.paragraphIndex, 1)
  assert.equal(otherResult.failure.start, 0)
})

test('Docs format verification preserves links while allowing requested inline formatting on linked text', () => {
  const baseline = [composed([
    run('target', { href: 'https://target.test' }),
    run(' sentinel', { href: 'https://sentinel.test' }),
  ])]
  const final = [composed([
    run('target', { href: 'https://target.test', bold: true }),
    run(' sentinel', { href: 'https://sentinel.test' }),
  ])]
  const result = verify(baseline, final, [{ text: 'target', bold: true }])
  assert.equal(result.ok, true, JSON.stringify(result))
})

test('Docs format verification detects unrelated link removal and destination changes', () => {
  for (const href of [undefined, 'https://changed.test']) {
    const baseline = [composed([
      run('target', { href: 'https://target.test' }),
      run(' sentinel', { href: 'https://sentinel.test' }),
    ])]
    const final = [composed([
      run('target', { href: 'https://target.test', bold: true }),
      run(' sentinel', { href }),
    ])]
    const result = verify(baseline, final, [{ text: 'target', bold: true }])
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.failure.code, 'DOCS_FORMAT_COLLATERAL')
    assert.equal(result.failure.attribute, 'href')
    assert.equal(result.failure.expected, 'https://sentinel.test')
    assert.equal(result.failure.actual, href ?? null)
    assert.equal(result.failure.start, 6)
  }
})
