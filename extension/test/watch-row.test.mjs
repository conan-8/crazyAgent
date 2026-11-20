import test from 'node:test'
import assert from 'node:assert/strict'
import { watchNotice, watchNoticeFromOpen, renderWatchRow, renderWatchCard, watchIsActionable, WATCH_KIND_LABELS } from '../sidepanel/watch-row.js'

class FakeClassList {
  constructor() { this.names = new Set() }
  add(...names) { for (const name of names) this.names.add(name) }
  contains(name) { return this.names.has(name) }
  toggle(name, force) {
    const want = force === undefined ? !this.names.has(name) : force === true
    if (want) this.names.add(name); else this.names.delete(name)
    return want
  }
  set(value) { this.names = new Set(String(value).split(/\s+/).filter(Boolean)) }
  toString() { return [...this.names].join(' ') }
}
class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase()
    this.ownerDocument = ownerDocument
    this.children = []
    this.attributes = new Map()
    this.dataset = {}
    this.classList = new FakeClassList()
    this.listeners = new Map()
    this.type = ''
    this.title = ''
    this._textContent = ''
  }
  set className(value) { this.classList.set(value) }
  get className() { return this.classList.toString() }
  set textContent(value) { this._textContent = String(value ?? ''); this.children = [] }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join('') }
  append(...nodes) { for (const node of nodes) this.children.push(node) }
  appendChild(node) { this.append(node); return node }
  replaceChildren(...nodes) { this.children = []; this._textContent = ''; this.append(...nodes) }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener) }
  click() { for (const listener of this.listeners.get('click') ?? []) listener.call(this, { type: 'click', target: this }) }
}
class FakeDocument { createElement(tagName) { return new FakeElement(tagName, this) } }

function byClass(root, name) {
  if (root.classList.contains(name)) return root
  for (const child of root.children) {
    const found = byClass(child, name)
    if (found) return found
  }
  return null
}
function allByClass(root, name, out = []) {
  if (root.classList.contains(name)) out.push(root)
  for (const child of root.children) allByClass(child, name, out)
  return out
}

const alertFrame = {
  type: 'chat.watch',
  id: 'watch-1',
  turnId: 'turn-1',
  kind: 'TOOL_HANG',
  state: 'open',
  blocker: 'TOOL_HANG',
  reason: 'A browser call has not returned for several minutes.',
  signals: [{ kind: 'TOOL_HANG', level: 'hard', detail: 'browser_wait_for unanswered for 240s' }],
  source: 'heuristic',
  at: '2026-11-16T19:00:00.000Z',
}

test('watchNotice normalizes a valid frame and rejects malformed ones', () => {
  const notice = watchNotice(alertFrame)
  assert.equal(notice.id, 'watch-1')
  assert.equal(notice.kind, 'TOOL_HANG')
  assert.equal(notice.state, 'open')
  assert.equal(notice.signals.length, 1)
  assert.equal(notice.source, 'heuristic')
  for (const bad of [null, {}, 'x', [], { type: 'chat.done', id: 'a' }, { type: 'chat.watch' }, { type: 'chat.watch', id: '' }]) {
    assert.equal(watchNotice(bad), null, JSON.stringify(bad))
  }
  // Unknown source falls back to heuristic; signals bounded.
  const weird = watchNotice({ ...alertFrame, source: 'bogus', signals: Array.from({ length: 30 }, () => ({ kind: 'X', level: 'hard', detail: 'd' })) })
  assert.equal(weird.source, 'heuristic')
  assert.equal(weird.signals.length, 12)
})

test('watchIsActionable only for open actionable alerts', () => {
  assert.equal(watchIsActionable(watchNotice(alertFrame)), true)
  assert.equal(watchIsActionable(watchNotice({ ...alertFrame, kind: 'ended-incomplete' })), true)
  assert.equal(watchIsActionable(watchNotice({ ...alertFrame, state: 'recovered', kind: 'recovered' })), false)
  assert.equal(watchIsActionable(watchNotice({ ...alertFrame, state: 'dismissed', kind: 'info' })), false)
  assert.equal(watchIsActionable(null), false)
})

test('an open alert renders the reason, signals, and three action buttons', () => {
  const document = new FakeDocument()
  const root = document.createElement('div')
  const calls = { stop: 0, steer: 0, dismiss: 0 }
  renderWatchRow(root, watchNotice(alertFrame), {
    onStop: () => { calls.stop += 1 },
    onSteer: () => { calls.steer += 1 },
    onDismiss: () => { calls.dismiss += 1 },
  })
  assert.equal(root.dataset.watchId, 'watch-1')
  assert.equal(root.dataset.watchState, 'open')
  assert.equal(root.classList.contains('alert'), true)
  assert.equal(root.classList.contains('collapsed'), false)
  assert.equal(byClass(root, 'watch-row-badge').textContent, WATCH_KIND_LABELS.TOOL_HANG)
  assert.match(byClass(root, 'watch-row-reason').textContent, /not returned/)
  assert.equal(allByClass(root, 'watch-row-signal').length, 1)
  const stop = byClass(root, 'watch-row-stop')
  const steer = byClass(root, 'watch-row-steer')
  const dismiss = byClass(root, 'watch-row-dismiss')
  assert.equal(stop.textContent, 'Stop')
  assert.equal(steer.textContent, 'Steer…')
  assert.equal(dismiss.textContent, "It's fine")
  stop.click(); steer.click(); dismiss.click()
  assert.deepEqual(calls, { stop: 1, steer: 1, dismiss: 1 })
})

test('a recovered notice collapses to a summary with no buttons', () => {
  const document = new FakeDocument()
  const root = document.createElement('div')
  renderWatchRow(root, watchNotice({ ...alertFrame, kind: 'recovered', state: 'recovered', reason: 'The agent is making progress again.', signals: [] }))
  assert.equal(root.classList.contains('collapsed'), true)
  assert.equal(root.classList.contains('alert'), false)
  assert.equal(byClass(root, 'watch-row-actions'), null)
  assert.match(byClass(root, 'watch-row-reason').textContent, /progress again/)
})

test('re-rendering the same root replaces the row (open then dismissed)', () => {
  const document = new FakeDocument()
  const root = document.createElement('div')
  renderWatchRow(root, watchNotice(alertFrame), {})
  assert.equal(allByClass(root, 'watch-row-stop').length, 1)
  renderWatchRow(root, watchNotice({ ...alertFrame, state: 'dismissed', kind: 'info', reason: 'Dismissed.' }), {})
  assert.equal(allByClass(root, 'watch-row-stop').length, 0)
  assert.equal(root.classList.contains('collapsed'), true)
})

test('M4 judge kinds stuck/blocked render actionable with their labels and source', () => {
  for (const [kind, label] of [['stuck', 'May be stuck'], ['blocked', 'Blocked']]) {
    const notice = watchNotice({ ...alertFrame, kind, state: 'open', blocker: 'loop', reason: 'The agent appears to be repeating the same action.', source: 'watcher', signals: [] })
    assert.equal(notice.source, 'watcher')
    assert.equal(watchIsActionable(notice), true, `${kind} is actionable`)
    const document = new FakeDocument()
    const root = document.createElement('div')
    renderWatchRow(root, notice, {})
    assert.equal(byClass(root, 'watch-row-badge').textContent, label)
    assert.deepEqual(byClass(root, 'watch-row-actions').children.map(button => button.textContent), ['Stop', 'Steer…', "It's fine"])
    assert.equal(root.classList.contains('alert'), true)
  }
  // A 'both' source (deterministic + judge) passes through too.
  assert.equal(watchNotice({ ...alertFrame, kind: 'stuck', source: 'both' }).source, 'both')
})

test('V1: a closed notice collapses the row (no buttons), like dismissed', () => {
  const document = new FakeDocument()
  const root = document.createElement('div')
  // Open actionable alert first.
  renderWatchRow(root, watchNotice(alertFrame), {})
  assert.equal(root.classList.contains('collapsed'), false)
  assert.equal(byClass(root, 'watch-row-actions').children.length, 3)
  // Closed at turn end (kind info, state closed, own id) collapses it.
  const closed = watchNotice({ ...alertFrame, kind: 'info', state: 'closed', blocker: null, reason: 'Turn ended.', signals: [] })
  assert.equal(watchIsActionable(closed), false)
  renderWatchRow(root, closed, {})
  assert.equal(root.classList.contains('collapsed'), true)
  assert.equal(root.classList.contains('alert'), false)
  assert.equal(byClass(root, 'watch-row-actions'), null, 'no buttons on a closed row')
  assert.equal(byClass(root, 'watch-row-reason').textContent, 'Turn ended.')
  assert.equal(root.dataset.watchState, 'closed')
})

test('V1: ended-incomplete is actionable while open, collapses when closed at next turn start', () => {
  const document = new FakeDocument()
  const root = document.createElement('div')
  const ended = watchNotice({ ...alertFrame, id: 'ended-1', kind: 'ended-incomplete', state: 'open', blocker: 'ended-incomplete', reason: 'The turn ended with work still open or blocked.', signals: [] })
  assert.equal(watchIsActionable(ended), true)
  renderWatchRow(root, ended, {})
  assert.deepEqual(byClass(root, 'watch-row-actions').children.map(b => b.textContent), ['Stop', 'Steer…', "It's fine"])
  // Closed at the next turn start.
  renderWatchRow(root, watchNotice({ ...alertFrame, id: 'ended-1', kind: 'info', state: 'closed', reason: 'A new turn started.', signals: [] }), {})
  assert.equal(root.classList.contains('collapsed'), true)
  assert.equal(byClass(root, 'watch-row-actions'), null)
  assert.equal(byClass(root, 'watch-row-reason').textContent, 'A new turn started.')
  // Ack-dismissed also collapses.
  renderWatchRow(root, watchNotice({ ...alertFrame, id: 'ended-1', kind: 'info', state: 'dismissed', reason: 'Dismissed.', signals: [] }), {})
  assert.equal(root.classList.contains('collapsed'), true)
})

test('W1: watchNoticeFromOpen normalizes chat.hello.watch.open and rejects malformed/non-actionable values', () => {
  const open = watchNoticeFromOpen({
    id: 'watch-reconnect-1',
    kind: 'stuck',
    at: '2026-11-19T22:00:00.000Z',
    reason: 'Spending 3 minutes retrying the same form submit.',
  })
  assert.equal(open.id, 'watch-reconnect-1')
  assert.equal(open.kind, 'stuck')
  assert.equal(open.state, 'open')
  assert.equal(watchIsActionable(open), true)
  assert.match(open.reason, /retrying the same form/)
  assert.equal(watchNoticeFromOpen(null), null)
  assert.equal(watchNoticeFromOpen({}), null)
  assert.equal(watchNoticeFromOpen({ id: 'x', kind: 'info', reason: 'info only' }), null)
})

test('W1: renderWatchCard shows pinned card for actionable alert and hides on clear/recovery', () => {
  const document = new FakeDocument()
  const card = document.createElement('div')
  card.classList.add('watch-card', 'hidden')
  const calls = { stop: 0, steer: 0, dismiss: 0 }
  renderWatchCard(card, watchNotice(alertFrame), {
    onStop: () => { calls.stop += 1 },
    onSteer: () => { calls.steer += 1 },
    onDismiss: () => { calls.dismiss += 1 },
  })
  assert.equal(card.classList.contains('hidden'), false)
  assert.equal(card.dataset.watchId, 'watch-1')
  assert.equal(byClass(card, 'watch-row-badge').textContent, WATCH_KIND_LABELS.TOOL_HANG)
  assert.match(byClass(card, 'watch-card-reason').textContent, /not returned/)
  assert.equal(allByClass(card, 'watch-row-signal').length, 1)
  byClass(card, 'watch-row-stop').click()
  byClass(card, 'watch-row-steer').click()
  byClass(card, 'watch-row-dismiss').click()
  assert.deepEqual(calls, { stop: 1, steer: 1, dismiss: 1 })

  // Clearing hides the card and strips its watch dataset.
  renderWatchCard(card, null, {})
  assert.equal(card.classList.contains('hidden'), true)
  assert.equal(card.dataset.watchId, undefined)
  assert.equal(card.children.length, 0)
})

test('W3: watchNotice, watchNoticeFromOpen, renderWatchRow, and renderWatchCard display watcher steer note transparently', () => {
  const document = new FakeDocument()
  const steered = watchNotice({
    ...alertFrame,
    kind: 'stuck',
    blocker: 'loop',
    reason: 'Clicking the same submit button with no visible change.',
    steer: { id: 'steer-1', text: 'Inspect validation errors instead of clicking Submit.' },
  })
  assert.deepEqual(steered.steer, { id: 'steer-1', text: 'Inspect validation errors instead of clicking Submit.' })

  const row = document.createElement('div')
  renderWatchRow(row, steered, {})
  assert.equal(byClass(row, 'watch-steer-note').textContent, 'Watcher nudged agent: Inspect validation errors instead of clicking Submit.')

  const card = document.createElement('div')
  renderWatchCard(card, steered, {})
  assert.equal(byClass(card, 'watch-card-title').textContent, 'Watcher alert · nudged agent')
  assert.equal(byClass(card, 'watch-steer-note').textContent, 'Watcher nudged agent: Inspect validation errors instead of clicking Submit.')

  // Reconnect open alert preserves the steer note too.
  const reopened = watchNoticeFromOpen({
    id: 'watch-1',
    kind: 'stuck',
    at: '2026-11-19T23:00:00.000Z',
    reason: 'Clicking the same submit button.',
    steer: { id: 'steer-1', text: 'Inspect validation errors instead of clicking Submit.' },
  })
  assert.deepEqual(reopened.steer, { id: 'steer-1', text: 'Inspect validation errors instead of clicking Submit.' })
})
