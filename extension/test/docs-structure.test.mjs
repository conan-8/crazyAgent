import test from 'node:test'
import assert from 'node:assert/strict'
import { parseInheritedTextMarks, decodeEntities, formatOutline, parseClassMarks, parseDocStructure, parseNamedStyleDefaults } from '../sidepanel/docs-structure.js'

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

test('Docs structure outline preserves empty lines, table shape, and cell backgrounds', () => {
  const blocks = parseDocStructure(doc(
    '<h2><span>Results</span></h2><p></p><p></p>'
      + '<table><tr><td colspan="2" style="background-color:#cccccc"><p><span>H</span></p></td></tr><tr><td><p><span>1</span></p></td><td></td></tr></table>',
  ))
  assert.match(formatOutline(blocks), /H2: Results/)
  assert.match(formatOutline(blocks), /\(empty line ×2\)/)
  assert.match(formatOutline(blocks), /TABLE 1 \(2 rows × 2 cols\)/)
  assert.match(formatOutline(blocks), /H ⟨merged 1×2⟩/)
  assert.match(formatOutline(blocks), /1 \| ·/)
  assert.equal(blocks[3].rows[0][0].background, '#cccccc')
  assert.equal(blocks[3].rows[1][0].background, 'none')
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

test('Docs structure honors explicit normal font formatting and preserves ancestor text decoration', () => {
  const blocks = parseDocStructure('<html><head><style>.fancy{font-style:italic;font-weight:700;text-decoration:underline}.plain{font-style:normal;font-weight:400;text-decoration:none}</style></head><body><p class="fancy"><span class="plain">plain</span><span>fancy</span></p></body></html>')
  assert.deepEqual(blocks[0].runs.map(run => ({ text: run.text, bold: run.bold, italic: run.italic, underline: run.underline })), [
    { text: 'plain', bold: false, italic: false, underline: true },
    { text: 'fancy', bold: true, italic: true, underline: true },
  ])
})

test('Docs structure reads exact text-decoration properties and ancestor checked styling', () => {
  const blocks = parseDocStructure('<html><head><style>.c5{color:#000000;font-weight:400;text-decoration:none;vertical-align:baseline;font-size:11pt;font-family:"Roboto";font-style:normal}.c8{font-weight:400;font-family:"Roboto"}.c24{text-decoration-skip-ink:none;-webkit-text-decoration-skip:none;text-decoration:underline}.c26{text-decoration:line-through}</style></head><body><p><span class="c8">plain </span><span class="c8 c24">underlined</span></p><ul><li class="c26"><span class="c5">checked</span></li></ul></body></html>')
  assert.equal(blocks[0].runs[1].text, 'underlined')
  assert.equal(blocks[0].runs[1].underline, true)
  assert.equal(blocks[0].runs[1].strike, false)
  assert.equal(blocks[0].marked, 'plain __underlined__')
  assert.equal(blocks[1].runs[0].text, 'checked')
  assert.equal(blocks[1].runs[0].strike, true)
  assert.equal(blocks[1].marked, '~~checked~~')
})

test('Docs structure preserves per-run link identity and does not merge different links', () => {
  const blocks = parseDocStructure(doc(
    '<p><span><a href="https://www.google.com/url?q=https://ex.com/a&amp;sa=D">same</a></span>'
      + '<span><a href="https://other.test">same</a></span><span>plain</span></p>',
  ))
  assert.deepEqual(blocks[0].runs.map(run => ({ text: run.text, href: run.href })), [
    { text: 'same', href: 'https://ex.com/a' },
    { text: 'same', href: 'https://other.test' },
    { text: 'plain', href: undefined },
  ])
  assert.equal(blocks[0].marked, '[same](https://ex.com/a)[same](https://other.test)plain')
})

test('element rules give the font, size, and color an unsized span inherits', () => {
  // Excerpt of a live Docs HTML export (2026-11-19).
  const html = '<html><head><style type="text/css">ol{margin:0;padding:0}.c2{text-decoration:underline}'
    + '.lst-kix_a-0>li{counter-increment:lst-ctn-kix_a-0}li{color:#000000;font-size:11pt;font-family:"Arial"}'
    + 'p{margin:0;color:#000000;font-size:11pt;font-family:"Arial"}'
    + 'h1{padding-top:12pt;color:#000000;font-weight:700;font-size:24pt;font-family:"Arial"}'
    + '.title{color:#000000;font-size:36pt;font-family:"Arial"}</style></head><body><p class="c1"><span class="c2">Under</span></p></body></html>'
  const marks = parseInheritedTextMarks(html)
  assert.deepEqual(marks.get('p'), { font: 'Arial', fontSize: 11, color: '#000000' })
  assert.deepEqual(marks.get('li'), { font: 'Arial', fontSize: 11, color: '#000000' })
  assert.deepEqual(marks.get('h1'), { font: 'Arial', fontSize: 24, color: '#000000' }, 'heading weight is not part of the inherited text marks')
  assert.equal(marks.has('title'), false, 'class rules stay with parseClassMarks')
  assert.equal(marks.size, 3)
})

test('element rules ignore descendant selectors and merge repeated standalone rules', () => {
  const html = '<html><head><style type="text/css">'
    + '@import url(https://fonts.example/css);'
    + 'p{color:#000000;font-family:"Arial"} p{font-size:11pt}'
    + 'td p{margin:0;color:#ff0000;font-size:9pt}'
    + 'li{color:#000000;font-size:11pt;font-family:"Arial"}'
    + 'ul li{margin:0;font-family:"Courier New"}'
    + '/* comment */ h1{font-size:24pt;font-weight:700;font-family:"Arial"}'
    + '.box h1{font-size:12pt;font-weight:400}'
    + '</style></head><body></body></html>'
  const marks = parseInheritedTextMarks(html)
  assert.deepEqual(marks.get('p'), { font: 'Arial', fontSize: 11, color: '#000000' })
  assert.deepEqual(marks.get('li'), { font: 'Arial', fontSize: 11, color: '#000000' })
  assert.deepEqual(marks.get('h1'), { font: 'Arial', fontSize: 24 })
  const styles = parseNamedStyleDefaults(html)
  assert.deepEqual(styles.get('Normal text'), { font: 'Arial', fontSize: 11, color: '#000000', bold: false, italic: false })
  assert.deepEqual(styles.get('Heading 1'), { font: 'Arial', fontSize: 24, color: '#000000', bold: true, italic: false })
})

// Named-style rules copied from a live export with custom styles (2026-11-19).
const NAMED_RULES = '<style>.c23{font-size:20pt}.c40{font-weight:400}'
  + 'li{color:#000000;font-size:11pt;font-family:"Arial"}p{margin:0;color:#000000;font-size:11pt;font-family:"Arial"}'
  + 'h1{padding-top:12pt;color:#000000;font-weight:700;font-size:24pt;padding-bottom:12pt;font-family:"Arial";line-height:1.0;text-align:left}'
  + 'h6{padding-top:12pt;color:#666666;font-size:11pt;padding-bottom:4pt;font-family:"Arial";line-height:1.0;font-style:italic;text-align:left}'
  + '.title{padding-top:24pt;color:#000000;font-weight:700;font-size:36pt;padding-bottom:6pt;font-family:"Arial";line-height:1.0;page-break-after:avoid;text-align:left}'
  + '.subtitle{padding-top:18pt;color:#666666;font-size:24pt;padding-bottom:4pt;font-family:"Georgia";line-height:1.0;page-break-after:avoid;font-style:italic;text-align:left}</style>'

test('heading runs inherit weight and italics from their element rule; the outline keeps explicit marks', () => {
  // A live Section Three span was only font-size:20pt under h1{font-weight:700}:
  // it rendered bold, but parsed as bold:false and failed a bold verification.
  const blocks = parseDocStructure(`<html><head>${NAMED_RULES}</head><body class="c0">`
    + '<h1 class="c9"><span class="c23">Section Three</span></h1>'
    + '<h1 class="c9"><span class="c40">Light heading</span></h1>'
    + '<h6 class="c9"><span>Small print</span></h6>'
    + '<p class="c1"><span>Body</span></p></body></html>')
  assert.deepEqual(blocks.map(block => [block.style, block.runs[0].bold, block.runs[0].italic]), [
    ['H1', true, false],
    ['H1', false, false],
    ['H6', false, true],
    ['P', false, false],
  ])
  assert.equal(blocks[0].runs[0].fontSize, 20)
  assert.deepEqual(blocks.map(block => block.marked), ['Section Three', 'Light heading', 'Small print', 'Body'])
  assert.equal(Object.hasOwn(blocks[0], 'emphasis'), false)
})

test('named style defaults combine class and element rules the way Docs renders them', () => {
  const html = `<html><head>${NAMED_RULES}</head><body></body></html>`
  const styles = parseNamedStyleDefaults(html)
  assert.deepEqual(styles.get('Normal text'), { font: 'Arial', fontSize: 11, color: '#000000', bold: false, italic: false })
  assert.deepEqual(styles.get('Title'), { font: 'Arial', fontSize: 36, color: '#000000', bold: true, italic: false })
  assert.deepEqual(styles.get('Subtitle'), { font: 'Georgia', fontSize: 24, color: '#666666', bold: false, italic: true })
  assert.deepEqual(styles.get('Heading 1'), { font: 'Arial', fontSize: 24, color: '#000000', bold: true, italic: false })
  assert.deepEqual(styles.get('Heading 6'), { font: 'Arial', fontSize: 11, color: '#666666', bold: false, italic: true })
  assert.equal(styles.has('Heading 2'), false, 'a style without exported rules is left to the caller')
})
