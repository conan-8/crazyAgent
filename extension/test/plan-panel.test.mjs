import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PLAN_PANEL_LIMITS,
  createPlanPanelModel,
  renderPlanPanel,
} from '../sidepanel/plan-panel.js'

class FakeClassList {
  constructor() {
    this.names = new Set()
  }

  add(...names) {
    for (const name of names) this.names.add(name)
  }

  contains(name) {
    return this.names.has(name)
  }

  set(value) {
    this.names = new Set(String(value).split(/\s+/).filter(Boolean))
  }

  toString() {
    return [...this.names].join(' ')
  }
}

class FakeText {
  constructor(value) {
    this.textContent = String(value)
  }
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
    this.hidden = false
    this._textContent = ''
  }

  set className(value) {
    this.classList.set(value)
  }

  get className() {
    return this.classList.toString()
  }

  set textContent(value) {
    this._textContent = String(value ?? '')
    this.children = []
  }

  get textContent() {
    return this._textContent + this.children.map(child => child.textContent).join('')
  }

  set innerHTML(_value) {
    throw new Error('innerHTML is not allowed in this test DOM')
  }

  append(...nodes) {
    for (const value of nodes) {
      this.children.push(value instanceof FakeText || value instanceof FakeElement
        ? value
        : new FakeText(value))
    }
  }

  appendChild(node) {
    this.append(node)
    return node
  }

  replaceChildren(...nodes) {
    this.children = []
    this._textContent = ''
    this.append(...nodes)
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }

  click() {
    for (const listener of this.listeners.get('click') ?? []) {
      listener.call(this, { type: 'click', target: this })
    }
  }
}

class FakeDocument {
  createElement(tagName) {
    return new FakeElement(tagName, this)
  }

  createTextNode(value) {
    return new FakeText(value)
  }
}

function item(content, status = 'pending') {
  return { content, status }
}

function fixturePlan() {
  return [
    item('Inspect the current page', 'completed'),
    item('Edit the selected text', 'in_progress'),
    item('Verify the result', 'pending'),
    item('Resolve the blocked login', 'blocked'),
  ]
}

function elements(root, predicate = () => true) {
  const matches = []
  for (const child of root.children) {
    if (!(child instanceof FakeElement)) continue
    if (predicate(child)) matches.push(child)
    matches.push(...elements(child, predicate))
  }
  return matches
}

function one(root, predicate) {
  const matches = elements(root, predicate)
  assert.equal(matches.length, 1)
  return matches[0]
}

function byClass(root, className) {
  return one(root, node => node.classList.contains(className))
}

function renderedItems(root) {
  return elements(root, node => node.classList.contains('plan-panel-item'))
}

test('the initial model is empty, hidden, and progress-safe', () => {
  const state = createPlanPanelModel().getState()
  assert.equal(state.visible, false)
  assert.equal(state.expanded, false)
  assert.equal(state.total, 0)
  assert.equal(state.done, 0)
  assert.equal(state.blocked, 0)
  assert.equal(state.current, null)
  assert.equal(state.progress, 0)
  assert.deepEqual(state.items, [])
})

test('the first non-empty update auto-opens and summarizes the complete plan', () => {
  const model = createPlanPanelModel()
  const result = model.update(fixturePlan())
  assert.equal(result.accepted, true)
  assert.equal(result.changed, true)
  assert.equal(result.state.visible, true)
  assert.equal(result.state.expanded, true)
  assert.equal(result.state.total, 4)
  assert.equal(result.state.done, 1)
  assert.equal(result.state.blocked, 1)
  assert.equal(result.state.progress, 0.25)
  assert.deepEqual(result.state.current, {
    index: 1,
    content: 'Edit the selected text',
    status: 'in_progress',
  })
  assert.deepEqual(result.state.items.map(entry => entry.status), [
    'completed', 'in_progress', 'pending', 'blocked',
  ])
})

test('later updates preserve a manual collapse and a manual expansion', () => {
  const model = createPlanPanelModel()
  model.update(fixturePlan())
  assert.equal(model.toggle().expanded, false)

  const changed = fixturePlan()
  changed[2].status = 'in_progress'
  const collapsed = model.update(changed)
  assert.equal(collapsed.accepted, true)
  assert.equal(collapsed.changed, true)
  assert.equal(collapsed.state.expanded, false)
  assert.equal(collapsed.state.current.content, 'Edit the selected text')

  assert.equal(model.toggle().expanded, true)
  const expanded = model.update(fixturePlan())
  assert.equal(expanded.state.expanded, true)
})

test('unchanged and invalid updates are distinct and retain the last valid state', () => {
  const model = createPlanPanelModel()
  const initial = model.update(fixturePlan()).state
  const unchanged = model.update(fixturePlan())
  assert.equal(unchanged.accepted, true)
  assert.equal(unchanged.changed, false)
  assert.equal(unchanged.state, initial)

  for (const value of [
    undefined,
    null,
    {},
    'pending',
    [null],
    [item('unknown status', 'working')],
    [{ content: 42, status: 'pending' }],
    [{ content: ' \n\t ', status: 'pending' }],
    [{ status: 'pending' }],
  ]) {
    const result = model.update(value)
    assert.equal(result.accepted, false, JSON.stringify(value))
    assert.equal(result.changed, false, JSON.stringify(value))
    assert.equal(result.state, initial, JSON.stringify(value))
  }
})

test('an invalid or empty first update does not consume the one-time auto-open', () => {
  const model = createPlanPanelModel()
  assert.equal(model.update([item('bad', 'unknown')]).accepted, false)
  const empty = model.update([])
  assert.equal(empty.accepted, true)
  assert.equal(empty.changed, false)
  assert.equal(empty.state.visible, false)
  assert.equal(model.update(fixturePlan()).state.expanded, true)
})

test('reset clears the plan and rearms auto-open for a new turn', () => {
  const model = createPlanPanelModel()
  model.update(fixturePlan())
  model.toggle()
  const reset = model.reset()
  assert.equal(reset.visible, false)
  assert.equal(reset.expanded, false)
  assert.equal(model.update(fixturePlan()).state.expanded, true)
})

test('clearing without reset hides the panel without forgetting manual collapse', () => {
  const model = createPlanPanelModel()
  model.update(fixturePlan())
  model.toggle()
  assert.equal(model.update([]).state.visible, false)
  const next = model.update(fixturePlan()).state
  assert.equal(next.visible, true)
  assert.equal(next.expanded, false)
})

test('blocked and pending items never count as done or become the current item', () => {
  const model = createPlanPanelModel()
  const state = model.update([
    item('Done', 'completed'),
    item('Waiting', 'pending'),
    item('Stopped', 'blocked'),
  ]).state
  assert.equal(state.done, 1)
  assert.equal(state.blocked, 1)
  assert.equal(state.current, null)
  assert.equal(state.progress, 1 / 3)
})

test('model snapshots are immutable and detached from the input array', () => {
  const model = createPlanPanelModel()
  const input = fixturePlan()
  const state = model.update(input).state
  input[0].content = 'Mutated outside the model'
  input[1].status = 'completed'
  assert.equal(state.items[0].content, 'Inspect the current page')
  assert.equal(state.items[1].status, 'in_progress')
  assert.equal(Object.isFrozen(state), true)
  assert.equal(Object.isFrozen(state.items), true)
  assert.equal(Object.isFrozen(state.items[0]), true)
  assert.equal(Object.isFrozen(state.current), true)
})

test('text is normalized and truncated at a Unicode code-point boundary', () => {
  const model = createPlanPanelModel()
  const state = model.update([
    item('  Research\n\t <b>safe text</b> \u0000 now  '),
    item('😀'.repeat(PLAN_PANEL_LIMITS.textChars + 5)),
    item('😀'.repeat(PLAN_PANEL_LIMITS.textChars)),
  ]).state
  assert.equal(state.items[0].content, 'Research <b>safe text</b> now')
  assert.equal(Array.from(state.items[1].content).length, PLAN_PANEL_LIMITS.textChars)
  assert.equal(state.items[1].content.endsWith('😀…'), true)
  assert.equal([...state.items[1].content].filter(character => character === '😀').length, PLAN_PANEL_LIMITS.textChars - 1)
  assert.equal(state.items[2].content, '😀'.repeat(PLAN_PANEL_LIMITS.textChars))
})

test('an empty model renders an empty hidden region', () => {
  const document = new FakeDocument()
  const root = document.createElement('div')
  root.appendChild(document.createElement('span'))
  renderPlanPanel(root, createPlanPanelModel().getState())
  assert.equal(root.hidden, true)
  assert.equal(root.children.length, 0)
  assert.equal(root.getAttribute('role'), 'region')
  assert.equal(root.getAttribute('aria-label'), 'Agent plan')
})

test('the expanded panel exposes summary, progress, and all four statuses accessibly', () => {
  const document = new FakeDocument()
  const root = document.createElement('div')
  const state = createPlanPanelModel().update(fixturePlan()).state
  renderPlanPanel(root, state)

  assert.equal(root.hidden, false)
  const toggle = byClass(root, 'plan-panel-toggle')
  const details = byClass(root, 'plan-panel-details')
  assert.equal(toggle.tagName, 'BUTTON')
  assert.equal(toggle.type, 'button')
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.equal(toggle.getAttribute('aria-controls'), details.id)
  assert.equal(toggle.title, 'Collapse plan')
  assert.equal(details.hidden, false)
  assert.match(byClass(root, 'plan-panel-count').textContent, /^1\/4 done$/)
  assert.match(byClass(root, 'plan-panel-blocked').textContent, /^1 blocked$/)
  assert.equal(byClass(root, 'plan-panel-blocked').hidden, false)
  assert.match(byClass(root, 'plan-panel-current').textContent, /^Current: Edit the selected text$/)

  const progress = byClass(root, 'plan-panel-progress')
  assert.equal(progress.tagName, 'PROGRESS')
  assert.equal(progress.max, 4)
  assert.equal(progress.value, 1)
  assert.equal(progress.getAttribute('aria-label'), '1 of 4 plan items completed')

  const rows = renderedItems(root)
  assert.equal(byClass(root, 'plan-panel-list').tagName, 'OL')
  assert.deepEqual(rows.map(row => row.dataset.status), [
    'completed', 'in_progress', 'pending', 'blocked',
  ])
  assert.deepEqual(rows.map(row => byClass(row, 'plan-panel-item-status').textContent), [
    'Completed', 'In progress', 'Pending', 'Blocked',
  ])
  assert.deepEqual(rows.map(row => row.getAttribute('aria-current')), [null, 'step', null, null])
})

test('a zero blocked count does not render a warning badge', () => {
  const document = new FakeDocument()
  const root = document.createElement('div')
  const state = createPlanPanelModel().update([item('Continue work', 'in_progress')]).state
  renderPlanPanel(root, state)
  assert.equal(byClass(root, 'plan-panel-blocked').hidden, true)
})

test('collapsed rendering hides only details and retains the current summary', () => {
  const document = new FakeDocument()
  const root = document.createElement('div')
  const model = createPlanPanelModel()
  model.update(fixturePlan())
  renderPlanPanel(root, model.toggle())
  assert.equal(byClass(root, 'plan-panel-toggle').getAttribute('aria-expanded'), 'false')
  assert.equal(byClass(root, 'plan-panel-toggle').title, 'Expand plan')
  assert.equal(byClass(root, 'plan-panel-details').hidden, true)
  assert.equal(renderedItems(root).length, 4)
  assert.match(root.textContent, /Current: Edit the selected text/)
  assert.match(root.textContent, /1\/4 done/)
})

test('the toggle callback supports a complete model and DOM wiring loop', () => {
  const document = new FakeDocument()
  const root = document.createElement('div')
  const model = createPlanPanelModel()
  model.update(fixturePlan())
  let renders = 0

  function paint() {
    renders += 1
    renderPlanPanel(root, model.getState(), {
      onToggle() {
        model.toggle()
        paint()
      },
    })
  }

  paint()
  byClass(root, 'plan-panel-toggle').click()
  assert.equal(renders, 2)
  assert.equal(model.getState().expanded, false)
  assert.equal(byClass(root, 'plan-panel-details').hidden, true)
  byClass(root, 'plan-panel-toggle').click()
  assert.equal(renders, 3)
  assert.equal(model.getState().expanded, true)
})

test('markup-like plan text is rendered strictly as text', () => {
  const document = new FakeDocument()
  const root = document.createElement('div')
  const markup = '<img src=x onerror="globalThis.compromised=true"><script>bad()</script>'
  const state = createPlanPanelModel().update([item(markup)]).state
  renderPlanPanel(root, state)
  assert.equal(byClass(root, 'plan-panel-item-content').textContent, markup)
  assert.match(root.textContent, /<script>bad\(\)<\/script>/)
  assert.equal(elements(root, node => node.tagName === 'IMG' || node.tagName === 'SCRIPT').length, 0)
})

test('expanded rows are bounded without truncating full-plan counts or current text', () => {
  const document = new FakeDocument()
  const root = document.createElement('div')
  const omitted = 7
  const input = Array.from({ length: PLAN_PANEL_LIMITS.items + omitted }, (_, index) => {
    const status = index < 10 ? 'completed' : index === PLAN_PANEL_LIMITS.items + 5 ? 'in_progress' : 'pending'
    return item(`Item ${index + 1}`, status)
  })
  const state = createPlanPanelModel().update(input).state
  renderPlanPanel(root, state)

  assert.equal(renderedItems(root).length, PLAN_PANEL_LIMITS.items)
  assert.equal(byClass(root, 'plan-panel-overflow').textContent, '7 more plan items not shown')
  assert.equal(byClass(root, 'plan-panel-count').textContent, `10/${PLAN_PANEL_LIMITS.items + omitted} done`)
  assert.equal(byClass(root, 'plan-panel-current').textContent, `Current: Item ${PLAN_PANEL_LIMITS.items + 6}`)
  assert.equal(byClass(root, 'plan-panel-progress').max, PLAN_PANEL_LIMITS.items + omitted)
})

test('each rendered root has a stable unique details target', () => {
  const document = new FakeDocument()
  const first = document.createElement('div')
  const second = document.createElement('div')
  const state = createPlanPanelModel().update(fixturePlan()).state
  renderPlanPanel(first, state)
  renderPlanPanel(second, state)
  const firstTarget = byClass(first, 'plan-panel-toggle').getAttribute('aria-controls')
  const secondTarget = byClass(second, 'plan-panel-toggle').getAttribute('aria-controls')
  assert.notEqual(firstTarget, secondTarget)
  renderPlanPanel(first, state)
  assert.equal(byClass(first, 'plan-panel-toggle').getAttribute('aria-controls'), firstTarget)
})
