import test from 'node:test'
import assert from 'node:assert/strict'
import { docsPageSetup } from '../sidepanel/browser.js'

const URL = 'https://docs.google.com/document/d/abc/edit'
const REQUEST = {
  action: 'page_setup',
  paper_size: 'Letter',
  orientation: 'portrait',
  margins: { Top: 1, Bottom: 1, Left: 1, Right: 1 },
}

function fakePageSetup(options = {}) {
  const state = {
    fileOpen: false,
    open: options.open === true,
    paperSize: options.paperSize ?? 'Letter',
    portrait: options.orientation ? options.orientation === 'portrait' : true,
    landscape: options.orientation === 'landscape',
    margins: Object.fromEntries(['Top', 'Bottom', 'Left', 'Right'].map(side => [side, {
      value: String(options.margin ?? 1), focused: false, point: { x: 20, y: 20 },
    }])),
    okPoint: { x: 7, y: 20 },
  }
  const events = []
  let snapshots = 0
  let activeTabs = 0
  let now = 1000
  const tab = { id: 7, url: URL }
  const io = {
    now: () => now,
    sleep: async ms => { now += ms },
    getWindowId: async () => 1,
    getActiveTab: async () => { activeTabs += 1; return { ...tab } },
    getTab: async () => ({ ...tab }),
    withDebugger: async (_tabId, fn) => fn(),
    trustedClick: async (_tabId, x) => {
      events.push(`click:${x}`)
      if (x === 1) state.fileOpen = true
      else if (x === 2) {
        state.open = true
        state.fileOpen = false
      } else if (x === 4) state.paperSize = 'Letter'
      else if (x === 5) {
        state.portrait = true
        state.landscape = false
      } else if (x === 6) {
        state.portrait = false
        state.landscape = true
      } else if (x === 7) {
        if (options.okFailsOnce && !state.okRetried) state.okRetried = true
        else state.open = false
      }
    },
    runInTab: async (_tabId, _func, [command, args]) => {
      events.push(`probe:${command}${args?.side ? `:${args.side}` : ''}`)
      if (command === 'fileMenu') return { ok: true, present: true, disabled: false, point: { x: 1, y: 20 } }
      if (command === 'pageSetupMenuItem') return { ok: true, present: state.fileOpen, disabled: false, point: state.fileOpen ? { x: 2, y: 20 } : undefined }
      if (command === 'pageSetup') return {
        ok: true,
        open: state.open,
        paperSize: state.paperSize,
        paperPoint: { x: 3, y: 20 },
        portrait: state.portrait,
        portraitPoint: { x: 5, y: 20 },
        landscape: state.landscape,
        landscapePoint: { x: 6, y: 20 },
        margins: state.margins,
        okPoint: state.okPoint,
      }
      if (command === 'pagePaperMenu') return { ok: true, point: { x: 4, y: 20 } }
      if (command === 'setPageMargin') {
        if (options.failMargin) return { ok: true, readback: false, value: state.margins[args.side].value }
        state.margins[args.side].value = args.value
        return { ok: true, readback: true, value: args.value }
      }
      throw new Error(`unexpected probe ${command}`)
    },
    snapshot: async () => {
      snapshots += 1
      return { op: 'snapshot', view: 'full' }
    },
  }
  return { io, state, events, snapshots: () => snapshots, activeTabs: () => activeTabs }
}

test('Docs page setup changes and verifies paper, orientation, and every margin before OK', async () => {
  const fake = fakePageSetup({ paperSize: 'A4', orientation: 'landscape', margin: 0.5 })
  const result = await docsPageSetup({}, REQUEST, fake.io)
  assert.equal(result.docs.action, 'page_setup')
  assert.equal(result.docs.status, 'completed')
  assert.equal(result.docs.verifiedBy, 'page-setup-dialog')
  assert.equal(fake.state.paperSize, 'Letter')
  assert.equal(fake.state.portrait, true)
  assert.deepEqual(Object.values(fake.state.margins).map(field => field.value), ['1', '1', '1', '1'])
  assert.deepEqual(fake.events.filter(event => event.startsWith('probe:setPageMargin')), [
    'probe:setPageMargin:Top', 'probe:setPageMargin:Bottom', 'probe:setPageMargin:Left', 'probe:setPageMargin:Right',
  ])
  assert.equal(fake.events.filter(event => event === 'click:7').length, 1)
  assert.equal(fake.state.open, false)
  assert.equal(fake.snapshots(), 1)
})

test('Docs page setup skips already-correct fields and only closes the verified dialog', async () => {
  const fake = fakePageSetup()
  const result = await docsPageSetup({}, REQUEST, fake.io)
  assert.equal(result.docs.status, 'completed')
  assert.equal(fake.events.some(event => event.startsWith('probe:setPageMargin') || event === 'click:4' || event === 'click:5'), false)
  assert.equal(fake.events.filter(event => event === 'click:7').length, 1)
  assert.equal(fake.snapshots(), 1)
})

test('Docs page setup resumes an already-open dialog instead of reopening File', async () => {
  const fake = fakePageSetup({ open: true })
  const result = await docsPageSetup({}, REQUEST, fake.io)
  assert.equal(result.docs.status, 'completed')
  assert.equal(fake.events.includes('click:1'), false)
  assert.equal(fake.events.includes('click:2'), false)
  assert.equal(fake.events.filter(event => event === 'click:7').length, 1)
  assert.equal(fake.state.open, false)
  assert.equal(fake.snapshots(), 1)
})

test('Docs page setup re-probes and retries OK once after a close timeout', async () => {
  const fake = fakePageSetup({ okFailsOnce: true })
  const result = await docsPageSetup({}, REQUEST, fake.io)
  assert.equal(result.docs.status, 'completed')
  assert.equal(fake.events.filter(event => event === 'click:7').length, 2)
  assert.equal(fake.state.open, false)
  assert.equal(fake.snapshots(), 1)
})

test('Docs page setup never clicks OK when a margin does not verify', async () => {
  const fake = fakePageSetup({ margin: 0.5, failMargin: true })
  await assert.rejects(docsPageSetup({}, REQUEST, fake.io), error => error.code === 'DOCS_QUERY_MISMATCH')
  assert.equal(fake.events.includes('click:7'), false)
  assert.equal(fake.state.open, true)
  assert.equal(fake.snapshots(), 0)
})

test('Docs page setup validates every argument before tab access', async () => {
  const fake = fakePageSetup()
  const rejected = [
    { action: 'page_setup' },
    { action: 'page_setup', paper_size: 'A4' },
    { action: 'page_setup', orientation: 'sideways' },
    { action: 'page_setup', margins: {} },
    { action: 'page_setup', margins: { Middle: 1 } },
    { action: 'page_setup', margins: { Top: -1 } },
    { action: 'page_setup', paper_size: 'Letter', surprise: true },
  ]
  for (const args of rejected) await assert.rejects(docsPageSetup({}, args, fake.io))
  assert.equal(fake.activeTabs(), 0)
  assert.equal(fake.snapshots(), 0)
})
