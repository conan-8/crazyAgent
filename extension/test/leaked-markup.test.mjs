import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isLeakedToolCallText,
  textStreamDeltaAction,
  hasLeakedReplyRow,
  removeLeakedReplyRows,
} from '../sidepanel/leaked-markup.js'
import { isLeakedToolCallText as companionRule } from '../../companion/session-controller.mjs'

/**
 * The panel's render-time guard must classify exactly like the companion's
 * committed-reply rule, or a reply the companion calls leaked would still
 * render (or a clean reply would vanish).
 */
const CORPUS = [
  '<｜DSML｜ calls>',
  '</｜DSML｜ invoke>',
  '<｜DSML｜ parameter name="actions">',
  '<｜DSML｜ function_calls>',
  '</｜DSML｜parameter>',
  'prose before <｜DSML｜ invoke name="browser_click"> and after',
  '\n<｜DSML｜ calls>\n<｜DSML｜ invoke name="browser_batch">\n</｜DSML｜ invoke>\n</｜DSML｜ calls>',
  '<|DSML| invoke name="browser_batch">',
  '  \n<|DSML| calls>',
  '</|DSML| invoke>',
  'DONE: all good',
  'DONE: the page mentions <|DSML| invoke markup',
  'The page mentions <|DSML| invoke markup',
  'I will now <|DSML| invoke>',
  'DONE: the page mentions <｜DSML｜ invoke markup',
  '<｜DSML｜ unknown>',
  'text <｜DSML｜',
  'Just a plain reply with a <tag> and an | pipe.',
  '',
  ' ',
]

test('the panel guard matches the companion rule on every corpus string', () => {
  for (const text of CORPUS) {
    assert.equal(isLeakedToolCallText(text), companionRule(text), JSON.stringify(text))
  }
  for (const value of [undefined, null, 42, {}, []]) {
    assert.equal(isLeakedToolCallText(value), false)
    assert.equal(companionRule(value), false)
  }
})

test('fullwidth DSML tags count anywhere; the ASCII form only at the start', () => {
  assert.equal(isLeakedToolCallText('Looking at the page. <｜DSML｜ invoke name="browser_click">'), true)
  assert.equal(isLeakedToolCallText('<|DSML| invoke name="browser_click">'), true)
  assert.equal(isLeakedToolCallText('\n\t <|DSML| calls>'), true)
  assert.equal(isLeakedToolCallText('Looking at the page. <|DSML| invoke name="browser_click">'), false)
  assert.equal(isLeakedToolCallText('DONE: submitted the form'), false)
})

test('stream deltas are matched on the accumulated reply, so split tags are caught', () => {
  // A tag split across two deltas: the first piece alone is not a tag yet.
  assert.equal(textStreamDeltaAction('', '\n<｜DSM', false), 'append')
  assert.equal(textStreamDeltaAction('\n<｜DSM', 'L｜ invoke name="browser_batch">', false), 'suppress')
  // Once leaked, the rest of the same stream is dropped, even clean-looking pieces.
  assert.equal(textStreamDeltaAction('', '</｜DSML｜ invoke>', true), 'drop')
  assert.equal(textStreamDeltaAction('anything', 'plain words', true), 'drop')
  // A clean stream keeps appending.
  assert.equal(textStreamDeltaAction('', 'The count is ', false), 'append')
  assert.equal(textStreamDeltaAction('The count is ', '2.', false), 'append')
  // Fullwidth markup after clean prose still leaks the whole reply.
  assert.equal(textStreamDeltaAction('The count is 2.', ' <｜DSML｜ calls>', false), 'suppress')
  // The ASCII form mid-reply is not leaked (companion parity).
  assert.equal(textStreamDeltaAction('I will now ', '<|DSML| invoke>', false), 'append')
  // A reply that starts with the ASCII form is leaked at once.
  assert.equal(textStreamDeltaAction('', '<|DSML| calls>', false), 'suppress')
})

/* A minimal DOM for the row-stripping helpers: class selectors, text, remove. */
class FakeElement {
  constructor(className = '') {
    this.classes = new Set(className.split(/\s+/).filter(Boolean))
    this.children = []
    this.parent = null
    this.text = ''
  }

  get textContent() {
    return this.text + this.children.map(child => child.textContent).join('')
  }

  appendChild(child) {
    child.parent = this
    this.children.push(child)
    return child
  }

  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this)
    this.parent = null
  }

  matches(selector) {
    return selector.split('.').filter(Boolean).every(name => this.classes.has(name))
  }

  descendants() {
    const out = []
    for (const child of this.children) {
      out.push(child, ...child.descendants())
    }
    return out
  }

  querySelectorAll(selector) {
    return this.descendants().filter(node => node.matches(selector))
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }
}

/** One activity row as pushActivity builds it: kind label + activity text. */
function row(kind, text) {
  const entry = new FakeElement(`activity-entry ${kind}`)
  const label = new FakeElement('act-kind')
  label.text = kind === 'text' ? 'reply' : kind
  const body = new FakeElement('activity-text')
  body.text = text
  entry.appendChild(label)
  entry.appendChild(body)
  return entry
}

function feedWith(...rows) {
  const feed = new FakeElement('activity-log')
  const turn = new FakeElement('activity-turn')
  const step = new FakeElement('activity-step')
  const body = new FakeElement('step-body')
  for (const entry of rows) body.appendChild(entry)
  step.appendChild(body)
  turn.appendChild(step)
  feed.appendChild(turn)
  return feed
}

const MARKUP = '\n<｜DSML｜ calls>\n<｜DSML｜ invoke name="browser_batch">\n</｜DSML｜ invoke>\n</｜DSML｜ calls>'

test('leaked reply rows are stripped from nested step bodies; clean rows stay', () => {
  const leaked = row('text', MARKUP)
  const clean = row('text', 'The count is 2.')
  const feed = feedWith(leaked, clean)
  assert.equal(hasLeakedReplyRow(feed), true)
  assert.equal(removeLeakedReplyRows(feed), 1)
  assert.equal(hasLeakedReplyRow(feed), false)
  assert.deepEqual(feed.querySelectorAll('.activity-entry.text'), [clean])
  // Stripping again changes nothing.
  assert.equal(removeLeakedReplyRows(feed), 0)
})

test('tool rows with DSML-looking arguments and reasoning rows are never stripped', () => {
  // A type command's text payload may legitimately contain markup-looking text.
  const tool = row('tool', '{"text":"<｜DSML｜ invoke name=\\"x\\">"}')
  const reasoning = row('reasoning', 'thinking about <｜DSML｜ invoke>')
  const asciiStart = row('text', '<|DSML| calls>')
  const asciiMid = row('text', 'I will now <|DSML| invoke>')
  const feed = feedWith(tool, reasoning, asciiStart, asciiMid)
  assert.equal(removeLeakedReplyRows(feed), 1)
  assert.deepEqual(feed.querySelectorAll('.activity-entry'), [tool, reasoning, asciiMid])
})

test('a feed without leaked rows is left untouched', () => {
  const feed = feedWith(row('text', 'DONE: submitted'), row('tool', '{}'))
  assert.equal(hasLeakedReplyRow(feed), false)
  assert.equal(removeLeakedReplyRows(feed), 0)
  assert.equal(feed.querySelectorAll('.activity-entry').length, 2)
})
