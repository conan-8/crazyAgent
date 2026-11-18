import test from 'node:test'
import assert from 'node:assert/strict'
import {
  browserErrorSummary,
  browserResultSummary,
  browserRunningText,
  chatErrorSummary,
  reasoningActivityText,
  toolResultSummary,
  toolRunningText,
} from '../sidepanel/activity-presenter.js'

test('running tool text never renders argument JSON or internal label IDs', () => {
  assert.equal(toolRunningText('browser_click', '{"label":495}'), 'Clicking…')
  assert.equal(toolRunningText('browser_click', '{"label":'), 'Clicking…')
  assert.equal(toolRunningText('browser_switch_tab', { tab_id: 239247924 }), 'Switching tabs…')
  assert.equal(toolRunningText('browser_switch_tab', { query: 'Team inbox' }), 'Switching to “Team inbox”…')
  assert.equal(browserRunningText('read_text', {}), 'Reading the page…')
})

test('label clicks show the accessible name, not the label or role metadata', () => {
  const text = 'clicked label 495: button "Save changes"\nresult: changed (DOM mutation)\nclick 611ms\ntab 239247924 "Form" https://example.test\n[495] button "Save changes"'
  assert.equal(toolResultSummary({ name: 'browser_click', text }), 'Clicked “Save changes”')
  assert.equal(toolResultSummary({ name: 'browser_click', text: 'clicked #495 Increment · changed · trusted input' }), 'Clicked “Increment”')
  assert.equal(toolResultSummary({ name: 'browser_click', text: 'clicked label 8: link "Read \\"more\\""' }), 'Clicked “Read "more"”')
  assert.equal(browserResultSummary('click', { clicked: { label: 495, role: 'button', text: 'Save changes' } }), 'Clicked “Save changes”')
  assert.equal(browserResultSummary('click', { clicked: { label: 495, role: 'button', text: '' } }), 'Clicked the button')
})

test('coordinate clicks keep only the useful image coordinates', () => {
  const text = 'clicked at (100, 200) image px → css (80, 160) · trusted input\nresult: changed (pixels-changed 2.4%)'
  assert.equal(toolResultSummary({ name: 'browser_click_at', text }), 'Clicked at (100, 200)')
  assert.equal(browserResultSummary('click_at', { point: { x: 100, y: 200, cssX: 80, cssY: 160 } }), 'Clicked at (100, 200)')
  assert.equal(browserResultSummary('click_at', { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }), 'Clicked 2 points')
})

test('tab results use titles and never expose browser tab IDs or URLs', () => {
  const text = 'tab 239247924 "Team inbox" https://mail.example.test/inbox\nviewport 1280x720 css; image 1280x720 px\nlabels (click by number): 20'
  assert.equal(toolResultSummary({ name: 'browser_switch_tab', text }), 'Switched to “Team inbox”')
  const summary = browserResultSummary('tabs.activate', { tab: { id: 239247924, title: 'Team inbox', url: 'https://mail.example.test' } })
  assert.equal(summary, 'Switched to “Team inbox”')
  assert.equal(browserResultSummary('tabs.list', {
    tabs: [
      { id: 239247924, title: 'Team inbox', active: true },
      { id: 3, title: 'Receipt', active: false },
    ],
  }), '2 open tabs · Active: “Team inbox”')
  assert.equal(toolResultSummary({ name: 'browser_tabs', text: '2 tab(s) in the current Chrome window:\n[239247924] "Team inbox" https://mail.example.test (active)' }), '2 open tabs')
})

test('read results do not dump page content or view metadata into the activity feed', () => {
  const text = 'tab 239247924 "Account settings" https://example.test\ntext scope=page; 400 total chars; showing 0-400\n\n{"secretLooking":"page content"}\n[1] button "Save"'
  assert.equal(toolResultSummary({ name: 'browser_read_text', text }), 'Read “Account settings”')
  assert.equal(browserResultSummary('read_text', { tab: { title: 'Account settings' }, text: '{"page":true}', totalMs: 200 }), 'Read “Account settings”')
})

test('typing names the field without exposing its label or typed contents', () => {
  const result = {
    typed: { label: 7, role: 'textbox', text: 'Email', chars: 12, method: 'trusted' },
    labels: [{ id: 7, role: 'textbox', text: 'Email' }],
  }
  assert.equal(browserResultSummary('type', result, { text: 'person@example.test' }), 'Typed into “Email”')
  assert.equal(browserResultSummary('type', { ...result, typed: { ...result.typed, text: '' } }), 'Typed into “Email”')
  assert.equal(toolResultSummary({ name: 'browser_type', text: 'typed into [7] textbox "Email" · replace · 12 chars · dom\nvalue now "person@example.test"' }), 'Typed into “Email”')
})

test('other common browser outcomes have concise human summaries', () => {
  assert.equal(browserResultSummary('press_key', { pressed: { key: 'Tab', modifiers: ['ctrl', 'shift'], trusted: true } }), 'Pressed Ctrl + Shift + Tab')
  assert.equal(browserResultSummary('navigate', { tab: { title: 'Receipt' }, navigated: { toUrl: 'https://example.test/receipt', waitMs: 400 } }), 'Opened “Receipt”')
  assert.equal(browserResultSummary('navigate', { navigated: { history: 'back', toUrl: 'https://example.test' } }), 'Went back')
  assert.equal(browserResultSummary('find', { find: { query: 'Total due', matchCount: 2 }, matches: [] }), 'Found 2 matches for “Total due”')
  assert.equal(browserResultSummary('docs', { docs: { action: 'format', status: 'completed' } }), 'Formatted the document text')
  assert.equal(browserResultSummary('batch', { batch: { total: 3, succeeded: 3, executed: 3, ok: true } }), 'Completed 3 actions')
})

test('tool failures are actionable without raw codes, JSON, or model-facing payloads', () => {
  assert.equal(toolResultSummary({ name: 'browser_click', ok: false, text: 'refused STALE_VIEW: coordinates 100,200 no longer match view #3\n{"label":495}' }), 'The page changed. I need a fresh view before acting.')
  assert.equal(toolResultSummary({ name: 'browser_switch_tab', ok: false, text: 'TAB_NOT_FOUND: Tab 239247924 does not exist. Current tabs: [3] "Other"' }), 'That tab is no longer open.')
  assert.equal(browserErrorSummary('click', 'CONFIRMATION_REQUIRED: clicking Submit needs approval', 'CONFIRMATION_REQUIRED'), 'This action needs your approval first.')
  const fallback = toolResultSummary({ name: 'browser_type', ok: false, text: 'browser_type requires text. Example: {"label":5,"text":"hello"}' })
  assert.equal(fallback, 'Couldn’t enter text. Details are in the debug log.')
  assert.doesNotMatch(fallback, /browser_|[{}]|\d{3,}/u)
})

test('reasoning keeps prose and coordinates but removes internal target references', () => {
  assert.equal(reasoningActivityText('The Increment button is labelled #12. I will click it.'), 'The Increment button is visible. I will click it.')
  assert.equal(reasoningActivityText('I should click label #495 now.'), 'I should click the control now.')
  assert.equal(reasoningActivityText('The result was clicked label 495: button "Save".'), 'The result was Clicked “Save”.')
  assert.equal(reasoningActivityText('Switch to tab 239247924 "Team inbox" https://mail.example.test next.'), 'Switch to tab “Team inbox” next.')
  assert.equal(reasoningActivityText('Use browser_click_at at (100, 200).'), 'Use a coordinate click at (100, 200).')
  assert.equal(reasoningActivityText('The page looks unchanged.'), 'The page looks unchanged.')
})

test('chat errors omit internal codes while preserving ordinary readable messages', () => {
  assert.equal(chatErrorSummary("The model's reply could not be used (MALFORMED_RESPONSE), so nothing was done. Send the request again."), 'The model’s reply couldn’t be used, so nothing was done. Send the request again.')
  assert.equal(chatErrorSummary('The request failed (RATE_LIMITED), so try again.'), 'The request failed, so try again.')
  assert.equal(chatErrorSummary('A turn is already running. Wait for it to finish.'), 'A turn is already running. Wait for it to finish.')
  assert.equal(chatErrorSummary(''), 'Something went wrong. Please try again.')
})

test('every standing browser tool has a safe fallback instead of echoing raw output', () => {
  const names = [
    'browser_screenshot', 'browser_scroll', 'browser_click', 'browser_click_role', 'browser_click_at',
    'browser_drag', 'browser_select', 'browser_select_option', 'browser_hover', 'browser_table',
    'browser_read_text', 'browser_find', 'browser_tabs', 'browser_places', 'browser_switch_tab',
    'browser_type', 'browser_press_key', 'browser_clipboard', 'browser_downloads', 'browser_download',
    'browser_upload', 'browser_navigate', 'browser_dialog', 'browser_wait_for', 'browser_batch',
    'browser_docs_rename', 'browser_docs_replace', 'browser_docs_page_setup', 'browser_docs_write',
    'browser_docs_table', 'browser_docs_read', 'browser_docs_select_text', 'browser_docs_format',
  ]
  for (const name of names) {
    const summary = toolResultSummary({ name, text: '{"label":495,"tab_id":239247924,"html":"<main>raw</main>"}' })
    assert.ok(summary.length > 0, name)
    assert.doesNotMatch(summary, /browser_|[{}]|<main>|239247924|495/u, `${name}: ${summary}`)
  }
})
