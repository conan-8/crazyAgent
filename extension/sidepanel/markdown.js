function appendInline(parent, text) {
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)\s]+\))/g
  let offset = 0
  for (const match of text.matchAll(pattern)) {
    parent.appendChild(document.createTextNode(text.slice(offset, match.index)))
    const token = match[0]
    let element
    let content
    if (token.startsWith('**') || token.startsWith('__')) {
      element = document.createElement('strong')
      content = token.slice(2, -2)
    } else if (token.startsWith('*') || token.startsWith('_')) {
      element = document.createElement('em')
      content = token.slice(1, -1)
    } else if (token.startsWith('`')) {
      element = document.createElement('code')
      content = token.slice(1, -1)
    } else {
      const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      element = document.createElement('a')
      element.href = parts[2]
      element.target = '_blank'
      element.rel = 'noreferrer noopener'
      content = parts[1]
    }
    element.textContent = content
    parent.appendChild(element)
    offset = match.index + token.length
  }
  parent.appendChild(document.createTextNode(text.slice(offset)))
}

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
}

function isTableDivider(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

export function renderMarkdown(container, text) {
  container.replaceChildren()
  container.classList.add('markdown-body')
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  let index = 0
  let paragraph = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    const element = document.createElement('p')
    appendInline(element, paragraph.join('\n'))
    container.appendChild(element)
    paragraph = []
  }

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      flushParagraph()
      index += 1
      continue
    }

    if (index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1])) {
      flushParagraph()
      const wrap = document.createElement('div')
      wrap.className = 'markdown-table-wrap'
      const table = document.createElement('table')
      const head = document.createElement('thead')
      const headRow = document.createElement('tr')
      const headers = tableCells(line)
      const aligns = tableCells(lines[index + 1]).map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left')
      headers.forEach((value, cellIndex) => {
        const cell = document.createElement('th')
        cell.style.textAlign = aligns[cellIndex] || 'left'
        appendInline(cell, value)
        headRow.appendChild(cell)
      })
      head.appendChild(headRow)
      table.appendChild(head)
      const body = document.createElement('tbody')
      index += 2
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const row = document.createElement('tr')
        tableCells(lines[index]).forEach((value, cellIndex) => {
          const cell = document.createElement('td')
          cell.style.textAlign = aligns[cellIndex] || 'left'
          appendInline(cell, value)
          row.appendChild(cell)
        })
        body.appendChild(row)
        index += 1
      }
      table.appendChild(body)
      wrap.appendChild(table)
      container.appendChild(wrap)
      continue
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      flushParagraph()
      const element = document.createElement(`h${heading[1].length + 2}`)
      appendInline(element, heading[2])
      container.appendChild(element)
      index += 1
      continue
    }

    const list = /^\s*([-+*]|\d+[.)])\s+(.+)$/.exec(line)
    if (list) {
      flushParagraph()
      const ordered = /^\d/.test(list[1])
      const element = document.createElement(ordered ? 'ol' : 'ul')
      while (index < lines.length) {
        const item = /^\s*([-+*]|\d+[.)])\s+(.+)$/.exec(lines[index])
        if (!item || /^\d/.test(item[1]) !== ordered) break
        const listItem = document.createElement('li')
        appendInline(listItem, item[2])
        element.appendChild(listItem)
        index += 1
      }
      container.appendChild(element)
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      flushParagraph()
      const element = document.createElement('blockquote')
      appendInline(element, quote[1])
      container.appendChild(element)
      index += 1
      continue
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph()
      container.appendChild(document.createElement('hr'))
      index += 1
      continue
    }

    paragraph.push(line)
    index += 1
  }
  flushParagraph()
}
