import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DOCS_PASTE_LIMITS,
  normalizeDocsPastePlacement,
  prepareDocsPaste,
  verifyDocsPasteAppend,
} from '../sidepanel/docs-paste.js'
import { parseDocStructure } from '../sidepanel/docs-structure.js'

const rejected = (fn, code) => assert.throws(fn, error => (
  (code === undefined || error.code === code) && error.code?.startsWith('DOCS_PASTE_')
    && error.stage === 'validate' && error.mutationPossible === false
))

const html = value => prepareDocsPaste({ html: value })
const markdown = value => prepareDocsPaste({ markdown: value })
const paragraph = (text = 'Sentinel') => ({
  kind: 'para',
  style: 'P',
  text,
  runs: text ? [{ text, bold: false, italic: false, underline: false, strike: false }] : [],
})

test('Docs paste prepares bounded rich Markdown with HTML, plain text, chunks, and an export manifest', () => {
  const result = markdown([
    '# Release',
    '',
    '<p style="text-align:center"><span style="font-family:Roboto;font-size:14pt;color:#0000FF;background-color:#FFFF00">Styled </span><b>bold</b> <i>italic</i> <u>under</u> <s>strike</s> <a href="https://example.com/a?x=1&amp;y=2">link</a></p>',
    '',
    '1. first',
    '2. second',
    '',
    '| Name | Value |',
    '| :--- | ---: |',
    '| A | 10 |',
    '',
    '![Architecture](https://images.example.com/diagram.png =320x200)',
    '',
    '\\pagebreak',
    '',
    '## After ==highlight== and **strong**',
  ].join('\n'))
  assert.equal(result.manifest.sourceFormat, 'markdown')
  assert.deepEqual(result.manifest.placement, { mode: 'append', at: 'end' })
  assert.equal(result.manifest.counts.headings, 2)
  assert.equal(result.manifest.counts.listItems, 2)
  assert.equal(result.manifest.counts.tables, 1)
  assert.equal(result.manifest.counts.images, 1)
  assert.equal(result.manifest.counts.links, 1)
  assert.equal(result.manifest.counts.pageBreaks, 1)
  assert.equal(result.chunks.length, 2)
  assert.equal(result.chunks[0].empty, false)
  assert.equal(result.chunks[1].blockStart, result.manifest.blocks.findIndex(block => block.kind === 'pagebreak') + 1)
  assert.match(result.html, /^<html><body><h1 /u)
  assert.match(result.html, /<hr style="page-break-before:always">/u)
  assert.doesNotMatch(result.html, /<!--|<script|onerror=/iu)
  assert.match(result.html, /font-family:'Roboto'/u)
  assert.match(result.html, /width="320" height="200"/u)
  assert.match(result.text, /1\. first\n2\. second/u)
  assert.match(result.text, /Name\tValue\nA\t10/u)
  assert.match(result.text, /\[Architecture\]/u)
  assert.match(result.text, /\n\f\n/u)
  const styled = result.manifest.blocks[1]
  assert.equal(styled.align, 'center')
  assert.equal(styled.runs[0].font, 'Roboto')
  assert.equal(styled.runs[0].fontSize, 14)
  assert.equal(styled.runs[0].color, '#0000ff')
  assert.equal(styled.runs[0].highlight, '#ffff00')
  assert.equal(styled.runs.find(run => run.text === 'link').href, 'https://example.com/a?x=1&y=2')
  const imageParagraph = result.manifest.blocks.find(block => block.images)
  assert.equal(imageParagraph.text, '[image]')
  assert.deepEqual(imageParagraph.images, [{ offset: 0, src: 'https://images.example.com/diagram.png', alt: 'Architecture', width: 320, height: 200 }])
  assert.equal(result.manifest.images[0].blockIndex, result.manifest.blocks.indexOf(imageParagraph))
  assert.equal(result.manifest.verification.required, true)
  assert.equal(result.status, undefined)
  assert.equal(result.verifiedBy, undefined)
  assert.equal(result.changed, undefined)
})

test('Docs paste inherits inline formatting, honors explicit normal marks, and escapes generated HTML', () => {
  const result = html('<html><body><h2 style="text-align:right"><span style="font-family:\'Playfair Display\';font-size:18pt;color:#AA00BB;background-color:#CCDDEE">A &amp; <b>B <i style="font-weight:400;text-decoration:underline line-through">C</i></b></span></h2><p><a href="https://example.com">5 &lt; 6 &quot;safe&quot;</a></p></body></html>')
  assert.equal(result.manifest.blocks.length, 2)
  const heading = result.manifest.blocks[0]
  assert.equal(heading.style, 'H2')
  assert.equal(heading.align, 'right')
  assert.equal(heading.text, 'A & B C')
  assert.deepEqual(heading.runs.map(run => ({ text: run.text, bold: run.bold, italic: run.italic, underline: run.underline, strike: run.strike })), [
    { text: 'A & ', bold: false, italic: false, underline: false, strike: false },
    { text: 'B ', bold: true, italic: false, underline: false, strike: false },
    { text: 'C', bold: false, italic: true, underline: true, strike: true },
  ])
  assert.equal(heading.runs[0].font, 'Playfair Display')
  assert.equal(heading.runs[0].fontSize, 18)
  assert.equal(heading.runs[0].color, '#aa00bb')
  assert.equal(heading.runs[0].highlight, '#ccddee')
  assert.equal(result.manifest.blocks[1].runs[0].href, 'https://example.com/')
  assert.equal(result.text, 'A & B C\n5 < 6 "safe"')
  assert.match(result.html, />A &amp; <\/span>/u)
  assert.match(result.html, />B <\/span>/u)
  assert.match(result.html, /5 &lt; 6 &quot;safe&quot;/u)
})

test('Docs paste applies caller-provided normal evidence without inventing document defaults', () => {
  const plain = html('<p>Plain</p>')
  assert.equal(plain.manifest.blocks[0].runs[0].font, undefined)
  assert.equal(plain.manifest.blocks[0].runs[0].color, undefined)
  const result = prepareDocsPaste({ html: '<p>Plain <span style="color:#ABCDEF">color</span></p>' }, {
    normal: { font: 'Arial', fontSize: 11, color: '#000000', highlight: 'none' },
  })
  assert.deepEqual(result.manifest.normal, { bold: false, italic: false, underline: false, strike: false, font: 'Arial', fontSize: 11, color: '#000000', highlight: 'none' })
  assert.equal(result.manifest.blocks[0].runs[0].font, 'Arial')
  assert.equal(result.manifest.blocks[0].runs[0].fontSize, 11)
  assert.equal(result.manifest.blocks[0].runs[0].highlight, 'none')
  assert.equal(result.manifest.blocks[0].runs[1].color, '#abcdef')
})

test('Docs paste preserves nested list order, levels, and ordered start values', () => {
  const result = markdown('3. three\n4. four\n    - child\n    - next child\n5. five\n\n- alpha\n- beta')
  const items = result.manifest.blocks.filter(block => block.style === 'LI')
  assert.deepEqual(items.map(item => ({ text: item.text, ordered: item.ordered, level: item.listLevel, number: item.number })), [
    { text: 'three', ordered: true, level: 0, number: 3 },
    { text: 'four', ordered: true, level: 0, number: 4 },
    { text: 'child', ordered: false, level: 1, number: undefined },
    { text: 'next child', ordered: false, level: 1, number: undefined },
    { text: 'five', ordered: true, level: 0, number: 5 },
    { text: 'alpha', ordered: false, level: 0, number: undefined },
    { text: 'beta', ordered: false, level: 0, number: undefined },
  ])
  assert.match(result.text, /3\. three\n4\. four\n  • child\n  • next child\n5\. five\n• alpha\n• beta/u)
})

test('Docs paste supports bounded table spans, backgrounds, header marks, and empty cells', () => {
  const result = html('<table><thead><tr><th colspan="2" style="background-color:#DDEEFF;text-align:center">Head</th></tr></thead><tbody><tr><td rowspan="2">A</td><td>B</td></tr><tr><td style="background-color:transparent"></td></tr></tbody></table>')
  const table = result.manifest.blocks[0]
  assert.equal(table.kind, 'table')
  assert.equal(table.index, 1)
  assert.deepEqual(table.rows.map(row => row.map(cell => ({ text: cell.text, colspan: cell.colspan, rowspan: cell.rowspan, background: cell.background }))), [
    [{ text: 'Head', colspan: 2, rowspan: 1, background: '#ddeeff' }],
    [{ text: 'A', colspan: 1, rowspan: 2, background: 'none' }, { text: 'B', colspan: 1, rowspan: 1, background: 'none' }],
    [{ text: '', colspan: 1, rowspan: 1, background: 'none' }],
  ])
  assert.equal(table.rows[0][0].paragraphs[0].align, 'center')
  assert.equal(table.rows[0][0].paragraphs[0].runs[0].bold, true)
  assert.deepEqual(table.rows[2][0].paragraphs[0].runs, [])
  assert.equal(result.text, 'Head\nA\tB\n')
})

test('Docs paste Markdown tables preserve alignment, escaped pipes, and bounded colspan shorthand', () => {
  const result = markdown('| Left | Center | Right |\n| :--- | :---: | ---: |\n| a\\|b || c |')
  const table = result.manifest.blocks[0]
  assert.equal(table.rows[0][0].paragraphs[0].align, 'left')
  assert.equal(table.rows[0][1].paragraphs[0].align, 'center')
  assert.equal(table.rows[0][2].paragraphs[0].align, 'right')
  assert.equal(table.rows[1][0].text, 'a|b')
  assert.equal(table.rows[1][0].colspan, 2)
  assert.equal(table.rows[1][1].text, 'c')
})

test('Docs paste generated HTML round-trips through the current export parser when evidence is supported', () => {
  const result = markdown('# Title\n\n**bold** and *italic* and ~~strike~~\n\n2. two\n3. three\n\n| H | I |\n| --- | --- |\n| A | B |\n\n\\pagebreak\n\n[end](https://example.com)')
  const actual = parseDocStructure(result.html)
  const verification = verifyDocsPasteAppend(result.manifest, [], actual)
  assert.equal(verification.ok, true, JSON.stringify({ verification, expected: result.manifest.blocks, actual }))
  assert.equal(verification.verifiedBy, 'export')
  assert.equal(verification.verifiedCount, result.manifest.blocks.length)
})

test('Docs paste keeps blank paragraphs and explicit line breaks in both payloads', () => {
  const result = html('<p></p><p>A<br>B</p>')
  assert.deepEqual(result.manifest.blocks.map(block => block.text), ['', 'A\nB'])
  assert.equal(result.text, '\nA\nB')
  assert.deepEqual(result.manifest.blocks[0].runs, [])
})

test('Docs paste requires explicit top-level page-break markers and keeps empty chunks explicit', () => {
  const result = html('<p>A</p><!-- pagebreak --><hr style="page-break-before:always"><p>B</p>')
  assert.equal(result.manifest.counts.pageBreaks, 2)
  assert.equal(result.chunks.length, 3)
  assert.equal(result.chunks[1].empty, true)
  assert.equal(result.chunks[1].html, '<html><body></body></html>')
  assert.deepEqual(result.manifest.blocks.map(block => block.kind), ['para', 'pagebreak', 'pagebreak', 'para'])
  assert.equal((result.html.match(/page-break-before:always/gu) ?? []).length, 2)
  rejected(() => html('<p>A</p><hr><p>B</p>'), 'DOCS_PASTE_STRUCTURE_UNSUPPORTED')
  rejected(() => html('<p>A<!--pagebreak-->B</p>'), 'DOCS_PASTE_STRUCTURE_UNSUPPORTED')
  rejected(() => html('<p>A</p><!--secret-->'), 'DOCS_PASTE_HTML')
})

test('Docs paste accepts https images with alt and bounded independent dimensions', () => {
  const result = html('<p><img src="https://images.example.com/a.png?x=1&amp;y=2" alt="A &quot;diagram&quot;" width="640"><br><img src="https://images.example.com/b.png" alt="" height="480"></p>')
  assert.deepEqual(result.manifest.images.map(image => ({ src: image.src, alt: image.alt, width: image.width, height: image.height })), [
    { src: 'https://images.example.com/a.png?x=1&y=2', alt: 'A "diagram"', width: 640, height: undefined },
    { src: 'https://images.example.com/b.png', alt: '', width: undefined, height: 480 },
  ])
  assert.equal(result.text, '[A "diagram"]\n[image]')
  assert.match(result.html, /x=1&amp;y=2/u)
  assert.match(result.html, /alt="A &quot;diagram&quot;"/u)
  for (const source of [
    '<p><img src="http://example.com/a.png" alt="a"></p>',
    '<p><img src="data:image/png;base64,AA" alt="a"></p>',
    '<p><img src="https://example.com/a.png"></p>',
    '<p><img src="https://example.com/a.png" alt="a" width="0"></p>',
    '<p><img src="https://example.com/a.png" alt="a" height="4097"></p>',
    '<p><a href="https://example.com"><img src="https://example.com/a.png" alt="a"></a></p>',
  ]) rejected(() => html(source))
})

test('Docs paste rejects active or unsupported HTML constructs instead of passing them through', () => {
  const sources = [
    '<script>alert(1)</script>', '<style>p{color:red}</style>', '<iframe src="https://example.com"></iframe>',
    '<form><p>x</p></form>', '<input value="x">', '<textarea>x</textarea>', '<svg><circle></circle></svg>',
    '<math><mi>x</mi></math>', '<video src="https://example.com/v"></video>', '<object data="x"></object>',
    '<link href="https://example.com">', '<meta charset="utf-8">', '<base href="https://example.com">',
    '<template><p>x</p></template>', '<custom-element>x</custom-element>', '<div>x</div>', '<pre>x</pre>',
    '<code>x</code>', '<blockquote>x</blockquote>', '<!doctype html><p>x</p>', '<?xml version="1.0"?><p>x</p>',
  ]
  for (const source of sources) assert.throws(() => html(source), error => error.mutationPossible === false && error.code.startsWith('DOCS_PASTE_'))
  rejected(() => html('<p onclick="alert(1)">x</p>'), 'DOCS_PASTE_ATTRIBUTE_UNSUPPORTED')
  rejected(() => html('<p><img src="https://example.com/a.png" alt="a" onerror="alert(1)"></p>'), 'DOCS_PASTE_ATTRIBUTE_UNSUPPORTED')
  rejected(() => html('<p class="x">x</p>'), 'DOCS_PASTE_ATTRIBUTE_UNSUPPORTED')
})

test('Docs paste rejects malformed markup, duplicate attributes, and ambiguous entities', () => {
  const sources = [
    '<p>x', '</p>', '<p>x</span>', '<p>x</p></p>', '<p style="color:#000000">x</p',
    '<p style=color:#000000>x</p>', '<p style="color:#000000" style="color:#ffffff">x</p>',
    '<p/>', '<p>1 < 2</p>', '<p title="x>y">x</p>', '<p>&copy;</p>', '<p>&#x110000;</p>',
    '<p>&#0;</p>', '<p>&amp;lt;</p>', '<!--unterminated',
  ]
  for (const source of sources) assert.throws(() => html(source), error => error.mutationPossible === false && error.code.startsWith('DOCS_PASTE_'))
  assert.equal(html('<p>&lt;&gt;&amp;&quot;&apos;&nbsp;&#65;&#x42;</p>').text, '<>&"\' AB')
})

test('Docs paste rejects unsafe or nondeterministic CSS before producing a payload', () => {
  const declarations = [
    'behavior:url(https://example.com/x)', 'position:fixed', 'background:url(https://example.com/x)',
    'color:expression(alert(1))', 'color:red', 'font-size:12px', 'font-size:401pt', 'font-weight:600',
    'font-style:oblique', 'font-family:Arial, sans-serif', 'font-family:Arial\\22 onmouseover',
    'text-decoration:blink', 'text-align:start', 'margin:0', 'padding:0', 'white-space:pre-wrap',
    'color:#000000 !important', 'color:#000000;color:#ffffff', '@import:url(https://example.com/x)',
  ]
  for (const declaration of declarations) assert.throws(() => html(`<p style="${declaration}">x</p>`), error => error.mutationPossible === false)
  rejected(() => html('<table style="width:50%"><tr><td>x</td></tr></table>'), 'DOCS_PASTE_STYLE_UNSUPPORTED')
  rejected(() => html('<p><span style="text-align:center">x</span></p>'), 'DOCS_PASTE_STYLE_UNSUPPORTED')
})

test('Docs paste accepts only https links without credentials and normalizes their destinations', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,x', 'http://example.com', '//example.com/x', 'https://user:pass@example.com/x', 'https://example.com/a b']) {
    rejected(() => html(`<p><a href="${href}">x</a></p>`), 'DOCS_PASTE_URL_UNSUPPORTED')
  }
  assert.equal(html('<p><a href="HTTPS://EXAMPLE.COM/a">x</a></p>').manifest.blocks[0].runs[0].href, 'https://example.com/a')
})

test('Docs paste sanitizes raw HTML in Markdown and rejects unsupported Markdown constructs', () => {
  rejected(() => markdown('before\n\n<script>alert(1)</script>'), 'DOCS_PASTE_TAG_UNSUPPORTED')
  for (const source of [
    '`code`', '```\ncode\n```', '> quote', '---', '- [ ] task', '- [x] task',
    '[link](https://example.com "title")', '![alt](https://example.com/a.png "title")',
  ]) rejected(() => markdown(source), 'DOCS_PASTE_MARKDOWN_UNSUPPORTED')
  const result = markdown('escaped \\*stars\\* and \\[brackets\\] and \\| pipe')
  assert.equal(result.text, 'escaped *stars* and [brackets] and | pipe')
})

test('Docs paste validates source shape, normal values, and limits before payload preparation', () => {
  rejected(() => prepareDocsPaste(), 'DOCS_PASTE_ARGUMENT')
  rejected(() => prepareDocsPaste({}), 'DOCS_PASTE_ARGUMENT')
  rejected(() => prepareDocsPaste({ html: '<p>x</p>', markdown: 'x' }), 'DOCS_PASTE_ARGUMENT')
  rejected(() => prepareDocsPaste({ text: 'x' }), 'DOCS_PASTE_ARGUMENT')
  rejected(() => prepareDocsPaste({ html: ' ' }), 'DOCS_PASTE_EMPTY')
  rejected(() => prepareDocsPaste({ markdown: 'x', extra: true }), 'DOCS_PASTE_ARGUMENT')
  rejected(() => prepareDocsPaste({ html: '<p>x</p>' }, { unknown: true }), 'DOCS_PASTE_ARGUMENT')
  rejected(() => prepareDocsPaste({ html: '<p>x</p>' }, { normal: { fontSize: 0 } }), 'DOCS_PASTE_SIZE_UNSUPPORTED')
  rejected(() => html(`<p>${'x'.repeat(DOCS_PASTE_LIMITS.textChars + 1)}</p>`), 'DOCS_PASTE_LIMIT')
  rejected(() => markdown('x'.repeat(DOCS_PASTE_LIMITS.sourceChars + 1)), 'DOCS_PASTE_LIMIT')
  rejected(() => html('<p>\u0001</p>'), 'DOCS_PASTE_TEXT_UNSUPPORTED')
})

test('Docs paste enforces block, node, depth, list, image, and page-break bounds', () => {
  rejected(() => html(Array.from({ length: DOCS_PASTE_LIMITS.topLevelBlocks + 1 }, () => '<p>x</p>').join('')), 'DOCS_PASTE_LIMIT')
  rejected(() => html(`<p>${'<span></span>'.repeat(DOCS_PASTE_LIMITS.nodes)}</p>`), 'DOCS_PASTE_LIMIT')
  rejected(() => html(`<p>${'<span>'.repeat(DOCS_PASTE_LIMITS.depth)}x${'</span>'.repeat(DOCS_PASTE_LIMITS.depth)}</p>`), 'DOCS_PASTE_LIMIT')
  rejected(() => markdown(Array.from({ length: DOCS_PASTE_LIMITS.listItems + 1 }, () => '- item').join('\n')), 'DOCS_PASTE_LIMIT')
  let nested = 'item'
  for (let index = 0; index <= DOCS_PASTE_LIMITS.listDepth; index += 1) nested = `<ul><li>level${nested}</li></ul>`
  rejected(() => html(nested), 'DOCS_PASTE_LIMIT')
  rejected(() => html(`<p>${'<img src="https://example.com/a.png" alt="a">'.repeat(DOCS_PASTE_LIMITS.images + 1)}</p>`), 'DOCS_PASTE_LIMIT')
  rejected(() => html('<!--pagebreak-->'.repeat(DOCS_PASTE_LIMITS.pageBreaks + 1)), 'DOCS_PASTE_LIMIT')
  rejected(() => html(`<p><img src="https://example.com/a.png" alt="${'a'.repeat(DOCS_PASTE_LIMITS.altChars + 1)}"></p>`), 'DOCS_PASTE_LIMIT')
})

test('Docs paste enforces table dimensions and complete non-overlapping rectangles', () => {
  const row = cells => `<tr>${Array.from({ length: cells }, (_, index) => `<td>${index}</td>`).join('')}</tr>`
  rejected(() => html(`<table>${Array.from({ length: DOCS_PASTE_LIMITS.tableRows + 1 }, () => row(1)).join('')}</table>`), 'DOCS_PASTE_LIMIT')
  rejected(() => html(`<table>${row(DOCS_PASTE_LIMITS.tableColumns + 1)}</table>`), 'DOCS_PASTE_STRUCTURE_UNSUPPORTED')
  rejected(() => html(`<table>${Array.from({ length: 21 }, () => row(20)).join('')}</table>`), 'DOCS_PASTE_LIMIT')
  rejected(() => html('<table><tr><td rowspan="2">A</td></tr></table>'), 'DOCS_PASTE_STRUCTURE_UNSUPPORTED')
  rejected(() => html('<table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table>'), 'DOCS_PASTE_STRUCTURE_UNSUPPORTED')
  rejected(() => html('<table><tr><td colspan="2">A</td></tr><tr><td rowspan="2">B</td><td>C</td></tr><tr><td>D</td><td>E</td></tr></table>'), 'DOCS_PASTE_STRUCTURE_UNSUPPORTED')
  rejected(() => html('<table><tr><td><ul><li>x</li></ul></td></tr></table>'), 'DOCS_PASTE_STRUCTURE_UNSUPPORTED')
})

test('Docs paste placement metadata preserves unique and explicit-ordinal anchors for later wiring', () => {
  assert.deepEqual(normalizeDocsPastePlacement(), { mode: 'append', at: 'end' })
  assert.deepEqual(normalizeDocsPastePlacement({ at: 'end' }), { mode: 'append', at: 'end' })
  assert.deepEqual(normalizeDocsPastePlacement({ before: 'Anchor' }), {
    mode: 'before', anchor: { text: 'Anchor' }, matchPolicy: 'unique',
  })
  assert.deepEqual(normalizeDocsPastePlacement({ after: 'Anchor', occurrence: 'first' }), {
    mode: 'after', anchor: { text: 'Anchor', occurrence: 'first' }, matchPolicy: 'explicit-ordinal',
  })
  assert.deepEqual(normalizeDocsPastePlacement({ replace: 'Anchor', occurrence: 3 }), {
    mode: 'replace', anchor: { text: 'Anchor', occurrence: 3 }, matchPolicy: 'explicit-ordinal',
  })
  assert.throws(() => normalizeDocsPastePlacement({ before: 'a', after: 'b' }), error => error.code === 'DOCS_PASTE_ANCHOR')
  assert.throws(() => normalizeDocsPastePlacement({ occurrence: 1 }), error => error.code === 'DOCS_PASTE_ANCHOR')
  assert.throws(() => normalizeDocsPastePlacement({ before: 'a', occurrence: 0 }), error => error.code === 'DOCS_PASTE_ANCHOR')
  assert.throws(() => normalizeDocsPastePlacement({ at: 'start' }), error => error.code === 'DOCS_PASTE_PLACEMENT_UNSUPPORTED')
  assert.throws(() => prepareDocsPaste({ html: '<p>x</p>', before: 'Anchor', occurrence: 2 }), error => (
    error.code === 'DOCS_PASTE_PLACEMENT_UNSUPPORTED' && error.mutationPossible === false
      && error.placement.anchor.occurrence === 2 && error.placement.matchPolicy === 'explicit-ordinal'
  ))
})

test('Docs paste export verification accepts exact appended content and split equivalent runs', () => {
  const prefix = [paragraph()]
  const result = prepareDocsPaste({ html: '<p style="font-family:Arial;color:#000000;background-color:transparent">Hello <a href="https://example.com">world</a></p>' }, { normal: { fontSize: 11 } })
  const actual = structuredClone(result.manifest.blocks)
  const first = actual[0].runs[0]
  const [left, right] = [first.text.slice(0, 2), first.text.slice(2)]
  actual[0].runs.splice(0, 1, { ...first, text: left }, { ...first, text: right })
  const verification = verifyDocsPasteAppend(result.manifest, prefix, [...prefix, ...actual])
  assert.deepEqual(verification, { ok: true, status: 'verified', verifiedCount: 1, verifiedBy: 'export', mutationPossible: true })
})

test('Docs paste export verification rejects text, formatting, link, and table divergence', () => {
  const result = markdown('**bold** [link](https://example.com)\n\n| A |\n| --- |\n| B |')
  for (const mutate of [
    actual => { actual[0].text = 'changed' },
    actual => { actual[0].runs[0].bold = false },
    actual => { delete actual[0].runs.at(-1).href },
    actual => { actual[1].rows[1][0].text = 'changed' },
    actual => { actual[1].rows[0][0].background = '#ffffff' },
  ]) {
    const actual = structuredClone(result.manifest.blocks)
    mutate(actual)
    const verification = verifyDocsPasteAppend(result.manifest, [], actual)
    assert.equal(verification.ok, false)
    assert.equal(verification.status, 'failed')
    assert.equal(verification.code, 'DOCS_PASTE_VERIFY_FAILED')
    assert.equal(verification.mutationPossible, true)
  }
})

test('Docs paste export verification detects prefix collateral and unexpected suffix content', () => {
  const prefix = [paragraph()]
  const result = html('<p>Appended</p>')
  const changedPrefix = [paragraph('Changed'), ...structuredClone(result.manifest.blocks)]
  const prefixResult = verifyDocsPasteAppend(result.manifest, prefix, changedPrefix)
  assert.equal(prefixResult.code, 'DOCS_PASTE_COLLATERAL')
  assert.equal(prefixResult.failure.collateral, true)
  assert.equal(prefixResult.failure.index, -1)
  const suffixResult = verifyDocsPasteAppend(result.manifest, prefix, [...prefix, ...structuredClone(result.manifest.blocks), paragraph('Extra')])
  assert.equal(suffixResult.code, 'DOCS_PASTE_COLLATERAL')
  assert.equal(suffixResult.failure.collateral, true)
  assert.equal(suffixResult.verifiedCount, 1)
})

test('Docs paste export verification distinguishes an unchanged export from missing evidence', () => {
  const result = html('<p style="text-align:center">A<img src="https://example.com/a.png" alt="a"></p>')
  const unchanged = verifyDocsPasteAppend(result.manifest, [], [])
  assert.equal(unchanged.status, 'failed')
  assert.equal(unchanged.code, 'DOCS_PASTE_VERIFY_FAILED')
  assert.equal(unchanged.failure.unchanged, true)
  const noAlignment = structuredClone(result.manifest.blocks)
  delete noAlignment[0].align
  const alignment = verifyDocsPasteAppend(result.manifest, [], noAlignment)
  assert.equal(alignment.status, 'unknown')
  assert.equal(alignment.code, 'DOCS_PASTE_EVIDENCE_REQUIRED')
  assert.equal(alignment.failure.evidence, 'alignment')
  const noImages = structuredClone(result.manifest.blocks)
  delete noImages[0].images
  const images = verifyDocsPasteAppend(result.manifest, [], noImages)
  assert.equal(images.status, 'unknown')
  assert.equal(images.failure.evidence, 'images')
  const noRuns = structuredClone(result.manifest.blocks)
  delete noRuns[0].runs
  const runs = verifyDocsPasteAppend(result.manifest, [], noRuns)
  assert.equal(runs.status, 'unknown')
  assert.equal(runs.failure.evidence, 'runs')
})

test('Docs paste export verification does not confuse missing metadata with wrong metadata', () => {
  const result = html('<p><img src="https://example.com/a.png" alt="expected"></p>')
  const actual = structuredClone(result.manifest.blocks)
  actual[0].images[0].alt = 'wrong'
  const verification = verifyDocsPasteAppend(result.manifest, [], actual)
  assert.equal(verification.status, 'failed')
  assert.equal(verification.code, 'DOCS_PASTE_VERIFY_FAILED')
  assert.notEqual(verification.status, 'unknown')
})

test('Docs paste export verification ignores global table numbering but not appended structure', () => {
  const result = html('<table><tr><td>A</td></tr></table>')
  const actual = structuredClone(result.manifest.blocks)
  actual[0].index = 8
  assert.equal(verifyDocsPasteAppend(result.manifest, [], actual).ok, true)
  actual[0].rows[0][0].colspan = 2
  assert.equal(verifyDocsPasteAppend(result.manifest, [], actual).code, 'DOCS_PASTE_VERIFY_FAILED')
  const wrongKind = structuredClone(result.manifest.blocks)
  wrongKind[0].rows[0][0].paragraphs[0].kind = 'image'
  assert.equal(verifyDocsPasteAppend(result.manifest, [], wrongKind).code, 'DOCS_PASTE_VERIFY_FAILED')
})

test('Docs paste rejects ignored CSS, reordered nested-list content, and ambiguous Markdown blocks', () => {
  rejected(() => html('<table style="color:#000000"><tr><td>x</td></tr></table>'), 'DOCS_PASTE_STYLE_UNSUPPORTED')
  rejected(() => html('<hr style="page-break-before:always;color:#000000">'), 'DOCS_PASTE_STYLE_UNSUPPORTED')
  rejected(() => html('<ul><li><ul><li>nested</li></ul>parent after</li></ul>'), 'DOCS_PASTE_STRUCTURE_UNSUPPORTED')
  for (const source of ['Heading\n===', 'text\n---', '~~~\ncode\n~~~', '    indented code', 'text\n> quote', 'text\n***']) {
    rejected(() => markdown(source), 'DOCS_PASTE_MARKDOWN_UNSUPPORTED')
  }
})

test('Docs paste round-trips nested lists and spans and rejects ambiguous Markdown table geometry', () => {
  const nested = markdown('- parent\n    - child\n- next')
  assert.equal(verifyDocsPasteAppend(nested.manifest, [], parseDocStructure(nested.html)).ok, true)
  const spanned = html('<table><tr><td rowspan="2" style="background-color:#ddeeff">A</td><td>B</td></tr><tr><td>C</td></tr></table>')
  assert.equal(verifyDocsPasteAppend(spanned.manifest, [], parseDocStructure(spanned.html)).ok, true)
  const empty = markdown('| A | B |\n| --- | --- |\n| x |  |')
  assert.equal(empty.manifest.blocks[0].rows[1][1].text, '')
  assert.equal(empty.manifest.blocks[0].rows[1][1].colspan, 1)
  rejected(() => markdown('| A || B |\n| --- | --- |\n| x | y | z |'), 'DOCS_PASTE_MARKDOWN_UNSUPPORTED')
})
