import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeEntities, formatOutline, parseClassMarks, parseDocStructure } from '../sidepanel/docs-structure.js'

const STYLE = '<style>.c7{font-weight:700}.c8{font-style:italic}.c9{text-decoration:underline}.c33{text-decoration:line-through}.roboto{font-family:"Roboto";font-size:11pt}.display{font-family:\'Playfair Display\';font-size:28pt}.bodyFont{font-family:Arial;font-size:10pt}</style>'
const doc = body => `<html><head>${STYLE}</head><body class="bodyFont">${body}</body></html>`

test('Docs structure decodes named, numeric, and nonbreaking entities', () => {
  assert.equal(decodeEntities('a&amp;b &lt;x&gt; &#39;q&#39; &#x41;&nbsp;z'), "a&b <x> 'q' A z")
})

test('Docs structure reads title, headings, marks, and links', () => {
  const blocks = parseDocStructure(doc(
    '<p class="c4 title"><span>Report</span></p>'
      + '<h1 class="c2"><span>Intro</span></h1>'
      + '<p class="c2"><span class="c1">Plain </span><span class="c7">bold</span><span> and </span><span class="c8 c7">both</span></p>'
      + '<p><span><a href="https://www.google.com/url?q=https://ex.com/a&amp;sa=D">site</a></span></p>',
  ))
  assert.equal(blocks.length, 4)
  assert.deepEqual(blocks.map(block => [block.style, block.text]), [['TITLE', 'Report'], ['H1', 'Intro'], ['P', 'Plain bold and both'], ['P', 'site']])
  assert.equal(blocks[2].marked, 'Plain **bold** and ***both***')
  assert.equal(blocks[3].marked, '[site](https://ex.com/a)')
})

test('Docs structure reads inherited and requested font and size evidence', () => {
  const blocks = parseDocStructure(doc(
    '<p class="roboto"><span>Body</span></p><p class="title display"><span>Heading</span></p>',
  ))
  assert.equal(blocks[0].runs[0].font, 'Roboto')
  assert.equal(blocks[0].runs[0].fontSize, 11)
  assert.equal(blocks[1].runs[0].font, 'Playfair Display')
  assert.equal(blocks[1].runs[0].fontSize, 28)
  const inherited = parseDocStructure(doc('<p><span>Default</span></p>'))
  assert.equal(inherited[0].runs[0].font, 'Arial')
  assert.equal(inherited[0].runs[0].fontSize, 10)
})

test('Docs structure reads list type, nesting, and ordered start values', () => {
  const blocks = parseDocStructure(doc(
    '<ul class="lst-kix_a-0"><li class="c2 li-bullet-0 lst-kix_a-0"><span>one</span></li></ul>'
      + '<ul class="lst-kix_a-1"><li class="lst-kix_a-1"><span>nested</span></li></ul>'
      + '<ol start="3" class="lst-kix_b-0"><li class="lst-kix_b-0"><span>third</span></li><li class="lst-kix_b-0"><span>fourth</span></li></ol>',
  ))
  assert.deepEqual(blocks.map(block => [block.text, block.listLevel, block.ordered, block.number]), [
    ['one', 0, false, undefined], ['nested', 1, false, undefined], ['third', 0, true, 3], ['fourth', 0, true, 4],
  ])
  assert.match(formatOutline(blocks), /• one/)
  assert.match(formatOutline(blocks), /  • nested/)
  assert.match(formatOutline(blocks), /3\. third/)
  assert.match(formatOutline(blocks), /4\. fourth/)
})

test('Docs structure preserves checklist and checked-state evidence', () => {
  const blocks = parseDocStructure(doc(
    '<ul><li><input type="checkbox" checked="checked"><span>done</span></li>'
      + '<li><input type="checkbox"><span>pending</span></li></ul>',
  ))
  assert.deepEqual(blocks.map(block => [block.text, block.checklist, block.checked]), [
    ['done', true, true], ['pending', true, false],
  ])
  assert.match(formatOutline(blocks), /☑ done/)
  assert.match(formatOutline(blocks), /☐ pending/)
})

test('Docs structure outline preserves empty lines and table shape', () => {
  const blocks = parseDocStructure(doc(
    '<h2><span>Results</span></h2><p></p><p></p>'
      + '<table><tr><td colspan="2"><p><span>H</span></p></td></tr><tr><td><p><span>1</span></p></td><td></td></tr></table>',
  ))
  assert.match(formatOutline(blocks), /H2: Results/)
  assert.match(formatOutline(blocks), /\(empty line ×2\)/)
  assert.match(formatOutline(blocks), /TABLE 1 \(2 rows × 2 cols\)/)
  assert.match(formatOutline(blocks), /H ⟨merged 1×2⟩/)
  assert.match(formatOutline(blocks), /1 \| ·/)
})

test('Docs structure class parser captures formatting without treating color as a text mark', () => {
  const marks = parseClassMarks(doc(''))
  assert.deepEqual(marks.get('c7'), { bold: true })
  assert.deepEqual(marks.get('c8'), { italic: true })
  assert.deepEqual(marks.get('c9'), { underline: true, strike: false })
  assert.deepEqual(marks.get('c33'), { underline: false, strike: true })
  assert.equal(marks.has('c1'), false)
})

test('Docs structure preserves run color and highlight evidence without page backgrounds', () => {
  const blocks = parseDocStructure('<html><head><style>.blue{color:#0000ff;background-color:#ffff00}.clear{background-color:transparent}.page{color:#000000;background-color:#ffffff}</style></head><body class="page"><p><span>plain </span><span class="blue">blue</span><span class="clear"> clear</span></p></body></html>')
  assert.equal(blocks.length, 1)
  assert.deepEqual(blocks[0].runs.map(run => ({ text: run.text, color: run.color, highlight: run.highlight })), [
    { text: 'plain ', color: '#000000', highlight: undefined },
    { text: 'blue', color: '#0000ff', highlight: '#ffff00' },
    { text: ' clear', color: '#000000', highlight: 'none' },
  ])
  assert.equal(blocks[0].marked, 'plain blue clear')
  assert.equal(formatOutline(blocks), 'P: plain blue clear')
})

test('Docs structure honors explicit normal formatting over inherited emphasis', () => {
  const blocks = parseDocStructure('<html><head><style>.fancy{font-style:italic;font-weight:700;text-decoration:underline}.plain{font-style:normal;font-weight:400;text-decoration:none}</style></head><body><p class="fancy"><span class="plain">plain</span><span>fancy</span></p></body></html>')
  assert.deepEqual(blocks[0].runs.map(run => ({ text: run.text, bold: run.bold, italic: run.italic, underline: run.underline })), [
    { text: 'plain', bold: false, italic: false, underline: false },
    { text: 'fancy', bold: true, italic: true, underline: true },
  ])
})
