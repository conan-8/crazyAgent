import { truncate } from './protocol.js'

const OPERATION_TOOLS = Object.freeze({
  snapshot: 'browser_screenshot',
  auto_view: 'browser_screenshot',
  scroll: 'browser_scroll',
  dialog: 'browser_dialog',
  'tabs.list': 'browser_tabs',
  'places.search': 'browser_places',
  'tabs.activate': 'browser_switch_tab',
  click: 'browser_click',
  click_role: 'browser_click_role',
  click_at: 'browser_click_at',
  drag: 'browser_drag',
  select: 'browser_select',
  select_option: 'browser_select_option',
  batch: 'browser_batch',
  table: 'browser_table',
  find: 'browser_find',
  download: 'browser_download',
  upload: 'browser_upload',
  type: 'browser_type',
  press_key: 'browser_press_key',
  navigate: 'browser_navigate',
  wait_for: 'browser_wait_for',
  hover: 'browser_hover',
  read_text: 'browser_read_text',
  clipboard: 'browser_clipboard',
})

function clean(value, max = 64) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text ? truncate(text, max) : ''
}

function quoted(value) {
  const text = clean(value)
  return text ? `“${text}”` : ''
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw !== 'string') return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function decodedString(value) {
  if (typeof value !== 'string') return ''
  try {
    return clean(JSON.parse(value))
  } catch {
    return ''
  }
}

function quotedMatch(text, pattern) {
  const match = pattern.exec(String(text ?? ''))
  return match ? decodedString(match[1]) : ''
}

function tabTitle(text) {
  return quotedMatch(text, /(?:^|\n)tab\s+\d+\s+("(?:\\.|[^"\\])*")/u)
}

function clickText(text) {
  const current = quotedMatch(text, /clicked\s+label\s+\d+\s*:\s*\S+\s+("(?:\\.|[^"\\])*")/u)
  if (current) return current
  const legacy = /^clicked\s+#\d+\s+([^·\n]+)/u.exec(String(text ?? '').trim())
  return clean(legacy?.[1])
}

function clickResult(clicked = {}) {
  const name = clean(clicked.text)
  if (name) return `Clicked ${quoted(name)}`
  const role = clean(clicked.role || clicked.tag, 32).toLowerCase()
  return role ? `Clicked the ${role}` : 'Clicked the element'
}

function keyName(key) {
  const names = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' }
  const value = String(key ?? '')
  return names[value.toLowerCase()] ?? clean(value.replace(/^Key(?=[A-Z]$)/u, '').replace(/([a-z])([A-Z])/gu, '$1 $2'), 32)
}

function keyResult(pressed = {}) {
  const keys = [...(Array.isArray(pressed.modifiers) ? pressed.modifiers : []), pressed.key]
    .filter(value => value !== undefined && value !== null && value !== '')
    .map(keyName)
    .filter(Boolean)
  return keys.length ? `Pressed ${keys.join(' + ')}` : 'Pressed the key'
}

function countText(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

function fileName(value) {
  return clean(String(value ?? '').split(/[\\/]/u).at(-1), 80)
}

function docsResult(action, status) {
  const summary = action === 'read' ? 'Read the document'
    : action === 'rename' ? 'Renamed the document'
      : ['replace_text', 'replace_many'].includes(action) ? 'Updated the document text'
        : action === 'page_setup' ? 'Updated page setup'
          : action === 'write' ? 'Added content to the document'
            : action === 'select_text' ? 'Selected text in the document'
              : ['format', 'format_many', 'set_font'].includes(action) ? 'Formatted the document text'
                : action === 'create' ? 'Created the table'
                  : action && action !== 'read' ? 'Updated the document'
                    : 'Finished the document action'
  return ['partial', 'failed', 'unverified'].includes(status) ? `${summary} · Needs review` : summary
}

export function reasoningActivityText(value) {
  return String(value ?? '')
    .replace(/clicked\s+label\s+\d+\s*:\s*\S+\s+("(?:\\.|[^"\\])*")/giu, match => {
      const target = clickText(match)
      return target ? `Clicked ${quoted(target)}` : 'Clicked the element'
    })
    .replace(/\s+\b(is\s+)?(?:labelled|labeled)\s+#\d+\b/giu, (_match, is) => is ? ' is visible' : '')
    .replace(/\b(click(?:ing)?|press(?:ing)?|select(?:ing)?|type into|use|using)\s+(?:the\s+)?label\s+#?\d+\b/giu, '$1 the control')
    .replace(/\btab\s+\d+\s+("(?:\\.|[^"\\])*")(?:\s+https?:\/\/\S+)?/giu, (_match, title) => `tab ${quoted(decodedString(title))}`)
    .replace(/\b(?:browser|agent)_[a-z0-9_]+\b/giu, name => ({
      browser_click: 'a click',
      browser_click_at: 'a coordinate click',
      browser_switch_tab: 'a tab switch',
      browser_read_text: 'the page text',
      browser_screenshot: 'a screenshot',
    })[name.toLowerCase()] ?? name.replace(/^(?:browser|agent)_/u, '').replaceAll('_', ' '))
}

export function toolRunningText(name, rawArgs = {}) {
  const args = parseArgs(rawArgs)
  switch (name) {
    case 'browser_screenshot': return 'Taking a screenshot…'
    case 'browser_click':
    case 'browser_click_role': return 'Clicking…'
    case 'browser_click_at': return 'Clicking the selected point…'
    case 'browser_hover': return 'Hovering over the target…'
    case 'browser_scroll': return 'Scrolling…'
    case 'browser_tabs': return 'Checking open tabs…'
    case 'browser_switch_tab': return args.query ? `Switching to ${quoted(args.query)}…` : 'Switching tabs…'
    case 'browser_read_text': return 'Reading the page…'
    case 'browser_find': return args.query ? `Finding ${quoted(args.query)}…` : 'Searching the page…'
    case 'browser_type': return args.text === '' ? 'Clearing the field…' : 'Typing…'
    case 'browser_press_key': return args.key ? `Pressing ${String(args.key).split('+').map(keyName).filter(Boolean).join(' + ')}…` : 'Pressing a key…'
    case 'browser_navigate': return args.history === 'back' ? 'Going back…'
      : args.history === 'forward' ? 'Going forward…'
        : args.history === 'reload' ? 'Reloading the page…'
          : args.new_tab === true ? 'Opening a new tab…' : 'Opening the page…'
    case 'browser_wait_for': return 'Waiting…'
    case 'browser_select': return 'Selecting text…'
    case 'browser_select_option': return 'Selecting an option…'
    case 'browser_drag': return 'Dragging…'
    case 'browser_batch': return 'Running the actions…'
    case 'browser_clipboard': return args.action === 'copy' ? 'Copying…'
      : args.action === 'read' ? 'Reading the clipboard…'
        : args.action === 'write' ? 'Saving to the clipboard…'
          : args.action === 'clear' ? 'Clearing the clipboard…' : 'Pasting…'
    case 'browser_places': return 'Finding saved places…'
    case 'browser_downloads': return 'Checking Downloads…'
    case 'browser_download': return 'Downloading the file…'
    case 'browser_upload': return 'Attaching the file…'
    case 'browser_dialog': return args.action === 'dismiss' ? 'Dismissing the dialog…' : 'Accepting the dialog…'
    case 'browser_table': return args.action === 'read' ? 'Reading the table…' : 'Updating the table…'
    case 'browser_docs_rename': return 'Renaming the document…'
    case 'browser_docs_replace': return 'Updating the document text…'
    case 'browser_docs_page_setup': return 'Updating page setup…'
    case 'browser_docs_write': return 'Writing to the document…'
    case 'browser_docs_table': return args.action === 'read' ? 'Reading the document table…' : 'Updating the document table…'
    case 'browser_docs_read': return 'Reading the document…'
    case 'browser_docs_select_text': return 'Selecting text in the document…'
    case 'browser_docs_format': return 'Formatting the document text…'
    case 'browser_plan': return 'Updating the plan…'
    case 'agent_request_help': return 'Asking for your help…'
    case 'agent_request_confirmation': return 'Asking for your approval…'
    default: return 'Working…'
  }
}

export function browserRunningText(op, args = {}) {
  return toolRunningText(OPERATION_TOOLS[op], args)
}

export function browserResultSummary(op, result, rawArgs = {}) {
  if (!result || typeof result !== 'object') return 'Done'
  const args = parseArgs(rawArgs)
  const title = clean(result.tab?.title)
  switch (op) {
    case 'tabs.list': {
      const tabs = Array.isArray(result.tabs) ? result.tabs : []
      const active = tabs.find(tab => tab.active === true)
      return `${countText(tabs.length, 'open tab')}${active?.title ? ` · Active: ${quoted(active.title)}` : ''}`
    }
    case 'tabs.activate': return title ? `Switched to ${quoted(title)}` : 'Switched tabs'
    case 'snapshot': return title ? `Captured ${quoted(title)}` : 'Captured the page'
    case 'auto_view': return title ? `Viewed ${quoted(title)}` : 'Viewed the page'
    case 'read_text': return title ? `Read ${quoted(title)}` : 'Read the page'
    case 'scroll': return ['up', 'down', 'left', 'right'].includes(args.direction) ? `Scrolled ${args.direction}` : 'Scrolled the page'
    case 'click': return clickResult(result.clicked)
    case 'click_at': {
      const points = Array.isArray(result.points) ? result.points : []
      if (points.length > 1) return `Clicked ${countText(points.length, 'point')}`
      const point = result.point ?? points[0]
      return Number.isFinite(point?.x) && Number.isFinite(point?.y)
        ? `Clicked at (${Math.round(point.x)}, ${Math.round(point.y)})`
        : 'Clicked the selected point'
    }
    case 'click_role': {
      const path = Array.isArray(result.roleClick?.path) ? result.roleClick.path : []
      const target = clean(path.at(-1)?.name || path.at(-1)?.text)
      return target ? `Clicked ${quoted(target)}` : 'Clicked through the menu'
    }
    case 'type': {
      const typed = result.typed ?? {}
      const label = Array.isArray(result.labels) ? result.labels.find(item => item.id === typed.label) : undefined
      const target = clean(typed.text || label?.text)
      const action = args.text === '' || typed.chars === 0 ? 'Cleared' : 'Typed into'
      return target ? `${action} ${quoted(target)}` : action === 'Cleared' ? 'Cleared the field' : 'Entered text'
    }
    case 'press_key': return keyResult(result.pressed)
    case 'navigate': {
      const navigated = result.navigated ?? {}
      const summary = navigated.history === 'back' ? 'Went back'
        : navigated.history === 'forward' ? 'Went forward'
          : navigated.history === 'reload' ? 'Reloaded the page'
            : title ? `${navigated.newTab === true ? 'Opened a new tab' : 'Opened'} ${quoted(title)}`
              : navigated.newTab === true ? 'Opened a new tab' : 'Opened the page'
      return navigated.timedOut === true ? `${summary} · Still loading` : summary
    }
    case 'wait_for': return result.waited?.found === false || result.waited?.timedOut === true ? 'Wait timed out' : 'Finished waiting'
    case 'select': return result.selected?.collapsed === true ? 'Cleared the selection'
      : Number(result.selected?.chars) > 0 ? `Selected ${countText(Number(result.selected.chars), 'character')}`
        : 'Selected text'
    case 'select_option': return 'Selected an option'
    case 'drag': return result.drag?.status === 'unknown' ? 'Dragged the item · Outcome unverified' : 'Dragged the item'
    case 'hover': return 'Hovered over the target'
    case 'find': {
      const query = result.find?.query ?? args.query
      const count = Math.max(0, Number(result.find?.matchCount ?? result.matches?.length) || 0)
      return `${count === 0 ? 'No matches' : `Found ${countText(count, 'match', 'matches')}`}${query ? ` for ${quoted(query)}` : ''}`
    }
    case 'places.search': {
      const count = Array.isArray(result.places) ? result.places.length : 0
      return count === 0 ? 'No saved places found' : `Found ${countText(count, 'saved place')}`
    }
    case 'clipboard': {
      const action = result.action ?? args.action
      return action === 'copy' ? 'Copied to the clipboard'
        : action === 'read' ? 'Read the clipboard'
          : action === 'write' ? 'Saved to the clipboard'
            : action === 'clear' ? 'Cleared the clipboard' : 'Pasted from the clipboard'
    }
    case 'download': {
      const name = fileName(result.download?.filename || result.download?.path || args.filename)
      return name ? `Downloaded ${quoted(name)}` : 'Downloaded the file'
    }
    case 'upload': {
      const name = fileName(result.upload?.filename || args.filename)
      return name ? `Attached ${quoted(name)}` : 'Attached the file'
    }
    case 'dialog': return (result.dialog?.action ?? args.action) === 'dismiss' ? 'Dismissed the dialog' : 'Accepted the dialog'
    case 'table': return (result.summary?.action ?? args.action) === 'read' ? 'Read the table' : 'Updated the table'
    case 'docs': return docsResult(result.docs?.action ?? args.action, result.docs?.status)
    case 'batch': {
      const batch = result.batch ?? {}
      const total = Math.max(0, Number(batch.total) || 0)
      const succeeded = Math.max(0, Number(batch.succeeded ?? batch.executed) || 0)
      return total > 0 && succeeded === total ? `Completed ${countText(total, 'action')}`
        : total > 0 ? `Completed ${succeeded} of ${countText(total, 'action')}` : 'Finished the actions'
    }
    default: return 'Done'
  }
}

function successText(name, args, text) {
  switch (name) {
    case 'browser_click': {
      const target = clickText(text) || quotedMatch(text, /^clicked\s+("(?:\\.|[^"\\])*")/u)
      return target ? `Clicked ${quoted(target)}` : 'Clicked the element'
    }
    case 'browser_click_at': {
      const match = /clicked\s+at\s+\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/u.exec(text)
      return match ? `Clicked at (${Math.round(Number(match[1]))}, ${Math.round(Number(match[2]))})` : 'Clicked the selected point'
    }
    case 'browser_click_role': return 'Clicked through the menu'
    case 'browser_switch_tab': {
      const title = tabTitle(text)
      return title ? `Switched to ${quoted(title)}` : 'Switched tabs'
    }
    case 'browser_tabs': {
      const match = /^(\d+)\s+tab\(s\)/u.exec(text)
      return match ? countText(Number(match[1]), 'open tab') : 'Listed open tabs'
    }
    case 'browser_screenshot': {
      const title = tabTitle(text)
      return title ? `Captured ${quoted(title)}` : 'Captured the page'
    }
    case 'browser_read_text': {
      const title = tabTitle(text)
      return title ? `Read ${quoted(title)}` : 'Read the page'
    }
    case 'browser_type': {
      const target = quotedMatch(text, /typed\s+into\s+\[\d+\]\s+\S+\s+("(?:\\.|[^"\\])*")/u)
      if (target) return `${args.text === '' ? 'Cleared' : 'Typed into'} ${quoted(target)}`
      return args.text === '' ? 'Cleared the field' : 'Entered text'
    }
    case 'browser_press_key': {
      const match = /^pressed\s+([^·\n]+)/u.exec(text)
      if (!match) return 'Pressed the key'
      return `Pressed ${match[1].split('+').map(keyName).filter(Boolean).join(' + ')}`
    }
    case 'browser_navigate': return /^navigated\s+back/u.test(text) ? 'Went back'
      : /^navigated\s+forward/u.test(text) ? 'Went forward'
        : /^reloaded/u.test(text) ? 'Reloaded the page' : 'Opened the page'
    case 'browser_find': return args.query ? `Searched for ${quoted(args.query)}` : 'Searched the page'
    case 'browser_downloads': {
      const match = /^(\d+)\s+matching\s+regular\s+file/u.exec(text)
      return match ? `Found ${countText(Number(match[1]), 'file')} in Downloads` : 'Checked Downloads'
    }
    case 'browser_download': {
      const name = quotedMatch(text, /^downloaded\s+("(?:\\.|[^"\\])*")/u)
      return name ? `Downloaded ${quoted(name)}` : 'Downloaded the file'
    }
    case 'browser_upload': {
      const name = quotedMatch(text, /^attached\s+("(?:\\.|[^"\\])*")/u)
      return name ? `Attached ${quoted(name)}` : 'Attached the file'
    }
    case 'browser_scroll': return 'Scrolled the page'
    case 'browser_drag': return 'Dragged the item'
    case 'browser_select': return 'Selected text'
    case 'browser_select_option': return 'Selected an option'
    case 'browser_hover': return 'Hovered over the target'
    case 'browser_table': return args.action === 'read' ? 'Read the table' : 'Updated the table'
    case 'browser_places': return 'Found saved places'
    case 'browser_clipboard': return args.action === 'copy' || args.action === undefined ? 'Copied to the clipboard'
      : args.action === 'read' ? 'Read the clipboard'
        : args.action === 'write' ? 'Saved to the clipboard'
          : args.action === 'clear' ? 'Cleared the clipboard' : 'Pasted from the clipboard'
    case 'browser_dialog': return args.action === 'dismiss' ? 'Dismissed the dialog' : 'Accepted the dialog'
    case 'browser_wait_for': return 'Finished waiting'
    case 'browser_batch': return 'Finished the actions'
    case 'browser_docs_rename': return docsResult('rename')
    case 'browser_docs_replace': return docsResult('replace_text')
    case 'browser_docs_page_setup': return docsResult('page_setup')
    case 'browser_docs_write': return docsResult('write')
    case 'browser_docs_table': return docsResult(args.action === 'read' ? 'read' : args.action === 'create' ? 'create' : 'table')
    case 'browser_docs_read': return docsResult('read')
    case 'browser_docs_select_text': return docsResult('select_text')
    case 'browser_docs_format': return docsResult('format')
    case 'browser_plan': return 'Updated the plan'
    case 'agent_request_help': return 'Asked for your help'
    case 'agent_request_confirmation': return 'Asked for your approval'
    default: return 'Done'
  }
}

export function toolErrorSummary(name, detail = '', explicitCode = '') {
  const text = `${explicitCode} ${String(detail ?? '').split('\n')[0]}`.toUpperCase()
  const has = code => text.includes(code)
  if (has('SIDE_PANEL_CLOSED')) return 'Keep the side panel open while I’m working.'
  if (has('CONFIRMATION_REQUIRED')) return 'This action needs your approval first.'
  if (has('PROTECTED_URL')) return 'The browser doesn’t allow me to control this page.'
  if (has('CAPTCHA')) return 'There’s a CAPTCHA to complete before I can continue.'
  if (has('LOGIN') || has('AUTH_REQUIRED')) return 'Please sign in before I can continue.'
  if (has('AMBIGUOUS_TAB')) return 'More than one tab matches. Please choose one or be more specific.'
  if (has('TAB_NOT_FOUND')) return 'That tab is no longer open.'
  if (has('STALE_TAB') || has('DRAG_STALE_TAB')) return 'The active tab changed before the action finished.'
  if (has('STALE_VIEW') || has('AMBIGUOUS_VIEW') || has('NO_VIEW')) return 'The page changed. I need a fresh view before acting.'
  if (has('BATCH_PRECONDITION_FAILED')) return 'The actions stopped because the page didn’t meet the expected conditions.'
  if (has('BATCH_POSTCONDITION_FAILED')) return 'The actions stopped because the result couldn’t be verified.'
  if (has('DOWNLOADS_FILE_NOT_FOUND')) return 'I couldn’t find that file in Downloads.'
  if (has('DISABLED')) return 'That control is disabled.'
  if (has('NO_TAB')) return 'There’s no active tab to work with.'
  if (has('PAUSED')) return 'Browser access is paused.'
  if (has('MALFORMED_RESPONSE')) return 'The model’s response couldn’t be used. Please try again.'
  if (name?.startsWith('browser_docs_')) return 'The document action couldn’t be completed safely. Details are in the debug log.'
  const action = name === 'browser_click' || name === 'browser_click_at' || name === 'browser_click_role' ? 'click'
    : name === 'browser_switch_tab' ? 'switch tabs'
      : name === 'browser_type' ? 'enter text'
        : name === 'browser_navigate' ? 'open the page'
          : name === 'browser_download' ? 'download the file'
            : name === 'browser_upload' ? 'attach the file' : 'complete the action'
  return `Couldn’t ${action}. Details are in the debug log.`
}

export function browserErrorSummary(op, detail = '', code = '') {
  return toolErrorSummary(OPERATION_TOOLS[op], detail, code)
}

export function chatErrorSummary(message, code = '') {
  const detail = String(message ?? '').trim()
  if (code === 'MALFORMED_RESPONSE' || detail.includes('MALFORMED_RESPONSE')) {
    return 'The model’s reply couldn’t be used, so nothing was done. Send the request again.'
  }
  return detail.replace(/\s*\([A-Z][A-Z0-9_]{2,}\)(?=\s|[,.;:]|$)/gu, '') || 'Something went wrong. Please try again.'
}

export function toolResultSummary({ name, args = {}, text = '', ok = true, browserSummary = '' } = {}) {
  if (ok === false) return toolErrorSummary(name, text)
  if (browserSummary) return clean(browserSummary, 320)
  return successText(name, parseArgs(args), String(text ?? ''))
}
