export const DOCS_PASTE_LIMITS = Object.freeze({
  sourceChars: 100_000,
  textChars: 20_000,
  htmlChars: 500_000,
  nodes: 5_000,
  depth: 24,
  topLevelBlocks: 50,
  blocks: 500,
  runs: 2_000,
  listItems: 200,
  listDepth: 8,
  tables: 10,
  tableRows: 50,
  tableColumns: 20,
  tableCells: 400,
  cellParagraphs: 20,
  images: 20,
  imageDimension: 4_096,
  altChars: 1_000,
  urlChars: 2_048,
  pageBreaks: 20,
})

const INLINE_TAGS = new Set(['span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'mark', 'a', 'br', 'img'])
const VOID_TAGS = new Set(['br', 'hr', 'img'])
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const RUN_FIELDS = ['bold', 'italic', 'underline', 'strike', 'font', 'fontSize', 'color', 'highlight', 'href']
const REQUIRED_RUN_FIELDS = ['bold', 'italic', 'underline', 'strike']
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
const LIST_LINE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

function pasteFailure(code, message, path, details = {}) {
  const error = new Error(path ? `${path}: ${message}` : message)
  error.code = code
  error.stage = 'validate'
  error.mutationPossible = false
  if (path) error.path = path
  Object.assign(error, details)
  return error
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function checkKeys(value, allowed, path) {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw pasteFailure('DOCS_PASTE_ARGUMENT', 'contains an unknown or invalid argument', path)
  }
}

function checkText(value, path) {
  if (CONTROL_CHARS.test(value)) throw pasteFailure('DOCS_PASTE_TEXT_UNSUPPORTED', 'contains a control character', path)
}

function decodeEntities(value, path) {
  const text = String(value)
  const decoded = text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/giu, (match, name) => {
    if (name[0] === '#') {
      const hex = name[1]?.toLowerCase() === 'x'
      const number = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (!Number.isSafeInteger(number) || number < 0 || number > 0x10ffff || number >= 0xd800 && number <= 0xdfff) {
        throw pasteFailure('DOCS_PASTE_ENTITY_UNSUPPORTED', 'contains an invalid numeric entity', path)
      }
      return String.fromCodePoint(number === 160 ? 32 : number)
    }
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
    if (!Object.hasOwn(entities, name.toLowerCase())) throw pasteFailure('DOCS_PASTE_ENTITY_UNSUPPORTED', `contains unsupported entity ${match}`, path)
    return entities[name.toLowerCase()]
  })
  if (/&(?:#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/iu.test(decoded)) {
    throw pasteFailure('DOCS_PASTE_ENTITY_UNSUPPORTED', 'contains a recursively encoded entity', path)
  }
  checkText(decoded, path)
  return decoded
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function normalizeColor(value, allowNone, path) {
  if (typeof value !== 'string') throw pasteFailure('DOCS_PASTE_COLOR_UNSUPPORTED', 'must be a six-digit hex color', path)
  const color = value.trim().toLowerCase()
  if (allowNone && ['none', 'transparent'].includes(color)) return 'none'
  if (!/^#[0-9a-f]{6}$/u.test(color)) throw pasteFailure('DOCS_PASTE_COLOR_UNSUPPORTED', `must be ${allowNone ? '"none", "transparent", or ' : ''}a six-digit hex color`, path)
  return color
}

function normalizeFont(value, path) {
  if (typeof value !== 'string') throw pasteFailure('DOCS_PASTE_FONT_UNSUPPORTED', 'must be one font family', path)
  let font = value.trim()
  if (font.length >= 2 && (font.startsWith('"') && font.endsWith('"') || font.startsWith("'") && font.endsWith("'"))) font = font.slice(1, -1).trim()
  if (!/^[a-z0-9][a-z0-9 ._-]{0,99}$/iu.test(font)) {
    throw pasteFailure('DOCS_PASTE_FONT_UNSUPPORTED', 'must be one unescaped font family of at most 100 characters', path)
  }
  return font
}

function normalizeSize(value, path) {
  const match = /^(\d{1,3})\s*pt$/iu.exec(String(value).trim())
  const size = match ? Number(match[1]) : 0
  if (!Number.isInteger(size) || size < 1 || size > 400) throw pasteFailure('DOCS_PASTE_SIZE_UNSUPPORTED', 'must be an integer from 1pt to 400pt', path)
  return size
}

function normalizeUrl(value, path) {
  if (typeof value !== 'string' || value.length === 0 || value.length > DOCS_PASTE_LIMITS.urlChars || value.trim() !== value || /\s/u.test(value)) {
    throw pasteFailure('DOCS_PASTE_URL_UNSUPPORTED', `must be a non-empty https URL of at most ${DOCS_PASTE_LIMITS.urlChars} characters without whitespace`, path)
  }
  let url
  try { url = new URL(value) } catch { throw pasteFailure('DOCS_PASTE_URL_UNSUPPORTED', 'is not a valid absolute URL', path) }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw pasteFailure('DOCS_PASTE_URL_UNSUPPORTED', 'must be an https URL without embedded credentials', path)
  }
  return url.href
}

function normalizeOccurrence(value, path) {
  if (value === undefined) return undefined
  if (value === 'first' || value === 'last') return value
  if (!Number.isSafeInteger(value) || value < 1) throw pasteFailure('DOCS_PASTE_ANCHOR', 'occurrence must be "first", "last", or a positive integer', path)
  return value
}

function normalizeAnchorText(value, path) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_000 || /[\r\n\u2028\u2029]/u.test(value)) {
    throw pasteFailure('DOCS_PASTE_ANCHOR', 'anchor text must be one nonblank single-line string of at most 1000 characters', path)
  }
  return value
}

export function normalizeDocsPastePlacement(value = {}) {
  checkKeys(value, ['at', 'before', 'after', 'replace', 'occurrence'], 'placement')
  const modes = ['before', 'after', 'replace'].filter(mode => value[mode] !== undefined)
  if (value.at !== undefined) modes.push('at')
  if (modes.length > 1) throw pasteFailure('DOCS_PASTE_ANCHOR', 'provide exactly one of at, before, after, or replace', 'placement')
  if (modes.length === 0 || modes[0] === 'at') {
    if (value.at !== undefined && value.at !== 'end') throw pasteFailure('DOCS_PASTE_PLACEMENT_UNSUPPORTED', 'only at:"end" is supported for append preparation', 'placement.at')
    if (value.occurrence !== undefined) throw pasteFailure('DOCS_PASTE_ANCHOR', 'occurrence requires a before, after, or replace anchor', 'placement.occurrence')
    return { mode: 'append', at: 'end' }
  }
  const mode = modes[0]
  const occurrence = normalizeOccurrence(value.occurrence, 'placement.occurrence')
  return {
    mode,
    anchor: { text: normalizeAnchorText(value[mode], `placement.${mode}`), ...occurrence === undefined ? {} : { occurrence } },
    matchPolicy: occurrence === undefined ? 'unique' : 'explicit-ordinal',
  }
}

function parseStyle(value, context, path) {
  const marks = {}
  const result = { marks }
  if (value === undefined) return result
  if (typeof value !== 'string' || value.length > 2_000 || /[{}@\\!]/u.test(value) || /\/\*/u.test(value)) {
    throw pasteFailure('DOCS_PASTE_STYLE_UNSUPPORTED', 'contains unsupported CSS syntax', path)
  }
  const allowed = new Set(context === 'table' ? ['border-collapse', 'width']
    : context === 'pagebreak' ? ['page-break-before']
      : ['font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line', 'color', 'background-color'])
  if (['paragraph', 'cell'].includes(context)) allowed.add('text-align')
  const seen = new Set()
  for (const declaration of value.split(';')) {
    if (!declaration.trim()) continue
    const colon = declaration.indexOf(':')
    if (colon < 1) throw pasteFailure('DOCS_PASTE_STYLE_UNSUPPORTED', 'contains a malformed declaration', path)
    const property = declaration.slice(0, colon).trim().toLowerCase()
    const raw = declaration.slice(colon + 1).trim()
    if (!allowed.has(property) || !raw || seen.has(property)) {
      throw pasteFailure('DOCS_PASTE_STYLE_UNSUPPORTED', `property ${JSON.stringify(property)} is unsupported or duplicated in this context`, path)
    }
    seen.add(property)
    if (property === 'font-family') marks.font = normalizeFont(raw, path)
    else if (property === 'font-size') marks.fontSize = normalizeSize(raw, path)
    else if (property === 'font-weight') {
      if (!['400', '700', 'normal', 'bold'].includes(raw.toLowerCase())) throw pasteFailure('DOCS_PASTE_STYLE_UNSUPPORTED', 'font-weight accepts only normal, bold, 400, or 700', path)
      marks.bold = ['700', 'bold'].includes(raw.toLowerCase())
    } else if (property === 'font-style') {
      if (!['normal', 'italic'].includes(raw.toLowerCase())) throw pasteFailure('DOCS_PASTE_STYLE_UNSUPPORTED', 'font-style accepts only normal or italic', path)
      marks.italic = raw.toLowerCase() === 'italic'
    } else if (property === 'text-decoration' || property === 'text-decoration-line') {
      if (seen.has('text-decoration') && seen.has('text-decoration-line')) throw pasteFailure('DOCS_PASTE_STYLE_UNSUPPORTED', 'use only one text-decoration property', path)
      const decoration = raw.toLowerCase()
      if (decoration === 'none') {
        marks.underline = false
        marks.strike = false
      } else {
        const tokens = decoration.split(/\s+/u)
        if (tokens.some(token => !['underline', 'line-through'].includes(token)) || new Set(tokens).size !== tokens.length) {
          throw pasteFailure('DOCS_PASTE_STYLE_UNSUPPORTED', 'text-decoration accepts only underline and line-through', path)
        }
        marks.underline = tokens.includes('underline')
        marks.strike = tokens.includes('line-through')
      }
    } else if (property === 'color') marks.color = normalizeColor(raw, false, path)
    else if (property === 'background-color') {
      const color = normalizeColor(raw, true, path)
      if (context === 'cell') result.background = color
      else marks.highlight = color
    } else if (property === 'text-align') {
      const align = raw.toLowerCase()
      if (!['left', 'center', 'right', 'justify'].includes(align)) throw pasteFailure('DOCS_PASTE_STYLE_UNSUPPORTED', 'text-align accepts only left, center, right, or justify', path)
      result.align = align
    } else if (property === 'border-collapse' && raw.toLowerCase() !== 'collapse') {
      throw pasteFailure('DOCS_PASTE_STYLE_UNSUPPORTED', 'border-collapse accepts only collapse', path)
    } else if (property === 'width' && raw !== '100%') {
      throw pasteFailure('DOCS_PASTE_STYLE_UNSUPPORTED', 'table width accepts only 100%', path)
    } else if (property === 'page-break-before') {
      if (raw.toLowerCase() !== 'always') throw pasteFailure('DOCS_PASTE_STYLE_UNSUPPORTED', 'page-break-before accepts only always', path)
      result.pageBreak = true
    }
  }
  return result
}

function parseHtml(source) {
  const root = { type: 'root', children: [] }
  const stack = [root]
  let nodes = 0
  let index = 0
  const add = node => {
    nodes += 1
    if (nodes > DOCS_PASTE_LIMITS.nodes) throw pasteFailure('DOCS_PASTE_LIMIT', `contains more than ${DOCS_PASTE_LIMITS.nodes} HTML nodes`, 'html')
    stack.at(-1).children.push(node)
  }
  while (index < source.length) {
    if (source[index] !== '<') {
      const end = source.indexOf('<', index)
      const next = end < 0 ? source.length : end
      const raw = source.slice(index, next)
      if (raw) add({ type: 'text', text: decodeEntities(raw, `html[${index}]`) })
      index = next
      continue
    }
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4)
      if (end < 0) throw pasteFailure('DOCS_PASTE_HTML', 'contains an unterminated comment', `html[${index}]`)
      if (!/^\s*pagebreak\s*$/iu.test(source.slice(index + 4, end))) throw pasteFailure('DOCS_PASTE_HTML', 'only <!--pagebreak--> comments are supported', `html[${index}]`)
      add({ type: 'pagebreak' })
      index = end + 3
      continue
    }
    if (source.startsWith('<!', index) || source.startsWith('<?', index)) throw pasteFailure('DOCS_PASTE_HTML', 'doctypes, processing instructions, and CDATA are unsupported', `html[${index}]`)
    const closing = source.startsWith('</', index)
    let cursor = index + (closing ? 2 : 1)
    const nameMatch = /^[a-z][a-z0-9]*/iu.exec(source.slice(cursor))
    if (!nameMatch) throw pasteFailure('DOCS_PASTE_HTML', 'contains a malformed tag or an unescaped < character', `html[${index}]`)
    const tag = nameMatch[0].toLowerCase()
    cursor += nameMatch[0].length
    if (closing) {
      while (/\s/u.test(source[cursor] ?? '')) cursor += 1
      if (source[cursor] !== '>') throw pasteFailure('DOCS_PASTE_HTML', `has a malformed closing tag for ${tag}`, `html[${index}]`)
      const open = stack.at(-1)
      if (stack.length === 1 || open.tag !== tag) throw pasteFailure('DOCS_PASTE_HTML', `has an unmatched closing tag for ${tag}`, `html[${index}]`)
      stack.pop()
      index = cursor + 1
      continue
    }
    const attrs = {}
    let selfClosing = false
    while (cursor < source.length) {
      while (/\s/u.test(source[cursor] ?? '')) cursor += 1
      if (source.startsWith('/>', cursor)) {
        selfClosing = true
        cursor += 2
        break
      }
      if (source[cursor] === '>') {
        cursor += 1
        break
      }
      const attrMatch = /^[a-z][a-z0-9-]*/iu.exec(source.slice(cursor))
      if (!attrMatch) throw pasteFailure('DOCS_PASTE_HTML', `has malformed attributes on ${tag}`, `html[${index}]`)
      const name = attrMatch[0].toLowerCase()
      cursor += attrMatch[0].length
      while (/\s/u.test(source[cursor] ?? '')) cursor += 1
      if (source[cursor] !== '=') throw pasteFailure('DOCS_PASTE_HTML', `attribute ${name} on ${tag} must have a quoted value`, `html[${index}]`)
      cursor += 1
      while (/\s/u.test(source[cursor] ?? '')) cursor += 1
      const quote = source[cursor]
      if (quote !== '"' && quote !== "'") throw pasteFailure('DOCS_PASTE_HTML', `attribute ${name} on ${tag} must have a quoted value`, `html[${index}]`)
      cursor += 1
      const end = source.indexOf(quote, cursor)
      if (end < 0) throw pasteFailure('DOCS_PASTE_HTML', `attribute ${name} on ${tag} is unterminated`, `html[${index}]`)
      const raw = source.slice(cursor, end)
      if (raw.includes('<')) throw pasteFailure('DOCS_PASTE_HTML', `attribute ${name} on ${tag} contains <`, `html[${index}]`)
      if (Object.hasOwn(attrs, name)) throw pasteFailure('DOCS_PASTE_HTML', `attribute ${name} on ${tag} is duplicated`, `html[${index}]`)
      attrs[name] = decodeEntities(raw, `html.${tag}.${name}`)
      cursor = end + 1
    }
    if (cursor > source.length || !source.slice(index, cursor).endsWith('>')) throw pasteFailure('DOCS_PASTE_HTML', `tag ${tag} is unterminated`, `html[${index}]`)
    const node = { type: 'element', tag, attrs, children: [] }
    add(node)
    if (selfClosing && !VOID_TAGS.has(tag)) throw pasteFailure('DOCS_PASTE_HTML', `non-void tag ${tag} cannot be self-closing`, `html[${index}]`)
    if (!selfClosing && !VOID_TAGS.has(tag)) {
      if (stack.length >= DOCS_PASTE_LIMITS.depth) throw pasteFailure('DOCS_PASTE_LIMIT', `exceeds HTML depth ${DOCS_PASTE_LIMITS.depth}`, `html.${tag}`)
      stack.push(node)
    }
    index = cursor
  }
  if (stack.length !== 1) throw pasteFailure('DOCS_PASTE_HTML', `tag ${stack.at(-1).tag} is not closed`, 'html')
  return root
}

function markdownTableCells(line) {
  let value = line.trim()
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1)
  const cells = []
  let buffer = ''
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\\' && value[index + 1] === '|') {
      buffer += '|'
      index += 1
      continue
    }
    if (value[index] !== '|') {
      buffer += value[index]
      continue
    }
    if (!buffer && cells.length) cells.at(-1).span += 1
    else cells.push({ text: buffer.trim(), span: 1 })
    buffer = ''
  }
  if (!buffer && cells.length) cells.at(-1).span += 1
  else cells.push({ text: buffer.trim(), span: 1 })
  return cells
}

function markdownTableSeparator(line) {
  if (!line.includes('|')) return undefined
  const cells = markdownTableCells(line)
  if (!cells.length || cells.some(cell => cell.span !== 1 || !/^:?-+:?$/u.test(cell.text))) return undefined
  return cells.map(cell => cell.text.startsWith(':') && cell.text.endsWith(':') ? 'center' : cell.text.endsWith(':') ? 'right' : cell.text.startsWith(':') ? 'left' : undefined)
}

function markdownInline(source) {
  const keep = []
  const stash = html => `\u0000${keep.push(html) - 1}\u0000`
  let value = source.replace(/\\([\\`*_[\]{}()#+\-.!|~=>])/gu, (_, char) => stash(escapeHtml(char)))
  if (value.includes('`')) throw pasteFailure('DOCS_PASTE_MARKDOWN_UNSUPPORTED', 'inline code and code fences are unsupported', 'markdown')
  value = value.replace(/<\/?[a-z][^>]*>|<!--[\s\S]*?-->/giu, tag => stash(tag))
  value = value.replace(/!\[([^\]\n]*)\]\((\S+?)(?:\s+=(\d*)x(\d*))?\)/gu, (_, alt, src, width, height) => stash(
    `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${width ? ` width="${width}"` : ''}${height ? ` height="${height}"` : ''}>`,
  ))
  value = value.replace(/\[([^\]\n]+)\]\((\S+?)\)/gu, (_, label, href) => `${stash(`<a href="${escapeHtml(href)}">`)}${label}${stash('</a>')}`)
  if (/!\[[^\]\n]*\]\(/u.test(value) || /\[[^\]\n]+\]\(/u.test(value)) {
    throw pasteFailure('DOCS_PASTE_MARKDOWN_UNSUPPORTED', 'image titles, link titles, reference links, and malformed destinations are unsupported', 'markdown')
  }
  value = escapeHtml(value)
    .replace(/\*\*\*([^*\n]+)\*\*\*/gu, '<b><i>$1</i></b>')
    .replace(/\*\*([^*\n]+)\*\*/gu, '<b>$1</b>')
    .replace(/__([^_\n]+)__/gu, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/gu, '$1<i>$2</i>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/gu, '$1<i>$2</i>')
    .replace(/~~([^~\n]+)~~/gu, '<s>$1</s>')
    .replace(/==([^=\n]+)==/gu, '<span style="background-color:#ffff00">$1</span>')
  const restored = value.replace(/\u0000(\d+)\u0000/gu, (_, index) => keep[Number(index)] ?? '')
  if (restored.includes('\u0000')) throw pasteFailure('DOCS_PASTE_MARKDOWN_UNSUPPORTED', 'contains an invalid escape placeholder', 'markdown')
  return restored
}

function markdownToHtml(source) {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n')
  const out = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }
    if (/^\s*\\pagebreak\s*$/u.test(line) || /^\s*<!--\s*pagebreak\s*-->\s*$/iu.test(line)) {
      out.push('<!--pagebreak-->')
      index += 1
      continue
    }
    if (/^\s*(?:```|~~~)/u.test(line) || /^\s*>/u.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/u.test(line) || /^(?: {4}|\t)\S/u.test(line)) {
      throw pasteFailure('DOCS_PASTE_MARKDOWN_UNSUPPORTED', 'code fences, indented code, blockquotes, and horizontal rules are unsupported', `markdown line ${index + 1}`)
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line)
    if (heading) {
      out.push(`<h${heading[1].length}>${markdownInline(heading[2])}</h${heading[1].length}>`)
      index += 1
      continue
    }
    const alignment = index + 1 < lines.length ? markdownTableSeparator(lines[index + 1]) : undefined
    if (line.includes('|') && alignment) {
      const headerColumns = markdownTableCells(line).reduce((sum, cell) => sum + cell.span, 0)
      if (headerColumns !== alignment.length) throw pasteFailure('DOCS_PASTE_MARKDOWN_UNSUPPORTED', 'table header spans must match the alignment separator columns', `markdown line ${index + 1}`)
      const row = (text, tag) => {
        let column = 0
        return `<tr>${markdownTableCells(text).map(cell => {
          const align = alignment[column]
          column += cell.span
          return `<${tag}${cell.span > 1 ? ` colspan="${cell.span}"` : ''}${align ? ` style="text-align:${align}"` : ''}>${markdownInline(cell.text)}</${tag}>`
        }).join('')}</tr>`
      }
      const rows = [row(line, 'th')]
      index += 2
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) rows.push(row(lines[index++], 'td'))
      out.push(`<table><tbody>${rows.join('')}</tbody></table>`)
      continue
    }
    if (LIST_LINE.test(line)) {
      const stack = []
      let html = ''
      while (index < lines.length && LIST_LINE.test(lines[index])) {
        const match = lines[index].match(LIST_LINE)
        const indent = match[1].replace(/\t/gu, '    ').length
        const ordered = /^\d/u.test(match[2])
        const kind = ordered ? 'ol' : 'ul'
        if (/^\[[ xX]\]\s+/u.test(match[3])) throw pasteFailure('DOCS_PASTE_MARKDOWN_UNSUPPORTED', 'task lists are unsupported; use ordinary list items', `markdown line ${index + 1}`)
        while (stack.length && indent < stack.at(-1).indent) html += `</li></${stack.pop().kind}>`
        let top = stack.at(-1)
        if (top && indent === top.indent && kind !== top.kind) {
          html += `</li></${stack.pop().kind}>`
          top = stack.at(-1)
        }
        if (!top || indent > top.indent) {
          const start = ordered ? Number.parseInt(match[2], 10) : 1
          html += `<${kind}${ordered && start !== 1 ? ` start="${start}"` : ''}>`
          stack.push({ indent, kind })
        } else html += '</li>'
        html += `<li>${markdownInline(match[3])}`
        index += 1
      }
      while (stack.length) html += `</li></${stack.pop().kind}>`
      out.push(html)
      continue
    }
    if (/^\s*</u.test(line)) {
      const buffer = []
      while (index < lines.length && lines[index].trim()) buffer.push(lines[index++])
      out.push(buffer.join('\n'))
      continue
    }
    const buffer = []
    while (index < lines.length && lines[index].trim()) {
      const current = lines[index]
      if (buffer.length && (/^\s*(?:=+|-+)\s*$/u.test(current) || /^\s*(?:```|~~~)/u.test(current)
        || /^\s*>/u.test(current) || /^\s*([-*_])(\s*\1){2,}\s*$/u.test(current))) {
        throw pasteFailure('DOCS_PASTE_MARKDOWN_UNSUPPORTED', 'setext headings, code fences, blockquotes, and horizontal rules are unsupported', `markdown line ${index + 1}`)
      }
      const nextAlignment = index + 1 < lines.length ? markdownTableSeparator(lines[index + 1]) : undefined
      if (buffer.length && (/^(#{1,6})\s+/u.test(current) || /^\s*</u.test(current) || LIST_LINE.test(current)
        || /^\s*\\pagebreak\s*$/u.test(current) || current.includes('|') && nextAlignment)) break
      buffer.push(current)
      index += 1
    }
    const content = buffer.map((entry, entryIndex) => {
      const hard = / {2}$|\\$/u.test(entry)
      const text = entry.trim().replace(/\\$/u, '')
      return `${markdownInline(text)}${entryIndex < buffer.length - 1 ? hard ? '<br>' : ' ' : ''}`
    }).join('')
    out.push(`<p>${content}</p>`)
  }
  return out.join('\n')
}

function requireAttrs(node, allowed, path) {
  const unknown = Object.keys(node.attrs).find(key => !allowed.includes(key))
  if (unknown) throw pasteFailure('DOCS_PASTE_ATTRIBUTE_UNSUPPORTED', `attribute ${JSON.stringify(unknown)} is unsupported on ${node.tag}`, path)
}

function normalizeNormal(normal = {}) {
  checkKeys(normal, ['font', 'fontSize', 'color', 'highlight'], 'normal')
  const result = { bold: false, italic: false, underline: false, strike: false }
  if (normal.font !== undefined) result.font = normalizeFont(normal.font, 'normal.font')
  if (normal.fontSize !== undefined) {
    if (!Number.isInteger(normal.fontSize) || normal.fontSize < 1 || normal.fontSize > 400) throw pasteFailure('DOCS_PASTE_SIZE_UNSUPPORTED', 'must be an integer from 1 to 400', 'normal.fontSize')
    result.fontSize = normal.fontSize
  }
  if (normal.color !== undefined) result.color = normalizeColor(normal.color, false, 'normal.color')
  if (normal.highlight !== undefined) result.highlight = normalizeColor(normal.highlight, true, 'normal.highlight')
  return result
}

function documentChildren(root) {
  const significant = root.children.filter(node => node.type !== 'text' || node.text.trim())
  if (significant.length === 1 && significant[0].type === 'element' && significant[0].tag === 'html') {
    const html = significant[0]
    requireAttrs(html, [], 'html')
    const body = html.children.filter(node => node.type !== 'text' || node.text.trim())
    if (body.length !== 1 || body[0].type !== 'element' || body[0].tag !== 'body') throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'html must contain exactly one body and no head', 'html')
    requireAttrs(body[0], [], 'html.body')
    return body[0].children
  }
  if (significant.some(node => node.type === 'element' && ['html', 'body', 'head'].includes(node.tag))) {
    throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'document wrappers must be a single html/body pair or a body-free fragment', 'html')
  }
  return root.children
}

function trimStructuralWhitespace(nodes) {
  const copy = [...nodes]
  while (copy[0]?.type === 'text' && !copy[0].text.trim()) copy.shift()
  while (copy.at(-1)?.type === 'text' && !copy.at(-1).text.trim()) copy.pop()
  return copy
}

function normalizeImage(node, path, state) {
  requireAttrs(node, ['src', 'alt', 'width', 'height'], path)
  if (node.children.length || !Object.hasOwn(node.attrs, 'src') || !Object.hasOwn(node.attrs, 'alt')) {
    throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'img requires src and alt and cannot have children', path)
  }
  if (node.attrs.alt.length > DOCS_PASTE_LIMITS.altChars) throw pasteFailure('DOCS_PASTE_LIMIT', `alt exceeds ${DOCS_PASTE_LIMITS.altChars} characters`, path)
  const dimension = name => {
    if (node.attrs[name] === undefined) return undefined
    if (!/^\d{1,4}$/u.test(node.attrs[name])) throw pasteFailure('DOCS_PASTE_IMAGE_SIZE_UNSUPPORTED', `${name} must be an integer from 1 to ${DOCS_PASTE_LIMITS.imageDimension}`, path)
    const value = Number(node.attrs[name])
    if (value < 1 || value > DOCS_PASTE_LIMITS.imageDimension) throw pasteFailure('DOCS_PASTE_IMAGE_SIZE_UNSUPPORTED', `${name} must be an integer from 1 to ${DOCS_PASTE_LIMITS.imageDimension}`, path)
    return value
  }
  state.images += 1
  if (state.images > DOCS_PASTE_LIMITS.images) throw pasteFailure('DOCS_PASTE_LIMIT', `contains more than ${DOCS_PASTE_LIMITS.images} images`, path)
  return {
    type: 'image',
    src: normalizeUrl(node.attrs.src, `${path}.src`),
    alt: node.attrs.alt,
    ...node.attrs.width === undefined ? {} : { width: dimension('width') },
    ...node.attrs.height === undefined ? {} : { height: dimension('height') },
  }
}

function normalizeInline(nodes, base, path, state) {
  const out = []
  for (const [index, node] of nodes.entries()) {
    const nodePath = `${path}[${index}]`
    if (node.type === 'text') {
      out.push({ type: 'text', text: node.text.replace(/\s*\n\s*/gu, ' '), marks: { ...base } })
      continue
    }
    if (node.type !== 'element') throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'page breaks must be top-level markers', nodePath)
    const tag = node.tag
    if (!INLINE_TAGS.has(tag)) throw pasteFailure('DOCS_PASTE_TAG_UNSUPPORTED', `tag ${tag} is not valid inline content`, nodePath)
    if (tag === 'br') {
      requireAttrs(node, [], nodePath)
      if (node.children.length) throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'br cannot have children', nodePath)
      out.push({ type: 'break', marks: { ...base } })
      continue
    }
    if (tag === 'img') {
      if (base.href) throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'linked images are unsupported', nodePath)
      out.push({ ...normalizeImage(node, nodePath, state), marks: { ...base } })
      continue
    }
    requireAttrs(node, tag === 'a' ? ['href', 'style'] : ['style'], nodePath)
    const style = parseStyle(node.attrs.style, 'inline', `${nodePath}.style`)
    const marks = { ...base }
    if (tag === 'b' || tag === 'strong') marks.bold = true
    else if (tag === 'i' || tag === 'em') marks.italic = true
    else if (tag === 'u') marks.underline = true
    else if (['s', 'strike', 'del'].includes(tag)) marks.strike = true
    else if (tag === 'mark') marks.highlight = '#ffff00'
    Object.assign(marks, style.marks)
    if (tag === 'a') {
      if (base.href || node.attrs.href === undefined) throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'links require one href and cannot be nested', nodePath)
      marks.href = normalizeUrl(node.attrs.href, `${nodePath}.href`)
      state.links += 1
    }
    out.push(...normalizeInline(node.children, marks, nodePath, state))
  }
  return out
}

function appendRun(paragraph, text, marks) {
  if (!text) return
  const run = {
    text,
    bold: marks.bold === true,
    italic: marks.italic === true,
    underline: marks.underline === true,
    strike: marks.strike === true,
    ...marks.font === undefined ? {} : { font: marks.font },
    ...marks.fontSize === undefined ? {} : { fontSize: marks.fontSize },
    ...marks.color === undefined ? {} : { color: marks.color },
    ...marks.highlight === undefined ? {} : { highlight: marks.highlight },
    ...marks.href === undefined ? {} : { href: marks.href },
  }
  const previous = paragraph.runs.at(-1)
  if (previous && RUN_FIELDS.every(field => previous[field] === run[field])) previous.text += text
  else paragraph.runs.push(run)
}

function makeParagraph(nodes, style, base, align, path, state) {
  const paragraph = { kind: 'para', style, text: '', runs: [], ...align === undefined ? {} : { align }, inline: [], plain: '' }
  paragraph.inline = normalizeInline(nodes, base, path, state)
  const images = []
  for (const item of paragraph.inline) {
    if (item.type === 'image') {
      const offset = paragraph.text.length
      images.push({ offset, src: item.src, alt: item.alt, ...item.width === undefined ? {} : { width: item.width }, ...item.height === undefined ? {} : { height: item.height } })
      appendRun(paragraph, '[image]', item.marks)
      paragraph.text += '[image]'
      paragraph.plain += `[${item.alt || 'image'}]`
    } else {
      const text = item.type === 'break' ? '\n' : item.text
      appendRun(paragraph, text, item.marks)
      paragraph.text += text
      paragraph.plain += text
    }
  }
  if (images.length) paragraph.images = images
  state.runs += paragraph.runs.length
  if (state.runs > DOCS_PASTE_LIMITS.runs) throw pasteFailure('DOCS_PASTE_LIMIT', `contains more than ${DOCS_PASTE_LIMITS.runs} formatted runs`, path)
  return paragraph
}

function ownAlignment(node, style, inherited, path) {
  if (node.attrs.align !== undefined && style.align !== undefined) throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'use either align or text-align, not both', path)
  const align = style.align ?? node.attrs.align?.toLowerCase() ?? inherited
  if (align !== undefined && !['left', 'center', 'right', 'justify'].includes(align)) throw pasteFailure('DOCS_PASTE_STYLE_UNSUPPORTED', 'align accepts only left, center, right, or justify', path)
  return align
}

function normalizeParagraph(node, context, path, state, inherited = {}) {
  requireAttrs(node, ['style', 'align'], path)
  const style = parseStyle(node.attrs.style, 'paragraph', `${path}.style`)
  const base = { ...(inherited.base ?? context.normal), ...style.marks }
  const paragraphStyle = inherited.paragraphStyle ?? (HEADING_TAGS.has(node.tag) ? node.tag.toUpperCase() : 'P')
  return makeParagraph(node.children, paragraphStyle, base, ownAlignment(node, style, inherited.align, path), path, state)
}

function normalizeList(node, context, path, state, level = 0) {
  if (level >= DOCS_PASTE_LIMITS.listDepth) throw pasteFailure('DOCS_PASTE_LIMIT', `exceeds list depth ${DOCS_PASTE_LIMITS.listDepth}`, path)
  requireAttrs(node, node.tag === 'ol' ? ['start'] : [], path)
  let start = 1
  if (node.attrs.start !== undefined) {
    if (!/^\d{1,5}$/u.test(node.attrs.start) || Number(node.attrs.start) < 1) throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'ol start must be a positive integer', path)
    start = Number(node.attrs.start)
  }
  const ordered = node.tag === 'ol'
  const items = []
  for (const [itemIndex, item] of node.children.entries()) {
    if (item.type === 'text' && !item.text.trim()) continue
    if (item.type !== 'element' || item.tag !== 'li') throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'lists may contain only li elements', `${path}[${itemIndex}]`)
    const itemPath = `${path}.li[${items.length}]`
    requireAttrs(item, ['style', 'align'], itemPath)
    const style = parseStyle(item.attrs.style, 'paragraph', `${itemPath}.style`)
    const base = { ...context.normal, ...style.marks }
    const align = ownAlignment(item, style, undefined, itemPath)
    const children = trimStructuralWhitespace(item.children)
    const nested = []
    const content = []
    let paragraphNode
    for (const child of children) {
      if (child.type === 'element' && ['ul', 'ol'].includes(child.tag)) nested.push(child)
      else if (child.type === 'element' && child.tag === 'p') {
        if (paragraphNode || content.length) throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'a list item accepts either inline content or one paragraph', itemPath)
        paragraphNode = child
      } else content.push(child)
    }
    const firstNested = children.findIndex(child => child.type === 'element' && ['ul', 'ol'].includes(child.tag))
    const contentAfterNested = firstNested >= 0 && children.slice(firstNested).some(child => (
      !(child.type === 'element' && ['ul', 'ol'].includes(child.tag)) && (child.type !== 'text' || child.text.trim())
    ))
    if (paragraphNode && nested.some(child => children.indexOf(child) < children.indexOf(paragraphNode)) || contentAfterNested) {
      throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'nested lists must follow all list-item content', itemPath)
    }
    let paragraph
    if (paragraphNode) paragraph = normalizeParagraph(paragraphNode, context, itemPath, state, { base, align })
    else {
      if (content.some(child => child.type === 'pagebreak' || child.type === 'element' && !INLINE_TAGS.has(child.tag))) {
        throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'list items accept inline content and nested lists only', itemPath)
      }
      paragraph = makeParagraph(trimStructuralWhitespace(content), 'P', base, align, itemPath, state)
    }
    if (!paragraph.text.trim() && !paragraph.images) throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'empty list items are unsupported', itemPath)
    paragraph.style = 'LI'
    paragraph.ordered = ordered
    paragraph.listLevel = level
    if (ordered) paragraph.number = start + items.length
    state.listItems += 1
    if (state.listItems > DOCS_PASTE_LIMITS.listItems) throw pasteFailure('DOCS_PASTE_LIMIT', `contains more than ${DOCS_PASTE_LIMITS.listItems} list items`, path)
    items.push({ paragraph, nested: nested.map((child, nestedIndex) => normalizeList(child, context, `${itemPath}.nested[${nestedIndex}]`, state, level + 1)) })
  }
  if (!items.length) throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'lists require at least one item', path)
  return { kind: 'list', ordered, start, items }
}

function normalizeTable(node, context, path, state) {
  requireAttrs(node, ['style', 'border'], path)
  if (node.attrs.border !== undefined && node.attrs.border !== '1') throw pasteFailure('DOCS_PASTE_ATTRIBUTE_UNSUPPORTED', 'table border accepts only "1"', path)
  parseStyle(node.attrs.style, 'table', `${path}.style`)
  const rowNodes = []
  for (const child of node.children) {
    if (child.type === 'text' && !child.text.trim()) continue
    if (child.type === 'element' && child.tag === 'tr') rowNodes.push(child)
    else if (child.type === 'element' && ['thead', 'tbody', 'tfoot'].includes(child.tag)) {
      requireAttrs(child, [], path)
      for (const row of child.children) {
        if (row.type === 'text' && !row.text.trim()) continue
        if (row.type !== 'element' || row.tag !== 'tr') throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'table sections may contain only tr elements', path)
        rowNodes.push(row)
      }
    } else throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'tables may contain only tr or table sections', path)
  }
  if (!rowNodes.length || rowNodes.length > DOCS_PASTE_LIMITS.tableRows) throw pasteFailure('DOCS_PASTE_LIMIT', `tables require 1 to ${DOCS_PASTE_LIMITS.tableRows} rows`, path)
  const rows = []
  let cellCount = 0
  for (const [rowIndex, row] of rowNodes.entries()) {
    requireAttrs(row, [], `${path}.tr[${rowIndex}]`)
    const cells = []
    for (const [cellIndex, cell] of row.children.entries()) {
      if (cell.type === 'text' && !cell.text.trim()) continue
      if (cell.type !== 'element' || !['td', 'th'].includes(cell.tag)) throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'table rows may contain only td or th elements', `${path}.tr[${rowIndex}]`)
      const cellPath = `${path}.tr[${rowIndex}].${cell.tag}[${cells.length}]`
      requireAttrs(cell, ['colspan', 'rowspan', 'style', 'align'], cellPath)
      const span = name => {
        if (cell.attrs[name] === undefined) return 1
        if (!/^\d{1,2}$/u.test(cell.attrs[name]) || Number(cell.attrs[name]) < 1) throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', `${name} must be a positive integer`, cellPath)
        return Number(cell.attrs[name])
      }
      const colspan = span('colspan')
      const rowspan = span('rowspan')
      if (colspan > DOCS_PASTE_LIMITS.tableColumns || rowspan > DOCS_PASTE_LIMITS.tableRows) throw pasteFailure('DOCS_PASTE_LIMIT', 'cell span exceeds table bounds', cellPath)
      const style = parseStyle(cell.attrs.style, 'cell', `${cellPath}.style`)
      const align = ownAlignment(cell, style, undefined, cellPath)
      const base = { ...context.normal, ...cell.tag === 'th' ? { bold: true } : {}, ...style.marks }
      const content = trimStructuralWhitespace(cell.children)
      const paragraphs = []
      let inline = []
      const flush = () => {
        const significant = trimStructuralWhitespace(inline)
        if (significant.length) paragraphs.push(makeParagraph(significant, 'P', base, align, cellPath, state))
        inline = []
      }
      for (const child of content) {
        if (child.type === 'element' && child.tag === 'p') {
          flush()
          paragraphs.push(normalizeParagraph(child, context, cellPath, state, { base, align }))
        } else if (child.type === 'text' || child.type === 'element' && INLINE_TAGS.has(child.tag)) inline.push(child)
        else throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'cells accept paragraphs and inline content only', cellPath)
      }
      flush()
      if (!paragraphs.length) paragraphs.push(makeParagraph([], 'P', base, align, cellPath, state))
      if (paragraphs.length > DOCS_PASTE_LIMITS.cellParagraphs) throw pasteFailure('DOCS_PASTE_LIMIT', `cells accept at most ${DOCS_PASTE_LIMITS.cellParagraphs} paragraphs`, cellPath)
      cells.push({ paragraphs, colspan, rowspan, background: style.background ?? 'none' })
      cellCount += 1
      if (cellCount > DOCS_PASTE_LIMITS.tableCells) throw pasteFailure('DOCS_PASTE_LIMIT', `table exceeds ${DOCS_PASTE_LIMITS.tableCells} cells`, path)
    }
    rows.push(cells)
  }
  const occupied = rowNodes.map(() => [])
  for (const [rowIndex, cells] of rows.entries()) {
    let column = 0
    for (const cell of cells) {
      while (occupied[rowIndex][column]) column += 1
      if (column + cell.colspan > DOCS_PASTE_LIMITS.tableColumns || rowIndex + cell.rowspan > rows.length) {
        throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'cell span exceeds the table rectangle or overlaps another cell', path)
      }
      for (let row = rowIndex; row < rowIndex + cell.rowspan; row += 1) {
        for (let col = column; col < column + cell.colspan; col += 1) {
          if (occupied[row][col]) throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'cell spans overlap', path)
          occupied[row][col] = true
        }
      }
      column += cell.colspan
    }
  }
  const columns = Math.max(0, ...occupied.map(row => row.length))
  if (!columns || occupied.some(row => Array.from({ length: columns }, (_, column) => row[column] === true).some(value => !value))) {
    throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'table rows and spans must form a complete rectangle', path)
  }
  state.tables += 1
  if (state.tables > DOCS_PASTE_LIMITS.tables) throw pasteFailure('DOCS_PASTE_LIMIT', `contains more than ${DOCS_PASTE_LIMITS.tables} tables`, path)
  return { kind: 'table', rows }
}

function normalizeBlocks(nodes, context, state) {
  const blocks = []
  let inline = []
  const flush = () => {
    const significant = trimStructuralWhitespace(inline)
    if (significant.length) blocks.push(makeParagraph(significant, 'P', context.normal, undefined, `blocks[${blocks.length}]`, state))
    inline = []
  }
  for (const node of nodes) {
    if (node.type === 'text' || node.type === 'element' && INLINE_TAGS.has(node.tag)) {
      inline.push(node)
      continue
    }
    flush()
    const path = `blocks[${blocks.length}]`
    if (node.type === 'pagebreak') {
      state.pageBreaks += 1
      if (state.pageBreaks > DOCS_PASTE_LIMITS.pageBreaks) throw pasteFailure('DOCS_PASTE_LIMIT', `contains more than ${DOCS_PASTE_LIMITS.pageBreaks} page breaks`, path)
      blocks.push({ kind: 'pagebreak' })
    } else if (node.type !== 'element') throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'contains an unsupported node', path)
    else if (node.tag === 'p' || HEADING_TAGS.has(node.tag)) blocks.push(normalizeParagraph(node, context, path, state))
    else if (['ul', 'ol'].includes(node.tag)) blocks.push(normalizeList(node, context, path, state))
    else if (node.tag === 'table') blocks.push(normalizeTable(node, context, path, state))
    else if (node.tag === 'hr') {
      requireAttrs(node, ['style'], path)
      if (node.children.length || parseStyle(node.attrs.style, 'pagebreak', path).pageBreak !== true) {
        throw pasteFailure('DOCS_PASTE_STRUCTURE_UNSUPPORTED', 'hr is supported only as style="page-break-before:always"', path)
      }
      state.pageBreaks += 1
      if (state.pageBreaks > DOCS_PASTE_LIMITS.pageBreaks) throw pasteFailure('DOCS_PASTE_LIMIT', `contains more than ${DOCS_PASTE_LIMITS.pageBreaks} page breaks`, path)
      blocks.push({ kind: 'pagebreak' })
    } else throw pasteFailure('DOCS_PASTE_TAG_UNSUPPORTED', `tag ${node.tag} is unsupported`, path)
    if (blocks.length > DOCS_PASTE_LIMITS.topLevelBlocks) throw pasteFailure('DOCS_PASTE_LIMIT', `contains more than ${DOCS_PASTE_LIMITS.topLevelBlocks} top-level blocks`, path)
  }
  flush()
  if (blocks.length > DOCS_PASTE_LIMITS.topLevelBlocks) throw pasteFailure('DOCS_PASTE_LIMIT', `contains more than ${DOCS_PASTE_LIMITS.topLevelBlocks} top-level blocks`, 'blocks')
  if (!blocks.length) throw pasteFailure('DOCS_PASTE_EMPTY', 'source contains no pasteable blocks', 'source')
  return blocks
}

function publicParagraph(paragraph) {
  const { inline, plain, ...publicBlock } = paragraph
  return { ...publicBlock, runs: paragraph.runs.map(run => ({ ...run })), ...paragraph.images ? { images: paragraph.images.map(image => ({ ...image })) } : {} }
}

function flattenList(list, output) {
  for (const item of list.items) {
    output.push(publicParagraph(item.paragraph))
    for (const nested of item.nested) flattenList(nested, output)
  }
}

function flattenBlock(block, output, state) {
  if (block.kind === 'para') output.push(publicParagraph(block))
  else if (block.kind === 'list') flattenList(block, output)
  else if (block.kind === 'pagebreak') output.push({ kind: 'pagebreak' })
  else if (block.kind === 'table') {
    state.tableIndex += 1
    output.push({
      kind: 'table',
      index: state.tableIndex,
      rows: block.rows.map(row => row.map(cell => {
        const paragraphs = cell.paragraphs.map(publicParagraph)
        return {
          text: paragraphs.map(paragraph => paragraph.text).join('\n').replace(/\n+$/u, ''),
          paragraphs,
          colspan: cell.colspan,
          rowspan: cell.rowspan,
          background: cell.background,
        }
      })),
    })
  }
}

function marksCss(marks) {
  const decoration = marks.underline || marks.strike ? `${marks.underline ? 'underline ' : ''}${marks.strike ? 'line-through' : ''}`.trim() : 'none'
  return [
    `font-weight:${marks.bold ? '700' : '400'}`,
    `font-style:${marks.italic ? 'italic' : 'normal'}`,
    `text-decoration:${decoration}`,
    ...marks.font === undefined ? [] : [`font-family:'${marks.font}'`],
    ...marks.fontSize === undefined ? [] : [`font-size:${marks.fontSize}pt`],
    ...marks.color === undefined ? [] : [`color:${marks.color}`],
    ...marks.highlight === undefined ? [] : [`background-color:${marks.highlight === 'none' ? 'transparent' : marks.highlight}`],
  ].join(';')
}

function renderImage(image) {
  return `<img src="${escapeHtml(image.src)}" alt="${escapeHtml(image.alt)}"${image.width === undefined ? '' : ` width="${image.width}"`}${image.height === undefined ? '' : ` height="${image.height}"`}>`
}

function renderInline(inline) {
  return inline.map(item => {
    if (item.type === 'image') return `<span style="${escapeHtml(marksCss(item.marks))}">${renderImage(item)}</span>`
    const style = escapeHtml(marksCss(item.marks))
    const content = item.type === 'break' ? '<br>' : escapeHtml(item.text)
    const span = `<span style="${style}">${content}</span>`
    return item.marks.href ? `<a href="${escapeHtml(item.marks.href)}">${span}</a>` : span
  }).join('')
}

function paragraphStyle(paragraph) {
  return `margin:0;white-space:pre-wrap${paragraph.align === undefined ? '' : `;text-align:${paragraph.align}`}`
}

function renderBlock(block) {
  if (block.kind === 'pagebreak') return '<hr style="page-break-before:always">'
  if (block.kind === 'para') {
    const tag = /^H[1-6]$/u.test(block.style) ? block.style.toLowerCase() : 'p'
    return `<${tag} style="${paragraphStyle(block)}">${renderInline(block.inline)}</${tag}>`
  }
  if (block.kind === 'list') {
    const tag = block.ordered ? 'ol' : 'ul'
    return `<${tag}${block.ordered && block.start !== 1 ? ` start="${block.start}"` : ''}>${block.items.map(item => `<li style="${paragraphStyle(item.paragraph)}">${renderInline(item.paragraph.inline)}${item.nested.map(renderBlock).join('')}</li>`).join('')}</${tag}>`
  }
  if (block.kind === 'table') {
    return `<table style="border-collapse:collapse;width:100%"><tbody>${block.rows.map(row => `<tr>${row.map(cell => {
      const background = cell.background === 'none' ? 'transparent' : cell.background
      return `<td colspan="${cell.colspan}" rowspan="${cell.rowspan}" style="border:1px solid #000000;padding:5px;vertical-align:top;background-color:${background}">${cell.paragraphs.map(renderBlock).join('')}</td>`
    }).join('')}</tr>`).join('')}</tbody></table>`
  }
  throw new TypeError(`Unknown normalized block ${block.kind}`)
}

function plainBlock(block) {
  if (block.kind === 'para') return block.plain
  if (block.kind === 'list') {
    const lines = []
    for (const item of block.items) {
      const marker = block.ordered ? `${item.paragraph.number}.` : '•'
      lines.push(`${'  '.repeat(item.paragraph.listLevel)}${marker} ${item.paragraph.plain}`)
      for (const nested of item.nested) lines.push(plainBlock(nested))
    }
    return lines.join('\n')
  }
  if (block.kind === 'table') return block.rows.map(row => row.map(cell => cell.paragraphs.map(paragraph => paragraph.plain).join(' / ')).join('\t')).join('\n')
  return ''
}

function manifestImages(blocks) {
  const images = []
  const addParagraph = (paragraph, blockIndex, location = {}) => {
    for (const image of paragraph.images ?? []) images.push({ blockIndex, ...location, ...image })
  }
  blocks.forEach((block, blockIndex) => {
    if (block.kind === 'para') addParagraph(block, blockIndex)
    else if (block.kind === 'table') {
      block.rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
        cell.paragraphs.forEach((paragraph, paragraphIndex) => addParagraph(paragraph, blockIndex, { tableIndex: block.index, rowIndex, columnIndex, paragraphIndex }))
      }))
    }
  })
  return images
}

function normalizePrepared(args, options) {
  checkKeys(args, ['html', 'markdown', 'at', 'before', 'after', 'replace', 'occurrence'], 'source')
  checkKeys(options, ['normal'], 'options')
  if ((args.html === undefined) === (args.markdown === undefined)) throw pasteFailure('DOCS_PASTE_ARGUMENT', 'provide exactly one of html or markdown', 'source')
  const format = args.html === undefined ? 'markdown' : 'html'
  const source = args[format]
  if (typeof source !== 'string' || !source.trim()) throw pasteFailure('DOCS_PASTE_EMPTY', `${format} must be a nonblank string`, format)
  if (source.length > DOCS_PASTE_LIMITS.sourceChars) throw pasteFailure('DOCS_PASTE_LIMIT', `source exceeds ${DOCS_PASTE_LIMITS.sourceChars} characters`, format)
  checkText(source, format)
  const { html, markdown, ...placementArgs } = args
  const placement = normalizeDocsPastePlacement(placementArgs)
  if (placement.mode !== 'append') throw pasteFailure('DOCS_PASTE_PLACEMENT_UNSUPPORTED', `${placement.mode} anchors are reserved for later wiring; only append-at-end payload preparation is implemented`, 'placement', { placement })
  return { format, source, placement, normal: normalizeNormal(options.normal) }
}

export function prepareDocsPaste(args, options = {}) {
  const request = normalizePrepared(args, options)
  const html = request.format === 'html' ? request.source : markdownToHtml(request.source)
  const root = parseHtml(html)
  const state = { tables: 0, images: 0, links: 0, listItems: 0, pageBreaks: 0, runs: 0 }
  const blocks = normalizeBlocks(documentChildren(root), { normal: request.normal }, state)
  const expected = []
  const flattenState = { tableIndex: 0 }
  const chunks = [{ blocks: [], blockStart: 0, blockCount: 0 }]
  for (const block of blocks) {
    if (block.kind === 'pagebreak') {
      expected.push({ kind: 'pagebreak' })
      chunks.push({ blocks: [], blockStart: expected.length, blockCount: 0 })
      continue
    }
    const current = chunks.at(-1)
    current.blocks.push(block)
    const before = expected.length
    flattenBlock(block, expected, flattenState)
    current.blockCount += expected.length - before
  }
  if (expected.length > DOCS_PASTE_LIMITS.blocks) throw pasteFailure('DOCS_PASTE_LIMIT', `expands to more than ${DOCS_PASTE_LIMITS.blocks} exported blocks`, 'source')
  const payloadChunks = chunks.map((chunk, index) => {
    const body = chunk.blocks.map(renderBlock).join('')
    const text = chunk.blocks.map(plainBlock).join('\n')
    return {
      index,
      html: `<html><body>${body}</body></html>`,
      text,
      empty: chunk.blocks.length === 0,
      blockStart: chunk.blockStart,
      blockCount: chunk.blockCount,
    }
  })
  const fullHtml = `<html><body>${blocks.map(renderBlock).join('')}</body></html>`
  const text = payloadChunks.map(chunk => chunk.text).join('\n\f\n')
  if (text.length > DOCS_PASTE_LIMITS.textChars) throw pasteFailure('DOCS_PASTE_LIMIT', `plain text exceeds ${DOCS_PASTE_LIMITS.textChars} characters`, 'source')
  if (fullHtml.length > DOCS_PASTE_LIMITS.htmlChars || payloadChunks.some(chunk => chunk.html.length > DOCS_PASTE_LIMITS.htmlChars)) {
    throw pasteFailure('DOCS_PASTE_LIMIT', `generated HTML exceeds ${DOCS_PASTE_LIMITS.htmlChars} characters`, 'source')
  }
  const images = manifestImages(expected)
  const manifest = {
    version: 1,
    sourceFormat: request.format,
    placement: request.placement,
    normal: { ...request.normal },
    plainText: text,
    counts: {
      sourceChars: request.source.length,
      textChars: text.length,
      blocks: expected.length,
      paragraphs: expected.filter(block => block.kind === 'para').length + expected.filter(block => block.kind === 'table').reduce((sum, table) => sum + table.rows.reduce((total, row) => total + row.reduce((count, cell) => count + cell.paragraphs.length, 0), 0), 0),
      headings: expected.filter(block => /^H[1-6]$/u.test(block.style)).length,
      listItems: state.listItems,
      tables: state.tables,
      tableCells: expected.filter(block => block.kind === 'table').reduce((sum, table) => sum + table.rows.reduce((count, row) => count + row.length, 0), 0),
      images: images.length,
      links: state.links,
      pageBreaks: state.pageBreaks,
    },
    blocks: expected,
    images,
    chunks: payloadChunks.map(({ index, empty, blockStart, blockCount }) => ({ index, empty, blockStart, blockCount })),
    verification: {
      required: true,
      method: 'docs-export-append',
      prefix: 'exact',
      appended: 'expected-content',
      suffix: 'exact',
      missingEvidence: 'unknown',
    },
  }
  return { html: fullHtml, text, chunks: payloadChunks, manifest }
}

function normalizedRunValue(field, value, expected) {
  if (field === 'highlight' && expected !== undefined) return value ?? 'none'
  if (field === 'color' && typeof value === 'string') return value.toLowerCase()
  return value
}

function compareParagraph(actual, expected, path) {
  if (actual?.kind !== 'para') return { mismatch: `${path}.kind diverged` }
  for (const field of ['style', 'text', 'ordered', 'listLevel', 'number']) {
    if (expected[field] !== undefined && actual?.[field] !== expected[field]) return { mismatch: `${path}.${field} diverged` }
  }
  if (expected.align !== undefined) {
    if (actual.align === undefined) return { evidence: 'alignment', message: `${path} has no exported alignment evidence` }
    if (actual.align !== expected.align) return { mismatch: `${path}.align diverged` }
  }
  if (expected.images !== undefined) {
    if (!Array.isArray(actual.images)) return { evidence: 'images', message: `${path} has no exported image metadata` }
    if (JSON.stringify(actual.images) !== JSON.stringify(expected.images)) return { mismatch: `${path}.images diverged` }
  }
  if (!Array.isArray(actual.runs)) return { evidence: 'runs', message: `${path} has no exported run evidence` }
  const expand = (runs, side) => {
    const marks = []
    let text = ''
    for (const run of runs) {
      if (!isObject(run) || typeof run.text !== 'string') return { evidence: 'runs', message: `${path} has invalid ${side} run evidence` }
      text += run.text
      for (let index = 0; index < run.text.length; index += 1) marks.push(run)
    }
    return { marks, text }
  }
  const wanted = expand(expected.runs, 'expected')
  const found = expand(actual.runs, 'actual')
  if (wanted.evidence || found.evidence) return wanted.evidence ? wanted : found
  if (wanted.text !== expected.text || found.text !== actual.text) return { mismatch: `${path} runs do not exactly cover paragraph text` }
  for (let index = 0; index < wanted.marks.length; index += 1) {
    for (const field of REQUIRED_RUN_FIELDS) {
      const expectedValue = wanted.marks[index][field]
      const actualValue = found.marks[index]?.[field]
      if (actualValue === undefined) return { evidence: field, message: `${path} character ${index} has no exported ${field} evidence` }
      if (actualValue !== expectedValue) return { mismatch: `${path} character ${index} has different ${field}` }
    }
    for (const field of ['font', 'fontSize', 'color', 'highlight']) {
      const expectedValue = wanted.marks[index][field]
      if (expectedValue === undefined) continue
      const actualValue = normalizedRunValue(field, found.marks[index]?.[field], expectedValue)
      if (actualValue === undefined) return { evidence: field, message: `${path} character ${index} has no exported ${field} evidence` }
      if (actualValue !== normalizedRunValue(field, expectedValue, expectedValue)) return { mismatch: `${path} character ${index} has different ${field}` }
    }
    const expectedHref = wanted.marks[index].href
    const actualHref = found.marks[index]?.href
    if (expectedHref !== undefined && actualHref === undefined) return { mismatch: `${path} character ${index} lost its link` }
    if (expectedHref === undefined && actualHref !== undefined) return { mismatch: `${path} character ${index} gained an unexpected link` }
    if (expectedHref !== actualHref) return { mismatch: `${path} character ${index} has a different link` }
  }
  return undefined
}

function compareBlock(actual, expected, index) {
  if (actual?.kind !== expected.kind) return { mismatch: `blocks[${index}].kind diverged` }
  if (expected.kind === 'para') return compareParagraph(actual, expected, `blocks[${index}]`)
  if (expected.kind === 'pagebreak') return undefined
  if (expected.kind === 'table') {
    if (!Array.isArray(actual.rows) || actual.rows.length !== expected.rows.length) return { mismatch: `blocks[${index}] table row count diverged` }
    for (const [rowIndex, row] of expected.rows.entries()) {
      if (!Array.isArray(actual.rows[rowIndex]) || actual.rows[rowIndex].length !== row.length) return { mismatch: `blocks[${index}] row ${rowIndex} cell count diverged` }
      for (const [columnIndex, cell] of row.entries()) {
        const actualCell = actual.rows[rowIndex][columnIndex]
        for (const field of ['text', 'colspan', 'rowspan', 'background']) {
          if (actualCell?.[field] !== cell[field]) return { mismatch: `blocks[${index}] cell ${rowIndex}:${columnIndex} ${field} diverged` }
        }
        if (!Array.isArray(actualCell.paragraphs) || actualCell.paragraphs.length !== cell.paragraphs.length) return { mismatch: `blocks[${index}] cell ${rowIndex}:${columnIndex} paragraph count diverged` }
        for (const [paragraphIndex, paragraph] of cell.paragraphs.entries()) {
          const result = compareParagraph(actualCell.paragraphs[paragraphIndex], paragraph, `blocks[${index}] cell ${rowIndex}:${columnIndex} paragraph ${paragraphIndex}`)
          if (result) return result
        }
      }
    }
    return undefined
  }
  return { mismatch: `blocks[${index}] has an unsupported expected kind` }
}

function verificationFailure(status, code, index, verifiedCount, message, details = {}) {
  return {
    ok: false,
    status,
    code,
    verifiedCount,
    verifiedBy: 'export',
    mutationPossible: true,
    failure: { index, code, message, ...details },
  }
}

export function verifyDocsPasteAppend(manifest, prefix, actual) {
  if (manifest?.version !== 1 || manifest.placement?.mode !== 'append' || !Array.isArray(manifest.blocks) || !Array.isArray(prefix) || !Array.isArray(actual)) {
    throw new TypeError('verifyDocsPasteAppend requires a prepared append manifest and parsed prefix/actual export blocks')
  }
  if (actual.length < prefix.length || prefix.some((block, index) => JSON.stringify(block) !== JSON.stringify(actual[index]))) {
    return verificationFailure('failed', 'DOCS_PASTE_COLLATERAL', -1, 0, 'The preserved document prefix changed during rich paste', { collateral: true })
  }
  const appended = actual.slice(prefix.length)
  for (const [index, expected] of manifest.blocks.entries()) {
    const block = appended[index]
    if (!block) return verificationFailure('failed', 'DOCS_PASTE_VERIFY_FAILED', index, index, `Appended block ${index} is missing`, ...index === 0 && appended.length === 0 ? [{ unchanged: true }] : [])
    const comparison = compareBlock(block, expected, index)
    if (comparison?.evidence) {
      return verificationFailure('unknown', 'DOCS_PASTE_EVIDENCE_REQUIRED', index, index, comparison.message, { evidence: comparison.evidence })
    }
    if (comparison) return verificationFailure('failed', 'DOCS_PASTE_VERIFY_FAILED', index, index, comparison.mismatch)
  }
  if (appended.length !== manifest.blocks.length) {
    return verificationFailure('failed', 'DOCS_PASTE_COLLATERAL', manifest.blocks.length, manifest.blocks.length, 'Unexpected content followed the appended rich paste', { collateral: true })
  }
  return { ok: true, status: 'verified', verifiedCount: manifest.blocks.length, verifiedBy: 'export', mutationPossible: true }
}
