import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clickRole,
  normalizeRoleClickName,
  parseRoleClickArgs,
  roleClickFrameOwnershipProbe,
  roleClickTransition,
} from '../sidepanel/role-click.js'

const URL = 'https://example.test/start'
const OTHER_URL = 'https://example.test/next'
const blankState = () => ({ checked: null, selected: null, expanded: null, pressed: null, current: null })
const control = (id, role, name, extra = {}) => ({
  id,
  role,
  name,
  x: 20,
  y: 30,
  coordinateSpace: 'top',
  disabled: false,
  covered: false,
  hidden: false,
  editor: false,
  state: blankState(),
  ...extra,
})

function fakeRoleClick(options = {}) {
  const state = {
    now: 1_000,
    tab: { id: 7, url: URL, title: 'Start' },
    activeTab: undefined,
    frames: options.frames ?? [{ frameId: 0 }],
    nodes: options.nodes ?? { 0: [] },
    surfaces: options.surfaces ?? 0,
    pending: [],
  }
  const events = []
  const clicks = []
  const snapshots = []
  const invalidations = []
  let driverAccess = 0
  let activeTabs = 0
  const addPending = fake => {
    const ready = state.pending.filter(item => state.now >= item.at)
    state.pending = state.pending.filter(item => state.now < item.at)
    for (const item of ready) {
      if (item.url) {
        state.tab = { ...state.tab, url: item.url, status: item.status }
        continue
      }
      state.nodes[item.frameId].push(item.node)
      if (item.surface) state.surfaces += 1
    }
  }
  const matches = (frameId, step) => (state.nodes[frameId] ?? [])
    .filter(node => !node.hidden && node.role === step.role && normalizeRoleClickName(node.name) === step.name)
    .map(node => ({
      role: node.role,
      name: normalizeRoleClickName(node.name),
      identity: node.id,
      x: node.x,
      y: node.y,
      coordinateSpace: node.coordinateSpace,
      disabled: node.disabled,
      covered: node.covered,
      editor: node.editor,
      state: { ...node.state },
    }))
  const fake = {
    state,
    events,
    clicks,
    snapshots,
    invalidations,
    activeTabs: () => activeTabs,
    schedule(frameId, node, delayMs, surface = false) {
      state.pending.push({ frameId, node, at: state.now + delayMs, surface })
    },
    scheduleNavigation(url, delayMs, status = 'complete') {
      state.pending.push({ url, status, at: state.now + delayMs })
    },
  }
  fake.io = {
    now: () => state.now,
    sleep: async ms => {
      state.now += ms
      addPending(fake)
    },
    getWindowId: async () => {
      driverAccess += 1
      activeTabs += 1
      return 1
    },
    getActiveTab: async () => ({ ...(state.activeTab ?? state.tab) }),
    getTab: async () => ({ ...state.tab }),
    assertCapturable: tab => {
      if (tab.id !== 7) throw new Error('wrong tab')
    },
    listFrames: async () => state.frames.map(frame => ({
      ...frame,
      ...(frame.frameId !== 0 ? { ownershipToken: frame.ownershipToken ?? 'test-token' } : {}),
    })),
    runInFrame: async (_tabId, frameId, func, [request]) => {
      if (func === roleClickFrameOwnershipProbe) {
        events.push(`ownership:${frameId}:${request.targetFrameId}`)
        if (options.ownershipError === frameId) throw new Error(`owner frame ${frameId} unavailable`)
        const overridden = await options.onOwnership?.(fake, frameId, request)
        const covered = (state.nodes[request.targetFrameId] ?? []).some(node => node.ancestorCovered)
        return { ok: true, owned: overridden ?? !covered }
      }
      events.push(`probe:${frameId}:${request.role}:${request.name}`)
      if (options.probeError === frameId) throw new Error(`frame ${frameId} unavailable`)
      options.onProbe?.(fake, frameId, request)
      addPending(fake)
      return {
        ok: true,
        url: frameId === 0 ? state.tab.url : URL,
        matches: matches(frameId, request),
        nextMatches: request.next ? matches(frameId, request.next) : [],
        surfaceCount: state.surfaces,
      }
    },
    withDebugger: async (_tabId, fn) => fn(),
    trustedClick: async (_tabId, x, y, hooks) => {
      events.push(`move:${x}:${y}`)
      await options.onMouseMove?.(fake)
      await options.beforeRevalidate?.(fake)
      if (await hooks.beforePress() === false) throw new Error('stale fake target')
      let found
      for (const frame of state.frames) {
        for (const node of state.nodes[frame.frameId] ?? []) {
          if (node.hidden) continue
          const nodeX = node.x + (node.coordinateSpace === 'frame' ? frame.viewportX : 0)
          const nodeY = node.y + (node.coordinateSpace === 'frame' ? frame.viewportY : 0)
          if (nodeX === x && nodeY === y) found = node
        }
      }
      hooks.onPress()
      events.push(`press:${x}:${y}`)
      if (options.neverSettle) await new Promise(() => {})
      if (!found) throw new Error(`no fake target at ${x},${y}`)
      await options.beforeRelease?.(fake)
      events.push(`release:${x}:${y}`)
      clicks.push({ id: found.id, x, y })
      found.onClick?.(fake, found)
      options.onClick?.(fake, found)
    },
    invalidateTab: tabId => { invalidations.push(tabId) },
    snapshot: async (_settings, tab) => {
      events.push('snapshot')
      snapshots.push(tab)
      if (options.snapshotError) throw new Error('snapshot unavailable')
      return { view: 'full', image: { data: 'fresh' }, tab: { ...tab } }
    },
  }
  return fake
}

const run = (fake, path) => clickRole({ showHitboxes: true }, { path }, { driver: fake.io })

test('role-click validation is complete before any driver or tab access', async () => {
  const fake = fakeRoleClick()
  const rejected = [
    undefined,
    {},
    { path: [] },
    { path: [{ role: 'button', name: 'A' }], surprise: true },
    { path: [{ role: 'button', name: 'A', surprise: true }] },
    { path: [{ role: 'Button', name: 'A' }] },
    { path: [{ role: 'textbox', name: 'A' }] },
    { path: [{ role: 'button', name: ' \n ' }] },
    { path: [{ role: 'button' }] },
    { path: [{ name: 'A' }] },
    { path: Array.from({ length: 5 }, () => ({ role: 'button', name: 'A' })) },
  ]
  for (const args of rejected) await assert.rejects(clickRole({}, args, fake.io))
  assert.equal(fake.activeTabs(), 0)
  assert.equal(fake.events.length, 0)
  assert.equal(fake.snapshots.length, 0)
})

test('role-click parsing normalizes whitespace without changing case', () => {
  assert.equal(normalizeRoleClickName('  Open \n the\tMenu '), 'Open the Menu')
  assert.deepEqual(parseRoleClickArgs({ path: [{ role: 'button', name: '  Open \n Menu ' }] }), [
    { role: 'button', name: 'Open Menu' },
  ])
})

test('role-click requires an exact case-sensitive accessible name', async () => {
  const fake = fakeRoleClick({ nodes: { 0: [control('file', 'button', 'File')] } })
  await assert.rejects(run(fake, [{ role: 'button', name: 'file' }]), error => {
    assert.match(error.code, /ROLE_CLICK_(?:NOT_FOUND|STEP_TIMEOUT)/)
    return true
  })
  assert.equal(fake.clicks.length, 0)
  assert.equal(fake.snapshots.length, 0)
})

test('role-click resolves every path step afresh and returns one full snapshot', async () => {
  const file = control('file', 'button', '  File\n Menu ', {
    onClick(fake, node) {
      node.state.expanded = 'true'
      fake.state.surfaces += 1
      fake.state.nodes[0].push(control('export', 'menuitem', 'Export', {
        x: 40,
        onClick(innerFake, item) {
          innerFake.state.nodes[0] = innerFake.state.nodes[0].filter(candidate => candidate !== item)
          innerFake.state.surfaces -= 1
        },
      }))
    },
  })
  const fake = fakeRoleClick({ nodes: { 0: [file] } })
  const result = await run(fake, [
    { role: 'button', name: ' File   Menu ' },
    { role: 'menuitem', name: 'Export' },
  ])
  assert.equal(result.op, 'click_role')
  assert.equal(result.view, 'full')
  assert.deepEqual(result.roleClick, {
    status: 'completed',
    completed: 2,
    path: [{ role: 'button', name: 'File Menu' }, { role: 'menuitem', name: 'Export' }],
  })
  assert.deepEqual(fake.clicks.map(click => click.id), ['file', 'export'])
  assert.deepEqual(fake.invalidations, [7, 7])
  assert.equal(fake.snapshots.length, 1)
  assert.ok(fake.events.filter(event => event.includes(':button:File Menu')).length >= 2)
})

test('visible duplicates remain ambiguous even when one is disabled', async () => {
  const fake = fakeRoleClick({ nodes: { 0: [
    control('one', 'button', 'Save', { disabled: true }),
    control('two', 'button', 'Save', { x: 80 }),
  ] } })
  await assert.rejects(run(fake, [{ role: 'button', name: 'Save' }]), error => {
    assert.equal(error.code, 'ROLE_CLICK_AMBIGUOUS')
    assert.equal(error.matchCount, 2)
    return true
  })
  assert.equal(fake.clicks.length, 0)
  assert.equal(fake.snapshots.length, 0)
})

test('a single disabled target is never clicked', async () => {
  const fake = fakeRoleClick({ nodes: { 0: [control('save', 'button', 'Save', { disabled: true })] } })
  await assert.rejects(run(fake, [{ role: 'button', name: 'Save' }]), error => error.code === 'ROLE_CLICK_DISABLED')
  assert.equal(fake.clicks.length, 0)
})

test('hidden duplicates do not make a visible exact target ambiguous', async () => {
  const visible = control('visible', 'button', 'Save', {
    onClick(_fake, node) { node.state.pressed = 'true' },
  })
  const fake = fakeRoleClick({ nodes: { 0: [visible, control('hidden', 'button', 'Save', { hidden: true })] } })
  const result = await run(fake, [{ role: 'button', name: 'Save' }])
  assert.equal(result.roleClick.status, 'completed')
  assert.deepEqual(fake.clicks.map(click => click.id), ['visible'])
})

test('a covered target is refused instead of clicking the covering element', async () => {
  const fake = fakeRoleClick({ nodes: { 0: [control('save', 'button', 'Save', { covered: true })] } })
  await assert.rejects(run(fake, [{ role: 'button', name: 'Save' }]), error => error.code === 'ROLE_CLICK_COVERED')
  assert.equal(fake.clicks.length, 0)
  assert.equal(fake.snapshots.length, 0)
})

test('delayed menu contents are re-probed within the step budget', async () => {
  const file = control('file', 'button', 'File', {
    onClick(fake, node) {
      node.state.expanded = 'true'
      fake.schedule(0, control('export', 'menuitem', 'Export', {
        x: 40,
        onClick(innerFake, item) {
          innerFake.state.nodes[0] = innerFake.state.nodes[0].filter(candidate => candidate !== item)
        },
      }), 120, true)
    },
  })
  const fake = fakeRoleClick({ nodes: { 0: [file] } })
  const result = await run(fake, [{ role: 'button', name: 'File' }, { role: 'menuitem', name: 'Export' }])
  assert.equal(result.roleClick.status, 'completed')
  assert.ok(fake.state.now >= 1_120)
  assert.ok(fake.events.filter(event => event.endsWith(':menuitem:Export')).length >= 3)
  assert.deepEqual(fake.clicks.map(click => click.id), ['file', 'export'])
  assert.equal(fake.snapshots.length, 1)
})

test('partial results name only the verified applied prefix', async () => {
  const file = control('file', 'button', 'File', {
    onClick(fake, node) {
      fake.state.nodes[0] = fake.state.nodes[0].filter(candidate => candidate !== node)
    },
  })
  const fake = fakeRoleClick({ nodes: { 0: [file] } })
  const result = await run(fake, [{ role: 'button', name: 'File' }, { role: 'menuitem', name: 'Missing' }])
  assert.equal(result.roleClick.status, 'partial')
  assert.equal(result.roleClick.completed, 1)
  assert.deepEqual(result.roleClick.path, [{ role: 'button', name: 'File' }])
  assert.equal(result.roleClick.failure.index, 1)
  assert.equal(result.roleClick.failure.name, 'Missing')
  assert.equal(result.roleClick.failure.dispatchAttempted, undefined)
  assert.deepEqual(fake.clicks.map(click => click.id), ['file'])
  assert.deepEqual(fake.invalidations, [7])
  assert.equal(fake.snapshots.length, 1)
})

test('intermediate navigation stops the path and is reported', async () => {
  const open = control('open', 'link', 'Open', {
    onClick(fake) { fake.state.tab = { ...fake.state.tab, url: OTHER_URL } },
  })
  const fake = fakeRoleClick({ nodes: { 0: [open] } })
  const result = await run(fake, [{ role: 'link', name: 'Open' }, { role: 'button', name: 'Next' }])
  assert.equal(result.roleClick.status, 'partial')
  assert.equal(result.roleClick.completed, 0)
  assert.equal(result.roleClick.failure.code, 'ROLE_CLICK_INTERMEDIATE_NAVIGATION')
  assert.equal(result.navigated, true)
  assert.equal(fake.clicks.length, 1)
  assert.equal(fake.snapshots.length, 1)
})

test('stale navigation discovered during resolution prevents the first click', async () => {
  let changed = false
  const fake = fakeRoleClick({
    nodes: { 0: [control('save', 'button', 'Save')] },
    onProbe(innerFake) {
      if (changed) return
      changed = true
      innerFake.state.tab = { ...innerFake.state.tab, url: OTHER_URL }
    },
  })
  await assert.rejects(run(fake, [{ role: 'button', name: 'Save' }]), error => {
    assert.equal(error.code, 'ROLE_CLICK_STALE_NAVIGATION')
    assert.equal(error.navigated, true)
    return true
  })
  assert.equal(fake.clicks.length, 0)
})

test('one frame probe failure rejects an otherwise unique target in another frame', async () => {
  const fake = fakeRoleClick({
    frames: [{ frameId: 0 }, { frameId: 2, viewportX: 100, viewportY: 50 }],
    nodes: { 0: [control('save', 'button', 'Save')], 2: [] },
    probeError: 2,
  })
  await assert.rejects(run(fake, [{ role: 'button', name: 'Save' }]), error => {
    assert.equal(error.code, 'ROLE_CLICK_FRAME_PROBE')
    assert.equal(error.frameId, 2)
    return true
  })
  assert.equal(fake.clicks.length, 0)
  assert.equal(fake.snapshots.length, 0)
})

test('editor and document-content targets are refused before dispatch', async () => {
  const fake = fakeRoleClick({ nodes: { 0: [control('edit', 'button', 'Edit', { editor: true })] } })
  await assert.rejects(run(fake, [{ role: 'button', name: 'Edit' }]), error => error.code === 'ROLE_CLICK_EDITOR')
  assert.equal(fake.clicks.length, 0)
  assert.equal(fake.invalidations.length, 0)
})

test('final navigation is allowed and reported', async () => {
  const open = control('open', 'link', 'Open', {
    onClick(fake) { fake.state.tab = { ...fake.state.tab, url: OTHER_URL } },
  })
  const fake = fakeRoleClick({ nodes: { 0: [open] } })
  const result = await run(fake, [{ role: 'link', name: 'Open' }])
  assert.equal(result.roleClick.status, 'completed')
  assert.equal(result.roleClick.completed, 1)
  assert.equal(result.navigated, true)
  assert.equal(result.tab.url, OTHER_URL)
  assert.equal(fake.snapshots.length, 1)
})

test('final input failure remains partial even when navigation is observed', async () => {
  const open = control('open', 'link', 'Open', {
    onClick(fake) {
      fake.state.tab = { ...fake.state.tab, url: OTHER_URL }
      throw new Error('mouse release failed')
    },
  })
  const fake = fakeRoleClick({ nodes: { 0: [open] } })
  const result = await run(fake, [{ role: 'link', name: 'Open' }])
  assert.equal(result.roleClick.status, 'partial')
  assert.equal(result.roleClick.completed, 0)
  assert.deepEqual(result.roleClick.path, [])
  assert.equal(result.roleClick.failure.code, 'ROLE_CLICK_INPUT')
  assert.equal(result.roleClick.failure.dispatchAttempted, true)
  assert.equal(result.navigated, true)
  assert.equal(fake.clicks.length, 1)
  assert.equal(fake.snapshots.length, 1)
})

test('child-frame clicks require and apply a top-viewport coordinate offset', async () => {
  const open = control('open', 'button', 'Open', {
    coordinateSpace: 'frame',
    onClick(_fake, node) { node.state.pressed = 'true' },
  })
  const fake = fakeRoleClick({
    frames: [{ frameId: 0 }, { frameId: 2, viewportX: 100, viewportY: 50 }],
    nodes: { 0: [], 2: [open] },
  })
  const result = await run(fake, [{ role: 'button', name: 'Open' }])
  assert.equal(result.roleClick.status, 'completed')
  assert.deepEqual(fake.clicks, [{ id: 'open', x: 120, y: 80 }])
})

test('child-frame targets fail closed without verified coordinates', async () => {
  const fake = fakeRoleClick({
    frames: [{ frameId: 0 }, { frameId: 2 }],
    nodes: { 0: [], 2: [control('open', 'button', 'Open', { coordinateSpace: 'frame' })] },
  })
  await assert.rejects(run(fake, [{ role: 'button', name: 'Open' }]), error => error.code === 'ROLE_CLICK_FRAME_COORDINATES')
  assert.equal(fake.clicks.length, 0)
})

test('final trusted dispatch succeeds without an app transition or a 3s wait', async () => {
  const fake = fakeRoleClick({ nodes: { 0: [control('save', 'button', 'Save')] } })
  const result = await run(fake, [{ role: 'button', name: 'Save' }])
  assert.equal(result.roleClick.status, 'completed')
  assert.equal(result.roleClick.completed, 1)
  assert.deepEqual(result.roleClick.path, [{ role: 'button', name: 'Save' }])
  assert.equal(fake.state.now, 1_100)
  assert.equal(fake.events.filter(event => event === 'probe:0:button:Save').length, 2)
  assert.equal(fake.clicks.length, 1)
  assert.deepEqual(fake.invalidations, [7])
  assert.equal(fake.snapshots.length, 1)
})

test('an intermediate step still requires observable progression', async () => {
  const fake = fakeRoleClick({ nodes: { 0: [
    control('save', 'button', 'Save'),
    control('next', 'button', 'Next', { x: 100 }),
  ] } })
  const result = await run(fake, [
    { role: 'button', name: 'Save' },
    { role: 'button', name: 'Next' },
  ])
  assert.equal(result.roleClick.status, 'partial')
  assert.equal(result.roleClick.completed, 0)
  assert.deepEqual(result.roleClick.path, [])
  assert.match(result.roleClick.failure.code, /ROLE_CLICK_(?:UNVERIFIED|STEP_TIMEOUT)/)
  assert.equal(result.roleClick.failure.dispatchAttempted, true)
  assert.ok(fake.state.now >= 4_000)
  assert.deepEqual(fake.clicks.map(click => click.id), ['save'])
  assert.equal(fake.snapshots.length, 1)
})

test('transition verification uses target state and newly available next controls', () => {
  const candidate = {
    frameId: 0,
    identity: 'file',
    disabled: false,
    covered: false,
    state: blankState(),
  }
  const before = { candidate, matches: [candidate], nextMatches: [], surfaceCount: 0 }
  assert.equal(roleClickTransition(before, { matches: [candidate], nextMatches: [], surfaceCount: 0 }), false)
  assert.equal(roleClickTransition(before, {
    matches: [{ ...candidate, state: { ...blankState(), expanded: 'true' } }],
    nextMatches: [],
    surfaceCount: 0,
  }), true)
  assert.equal(roleClickTransition(before, { matches: [candidate], nextMatches: [{}], surfaceCount: 0 }), true)
  assert.equal(roleClickTransition(before, { matches: [], nextMatches: [], surfaceCount: 0 }), true)
})

test('hover revalidation refuses identity, exact role/name, position, and hit changes without pressing', async () => {
  const cases = [
    ['identity', node => { node.id = 'replacement' }, 'ROLE_CLICK_STALE_TARGET'],
    ['name', node => { node.name = 'Other' }, 'ROLE_CLICK_STALE_TARGET'],
    ['role', node => { node.role = 'link' }, 'ROLE_CLICK_STALE_TARGET'],
    ['position', node => { node.x += 1 }, 'ROLE_CLICK_STALE_TARGET'],
    ['hit ownership', node => { node.covered = true }, 'ROLE_CLICK_COVERED'],
  ]
  for (const [label, mutate, code] of cases) {
    const node = control('save', 'button', 'Save')
    const fake = fakeRoleClick({
      nodes: { 0: [node] },
      onMouseMove() { mutate(node) },
    })
    await assert.rejects(run(fake, [{ role: 'button', name: 'Save' }]), error => {
      assert.equal(error.code, code, label)
      return true
    })
    assert.equal(fake.events.some(event => event.startsWith('press:')), false, label)
    assert.equal(fake.clicks.length, 0, label)
    assert.equal(fake.snapshots.length, 0, label)
  }
})

test('ancestor and top ownership is required initially and after hover', async () => {
  for (const hover of [false, true]) {
    const node = control('open', 'button', 'Open', {
      coordinateSpace: 'frame',
      ancestorCovered: !hover,
    })
    const fake = fakeRoleClick({
      frames: [{ frameId: 0 }, { frameId: 2, viewportX: 100, viewportY: 50 }],
      nodes: { 0: [], 2: [node] },
      onMouseMove() { if (hover) node.ancestorCovered = true },
    })
    await assert.rejects(run(fake, [{ role: 'button', name: 'Open' }]), error => error.code === 'ROLE_CLICK_COVERED')
    assert.ok(fake.events.some(event => event === 'ownership:0:2'))
    assert.equal(fake.events.some(event => event.startsWith('press:')), false)
    assert.equal(fake.clicks.length, 0)
  }
})

test('a delayed before-press callback observes cancellation and no click lands after return', async () => {
  const fake = fakeRoleClick({
    nodes: { 0: [control('save', 'button', 'Save')] },
    beforeRevalidate: innerFake => innerFake.io.sleep(4_000),
  })
  await assert.rejects(run(fake, [{ role: 'button', name: 'Save' }]), error => {
    assert.equal(error.code, 'ROLE_CLICK_STEP_TIMEOUT')
    assert.notEqual(error.dispatchAttempted, true)
    return true
  })
  assert.equal(fake.events.some(event => event.startsWith('press:')), false)
  assert.equal(fake.clicks.length, 0)
  assert.equal(fake.snapshots.length, 0)
  await fake.io.sleep(100)
  assert.equal(fake.clicks.length, 0)
})

test('an in-flight release settles before timeout evidence and snapshot are returned', async () => {
  const fake = fakeRoleClick({
    nodes: { 0: [control('save', 'button', 'Save')] },
    beforeRelease: innerFake => innerFake.io.sleep(3_500),
  })
  const result = await run(fake, [{ role: 'button', name: 'Save' }])
  assert.equal(result.roleClick.status, 'partial')
  assert.equal(result.roleClick.completed, 0)
  assert.equal(result.roleClick.failure.code, 'ROLE_CLICK_STEP_TIMEOUT')
  assert.equal(result.roleClick.failure.dispatchAttempted, true)
  assert.equal(fake.clicks.length, 1)
  assert.ok(fake.events.indexOf('release:20:30') < fake.events.indexOf('snapshot'))
})

test('input that cannot settle returns explicit unsettled mutation evidence', { timeout: 5_000 }, async () => {
  const fake = fakeRoleClick({
    nodes: { 0: [control('save', 'button', 'Save')] },
    neverSettle: true,
  })
  await assert.rejects(run(fake, [{ role: 'button', name: 'Save' }]), error => {
    assert.equal(error.code, 'ROLE_CLICK_UNSETTLED')
    assert.equal(error.unsettled, true)
    assert.equal(error.dispatchAttempted, true)
    return true
  })
  assert.equal(fake.events.some(event => event.startsWith('press:')), true)
  assert.equal(fake.events.some(event => event.startsWith('release:')), false)
  assert.equal(fake.snapshots.length, 0)
})

test('snapshot failure preserves completed dispatch evidence and an unavailable view', async () => {
  const fake = fakeRoleClick({
    nodes: { 0: [control('save', 'button', 'Save')] },
    snapshotError: true,
  })
  const result = await run(fake, [{ role: 'button', name: 'Save' }])
  assert.equal(result.op, 'click_role')
  assert.equal(result.view, 'unavailable')
  assert.equal(result.viewUnavailable.code, 'ROLE_CLICK_SNAPSHOT')
  assert.match(result.viewUnavailable.message, /snapshot unavailable/)
  assert.deepEqual(result.roleClick, {
    status: 'completed',
    completed: 1,
    path: [{ role: 'button', name: 'Save' }],
  })
  assert.equal(fake.clicks.length, 1)
})

test('final delayed navigation settles before the snapshot without requiring an app outcome', async () => {
  const open = control('open', 'link', 'Open', {
    onClick(fake) {
      fake.scheduleNavigation(OTHER_URL, 75, 'loading')
      fake.scheduleNavigation(OTHER_URL, 150, 'complete')
    },
  })
  const fake = fakeRoleClick({ nodes: { 0: [open] } })
  const result = await run(fake, [{ role: 'link', name: 'Open' }])
  assert.equal(result.roleClick.status, 'completed')
  assert.equal(result.navigated, true)
  assert.equal(result.tab.url, OTHER_URL)
  assert.equal(fake.snapshots[0].url, OTHER_URL)
  assert.equal(fake.state.now, 1_150)
})

test('persistent final loading remains bounded and does not change dispatch completion', async () => {
  const open = control('open', 'link', 'Open', {
    onClick(fake) { fake.scheduleNavigation(OTHER_URL, 0, 'loading') },
  })
  const fake = fakeRoleClick({ nodes: { 0: [open] } })
  const result = await run(fake, [{ role: 'link', name: 'Open' }])
  assert.equal(result.roleClick.status, 'completed')
  assert.equal(result.roleClick.completed, 1)
  assert.equal(result.navigated, true)
  assert.equal(result.tab.url, OTHER_URL)
  assert.equal(result.tab.status, 'loading')
  assert.equal(fake.state.now, 3_100)
})
