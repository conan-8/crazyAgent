const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

export function decodeEntities(value) {
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
      if (!Number.isFinite(code)) return match
      return code === 160 ? ' ' : String.fromCodePoint(code)
    }
    return ENTITIES[name.toLowerCase()] ?? match
  })
}

function attr(attrs, wanted) {
  const match = new RegExp(`\\b${wanted}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'iu').exec(attrs)
  return match ? decodeEntities(match[2] ?? match[3] ?? '') : undefined
}

export function normalizeDocsColor(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text || text === 'transparent' || text === 'none' || /^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/u.test(text)) return 'none'
  if (/^#[0-9a-f]{6}$/u.test(text)) return text
  if (/^#[0-9a-f]{3}$/u.test(text)) return `#${[...text.slice(1)].map(char => char + char).join('')}`
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/u.exec(text)
  if (rgb) return `#${rgb.slice(1).map(value => Number(value).toString(16).padStart(2, '0')).join('')}`
  return text
}

function applyStyle(marks, body) {
  const weight = /font-weight\s*:\s*([^;}]+)/iu.exec(body)?.[1]
  if (weight) marks.bold = /^(?:700|bold)$/iu.test(weight.trim())
  const fontStyle = /font-style\s*:\s*([^;}]+)/iu.exec(body)?.[1]
  if (fontStyle) marks.italic = /^italic$/iu.test(fontStyle.trim())
  const decoration = /text-decoration[^:]*:\s*([^;}]+)/iu.exec(body)?.[1]
  if (decoration) {
    marks.underline = /underline/iu.test(decoration)
    marks.strike = /line-through/iu.test(decoration)
  }
  const font = /font-family\s*:\s*([^;}]+)/iu.exec(body)?.[1]?.split(',')[0]?.trim().replace(/^["']|["']$/gu, '')
  if (font) marks.font = font
  const size = /font-size\s*:\s*(\d+(?:\.\d+)?)\s*pt/iu.exec(body)
  if (size) marks.fontSize = Number(size[1])
  const color = /(?:^|;)\s*color\s*:\s*([^;}]+)/iu.exec(body)?.[1]
  if (color) marks.color = normalizeDocsColor(color)
  const background = /background-color\s*:\s*([^;}]+)/iu.exec(body)?.[1]
  if (background) marks.highlight = normalizeDocsColor(background)
}

export function parseClassMarks(html) {
  const out = new Map()
  const style = /<style[^>]*>([\s\S]*?)<\/style>/iu.exec(html)?.[1] ?? ''
  for (const match of style.matchAll(/\.([a-zA-Z0-9_-]+)\s*\{([^}]*)\}/gu)) {
    const marks = {}
    applyStyle(marks, match[2])
    if (Object.keys(marks).length > 0) out.set(match[1], marks)
  }
  return out
}

function marksOf(attrs, classMarks, includeBackground = true) {
  const merged = {}
  for (const className of (attr(attrs, 'class') ?? '').split(/\s+/u)) {
    const marks = classMarks.get(className)
    if (marks) Object.assign(merged, marks)
  }
  applyStyle(merged, attr(attrs, 'style') ?? '')
  if (!includeBackground) delete merged.highlight
  return merged
}

function wrap(text, marks, href) {
  if (!text.trim()) return text
  const lead = /^\s*/u.exec(text)[0]
  const trail = /\s*$/u.exec(text)[0]
  let core = text.trim()
  if (marks.underline && !href) core = `__${core}__`
  if (marks.italic) core = `*${core}*`
  if (marks.bold) core = `**${core}**`
  if (marks.strike) core = `~~${core}~~`
  if (href) core = `[${core}](${href})`
  return lead + core + trail
}

function runMarks(marks, href) {
  return {
    bold: marks.bold === true,
    italic: marks.italic === true,
    underline: marks.underline === true,
    strike: marks.strike === true,
    ...(marks.font ? { font: marks.font } : {}),
    ...(marks.fontSize !== undefined ? { fontSize: marks.fontSize } : {}),
    ...(marks.color ? { color: marks.color } : {}),
    ...(marks.highlight ? { highlight: marks.highlight } : {}),
    ...(href ? { href } : {}),
  }
}

function sameRunMarks(left, right) {
  return left.bold === right.bold && left.italic === right.italic && left.underline === right.underline
    && left.strike === right.strike && left.font === right.font && left.fontSize === right.fontSize
    && left.color === right.color && left.highlight === right.highlight && left.href === right.href
}

export function parseDocStructure(html) {
  const classMarks = parseClassMarks(html)
  const bodyStart = String(html).search(/<body[^>]*>/iu)
  const body = bodyStart >= 0 ? String(html).slice(bodyStart) : String(html)
  const blocks = []
  const tables = []
  const lists = []
  const spanMarks = []
  let para
  let href
  let tableCount = 0
  let bodyMarks = {}

  const currentMarks = () => Object.assign({}, bodyMarks, para?.marks, ...spanMarks)
  const append = raw => {
    if (!para) para = { style: 'P', text: '', marked: '', runs: [], marks: {} }
    para.text += raw
    para.marked += wrap(raw, currentMarks(), href)
    const marks = runMarks(currentMarks(), href)
    const previous = para.runs.at(-1)
    if (previous && sameRunMarks(previous, marks)) previous.text += raw
    else para.runs.push({ text: raw, ...marks })
  }
  const closePara = () => {
    if (!para) return
    const current = para
    para = undefined
    const cell = tables.at(-1)?.cell
    const { marks, ...block } = current
    if (cell) {
      cell.text.push(current.text)
      cell.paragraphs.push({ kind: 'para', ...block })
      return
    }
    blocks.push({ kind: 'para', ...block })
  }
  const expression = /<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/gu
  for (const match of body.matchAll(expression)) {
    const [, slash, tagRaw, attrs = '', text] = match
    if (text !== undefined) {
      const decoded = decodeEntities(text.replace(/\s*\n\s*/gu, ' '))
      if (decoded && (para || decoded.trim())) append(decoded)
      continue
    }
    const tag = tagRaw.toLowerCase()
    const closing = slash === '/'
    switch (tag) {
      case 'body':
        if (!closing) bodyMarks = marksOf(attrs, classMarks, false)
        break
      case 'p':
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
      case 'li': {
        if (closing) {
          closePara()
          break
        }
        closePara()
        const classes = attr(attrs, 'class') ?? ''
        let style = tag === 'p' ? 'P' : tag === 'li' ? 'LI' : tag.toUpperCase()
        if (/\btitle\b/u.test(classes)) style = 'TITLE'
        else if (/\bsubtitle\b/u.test(classes)) style = 'SUBTITLE'
        para = { style, text: '', marked: '', runs: [], marks: marksOf(attrs, classMarks, false) }
        if (tag === 'li') {
          para.listLevel = Number(/lst-[^\s"']*-(\d+)/u.exec(classes)?.[1] ?? Math.max(0, lists.length - 1))
          const list = lists.at(-1)
          para.ordered = list?.ordered ?? false
          if (para.ordered) {
            para.number = list?.nextNumber ?? 1
            if (list) list.nextNumber += 1
          }
        }
        break
      }
      case 'ul':
      case 'ol': {
        if (closing) lists.pop()
        else {
          const start = Math.max(1, Number(attr(attrs, 'start') ?? 1) || 1)
          lists.push({ ordered: tag === 'ol', nextNumber: start })
        }
        break
      }
      case 'span':
        if (closing) spanMarks.pop()
        else spanMarks.push(marksOf(attrs, classMarks))
        break
      case 'b':
      case 'strong':
        if (closing) spanMarks.pop()
        else spanMarks.push({ bold: true })
        break
      case 'i':
      case 'em':
        if (closing) spanMarks.pop()
        else spanMarks.push({ italic: true })
        break
      case 'u':
        if (closing) spanMarks.pop()
        else spanMarks.push({ underline: true })
        break
      case 's':
      case 'strike':
        if (closing) spanMarks.pop()
        else spanMarks.push({ strike: true })
        break
      case 'a':
        if (closing) href = undefined
        else {
          const target = attr(attrs, 'href')
          const query = target && /[?&]q=([^&]+)/u.exec(target)?.[1]
          href = query ? decodeURIComponent(query) : target
        }
        break
      case 'br':
        if (!closing) append('\n')
        break
      case 'input':
        if (!closing && para?.style === 'LI' && /\btype\s*=\s*["']checkbox["']/iu.test(attrs)) {
          para.checklist = true
          para.checked = attr(attrs, 'checked') !== undefined || attr(attrs, 'aria-checked') === 'true'
            || /(?:^|\s)checked(?:\s|=|$)/iu.test(attrs)
        }
        break
      case 'img':
        if (closing) break
        if (para || tables.at(-1)?.cell) append('[image]')
        else blocks.push({ kind: 'image' })
        break
      case 'hr':
        if (closing) break
        closePara()
        if (!tables.length) blocks.push({ kind: /page-break/iu.test(attrs) ? 'pagebreak' : 'hr' })
        break
      case 'table':
        closePara()
        if (closing) {
          const table = tables.pop()
          if (table && !tables.length) blocks.push({ kind: 'table', index: ++tableCount, rows: table.rows })
          else if (table && tables.at(-1)?.cell) {
            tables.at(-1).cell.text.push(table.rows.map(row => row.map(cell => cell.text).join(' | ')).join(' / '))
          }
        } else tables.push({ rows: [] })
        break
      case 'tr':
        if (!closing) tables.at(-1)?.rows.push([])
        break
      case 'td':
      case 'th': {
        const table = tables.at(-1)
        if (!table) break
        if (closing) {
          closePara()
          if (table.cell) {
            table.rows.at(-1)?.push({
              text: table.cell.text.join('\n').replace(/\n+$/u, ''),
              paragraphs: table.cell.paragraphs.length > 0 ? table.cell.paragraphs : [{ kind: 'para', style: 'P', text: '', marked: '', runs: [] }],
              colspan: table.cell.colspan,
              rowspan: table.cell.rowspan,
            })
            table.cell = undefined
          }
        } else {
          if (!table.rows.length) table.rows.push([])
          table.cell = {
            text: [],
            paragraphs: [],
            colspan: Math.max(1, Number(attr(attrs, 'colspan') ?? 1) || 1),
            rowspan: Math.max(1, Number(attr(attrs, 'rowspan') ?? 1) || 1),
          }
        }
        break
      }
      default:
        break
    }
  }
  closePara()
  return blocks
}

export function formatOutline(blocks) {
  const lines = []
  let empties = 0
  const flushEmpties = () => {
    if (empties) lines.push(empties === 1 ? '(empty line)' : `(empty line ×${empties})`)
    empties = 0
  }
  for (const block of blocks) {
    if (block.kind === 'para' && !block.text.trim()) {
      empties += 1
      continue
    }
    flushEmpties()
    if (block.kind === 'para') {
      if (block.style === 'LI') {
        const indent = '  '.repeat(block.listLevel ?? 0)
        const marker = block.ordered ? `${block.number ?? 1}.` : block.checklist ? block.checked ? '☑' : '☐' : '•'
        lines.push(`${indent}${marker} ${block.marked.trim()}`)
      } else lines.push(`${block.style}: ${block.marked.trim()}`)
    } else if (block.kind === 'table') {
      const columns = Math.max(0, ...block.rows.map(row => row.reduce((sum, cell) => sum + cell.colspan, 0)))
      lines.push(`TABLE ${block.index} (${block.rows.length} rows × ${columns} cols):`)
      block.rows.forEach((row, rowIndex) => {
        const cells = row.map(cell => {
          const span = cell.colspan > 1 || cell.rowspan > 1 ? ` ⟨merged ${cell.rowspan}×${cell.colspan}⟩` : ''
          return `${cell.text.replace(/\n/gu, ' ⏎ ') || '·'}${span}`
        })
        lines.push(`  r${rowIndex + 1}: ${cells.join(' | ')}`)
      })
    } else if (block.kind === 'hr') lines.push('— horizontal line —')
    else if (block.kind === 'pagebreak') lines.push('═══ page break ═══')
    else if (block.kind === 'image') lines.push('[image]')
  }
  flushEmpties()
  return lines.join('\n')
}
