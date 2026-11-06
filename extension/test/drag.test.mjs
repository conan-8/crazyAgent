import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DragError,
  dispatchTrustedDrag,
  docsDragError,
  dragProbe,
  evaluateDragDestinationOutcome,
  evaluateDragOutcome,
  executeDrag,
  parseDragArgs,
} from '../sidepanel/drag.js'

const box = (left = 20, top = 30, width = 60, height = 24) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
})

function measuredSnapshot(overrides = {}) {
  return {
    connected: true,
    parent: 41,
    index: 0,
    bounds: box(),
    value: { measured: false },
    ariaValueNow: { measured: true, value: null },
    selection: { measured: true, collapsed: true, signature: 'empty', truncated: false },
    ...overrides,
  }
}

function destinationSnapshot(overrides = {}) {
  return {
    connected: true,
    children: { measured: true, signature: '[]', truncated: false },
    text: { measured: true, signature: 'destination', truncated: false },
    ...overrides,
  }
}

test('drag parsing normalizes labels, refs, positions, deltas, and timing', () => {
  assert.deepEqual(parseDragArgs({ label: 4, to_label: 9, to_position: 'bottom' }), {
    source: { label: 4 },
    destination: { label: 9, position: 'bottom' },
    holdMs: 60,
    settleMs: 150,
  })
  assert.deepEqual(parseDragArgs({ ref: 'e12', to_ref: '15', hold: 350, settle_ms: 0 }), {
    source: { label: 12 },
    destination: { label: 15, position: 'center' },
    holdMs: 350,
    settleMs: 0,
  })
  assert.deepEqual(parseDragArgs({ x: 10.5, y: 20, to_x: 100, to_y: 200 }), {
    source: { x: 10.5, y: 20 },
    destination: { x: 100, y: 200 },
    holdMs: 60,
    settleMs: 150,
  })
  assert.deepEqual(parseDragArgs({ label: 2, dy: -8 }).destination, { dx: 0, dy: -8 })
  assert.equal(parseDragArgs({ label: 2, dx: 0 }).destination.dx, 0, 'a zero-distance delta remains an intentional no-op request')
})

test('drag parsing rejects malformed and ambiguous requests with no mutation', () => {
  const rejected = [
    undefined, null, [], {}, { label: 1 },
    { label: 1, ref: 1, dx: 2 },
    { label: 1, x: 2, y: 3, dx: 2 },
    { x: 1, dx: 2 },
    { label: 0, dx: 2 },
    { label: 1.5, dx: 2 },
    { ref: 'e01', dx: 2 },
    { ref: '12x', dx: 2 },
    { label: 1, to_label: 2, to_ref: 2 },
    { label: 1, to_label: 2, dx: 2 },
    { label: 1, to_x: 2 },
    { label: 1, to_x: Number.NaN, to_y: 2 },
    { label: 1, dx: '2' },
    { label: 1, dx: 2, to_position: 'top' },
    { label: 1, to_label: 2, to_position: 'middle' },
    { label: 1, dx: 2, hold: -1 },
    { label: 1, dx: 2, hold_ms: 3_001 },
    { label: 1, dx: 2, hold: 2, hold_ms: 2 },
    { label: 1, dx: 2, settle_ms: 2.5 },
    { label: 1, dx: 2, target: 'surprise' },
  ]
  for (const args of rejected) {
    assert.throws(() => parseDragArgs(args), error => {
      assert.ok(error instanceof DragError)
      assert.equal(error.mutationPossible, false)
      return true
    }, JSON.stringify(args))
  }
})

test('executeDrag completes validation before touching its driver', async () => {
  let touched = false
  const io = new Proxy({}, { get: () => { touched = true; throw new Error('driver touched') } })
  await assert.rejects(executeDrag({ label: 1, to_label: 2, dx: 1 }, io), error => error.code === 'DRAG_DESTINATION_AMBIGUOUS')
  assert.equal(touched, false)
})

test('Docs drag guard preserves the existing selection prohibition without matching lookalikes', () => {
  const guarded = docsDragError('https://docs.google.com/document/d/abc/edit')
  assert.equal(guarded.code, 'DOCS_CANVAS_SELECT_UNSUPPORTED')
  assert.equal(guarded.mutationPossible, false)
  assert.match(guarded.message, /browser_docs_select_text/)
  for (const url of [
    'https://docs.google.com/spreadsheets/d/abc/edit',
    'https://docs.google.com/documentary',
    'https://docs.google.com.evil.test/document/d/abc',
    'http://docs.google.com/document/d/abc',
    'https://example.test/',
    undefined,
  ]) assert.equal(docsDragError(url), undefined)
})

test('outcome evaluation returns unchanged only when every applicable check is quiet', () => {
  const before = measuredSnapshot()
  const outcome = evaluateDragOutcome(before, measuredSnapshot())
  assert.equal(outcome.changed, false)
  assert.equal(outcome.complete, true)
  assert.deepEqual(outcome.unknownChecks, [])
  assert.deepEqual(outcome.signals, [])
})

test('outcome evaluation independently detects parent, index, bounds, value, ARIA, and selection', () => {
  const before = measuredSnapshot({ value: { measured: true, value: '20' } })
  const cases = [
    ['parent', measuredSnapshot({ parent: 99, value: { measured: true, value: '20' } })],
    ['index', measuredSnapshot({ index: 2, value: { measured: true, value: '20' } })],
    ['bounds', measuredSnapshot({ bounds: box(24), value: { measured: true, value: '20' } })],
    ['value', measuredSnapshot({ value: { measured: true, value: '75' } })],
    ['ariaValueNow', measuredSnapshot({ value: { measured: true, value: '20' }, ariaValueNow: { measured: true, value: '75' } })],
    ['selection', measuredSnapshot({ value: { measured: true, value: '20' }, selection: { measured: true, collapsed: false, signature: 'text', truncated: false } })],
  ]
  for (const [name, after] of cases) {
    const outcome = evaluateDragOutcome(before, after)
    assert.equal(outcome.changed, true, name)
    assert.equal(outcome.checks[name], 'changed', name)
    assert.equal(outcome.complete, true, name)
  }
  assert.equal(evaluateDragOutcome(before, measuredSnapshot({ bounds: box(21), value: { measured: true, value: '20' } })).changed, true, 'an exact 1px move is measured, not DRAG_NO_EFFECT')
  assert.equal(evaluateDragOutcome(before, measuredSnapshot({ bounds: box(23), value: { measured: true, value: '20' } })).changed, true, 'a 3px move is also measured')
  assert.equal(evaluateDragOutcome(before, measuredSnapshot({ bounds: box(20), value: { measured: true, value: '20' } })).changed, false, 'only identical bounds are unchanged')
})

test('an unmeasurable rerender is unknown, never unchanged', () => {
  const outcome = evaluateDragOutcome(measuredSnapshot(), measuredSnapshot({ connected: false, bounds: null }))
  assert.equal(outcome.changed, null)
  assert.equal(outcome.complete, false)
  assert.ok(outcome.unknownChecks.includes('bounds'))
  assert.ok(outcome.unknownChecks.includes('parent'))
  assert.ok(outcome.unknownChecks.includes('index'))
})

test('a measured selection change remains visible even when source checks become unknown', () => {
  const outcome = evaluateDragOutcome(measuredSnapshot(), measuredSnapshot({
    connected: false,
    bounds: null,
    selection: { measured: true, collapsed: false, signature: 'selected', truncated: false },
  }))
  assert.equal(outcome.changed, true)
  assert.equal(outcome.complete, false)
  assert.deepEqual(outcome.signals, ['selection-changed'])
})

test('collapsed caret movement is not selected-text evidence', () => {
  const outcome = evaluateDragOutcome(
    measuredSnapshot({ selection: { measured: true, collapsed: true, signature: 'range-0', truncated: false } }),
    measuredSnapshot({ selection: { measured: true, collapsed: true, signature: 'range-1', truncated: false } }),
  )
  assert.equal(outcome.changed, false)
  assert.equal(outcome.checks.selection, 'unchanged')
})

test('missing measurements and truncated identical selections cannot prove a no-op', () => {
  const missing = evaluateDragOutcome(measuredSnapshot(), measuredSnapshot({ bounds: null }))
  assert.equal(missing.changed, null)
  const truncated = evaluateDragOutcome(
    measuredSnapshot({ selection: { measured: true, collapsed: false, signature: 'same', truncated: true } }),
    measuredSnapshot({ selection: { measured: true, collapsed: false, signature: 'same', truncated: true } }),
  )
  assert.equal(truncated.changed, null)
  assert.equal(truncated.checks.selection, 'unknown')
})

test('destination evidence detects scoped child/text effects and stays unknown when unmeasurable', () => {
  const before = destinationSnapshot()
  const children = evaluateDragDestinationOutcome(before, destinationSnapshot({
    children: { measured: true, signature: '[42]', truncated: false },
  }))
  assert.equal(children.changed, true)
  assert.deepEqual(children.signals, ['destination-children-changed'])
  const text = evaluateDragDestinationOutcome(before, destinationSnapshot({
    text: { measured: true, signature: 'drop receipt', truncated: false },
  }))
  assert.equal(text.changed, true)
  assert.deepEqual(text.signals, ['destination-text-changed'])
  assert.equal(evaluateDragDestinationOutcome(before, destinationSnapshot()).changed, false)
  const rerendered = evaluateDragDestinationOutcome(before, destinationSnapshot({ connected: false }))
  assert.equal(rerendered.changed, null)
  assert.equal(rerendered.complete, false)
})

function fakeCdp(options = {}) {
  const calls = []
  const sleeps = []
  let listener
  let listening = false
  let pressedMoves = 0
  let failureCount = 0
  const data = options.data ?? { items: [{ type: 'text/plain', data: 'payload' }], dragOperationsMask: 1 }
  const io = {
    calls,
    sleeps,
    listening: () => listening,
    sendCommand: async (method, params) => {
      calls.push({ method, params })
      const shouldFail = options.failMethod === method
        && (options.failWhen === undefined || options.failWhen(params) === true)
        && failureCount++ === 0
      if (shouldFail) throw new Error(`failed ${method}`)
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && params.buttons === 1) {
        pressedMoves += 1
        if (options.interceptAt === pressedMoves) listener?.(data)
      }
    },
    onDragIntercepted: callback => {
      listening = true
      listener = callback
      if (options.badUnsubscribe) return undefined
      return () => { listening = false }
    },
    sleep: async ms => { sleeps.push(ms) },
  }
  return { io, calls, sleeps }
}

const dispatchRequest = () => ({ from: { x: 10, y: 10 }, to: { x: 110, y: 10 }, holdMs: 60 })

test('trusted pointer drag holds, activates by 6px, interpolates, releases, and cleans interception', async () => {
  const fake = fakeCdp()
  const result = await dispatchTrustedDrag(dispatchRequest(), fake.io)
  assert.equal(result.mode, 'pointer')
  assert.equal(result.dropDispatched, false)
  assert.equal(result.mouseReleased, true)
  assert.equal(fake.io.listening(), false)
  assert.deepEqual(fake.calls[0], { method: 'Input.setInterceptDrags', params: { enabled: true } })
  assert.deepEqual(fake.calls.at(-1), { method: 'Input.setInterceptDrags', params: { enabled: false } })
  const mouse = fake.calls.filter(call => call.method === 'Input.dispatchMouseEvent')
  assert.equal(mouse[1].params.type, 'mousePressed')
  const pressedMoves = mouse.filter(call => call.params.type === 'mouseMoved' && call.params.buttons === 1)
  assert.equal(pressedMoves[0].params.x, 16)
  assert.ok(pressedMoves.length >= 8)
  assert.equal(pressedMoves.at(-1).params.x, 110)
  assert.equal(mouse.at(-1).params.type, 'mouseReleased')
  assert.equal(fake.sleeps[0], 60)
  assert.equal(fake.calls.some(call => call.method === 'Input.dispatchDragEvent'), false)
})

test('pointer-only dispatch can skip HTML5 interception without weakening release evidence', async () => {
  const fake = fakeCdp()
  const result = await dispatchTrustedDrag({ ...dispatchRequest(), intercept: false }, fake.io)
  assert.equal(result.mode, 'pointer')
  assert.equal(result.intercepted, false)
  assert.equal(result.mouseReleased, true)
  assert.equal(fake.calls.some(call => call.method === 'Input.setInterceptDrags'), false)
  assert.equal(fake.calls.some(call => call.params.type === 'mouseReleased'), true)
  assert.equal(fake.io.listening(), false)
})

test('dispatch validates before hover, after hover, and after the destination hold', async () => {
  const events = []
  await dispatchTrustedDrag({ ...dispatchRequest(), intercept: false, destinationHoldMs: 100 }, {
    beforeHover: async () => { events.push('beforeHover') },
    beforePress: async () => { events.push('beforePress') },
    beforeDrop: async () => { events.push('beforeDrop') },
    sendCommand: async (method, params) => { events.push(params.type ?? method) },
    onDragIntercepted: () => () => {},
    sleep: async ms => { events.push(`sleep:${ms}`) },
  })
  assert.ok(events.indexOf('beforeHover') < events.indexOf('mouseMoved'))
  assert.ok(events.indexOf('mouseMoved') < events.indexOf('beforePress'))
  assert.ok(events.indexOf('beforePress') < events.indexOf('mousePressed'))
  assert.ok(events.indexOf('sleep:100') < events.indexOf('beforeDrop'))
  assert.ok(events.indexOf('beforeDrop') < events.indexOf('mouseReleased'))
})

test('failed drop revalidation cancels outside the target and native drag replay', async () => {
  const fake = fakeCdp({ interceptAt: 1 })
  const beforeDrop = async () => {
    throw new DragError('DRAG_STALE_TARGET', 'destination moved', { mutationPossible: true })
  }
  await assert.rejects(dispatchTrustedDrag({ ...dispatchRequest(), beforeDrop }, { ...fake.io, beforeDrop }), error => {
    assert.equal(error.mutationPossible, true)
    assert.equal(error.dispatch.dropCancelled, true)
    assert.equal(error.dispatch.dropDispatched, false)
    return true
  })
  assert.equal(fake.calls.some(call => call.method === 'Input.dispatchDragEvent' && call.params.type === 'drop'), false)
  assert.equal(fake.calls.some(call => call.method === 'Input.dispatchDragEvent' && call.params.type === 'dragCancel'), true)
  const release = fake.calls.findLast(call => call.params.type === 'mouseReleased')
  assert.deepEqual({ x: release.params.x, y: release.params.y }, { x: 0, y: 0 })
})

test('a zero-distance long press sends hold and release without inventing movement', async () => {
  const fake = fakeCdp()
  const result = await dispatchTrustedDrag({ from: { x: 10, y: 10 }, to: { x: 10, y: 10 }, holdMs: 350 }, fake.io)
  assert.equal(result.movementCount, 0)
  assert.equal(fake.sleeps[0], 350)
  const moves = fake.calls.filter(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mouseMoved' && call.params.buttons === 1)
  assert.equal(moves.length, 0)
  assert.equal(fake.calls.some(call => call.params.type === 'mouseReleased'), true)
})

test('native HTML5 interception switches to drag events at the current step and never replays backwards', async () => {
  const fake = fakeCdp({ interceptAt: 3 })
  const result = await dispatchTrustedDrag(dispatchRequest(), fake.io)
  assert.equal(result.mode, 'html5')
  assert.equal(result.intercepted, true)
  assert.equal(result.dropDispatched, true)
  assert.equal(Object.hasOwn(result, 'changed'), false, 'drop dispatch is not an outcome verdict')
  const dragEvents = fake.calls.filter(call => call.method === 'Input.dispatchDragEvent')
  assert.equal(dragEvents[0].params.type, 'dragEnter')
  assert.equal(dragEvents.at(-1).params.type, 'drop')
  assert.equal(dragEvents.at(-1).params.x, 110)
  assert.ok(dragEvents.some(call => call.params.type === 'dragOver'))
  const enterX = dragEvents[0].params.x
  assert.ok(dragEvents.slice(1).every(call => call.params.x >= enterX), 'native path stays monotonic after interception')
  const interceptionIndex = fake.calls.findIndex(call => call.method === 'Input.dispatchDragEvent')
  assert.equal(fake.calls.slice(interceptionIndex).some(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mouseMoved'), false)
  assert.equal(fake.calls.at(-2).params.type, 'mouseReleased')
  assert.equal(fake.io.listening(), false)
})

test('malformed native drag data fails honestly and still releases and disables interception', async () => {
  const fake = fakeCdp({ interceptAt: 1, data: {} })
  await assert.rejects(dispatchTrustedDrag(dispatchRequest(), fake.io), error => {
    assert.equal(error.code, 'DRAG_INTERCEPT_DATA')
    assert.equal(error.mutationPossible, true)
    return true
  })
  assert.equal(fake.calls.some(call => call.params.type === 'mouseReleased'), true)
  assert.deepEqual(fake.calls.at(-1), { method: 'Input.setInterceptDrags', params: { enabled: false } })
})

test('interception setup failure happens before input and cannot claim mutation', async () => {
  const fake = fakeCdp({ failMethod: 'Input.setInterceptDrags', failWhen: params => params.enabled })
  await assert.rejects(dispatchTrustedDrag(dispatchRequest(), fake.io), error => {
    assert.equal(error.code, 'DRAG_INPUT_FAILED')
    assert.equal(error.mutationPossible, false)
    return true
  })
  assert.equal(fake.calls.some(call => call.method === 'Input.dispatchMouseEvent'), false)
  assert.equal(fake.calls.at(-1).params.enabled, false)
})

test('press failure marks mutation possible and attempts release and cleanup', async () => {
  const fake = fakeCdp({ failMethod: 'Input.dispatchMouseEvent', failWhen: params => params.type === 'mousePressed' })
  await assert.rejects(dispatchTrustedDrag(dispatchRequest(), fake.io), error => {
    assert.equal(error.code, 'DRAG_INPUT_FAILED')
    assert.equal(error.mutationPossible, true)
    assert.equal(error.cleanupErrors, undefined, 'the compensating release and interception cleanup both succeed')
    return true
  })
  const mouse = fake.calls.filter(call => call.method === 'Input.dispatchMouseEvent')
  assert.equal(mouse.at(-1).params.type, 'mouseReleased')
  assert.equal(fake.calls.at(-1).params.enabled, false)
})

test('cleanup failure after a completed drag is not reported as clean success', async () => {
  const fake = fakeCdp({ failMethod: 'Input.setInterceptDrags', failWhen: params => !params.enabled })
  await assert.rejects(dispatchTrustedDrag(dispatchRequest(), fake.io), error => {
    assert.equal(error.code, 'DRAG_CLEANUP_FAILED')
    assert.equal(error.mutationPossible, true)
    assert.equal(error.dispatch.mode, 'pointer')
    return true
  })
})

function fakeExecution(options = {}) {
  const tab = { id: 7, title: 'Drag fixture', url: 'https://example.test/drag' }
  const before = options.before ?? measuredSnapshot()
  const after = options.after ?? measuredSnapshot({ index: 1 })
  const destinationBefore = options.destinationBefore ?? destinationSnapshot()
  const afterDestination = options.afterDestination ?? destinationSnapshot()
  const probes = []
  const commands = []
  const events = []
  let listener
  let debuggerRuns = 0
  let tabReads = 0
  let pressedMoves = 0
  const labels = options.labels ?? {
    1: { frameId: 0, localId: 11 },
    2: { frameId: 0, localId: 22 },
  }
  const io = {
    probes,
    commands,
    events,
    debuggerRuns: () => debuggerRuns,
    getActiveTab: async () => {
      tabReads += 1
      if (options.changeTabBeforeInput && tabReads > 1) return { ...tab, id: 8 }
      return tab
    },
    assertCapturable: async () => {},
    resolveLabelTarget: (_tab, label) => labels[label],
    runInFrame: async (_tabId, frameId, func, [request]) => {
      assert.equal(func, dragProbe)
      probes.push({ frameId, ...request })
      if (request.phase === 'cleanup') return { ok: true }
      if (request.phase === 'prepare' && request.side === 'source' && options.sourceProbeError) throw new Error('source probe lost')
      if (request.phase === 'prepare' && request.side === 'destination' && options.destinationProbeError) throw new Error('destination probe lost')
      if (request.phase === 'revalidate') {
        const pressed = commands.some(call => call.params.type === 'mousePressed')
        const hovered = commands.some(call => call.params.type === 'mouseMoved')
        const stale = !hovered ? options.staleBeforeHover : pressed ? options.staleBeforeDrop : options.staleBeforePress
        if (stale === request.side) return { ok: false, code: 'DRAG_STALE_TARGET', message: `${request.side} changed` }
        return { ok: true }
      }
      if (request.phase === 'after') {
        if (options.measureError) return { ok: false, code: 'DRAG_MEASURE_FAILED', message: 'measurement unavailable' }
        return { ok: true, snapshot: after, source: after, destination: afterDestination }
      }
      if (request.side === 'source') {
        return {
          ok: true,
          x: 20,
          y: 30,
          viewport: { width: 800, height: 600 },
          target: { tag: 'div', text: 'Source', native: options.native === true },
          before,
        }
      }
      const x = request.localId === undefined ? request.x : 180
      const y = request.localId === undefined ? request.y : 30
      if (x < 0 || y < 0 || x >= 800 || y >= 600) return { ok: false, code: 'DRAG_OFF_SCREEN', message: 'destination outside viewport' }
      return {
        ok: true,
        x,
        y,
        viewport: { width: 800, height: 600 },
        target: { tag: 'div', text: 'Destination' },
        before: destinationBefore,
      }
    },
    withDebugger: async (_tabId, operation) => {
      debuggerRuns += 1
      events.push('debugger')
      if (options.debuggerAttachError) throw new Error('attach failed')
      const result = await operation()
      if (options.debuggerDetachError) throw new Error('detach failed')
      return result
    },
    sendCommand: async (_tabId, method, params) => {
      commands.push({ method, params })
      if (options.failEnable && method === 'Input.setInterceptDrags' && params.enabled) throw new Error('no interception')
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && params.buttons === 1) {
        pressedMoves += 1
        if (options.native && pressedMoves === 1) listener?.({ items: [{ type: 'text/plain', data: 'payload' }] })
      }
    },
    onDragIntercepted: (_tabId, callback) => {
      listener = callback
      return () => {}
    },
    sleep: async ms => { events.push(`sleep:${ms}`) },
    framePointToTop: async (frameId, point) => ({ x: point.x + frameId * 50, y: point.y + frameId * 10 }),
  }
  return { io, tab, before, after, probes, commands, events }
}

test('executeDrag resolves label/ref aliases, destination position, and measured reorder', async () => {
  const fake = fakeExecution()
  const result = await executeDrag({ ref: 'e1', to_ref: 'e2', to_position: 'bottom' }, fake.io)
  assert.equal(result.changed, true)
  assert.equal(result.mutationPossible, true)
  assert.equal(result.drag.status, 'changed')
  assert.deepEqual(result.signals, ['index-changed'])
  assert.deepEqual(result.drag.from, { x: 20, y: 30 })
  assert.deepEqual(result.drag.to, { x: 180, y: 30 })
  const source = fake.probes.find(probe => probe.side === 'source')
  const destination = fake.probes.find(probe => probe.side === 'destination')
  assert.equal(source.localId, 11)
  assert.equal(destination.localId, 22)
  assert.equal(destination.position, 'bottom')
  assert.equal(fake.probes.at(-1).phase, 'cleanup')
  assert.equal(fake.io.debuggerRuns(), 1)
})

test('executeDrag resolves coordinate and delta destinations for evidence and revalidation', async () => {
  const coordinate = fakeExecution()
  await executeDrag({ x: 20, y: 30, to_x: 200, to_y: 90 }, coordinate.io)
  assert.equal(coordinate.probes.filter(probe => probe.phase === 'prepare').length, 2)
  assert.equal(coordinate.probes[0].x, 20)
  assert.equal(coordinate.probes[0].localId, undefined)
  assert.equal(coordinate.probes[1].x, 200)

  const delta = fakeExecution()
  const result = await executeDrag({ label: 1, dx: 40, dy: -10 }, delta.io)
  assert.deepEqual(result.drag.to, { x: 60, y: 20 })
  const destination = delta.probes.find(probe => probe.side === 'destination' && probe.phase === 'prepare')
  assert.equal(destination.localId, undefined)
  assert.equal(destination.x, 60)
  assert.equal(destination.y, 20)
})

test('executeDrag maps source, destination, and delta points from child frames before CDP', async () => {
  const labelled = fakeExecution({ labels: {
    1: { frameId: 2, localId: 11 },
    2: { frameId: 3, localId: 22 },
  } })
  const result = await executeDrag({ label: 1, to_label: 2 }, labelled.io)
  assert.deepEqual(result.drag.from, { x: 120, y: 50 })
  assert.deepEqual(result.drag.to, { x: 330, y: 60 })

  const delta = fakeExecution({ labels: { 1: { frameId: 2, localId: 11 } } })
  const moved = await executeDrag({ label: 1, dx: 40, dy: -10 }, delta.io)
  assert.deepEqual(moved.drag.from, { x: 120, y: 50 })
  assert.deepEqual(moved.drag.to, { x: 160, y: 40 })
})

test('child-frame labels fail before input when no coordinate mapper is installed', async () => {
  const fake = fakeExecution({ labels: { 1: { frameId: 2, localId: 11 } } })
  delete fake.io.framePointToTop
  await assert.rejects(executeDrag({ label: 1, dx: 10 }, fake.io), error => {
    assert.equal(error.code, 'DRAG_FRAME_UNSUPPORTED')
    assert.equal(error.mutationPossible, false)
    return true
  })
  assert.equal(fake.io.debuggerRuns(), 0)
  assert.equal(fake.probes.at(-1).phase, 'cleanup')
})

test('a fully measured no-op fails even when native drop dispatch completed', async () => {
  const fake = fakeExecution({ native: true, after: measuredSnapshot() })
  await assert.rejects(executeDrag({ label: 1, to_label: 2 }, fake.io), error => {
    assert.equal(error.code, 'DRAG_NO_EFFECT')
    assert.equal(error.mutationPossible, true)
    assert.equal(error.dispatch.mode, 'html5')
    assert.equal(error.dispatch.dropDispatched, true)
    assert.equal(error.outcome.changed, false)
    assert.equal(error.outcome.complete, true)
    return true
  })
  assert.equal(fake.probes.some(probe => probe.phase === 'after'), true)
  assert.equal(fake.probes.at(-1).phase, 'cleanup')
})

test('an unmeasurable rerender returns unknown instead of throwing no-op or claiming movement', async () => {
  const fake = fakeExecution({ after: measuredSnapshot({ connected: false, bounds: null }) })
  const result = await executeDrag({ label: 1, dx: 30 }, fake.io)
  assert.equal(result.changed, null)
  assert.equal(result.drag.status, 'unknown')
  assert.equal(result.drag.outcome.complete, false)
  assert.equal(result.mutationPossible, true)
  assert.equal(result.drag.dispatch.mode, 'pointer')
  assert.equal(result.ok, null)
})

test('a static source with a destination clone effect is changed, not a no-op', async () => {
  const fake = fakeExecution({
    native: true,
    after: measuredSnapshot(),
    afterDestination: destinationSnapshot({ children: { measured: true, signature: '[99]', truncated: false } }),
  })
  const result = await executeDrag({ label: 1, to_label: 2 }, fake.io)
  assert.equal(result.changed, true)
  assert.equal(result.ok, true)
  assert.equal(result.drag.sourceOutcome.changed, false)
  assert.equal(result.drag.destinationOutcome.changed, true)
  assert.deepEqual(result.signals, ['destination-children-changed'])
})

test('missing destination evidence stays unknown rather than proving a no-op or move', async () => {
  const fake = fakeExecution({ after: measuredSnapshot(), afterDestination: destinationSnapshot({ connected: false }) })
  const result = await executeDrag({ label: 1, to_label: 2 }, fake.io)
  assert.equal(result.changed, null)
  assert.equal(result.ok, null)
  assert.equal(result.drag.sourceOutcome.changed, false)
  assert.equal(result.drag.destinationOutcome.changed, null)
})

test('stale targets stop before hover, after hover, and before drop with distinct mutation contracts', async () => {
  const beforeHover = fakeExecution({ staleBeforeHover: 'source' })
  await assert.rejects(executeDrag({ label: 1, to_label: 2 }, beforeHover.io), error => {
    assert.equal(error.code, 'DRAG_STALE_TARGET')
    assert.equal(error.mutationPossible, false)
    return true
  })
  assert.equal(beforeHover.commands.some(call => call.params.type === 'mouseMoved'), false)

  const beforePress = fakeExecution({ staleBeforePress: 'source' })
  await assert.rejects(executeDrag({ label: 1, to_label: 2 }, beforePress.io), error => {
    assert.equal(error.code, 'DRAG_STALE_TARGET')
    assert.equal(error.mutationPossible, true, 'hover-capable input already ran')
    return true
  })
  assert.equal(beforePress.commands.some(call => call.params.type === 'mouseMoved'), true)
  assert.equal(beforePress.commands.some(call => call.params.type === 'mousePressed'), false)
  assert.equal(beforePress.probes.some(probe => probe.phase === 'after'), false)

  const beforeDrop = fakeExecution({ staleBeforeDrop: 'destination' })
  await assert.rejects(executeDrag({ label: 1, to_label: 2 }, beforeDrop.io), error => {
    assert.equal(error.code, 'DRAG_STALE_TARGET')
    assert.equal(error.mutationPossible, true)
    return true
  })
  assert.equal(beforeDrop.commands.some(call => call.params.type === 'mousePressed'), true)
  assert.equal(beforeDrop.commands.some(call => call.params.type === 'mouseReleased'), true)
  assert.equal(beforeDrop.commands.some(call => call.method === 'Input.dispatchDragEvent' && call.params.type === 'drop'), false)
  assert.equal(beforeDrop.probes.some(probe => probe.phase === 'after'), false)
})

test('lost source and destination probe responses still clean every registered frame', async () => {
  const sourceLost = fakeExecution({ sourceProbeError: true })
  await assert.rejects(executeDrag({ label: 1, to_label: 2 }, sourceLost.io), /source probe lost/)
  assert.equal(sourceLost.probes[0].phase, 'prepare')
  assert.equal(sourceLost.probes.at(-1).phase, 'cleanup')
  assert.equal(sourceLost.commands.length, 0)

  const destinationLost = fakeExecution({ destinationProbeError: true })
  await assert.rejects(executeDrag({ label: 1, to_label: 2 }, destinationLost.io), /destination probe lost/)
  assert.equal(destinationLost.probes.at(-1).phase, 'cleanup')
  assert.ok(destinationLost.probes.some(probe => probe.phase === 'prepare' && probe.side === 'source'))
  assert.equal(destinationLost.commands.length, 0)
})

test('ambiguous resolved targets fail closed before debugger input', async () => {
  const fake = fakeExecution({ labels: {
    1: [{ frameId: 0, localId: 11 }, { frameId: 2, localId: 12 }],
  } })
  await assert.rejects(executeDrag({ label: 1, dx: 10 }, fake.io), error => {
    assert.equal(error.code, 'DRAG_TARGET_AMBIGUOUS')
    assert.equal(error.mutationPossible, false)
    return true
  })
  assert.equal(fake.io.debuggerRuns(), 0)
  assert.equal(fake.probes.length, 0)
})

test('Docs guard and stale tab reject before probes or trusted input', async () => {
  const docs = fakeExecution()
  docs.tab.url = 'https://docs.google.com/document/d/abc/edit'
  await assert.rejects(executeDrag({ label: 1, dx: 10 }, docs.io), error => error.code === 'DOCS_CANVAS_SELECT_UNSUPPORTED' && error.mutationPossible === false)
  assert.equal(docs.probes.length, 0)
  assert.equal(docs.io.debuggerRuns(), 0)

  const stale = fakeExecution({ changeTabBeforeInput: true })
  await assert.rejects(executeDrag({ label: 1, dx: 10 }, stale.io), error => error.code === 'DRAG_STALE_TAB' && error.mutationPossible === false)
  assert.equal(stale.io.debuggerRuns(), 0)
  assert.equal(stale.commands.length, 0)
})

test('measurement failure after input preserves mutationPossible and never becomes unchanged', async () => {
  const fake = fakeExecution({ measureError: true })
  await assert.rejects(executeDrag({ label: 1, dx: 10 }, fake.io), error => {
    assert.equal(error.code, 'DRAG_MEASURE_FAILED')
    assert.equal(error.mutationPossible, true)
    assert.ok(error.dispatch)
    return true
  })
  assert.equal(fake.probes.at(-1).phase, 'cleanup')
})

test('driver failure before mouse input stays mutation-free through executeDrag', async () => {
  const fake = fakeExecution({ failEnable: true, native: true })
  await assert.rejects(executeDrag({ label: 1, dx: 10 }, fake.io), error => {
    assert.equal(error.code, 'DRAG_INPUT_FAILED')
    assert.equal(error.mutationPossible, false)
    return true
  })
  assert.equal(fake.probes.some(probe => probe.phase === 'after'), false)
  assert.equal(fake.probes.at(-1).phase, 'cleanup')
})

test('off-screen destinations fail before debugger input', async () => {
  const fake = fakeExecution()
  await assert.rejects(executeDrag({ label: 1, to_x: 900, to_y: 30 }, fake.io), error => {
    assert.equal(error.code, 'DRAG_OFF_SCREEN')
    assert.equal(error.mutationPossible, false)
    return true
  })
  assert.equal(fake.io.debuggerRuns(), 0)
  assert.equal(fake.commands.length, 0)
  assert.equal(fake.probes.at(-1).phase, 'cleanup')
})

test('debugger attach and detach failures retain their distinct mutation contracts', async () => {
  const attach = fakeExecution({ debuggerAttachError: true })
  await assert.rejects(executeDrag({ label: 1, dx: 10 }, attach.io), error => {
    assert.match(error.message, /attach failed/)
    assert.equal(error.mutationPossible, false)
    return true
  })
  assert.equal(attach.commands.length, 0)

  const detach = fakeExecution({ debuggerDetachError: true })
  await assert.rejects(executeDrag({ label: 1, dx: 10 }, detach.io), error => {
    assert.match(error.message, /detach failed/)
    assert.equal(error.mutationPossible, true)
    return true
  })
  assert.equal(detach.commands.some(call => call.params.type === 'mouseReleased'), true)
  assert.equal(detach.probes.some(probe => probe.phase === 'after'), false)
  assert.equal(detach.probes.at(-1).phase, 'cleanup')
})

function installProbeDom(t, options = {}) {
  const previous = new Map()
  for (const key of ['document', 'window', '__crazyagent', '__crazyagentDragSessions', '__crazyagentDragIdentities']) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  }
  const parent = { children: [] }
  const attributes = new Map(Object.entries(options.attributes ?? {}))
  const rect = options.rect ?? box(20, 30, 60, 24)
  const source = {
    tagName: 'DIV',
    textContent: 'Probe item',
    isConnected: true,
    parentElement: parent,
    children: [],
    disabled: options.disabled === true,
    type: '',
    value: options.value,
    getBoundingClientRect: () => rect,
    getAttribute: name => attributes.has(name) ? attributes.get(name) : null,
    matches: selector => selector === ':disabled' && options.disabled === true,
    contains: candidate => candidate === source,
    getRootNode: () => ({}),
  }
  parent.children.push(source)
  const selection = {
    text: '',
    isCollapsed: true,
    rangeCount: 0,
    toString() { return this.text },
  }
  const document = {
    elementFromPoint: () => options.covered ? { contains: () => false, getRootNode: () => ({}) } : source,
    getSelection: () => selection,
  }
  source.ownerDocument = document
  const window = { innerWidth: 800, innerHeight: 600 }
  window.top = window
  Object.assign(globalThis, {
    document,
    window,
    __crazyagent: {
      byId: new Map([[11, source]]),
      infoById: new Map([[11, { tag: 'div', text: 'Probe item' }]]),
    },
  })
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  return { source, parent, attributes, rect, selection }
}

test('self-contained probe prepares labels, measures real state, and evaluates after mutations', t => {
  const dom = installProbeDom(t, { value: '20', attributes: { 'aria-valuenow': '20', 'aria-label': 'Probe slider' } })
  const prepared = dragProbe({ phase: 'prepare', side: 'source', token: 'probe-one', localId: 11 })
  assert.equal(prepared.ok, true)
  assert.equal(prepared.x, 50)
  assert.equal(prepared.y, 42)
  assert.equal(prepared.coordinateSpace, 'top')
  assert.equal(prepared.before.parent !== null, true)
  assert.equal(prepared.before.value.value, '20')
  assert.equal(prepared.before.ariaValueNow.value, '20')

  dom.parent.children.unshift({})
  dom.rect.left = 28
  dom.rect.right = 88
  dom.source.value = '75'
  dom.attributes.set('aria-valuenow', '75')
  dom.selection.text = 'selected text'
  dom.selection.isCollapsed = false
  dom.selection.rangeCount = 1
  const measured = dragProbe({ phase: 'after', token: 'probe-one' })
  const outcome = evaluateDragOutcome(prepared.before, measured.snapshot)
  assert.equal(outcome.changed, true)
  assert.ok(outcome.signals.includes('index-changed'))
  assert.ok(outcome.signals.includes('bounds-changed'))
  assert.ok(outcome.signals.includes('value-changed'))
  assert.ok(outcome.signals.includes('aria-valuenow-changed'))
  assert.ok(outcome.signals.includes('selection-changed'))
  assert.deepEqual(dragProbe({ phase: 'cleanup', token: 'probe-one' }), { ok: true })
})

test('probe resolves coordinate sources and all labelled destination positions', t => {
  installProbeDom(t)
  for (const [position, expected] of Object.entries({
    center: { x: 50, y: 42 },
    left: { x: 28, y: 42 },
    right: { x: 72, y: 42 },
    top: { x: 50, y: 36 },
    bottom: { x: 50, y: 48 },
  })) {
    const result = dragProbe({ phase: 'prepare', side: 'destination', token: `position-${position}`, localId: 11, position })
    assert.equal(result.ok, true, position)
    assert.deepEqual({ x: result.x, y: result.y }, expected, position)
  }
  const coordinate = dragProbe({ phase: 'prepare', side: 'source', token: 'coordinate', x: 50, y: 42 })
  assert.equal(coordinate.ok, true)
  assert.equal(coordinate.before.connected, true)
})

test('probe reports detached rerenders as unknown and refuses stale, disabled, or covered starts', t => {
  const dom = installProbeDom(t)
  const prepared = dragProbe({ phase: 'prepare', side: 'source', token: 'rerender', localId: 11 })
  dom.source.isConnected = false
  const after = dragProbe({ phase: 'after', token: 'rerender' })
  assert.equal(evaluateDragOutcome(prepared.before, after.snapshot).changed, null)
  assert.equal(dragProbe({ phase: 'prepare', side: 'source', token: 'stale', localId: 11 }).code, 'DETACHED')
  assert.equal(dragProbe({ phase: 'prepare', side: 'source', token: 'missing', localId: 99 }).code, 'UNKNOWN_LABEL')
  dragProbe({ phase: 'cleanup', token: 'rerender' })
})

test('probe refuses disabled, covered, and off-screen targets before a session starts', async t => {
  const disabled = installProbeDom(t, { disabled: true })
  assert.equal(dragProbe({ phase: 'prepare', side: 'source', token: 'disabled', localId: 11 }).code, 'DISABLED')
  assert.equal(globalThis.__crazyagentDragSessions.has('disabled'), false)
  void disabled
})

test('probe covered target is obscured', t => {
  installProbeDom(t, { covered: true })
  assert.equal(dragProbe({ phase: 'prepare', side: 'source', token: 'covered', localId: 11 }).code, 'OBSCURED')
})

test('probe off-screen target is rejected', t => {
  installProbeDom(t, { rect: box(-100, 30, 60, 24) })
  assert.equal(dragProbe({ phase: 'prepare', side: 'source', token: 'offscreen', localId: 11 }).code, 'DRAG_OFF_SCREEN')
})
