import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { apply } from '../lib/index.js'

const IMAGE = { data: 'AAAA', mimeType: 'image/jpeg', width: 1, height: 1, bytes: 3 }
const SCROLL = {
  op: 'scroll',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 612, maxY: 2400, container: 'document', atTop: false, atBottom: false },
  moved: { dx: 0, dy: 612 },
  image: IMAGE,
}
const SNAPSHOT = {
  op: 'snapshot',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 2400, container: 'document', atTop: true, atBottom: false },
  labels: [
    { id: 3, tag: 'button', role: 'button', text: 'Sign in', disabled: false, x: 10, y: 20, w: 80, h: 32 },
    { id: 9, tag: 'a', role: 'link', text: 'Forgot password?', disabled: false, x: 10, y: 60, w: 120, h: 24 },
  ],
  labelCount: 2,
  surfaces: [{ kind: 'canvas', x: 20, y: 100, w: 800, h: 420 }],
  image: IMAGE,
}
const CLICK = {
  op: 'click',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 2400, container: 'document', atTop: true, atBottom: false },
  clicked: { label: 3, tag: 'button', role: 'button', text: 'Sign in' },
  changed: true,
  signals: ['dom-mutations:2'],
  navigated: false,
  clickMs: 210,
  labels: [
    { id: 3, tag: 'button', role: 'button', text: 'Sign in', disabled: false, x: 10, y: 20, w: 80, h: 32 },
    { id: 9, tag: 'a', role: 'link', text: 'Forgot password?', disabled: false, x: 10, y: 60, w: 120, h: 24 },
  ],
  labelCount: 2,
  image: IMAGE,
}
const CLICK_AT = {
  op: 'click_at',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 0, container: 'document', atTop: true, atBottom: true },
  point: { space: 'image', x: 100, y: 200, cssX: 80, cssY: 160 },
  points: [{ space: 'image', x: 100, y: 200, cssX: 80, cssY: 160, changed: true, pixelsChanged: 1.4, pixelMean: 3 }],
  trusted: true,
  changed: true,
  changedCount: 1,
  pixelsChanged: 1.4,
  clickMs: 210,
  labels: [],
  surfaces: [{ kind: 'canvas', x: 20, y: 100, w: 800, h: 420 }],
  image: IMAGE,
}
const CLICK_AT_MULTI = {
  op: 'click_at',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 0, container: 'document', atTop: true, atBottom: true },
  points: [
    { space: 'image', x: 100, y: 200, cssX: 80, cssY: 160, changed: true, pixelsChanged: 1.4, pixelMean: 3 },
    { space: 'image', x: 300, y: 400, cssX: 240, cssY: 320, changed: false, pixelsChanged: 0, pixelMean: 0 },
    { space: 'image', x: 500, y: 500, cssX: 400, cssY: 400, changed: true, pixelsChanged: 0.5, pixelMean: 2 },
  ],
  trusted: true,
  changedCount: 2,
  clickMs: 210,
  labels: [],
  surfaces: [{ kind: 'canvas', x: 20, y: 100, w: 800, h: 420 }],
  image: IMAGE,
}
const CLICK_AT_NONE = {
  op: 'click_at',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 0, container: 'document', atTop: true, atBottom: true },
  view: 'none',
  screenshotSkipped: true,
  points: [
    { space: 'image', x: 100, y: 200, cssX: 80, cssY: 160, changed: null, pixelsChanged: null, pixelMean: null },
    { space: 'image', x: 300, y: 400, cssX: 240, cssY: 320, changed: null, pixelsChanged: null, pixelMean: null },
  ],
  trusted: true,
  changed: null,
  changedCount: null,
  pixelsChanged: null,
  clickMs: 180,
}
const CLICK_AT_OFFSCREEN = {
  op: 'click_at',
  tab: CLICK_AT.tab,
  viewport: CLICK_AT.viewport,
  scroll: CLICK_AT.scroll,
  points: [
    { space: 'image', x: 100, y: 200, cssX: 80, cssY: 160, changed: true, pixelsChanged: 1.4 },
    { space: 'image', x: 300, y: 400, cssX: 240, cssY: 320, changed: true, pixelsChanged: 0.7 },
    { space: 'image', x: 900, y: 700, cssX: 720, cssY: 560, changed: null, pixelsChanged: null, offScreen: true },
  ],
  offScreenCount: 1,
  staleScroll: { fromY: 100, toY: 160, dy: 60 },
  changedCount: 2,
  trusted: true,
  clickMs: 210,
  labels: [],
  surfaces: [],
  image: IMAGE,
}
const CLICK_AT_OFFSCREEN_SINGLE = {
  op: 'click_at',
  tab: CLICK_AT.tab,
  viewport: CLICK_AT.viewport,
  scroll: CLICK_AT.scroll,
  point: { space: 'image', x: 900, y: 700, cssX: 720, cssY: 560, changed: null, offScreen: true },
  points: [{ space: 'image', x: 900, y: 700, cssX: 720, cssY: 560, changed: null, offScreen: true }],
  offScreenCount: 1,
  changed: null,
  trusted: true,
  clickMs: 180,
  labels: [],
  surfaces: [],
  image: IMAGE,
}
const CLICK_SCROLLED = {
  ...CLICK,
  scrolledIntoView: true,
  scroll: { ...CLICK.scroll, y: 120, dy: 120, atTop: false },
}
const CLICK_SCROLLED_SMALL = {
  ...CLICK,
  scrolledIntoView: true,
  scroll: { ...CLICK.scroll, dy: 3 },
}
const SELECT = {
  op: 'select_option',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 0, container: 'document', atTop: true, atBottom: true },
  selected: { value: 'ca', text: 'Canada' },
  selectedIndex: 1,
  labels: [],
  image: IMAGE,
}
const HOVER = {
  op: 'hover',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 0, container: 'document', atTop: true, atBottom: true },
  hovered: { label: 5, tag: 'button', role: 'button', text: 'Menu' },
  labels: [{ id: 6, tag: 'button', role: 'button', text: 'Menu item', disabled: false, x: 10, y: 40, w: 90, h: 30 }],
  image: IMAGE,
}
const READ_TEXT = {
  op: 'read_text',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  scope: 'page',
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 2400, container: 'document', atTop: true, atBottom: false },
  text: 'ALPHA-MARKER\nBETA-MARKER',
  totalChars: 24,
  offset: 0,
  maxChars: 12000,
  truncated: true,
  nextOffset: 24,
  totalMs: 7,
}
const TABS = {
  op: 'tabs.list',
  tabs: [
    { id: 7, title: 'Fixture', url: 'https://example.test/fixture', active: true, pinned: false, status: 'complete' },
    { id: 8, title: 'Second Tab', url: 'https://example.test/two', active: false, pinned: false, status: 'complete' },
  ],
}
const TYPE = {
  op: 'type',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 0, container: 'document', atTop: true, atBottom: true },
  typed: {
    label: 7,
    chars: 12,
    mode: 'replace',
    submitted: false,
    method: 'dom',
    beforeChars: 0,
    afterChars: 12,
    valuePreview: 'jane@example.com',
  },
  changed: true,
  signals: ['dom-mutations:2'],
  labels: [{ id: 7, tag: 'input', role: 'textbox', text: 'Email', disabled: false, x: 10, y: 20, w: 200, h: 32 }],
  labelCount: 1,
  image: IMAGE,
}
const TYPE_FOCUSED = {
  ...TYPE,
  typed: {
    chars: 5,
    mode: 'append',
    submitted: true,
    method: 'trusted',
    beforeChars: 0,
    afterChars: 5,
    valuePreview: 'hello',
  },
  labels: [],
  labelCount: 0,
}
const TYPE_TRUSTED_FOCUS = {
  ...TYPE_FOCUSED,
  typed: {
    ...TYPE_FOCUSED.typed,
    submitted: false,
    method: 'trusted-focus',
  },
}
const TYPE_PASSWORD = {
  ...TYPE,
  typed: {
    label: 8,
    chars: 12,
    mode: 'replace',
    submitted: false,
    method: 'trusted',
    beforeChars: 0,
    afterChars: 12,
    valuePreview: '[password 12 chars]',
  },
  labels: [{ id: 8, tag: 'input', role: 'textbox', text: 'Password', disabled: false, x: 10, y: 60, w: 200, h: 32 }],
}
const TYPE_UNCHANGED = {
  ...TYPE,
  typed: {
    label: 7,
    chars: 3,
    mode: 'replace',
    submitted: false,
    method: 'dom',
    beforeChars: 0,
    afterChars: 0,
    valuePreview: '',
  },
  changed: false,
  signals: [],
}
const CLIPBOARD_COPY = {
  op: 'clipboard',
  action: 'copy',
  clipboard: {
    target: 'virtual',
    system: false,
    chars: 1_234,
    preview: 'Selected article opening sentence about the fixture page…',
    source: 'selection',
  },
  totalMs: 12,
}
const CLIPBOARD_COPY_LABEL = {
  op: 'clipboard',
  action: 'copy',
  clipboard: {
    target: 'virtual',
    system: false,
    chars: 24,
    preview: 'Forgot password?',
    source: 'label',
    label: 9,
  },
  totalMs: 9,
}
const CLIPBOARD_READ = {
  op: 'clipboard',
  action: 'read',
  clipboard: {
    target: 'virtual',
    system: false,
    chars: 1_234,
    preview: 'Selected article opening sentence about the fixture page…',
    source: 'selection',
    tabId: 7,
    url: 'https://example.test/fixture',
    at: 1_700_000_000_000,
  },
  text: 'ALPHA-MARKER\nBETA-MARKER',
  totalChars: 1_234,
  offset: 0,
  truncated: true,
  totalMs: 4,
}
const CLIPBOARD_READ_SYSTEM = {
  op: 'clipboard',
  action: 'read',
  clipboard: {
    target: 'system',
    system: true,
    chars: 24,
    preview: 'CLIPBOARD-SYSTEM-MARKER',
  },
  text: 'CLIPBOARD-SYSTEM-MARKER',
  totalChars: 24,
  offset: 0,
  truncated: false,
  totalMs: 5,
}
const CLIPBOARD_WRITE = {
  op: 'clipboard',
  action: 'write',
  clipboard: {
    target: 'virtual',
    system: false,
    chars: 11,
    preview: 'hello world',
    source: 'write',
  },
  totalMs: 3,
}
const CLIPBOARD_CLEAR = {
  op: 'clipboard',
  action: 'clear',
  clipboard: {
    target: 'virtual',
    system: false,
    chars: 0,
    cleared: true,
  },
  totalMs: 2,
}
const CLIPBOARD_PASTE = {
  op: 'clipboard',
  action: 'paste',
  tab: TYPE.tab,
  viewport: TYPE.viewport,
  scroll: TYPE.scroll,
  clipboard: {
    target: 'virtual',
    system: false,
    chars: 16,
    preview: 'jane@example.com',
    source: 'selection',
  },
  pasted: { chars: 16, mode: 'replace', label: 7, via: 'virtual', submitted: false },
  typed: {
    label: 7,
    chars: 16,
    mode: 'replace',
    submitted: false,
    method: 'dom',
    beforeChars: 0,
    afterChars: 16,
    valuePreview: 'jane@example.com',
  },
  changed: true,
  signals: ['dom-mutations:1'],
  labels: TYPE.labels,
  labelCount: 1,
  image: IMAGE,
}
const CLIPBOARD_PASTE_COMPACT = {
  ...CLIPBOARD_PASTE,
  view: 'compact',
  screenshotSkipped: true,
  labels: [],
  labelCount: 0,
  labelsDelta: { count: 0, unchanged: 0, addedCount: 0, removedCount: 0, added: [] },
  image: undefined,
}
const CLIPBOARD_PASTE_KEYS = {
  op: 'clipboard',
  action: 'paste',
  tab: TYPE.tab,
  viewport: TYPE.viewport,
  scroll: TYPE.scroll,
  clipboard: { target: 'system', system: true, chars: null, rich: true },
  pasted: { chars: null, mode: 'keys', label: 7, via: 'keys', trusted: true, rich: true },
  pressed: { key: 'v', modifiers: ['ctrl'], trusted: true },
  changed: true,
  signals: ['fingerprint-changed'],
  labels: [],
  labelCount: 0,
  image: IMAGE,
}
const CLIPBOARD_PASTE_SYSTEM_TEXT = {
  ...CLIPBOARD_PASTE,
  clipboard: {
    target: 'system',
    system: true,
    chars: 24,
    preview: 'CLIPBOARD-SYSTEM-MARKER',
    source: 'system',
  },
  pasted: { chars: 24, mode: 'append', label: 7, via: 'system', submitted: false },
  typed: { ...CLIPBOARD_PASTE.typed, chars: 24, mode: 'append', afterChars: 24, valuePreview: 'CLIPBOARD-SYSTEM-MARKER' },
}
const PRESS_KEY = {
  op: 'press_key',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 0, container: 'document', atTop: true, atBottom: true },
  pressed: { key: 'KeyA', modifiers: ['ctrl'], trusted: true },
  changed: true,
  signals: ['dom-mutations:1'],
  labels: [],
  image: IMAGE,
}
const PRESS_KEY_SYNTHETIC = {
  ...PRESS_KEY,
  pressed: { key: 'Enter', modifiers: [], trusted: false },
  changed: false,
  signals: [],
}
const NAVIGATE = {
  op: 'navigate',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 0, container: 'document', atTop: true, atBottom: true },
  navigated: {
    requestedUrl: 'https://example.test/docs',
    fromUrl: 'https://example.test/start',
    toUrl: 'https://example.test/docs',
    tabId: 7,
    newTab: false,
    status: 'complete',
    timedOut: false,
    waitMs: 812,
  },
  changed: true,
  signals: ['navigated'],
  labels: [],
  image: IMAGE,
}
const NAVIGATE_NEW_TAB = {
  ...NAVIGATE,
  tab: { id: 8, title: 'Fixture Docs', url: 'https://example.test/docs' },
  navigated: { ...NAVIGATE.navigated, newTab: true, tabId: 8 },
}
const NAVIGATE_HISTORY = {
  ...NAVIGATE,
  navigated: {
    fromUrl: 'https://example.test/b',
    toUrl: 'https://example.test/a',
    tabId: 7,
    newTab: false,
    history: 'back',
    status: 'complete',
    timedOut: false,
    waitMs: 120,
  },
}
const NAVIGATE_TIMEOUT = {
  ...NAVIGATE,
  navigated: {
    requestedUrl: 'https://example.test/slow',
    fromUrl: 'https://example.test/docs',
    toUrl: 'https://example.test/slow',
    tabId: 7,
    newTab: false,
    status: 'loading',
    timedOut: true,
    waitMs: 10000,
  },
  changed: false,
  signals: [],
}
const WAIT_FOR = {
  op: 'wait_for',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 0, container: 'document', atTop: true, atBottom: true },
  waited: { conditions: { text: 'READY' }, found: true, timedOut: false, elapsedMs: 812 },
  changed: true,
  labels: [],
  image: IMAGE,
}
const WAIT_FOR_TIMEOUT = {
  ...WAIT_FOR,
  waited: { conditions: { text: 'NEVER' }, found: false, timedOut: true, elapsedMs: 10000 },
  changed: false,
  signals: [],
}
const DOCS_SET_FONT = {
  op: 'docs',
  tab: { id: 7, title: 'Fixture Docs', url: 'https://docs.example.test/document' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 0, container: 'document', atTop: true, atBottom: true },
  docs: {
    action: 'set_font',
    status: 'applied',
    matchCount: 1,
    fontAdded: true,
    verifiedBy: 'toolbar',
  },
  labels: [],
  image: IMAGE,
}
const SELECT_RANGE = {
  op: 'select',
  tab: CLICK.tab,
  viewport: CLICK.viewport,
  scroll: CLICK.scroll,
  selected: {
    from: { x: 100, y: 100, cssX: 80, cssY: 80 },
    to: { x: 500, y: 200, cssX: 400, cssY: 160 },
    chars: 128,
    textPreview: 'Bold heading text and more content',
  },
  changed: true,
  signals: ['selection'],
  labels: [],
  image: IMAGE,
}
const SELECT_COLLAPSED = {
  op: 'select',
  tab: CLICK.tab,
  viewport: CLICK.viewport,
  scroll: CLICK.scroll,
  selected: { collapsed: true, chars: 0, from: { x: 10, y: 10 }, to: { x: 10, y: 10 } },
  changed: false,
  signals: [],
  labels: [],
  image: IMAGE,
}
const SELECT_COMPACT = {
  op: 'select',
  view: 'compact',
  tab: CLICK.tab,
  viewport: CLICK.viewport,
  scroll: CLICK.scroll,
  selected: { from: { x: 100, y: 100 }, to: { x: 500, y: 200 }, chars: 128, textPreview: 'Bold heading text' },
  changed: true,
  signals: ['selection'],
  labelsDelta: { count: 42, unchanged: 42, addedCount: 0, removedCount: 0, added: [] },
  labelCount: 42,
  screenshotSkipped: true,
}
const SELECT_NONE = {
  op: 'select',
  view: 'none',
  tab: CLICK.tab,
  viewport: CLICK.viewport,
  scroll: CLICK.scroll,
  selected: { from: { x: 100, y: 100 }, to: { x: 500, y: 200 }, chars: 128, textPreview: 'Bold heading text' },
  changed: true,
  signals: ['selection'],
  labelCount: 42,
  screenshotSkipped: true,
}
const CLICK_COMPACT = {
  op: 'click',
  view: 'compact',
  tab: CLICK.tab,
  viewport: CLICK.viewport,
  scroll: CLICK.scroll,
  clicked: CLICK.clicked,
  changed: true,
  signals: ['dom-mutations:2'],
  labelsDelta: { count: 41, unchanged: 39, addedCount: 1, removedCount: 1, added: [{ id: 57, role: 'button', text: 'Bold', disabled: false }] },
  labelCount: 41,
  screenshotSkipped: true,
}
const CLICK_NONE = {
  op: 'click',
  view: 'none',
  tab: CLICK.tab,
  viewport: CLICK.viewport,
  scroll: CLICK.scroll,
  clicked: CLICK.clicked,
  changed: true,
  signals: ['dom-mutations:2'],
  labelCount: 2,
  screenshotSkipped: true,
}
const TYPE_COMPACT = {
  op: 'type',
  view: 'compact',
  tab: TYPE.tab,
  viewport: TYPE.viewport,
  scroll: TYPE.scroll,
  typed: TYPE.typed,
  changed: true,
  signals: ['dom-mutations:2'],
  labelsDelta: { count: 42, unchanged: 42, addedCount: 0, removedCount: 0, added: [] },
  labelCount: 42,
  screenshotSkipped: true,
}
const CLICK_AT_COMPACT = {
  op: 'click_at',
  view: 'compact',
  tab: CLICK_AT.tab,
  viewport: CLICK_AT.viewport,
  scroll: CLICK_AT.scroll,
  points: CLICK_AT_MULTI.points.slice(0, 2).map(point => ({ ...point, changed: null, pixelsChanged: null, pixelMean: null })),
  trusted: true,
  changedCount: null,
  clickMs: 180,
  labelsDelta: { count: 42, unchanged: 41, addedCount: 1, removedCount: 1, added: [{ id: 57, role: 'button', text: 'Bold', disabled: false }] },
  labelCount: 42,
  screenshotSkipped: true,
}
const BATCH_OK = {
  op: 'batch',
  view: 'full',
  totalMs: 1290,
  batch: { total: 3, executed: 3, succeeded: 3, ok: true, stoppedEarly: false, elapsedMs: 1240, viewMs: 50 },
  actions: [
    { index: 1, op: 'click', ok: true, changed: true, signals: ['dom-mutations:1'], clicked: CLICK.clicked },
    { index: 2, op: 'type', ok: true, changed: true, signals: ['dom-mutations:1'], typed: { ...TYPE.typed, chars: 5, afterChars: 5, valuePreview: 'hello' } },
    { index: 3, op: 'press_key', ok: true, changed: true, signals: ['dom-mutations:1'], pressed: { key: 'Enter', modifiers: [], trusted: true } },
  ],
  labels: CLICK.labels,
  labelCount: 2,
  labelMs: 5,
  surfaces: [{ kind: 'canvas', x: 20, y: 100, w: 800, h: 420 }],
  tab: CLICK.tab,
  viewport: CLICK.viewport,
  scroll: CLICK.scroll,
  captureMs: 40,
  encodeMs: 20,
  image: IMAGE,
}
const BATCH_STOPPED = {
  op: 'batch',
  view: 'compact',
  totalMs: 900,
  batch: { total: 6, executed: 3, succeeded: 2, ok: false, stoppedEarly: true, failedIndex: 3, elapsedMs: 850, viewMs: 10 },
  actions: [
    { index: 1, op: 'click', ok: true, changed: true },
    { index: 2, op: 'type', ok: true, changed: true, typed: { label: 10, chars: 5, mode: 'replace', submitted: false, method: 'dom', beforeChars: 0, afterChars: 5, valuePreview: 'Jane' } },
    { index: 3, op: 'type', ok: false, error: { code: 'UNKNOWN_LABEL', message: 'Label 99 is not in the current view.' } },
  ],
  tab: CLICK.tab,
  viewport: CLICK.viewport,
  scroll: CLICK.scroll,
  labelCount: 39,
  labelMs: 4,
  labelsDelta: { count: 39, unchanged: 39, addedCount: 0, removedCount: 0, added: [] },
  screenshotSkipped: true,
}
const BATCH_STOP_OFF = {
  op: 'batch',
  view: 'none',
  totalMs: 430,
  batch: { total: 4, executed: 4, succeeded: 3, ok: false, stoppedEarly: false, elapsedMs: 400, viewMs: 0 },
  actions: [
    { index: 1, op: 'click', ok: true, changed: true },
    { index: 2, op: 'click', ok: false, error: { code: 'DETACHED', message: 'Label 9 no longer exists.' } },
    { index: 3, op: 'click', ok: true, changed: false },
    { index: 4, op: 'navigate', ok: true, changed: true, signals: ['navigated'], navigated: { fromUrl: 'https://example.test/fixture', toUrl: 'https://example.test/docs', status: 'complete', timedOut: false, waitMs: 200 } },
  ],
  tab: CLICK.tab,
  viewport: CLICK.viewport,
  scroll: CLICK.scroll,
  screenshotSkipped: true,
}
const BATCH_SINGLE = {
  op: 'batch',
  view: 'none',
  totalMs: 650,
  batch: { total: 1, executed: 1, succeeded: 1, ok: true, stoppedEarly: false, elapsedMs: 640, viewMs: 0 },
  actions: [{ index: 1, op: 'click', ok: true, changed: true }],
  tab: CLICK.tab,
  viewport: CLICK.viewport,
  scroll: CLICK.scroll,
  screenshotSkipped: true,
}
const BATCH_CLICK_AT = {
  op: 'batch',
  view: 'none',
  totalMs: 500,
  batch: { total: 2, executed: 2, succeeded: 2, ok: true, stoppedEarly: false, elapsedMs: 480, viewMs: 0 },
  actions: [
    { index: 1, op: 'click_at', ok: true, changed: null, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], trusted: true },
    { index: 2, op: 'wait_for', ok: true, changed: true, waited: { conditions: { text: 'READY' }, found: true, timedOut: false, elapsedMs: 200 } },
  ],
  tab: CLICK.tab,
  viewport: CLICK.viewport,
  scroll: CLICK.scroll,
  screenshotSkipped: true,
}
const BATCH_SELECT = {
  op: 'batch',
  view: 'compact',
  totalMs: 620,
  batch: { total: 3, executed: 3, succeeded: 3, ok: true, stoppedEarly: false, elapsedMs: 580, viewMs: 20 },
  actions: [
    { index: 1, op: 'select', ok: true, changed: true, signals: ['selection'], selected: { from: { x: 100, y: 100 }, to: { x: 500, y: 200 }, chars: 128, textPreview: 'Bold heading text' } },
    { index: 2, op: 'select', ok: true, changed: false, selected: { collapsed: true, chars: 0 } },
    { index: 3, op: 'press_key', ok: true, changed: true, pressed: { key: 'KeyB', modifiers: ['ctrl'], trusted: true } },
  ],
  tab: CLICK.tab,
  viewport: CLICK.viewport,
  scroll: CLICK.scroll,
  labelCount: 41,
  labelMs: 3,
  labelsDelta: { count: 41, unchanged: 41, addedCount: 0, removedCount: 0, added: [] },
  screenshotSkipped: true,
}

async function startFakeBridge(options = {}) {
  const delays = options.delays ?? {}
  const respond = options.respond
  const failures = options.failures ?? {}
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const port = server.address().port
  const activities = []
  const commands = []
  const logEvents = []
  server.on('connection', ws => {
    ws.on('message', data => {
      const message = JSON.parse(data.toString())
      if (message.type === 'hello') {
        ws.send(JSON.stringify({ v: 1, type: 'hello.ok', version: 1 }))
        return
      }
      if (message.type === 'activity') {
        activities.push(message.activity)
        return
      }
      if (message.type === 'log.event') {
        logEvents.push(message.event)
        return
      }
      if (message.type === 'browser.command') {
        const op = message.command?.op
        const args = message.command?.args ?? {}
        commands.push({ op, args })
        const failure = failures[op]
        if (failure !== undefined) {
          try {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({
                v: 1,
                type: 'browser.result',
                id: message.id,
                ok: false,
                error: { message: failure.message, ...failure.code === undefined ? {} : { code: failure.code } },
              }))
            }
          } catch {
            // The fake server may be closing during test teardown.
          }
          return
        }
        const send = result => {
          const payload = JSON.stringify({ v: 1, type: 'browser.result', id: message.id, ok: true, result })
          const write = () => {
            try {
              if (ws.readyState === 1) ws.send(payload)
            } catch {
              // The fake server may be closing during test teardown.
            }
          }
          const delay = Number(delays[op]) || 0
          if (delay > 0) setTimeout(write, delay)
          else write()
        }
        const custom = respond?.(op, args)
        if (custom !== undefined) {
          send(custom)
          return
        }
        if (op === 'batch') {
          const actions = Array.isArray(args.actions) ? args.actions : []
          send(actions.some(action => action?.op === 'select') ? BATCH_SELECT
            : args.stop_on_error === false ? BATCH_STOP_OFF
              : actions.length >= 6 ? BATCH_STOPPED
                : actions.length === 3 ? BATCH_OK
                  : actions.length === 2 ? BATCH_CLICK_AT
                    : BATCH_SINGLE)
          return
        }
        if (op === 'select') {
          const from = args.from ?? {}
          const to = args.to ?? {}
          const collapsed = from.x === to.x && from.y === to.y
          send(args.view === 'none' ? SELECT_NONE
            : args.view === 'compact' ? SELECT_COMPACT
              : collapsed ? SELECT_COLLAPSED
                : SELECT_RANGE)
          return
        }
        if (op === 'click_at') {
          send(args.view === 'none' ? CLICK_AT_NONE
            : args.view === 'compact' ? CLICK_AT_COMPACT
              : Array.isArray(args.points) ? CLICK_AT_MULTI
                : CLICK_AT)
          return
        }
        if (op === 'click') {
          send(args.view === 'compact' ? CLICK_COMPACT
            : args.view === 'none' ? CLICK_NONE
              : CLICK)
          return
        }
        if (op === 'type') {
          send(args.view === 'compact' ? TYPE_COMPACT
            : args.text === 'NOCHANGE' ? TYPE_UNCHANGED
              : args.text === 'FOCUS' ? TYPE_TRUSTED_FOCUS
                : args.label === 8 ? TYPE_PASSWORD
                  : args.label === undefined ? TYPE_FOCUSED
                    : TYPE)
          return
        }
        if (op === 'press_key') {
          send(Array.isArray(args.modifiers) && args.modifiers.length > 0 ? PRESS_KEY : PRESS_KEY_SYNTHETIC)
          return
        }
        if (op === 'clipboard') {
          const target = args.target === 'system' ? 'system' : 'virtual'
          const asTarget = result => ({ ...result, clipboard: { ...result.clipboard, target, system: target === 'system' } })
          if (args.action === 'copy') {
            send(asTarget(args.source === 'label' ? CLIPBOARD_COPY_LABEL : CLIPBOARD_COPY))
            return
          }
          if (args.action === 'read') {
            send(target === 'system' ? CLIPBOARD_READ_SYSTEM : CLIPBOARD_READ)
            return
          }
          if (args.action === 'write') {
            send(asTarget(CLIPBOARD_WRITE))
            return
          }
          if (args.action === 'clear') {
            send(CLIPBOARD_CLEAR)
            return
          }
          if (args.action === 'paste') {
            if (target === 'system') {
              send(args.rich === false ? CLIPBOARD_PASTE_SYSTEM_TEXT : CLIPBOARD_PASTE_KEYS)
              return
            }
            const base = args.view === 'compact' ? CLIPBOARD_PASTE_COMPACT : CLIPBOARD_PASTE
            const mode = args.mode === 'append' ? 'append' : 'replace'
            send({
              ...base,
              pasted: { ...base.pasted, mode, ...(args.submit === true ? { submitted: true } : {}) },
              typed: { ...base.typed, mode, ...(args.submit === true ? { submitted: true } : {}) },
            })
            return
          }
        }
        if (op === 'navigate') {
          send(args.history === 'back' ? NAVIGATE_HISTORY
            : args.new_tab === true ? NAVIGATE_NEW_TAB
              : typeof args.url === 'string' && args.url.includes('slow') ? NAVIGATE_TIMEOUT
                : NAVIGATE)
          return
        }
        if (op === 'wait_for') {
          send(args.text === 'NEVER' ? WAIT_FOR_TIMEOUT : WAIT_FOR)
          return
        }
        if (op === 'docs') {
          send(DOCS_SET_FONT)
          return
        }
        const result = op === 'scroll' ? SCROLL
          : op === 'tabs.list' ? TABS
            : op === 'read_text' ? READ_TEXT
              : op === 'select_option' ? SELECT
                : op === 'hover' ? HOVER
                  : SNAPSHOT
        send(result)
      }
    })
  })
  return { server, url: `ws://127.0.0.1:${port}/bridge`, activities, commands, logEvents }
}

function makeContext() {
  const tools = new Map()
  const sections = []
  const disposers = []
  const listeners = new Map()
  let provider
  const ctx = {
    logger: { info: () => {} },
    browserUse: {
      register: name => {
        provider = name
        return () => {}
      },
    },
    tools: {
      register: definition => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      getSectionOrder: () => 3000,
      section: section => {
        sections.push(section)
        return () => {}
      },
    },
    on: (event, handler) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect: fn => {
      const iterator = fn()
      let step = iterator.next()
      while (!step.done) {
        if (typeof step.value === 'function') disposers.push(step.value)
        step = iterator.next()
      }
      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    },
  }
  return {
    ctx,
    tools,
    sections,
    listeners,
    getProvider: () => provider,
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for condition')
}

test('registers the provider, guidance, and the twenty-four browser tools', async t => {
  const { server, url, logEvents } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  assert.equal(String(fake.getProvider()), 'extension-current-window')
  const toolNames = [...fake.tools.keys()].sort()
  assert.deepEqual(toolNames, [
    'browser_batch',
    'browser_click',
    'browser_click_at',
    'browser_clipboard',
    'browser_docs',
    'browser_docs_format',
    'browser_docs_page_setup',
    'browser_docs_read',
    'browser_docs_rename',
    'browser_docs_replace_many',
    'browser_docs_replace_text',
    'browser_docs_write',
    'browser_hover',
    'browser_navigate',
    'browser_press_key',
    'browser_read_text',
    'browser_screenshot',
    'browser_scroll',
    'browser_select',
    'browser_select_option',
    'browser_switch_tab',
    'browser_tabs',
    'browser_type',
    'browser_wait_for',
  ])
  await waitFor(() => logEvents.some(event => event.type === 'provider.registered'))
  const registered = logEvents.find(event => event.type === 'provider.registered')
  assert.deepEqual([...registered.data.tools].sort(), toolNames)
  const parallelSafe = new Set(['browser_tabs', 'browser_read_text', 'browser_docs_read'])
  for (const [name, tool] of fake.tools) {
    if (parallelSafe.has(name)) assert.equal(tool.isConcurrencySafe(), true, `${name} must be parallel-safe`)
    else assert.equal(tool.isConcurrencySafe, undefined, `${name} must remain exclusive`)
  }
  assert.equal(fake.sections.length, 1)
  const guidance = fake.sections[0].text
  assert.match(guidance, /untrusted data/)
  // Operating stance: user authority, haste, no invented refusals.
  assert.match(guidance, /Operating rules \(highest priority\)/)
  assert.match(guidance, /The user's instruction is the task/)
  assert.match(guidance, /Do not refuse, moralize, warn/)
  assert.match(guidance, /Be hasty/)
  assert.match(guidance, /first good-enough step/)
  assert.match(guidance, /Exact Google Docs deletion\/replacement is a direct tool task, not a reading task/)
  assert.match(guidance, /your FIRST tool call/)
  assert.match(guidance, /Do not call browser_read_text or browser_screenshot first/)
  assert.match(guidance, /Do not invent refusals/)
  assert.match(guidance, /no AI/)
  // v2 refinements: verification/claims, final-answer contract, destructive
  // actions, blocked-by-user, stop-early budget, untrusted-vs-user, clipboard guard.
  assert.match(guidance, /user's words are the instructions/)
  assert.match(guidance, /1-3 short bullets/)
  assert.match(guidance, /Never close tabs/)
  assert.match(guidance, /Do not clear formatting, select-all\/delete, erase content, or repeatedly Backspace as failure recovery/)
  assert.match(guidance, /one scoped Ctrl\+Z is allowed/)
  assert.match(guidance, /never chain blind undos/)
  assert.match(guidance, /login, CAPTCHA\/2FA, payment/)
  assert.match(guidance, /only use credentials the user provided/)
  assert.match(guidance, /no per-turn call limit/)
  assert.match(guidance, /never split work across turns/)
  // Canvas editors require visual confirmation between single actions.
  assert.match(guidance, /render their chrome themselves/)
  assert.match(guidance, /one action \+ full fresh view/)
  assert.match(guidance, /No mutating batches or multi-point bursts/)
  assert.match(guidance, /executor will reject them/)
  assert.match(guidance, /Never reuse coordinates measured in an earlier view/)
  assert.match(guidance, /labelled ARIA toolbar\/menu controls/)
  assert.match(guidance, /Docs' div comboboxes are not native selects/)
  assert.match(guidance, /never use browser_select_option on them/)
  assert.match(guidance, /exact labelled menuitemcheckbox/)
  assert.match(guidance, /More fonts control and its labelled search field/)
  assert.match(guidance, /prefer browser_docs with action:"set_font" for font-only changes/)
  assert.match(guidance, /make browser_docs_format your FIRST tool call/)
  assert.match(guidance, /paragraph_style, font_size, bold, italic, underline, or font/)
  assert.match(guidance, /one unique selection and one final view/)
  assert.match(guidance, /Booleans are desired states/)
  assert.match(guidance, /Compose one logical unit in ONE assistant response/)
  assert.match(guidance, /Browser mutations execute exclusively in model order/)
  assert.match(guidance, /make browser_docs_write your FIRST content tool call/)
  assert.match(guidance, /formats every run ahead of the caret/)
  assert.match(guidance, /runs:\[\{text/)
  assert.match(guidance, /color, and highlight/)
  assert.match(guidance, /Include every explicitly requested attribute, including font_size/)
  assert.match(guidance, /never retype content or drop requested attributes/)
  assert.match(guidance, /exits lists with Enter twice/)
  assert.match(guidance, /list:"numbered"\|"bulleted"\|"checklist"/)
  assert.match(guidance, /\{text,checked\}/)
  assert.match(guidance, /\{page_break:true\}/)
  assert.match(guidance, /never send blank:false/)
  assert.match(guidance, /always pair every items array with list and every list with items/)
  assert.match(guidance, /use browser_docs_page_setup/)
  assert.match(guidance, /compose already-known rename, page-setup, and write calls in one response/)
  assert.match(guidance, /Returned results are enough verification/)
  assert.match(guidance, /plain unformatted prose, enter contiguous text and intended newlines in one call/)
  assert.match(guidance, /unique 1-of-1 exact text find/)
  assert.match(guidance, /exact visible role\/name controls/)
  assert.match(guidance, /More fonts add → close → reopen → apply/)
  assert.match(guidance, /Duplicate text is left untouched/)
  assert.match(guidance, /Syne must not match Syne Mono/)
  assert.match(guidance, /matched text only, never its paragraph break/)
  assert.match(guidance, /not a license for dependent batches/)
  assert.match(guidance, /actual tool browser_docs_replace_text/)
  assert.match(guidance, /do not read page text first/)
  assert.match(guidance, /do not choose another target/)
  assert.match(guidance, /one actual browser_docs_replace_many call/)
  assert.match(guidance, /rechecks uniqueness after earlier edits/)
  assert.match(guidance, /never claim unattempted edits completed/)
  assert.match(guidance, /Do not manually operate Find and Replace for these cases or switch tool names/)
  assert.match(guidance, /clicks Replace once internally/)
  assert.match(guidance, /use browser_docs_rename/)
  assert.match(guidance, /verifies title-field focus before Enter/)
  assert.match(guidance, /Three consecutive Docs replacement failures trip DOCS_FAILURE_CIRCUIT/)
  assert.match(guidance, /Google Docs drag selection is rejected because it can move text/)
  assert.doesNotMatch(guidance, /browser_docs\.(?:set_font|replace_text|replace_many)/)
  assert.doesNotMatch(guidance, /update_normal_style/)
  assert.match(guidance, /Ctrl\+F, make selection a separate visually confirmed step before formatting/)
  assert.match(guidance, /never use stop_on_error:false for dependent edits/)
  assert.match(guidance, /Unlabelled browser_type inserts at the caret\/current selection, not a whole-document replace/)
  assert.match(guidance, /Canvas append\/empty operations may be rejected/)
  assert.match(guidance, /never retry unverified input blindly/)
  assert.match(guidance, /selection is UNVERIFIED/)
  assert.doesNotMatch(guidance, /cannot select a neighbour/)
  assert.doesNotMatch(guidance, /That whole sequence is one batch/)
  assert.doesNotMatch(guidance, /browser_press_key takes repeat/)
  assert.doesNotMatch(guidance, /One big paste/)
  assert.doesNotMatch(guidance, /Measured 2026-10-23/)
  assert.match(guidance, /leaves the earlier actions APPLIED/)
  assert.match(guidance, /document tabs/)
  assert.match(guidance, /only see real Chrome tabs/)
  assert.match(guidance, /Never paste secrets or passwords/)
  assert.match(guidance, /read the system clipboard only when the user asks/)
  assert.match(guidance, /points:\[\{x,y\}, \.\.\.\]/)
  assert.match(guidance, /view:"none"/)
  assert.match(guidance, /delay_ms/)
  for (const tool of ['browser_type', 'browser_press_key', 'browser_navigate', 'browser_wait_for', 'browser_batch', 'browser_select', 'browser_clipboard']) {
    assert.match(guidance, new RegExp(tool), tool)
  }
  // Clipboard guidance: virtual-first, system only on request, rich Ctrl+V.
  assert.match(guidance, /virtual clipboard/i)
  assert.match(guidance, /never read the system clipboard without a user request/)
  assert.match(guidance, /trusted Ctrl\+V/)
  assert.match(guidance, /rich text and images/)
  assert.match(guidance, /select text with browser_select first/)
  assert.match(guidance, /detail:"fast"/)
  assert.match(guidance, /Ctrl\+Alt\+M/)
  assert.match(guidance, /view: "auto"/)
  assert.match(guidance, /view:"full"/)
  assert.match(guidance, /compact confirmation/)
  assert.match(guidance, /returns one view for the whole sequence/)
  assert.match(guidance, /stop_on_error:false/)
  // Hardening guidance: click_at capacity, composite keys, dangerous chords,
  // range selection, stale/off-screen coordinates, retries, and file pickers.
  assert.match(guidance, /up to 20/)
  assert.match(guidance, /composite form 'shift\+Tab'/)
  assert.match(guidance, /ctrl\/cmd\+W/)
  assert.match(guidance, /use one scoped Ctrl\+Z only to revert a known accidental latest mutation/)
  assert.match(guidance, /never undo blindly or repeatedly/)
  assert.match(guidance, /Prefer it over clicking and pressing Home\/Shift\+End/)
  assert.match(guidance, /off-screen or clipped/)
  assert.match(guidance, /fails twice/)
  assert.match(guidance, /file pickers cannot be driven by browser_click/)
  assert.doesNotMatch(guidance, /cannot click or type in Phase 1/)
  assert.doesNotMatch(guidance, /cannot type/i)
  assert.doesNotMatch(guidance, /cannot navigate/i)
})

test('scroll tool returns metadata and an image block', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  await waitFor(() => server.clients.size > 0)
  const definition = fake.tools.get('browser_scroll')
  const value = await definition.execute({ direction: 'down' }, { callId: 'call-1', signal: new AbortController().signal })
  assert.equal(value.content.length, 2)
  assert.equal(value.content[0].type, 'text')
  assert.match(value.content[0].text, /tab 7 "Fixture"/)
  assert.match(value.content[0].text, /scroll document y=612\/2400/)
  assert.equal(value.content[1].type, 'image')
  assert.equal(value.content[1].mimeType, 'image/jpeg')
  assert.equal(value.content[1].data, 'AAAA')
})

test('tabs tool returns a readable list without an image', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  await waitFor(() => server.clients.size > 0)
  const definition = fake.tools.get('browser_tabs')
  const value = await definition.execute({}, { callId: 'call-2', signal: new AbortController().signal })
  assert.equal(value.content.length, 1)
  assert.match(value.content[0].text, /\[7\] "Fixture"/)
  assert.match(value.content[0].text, /\[8\] "Second Tab"/)
})

test('forwards DSH assistant-stream frames as live activity', async t => {
  const { server, url, activities } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  await waitFor(() => server.clients.size > 0)
  await new Promise(resolve => setTimeout(resolve, 75))
  const handler = fake.listeners.get('agent/assistant-stream')
  assert.equal(typeof handler, 'function')
  handler({ frame: { type: 'start', turn: 1, step: 1, attemptId: 'attempt-1' } })
  handler({ frame: { type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text: 'checking the page' } } })
  handler({ frame: { type: 'chunk', chunk: { type: 'text-delta', index: 1, text: 'I can see it.' } } })
  handler({ frame: { type: 'chunk', chunk: { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'browser_scroll', argumentsDelta: '{"direction":"down"}' } } })
  handler({ frame: { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 12 } } } })
  handler({ frame: { type: 'chunk', chunk: { type: 'finish', reason: 'stop' } } })
  handler({ frame: { type: 'end', outcome: { kind: 'committed' } } })

  await waitFor(() => activities.length >= 7)
  assert.deepEqual(activities.map(item => item.kind), [
    'model-start',
    'reasoning',
    'text',
    'tool-call-delta',
    'usage',
    'finish',
    'model-end',
  ])
  assert.equal(activities[1].text, 'checking the page')
  assert.equal(activities[2].text, 'I can see it.')
  assert.equal(activities[3].name, 'browser_scroll')
  assert.equal(activities[4].usage.inputTokens, 12)
})


test('read_text returns text without an image block', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_read_text')
  const result = await definition.execute({ scope: 'page' }, { callId: 'c1', signal: new AbortController().signal })
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0].type, 'text')
  assert.match(result.content[0].text, /ALPHA-MARKER/)
  assert.match(result.content[0].text, /next_offset 24/)
})

test('switch_tab accepts a query and rejects an empty target', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const tool = fake.tools.get('browser_switch_tab')
  const exec = { callId: 'c2', signal: new AbortController().signal }
  await assert.rejects(() => tool.execute({}, exec), /requires tab_id or query/)
  const result = await tool.execute({ query: 'fixture' }, { callId: 'c3', signal: new AbortController().signal })
  assert.ok(result.content.some(block => block.type === 'image'))
})


test('screenshot content lists labels for clicking', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_screenshot')
  const value = await definition.execute({}, { callId: 'c-shot', signal: new AbortController().signal })
  assert.match(value.content[0].text, /labels \(click by number\): 2/)
  assert.match(value.content[0].text, /\[3\] button "Sign in"/)
  assert.match(value.content[0].text, /\[9\] link "Forgot password\?"/)
})

test('screenshot forwards delay_ms to the bridge', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_screenshot')
  assert.match(definition.description, /delay_ms/)
  assert.match(definition.description, /fast/)
  await definition.execute({ delay_ms: 350 }, { callId: 'c-delay', signal: new AbortController().signal })
  assert.deepEqual(commands.at(-1), { op: 'snapshot', args: { detail: 'normal', delay_ms: 350 } })
  await definition.execute({ detail: 'high' }, { callId: 'c-nodelay', signal: new AbortController().signal })
  assert.deepEqual(commands.at(-1), { op: 'snapshot', args: { detail: 'high' } })
  await definition.execute({ detail: 'fast' }, { callId: 'c-fast', signal: new AbortController().signal })
  assert.deepEqual(commands.at(-1), { op: 'snapshot', args: { detail: 'fast' } })
})

test('a re-resolved stale label is reported to the model', async t => {
  const reResolved = { from: 3, to: 117, tag: 'button', role: 'button', text: 'Sign in', frame: 0 }
  const { server, url } = await startFakeBridge({
    respond: (op, args) => op === 'click' && args.label === 3 ? { ...CLICK, clicked: { ...CLICK.clicked, label: 117 }, reResolved, signals: ['dom-mutations:2', 'label-re-resolved:3->117'] } : undefined,
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const value = await fake.tools.get('browser_click').execute({ label: 3 }, { callId: 'c-reresolve', signal: new AbortController().signal })
  const text = value.content.map(block => block.text ?? '').join('\n')
  // The model must learn that its label map moved, or it keeps re-aiming at the
  // id that no longer exists.
  assert.match(text, /note: label 3 was stale/)
  assert.match(text, /button "Sign in"/)
  assert.match(text, /re-resolved it to label 117/)
  assert.match(text, /use 117 from here/)
  // The ordinary path carries no note.
  const plain = await fake.tools.get('browser_click').execute({ label: 117 }, { callId: 'c-plain', signal: new AbortController().signal })
  assert.doesNotMatch(plain.content.map(block => block.text ?? '').join('\n'), /re-resolved/)
})

test('click tool reports the target and the resulting view', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_click')
  const value = await definition.execute({ label: 3 }, { callId: 'c-click', signal: new AbortController().signal })
  assert.equal(value.content[0].type, 'text')
  assert.match(value.content[0].text, /clicked label 3: button "Sign in"/)
  assert.match(value.content[0].text, /result: changed \(dom-mutations:2\)/)
  assert.match(value.content[0].text, /labels \(click by number\): 2/)
  assert.equal(value.content[1].type, 'image')
  await assert.rejects(
    () => definition.execute({ label: 0 }, { callId: 'c-bad', signal: new AbortController().signal }),
    /positive integer label/,
  )
})


test('screenshot content reports canvas surfaces', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_screenshot')
  const value = await definition.execute({}, { callId: 'c-surface', signal: new AbortController().signal })
  assert.match(value.content[0].text, /surfaces \(no DOM labels; use browser_click_at\): canvas 800x420 @20,100/)
})

test('click_at reports trusted input and pixel change', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_click_at')
  const value = await definition.execute({ x: 100, y: 200 }, { callId: 'c-at', signal: new AbortController().signal })
  assert.match(value.content[0].text, /clicked at \(100, 200\) image px → css \(80, 160\) · trusted input/)
  assert.match(value.content[0].text, /result: changed \(pixels-changed 1\.4%\)/)
  assert.equal(value.content[1].type, 'image')
  await assert.rejects(
    () => definition.execute({ x: 'a', y: 2 }, { callId: 'c-bad-at', signal: new AbortController().signal }),
    /finite x and y/,
  )
})

test('click_at multi-point content lists every point and the changed count', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_click_at')
  assert.equal(definition.parameters.properties.points.maxItems, 20)
  assert.match(definition.parameters.properties.points.description, /several targets/)
  // The advertised schema must make a target non-optional at generation time:
  // x/y and points are each individually optional, so without anyOf a decoder
  // can emit {"space":"css"} alone (seen 7 times in the 2026-10-22 runs).
  assert.deepEqual(definition.parameters.anyOf, [{ required: ['x', 'y'] }, { required: ['points'] }])
  assert.equal(definition.parameters.additionalProperties, false)
  assert.match(definition.description, /up to 20/)
  const value = await definition.execute({
    points: [{ x: 100, y: 200 }, { x: 300, y: 400 }, { x: 500, y: 500 }],
  }, { callId: 'c-multi', signal: new AbortController().signal })
  const text = value.content[0].text
  assert.match(text, /clicked 3 points with trusted input in 210ms/)
  assert.match(text, /  \[1\] \(100, 200\) image → css \(80, 160\) · changed 1\.4%/)
  assert.match(text, /  \[2\] \(300, 400\) image → css \(240, 320\) · no visible change/)
  assert.match(text, /  \[3\] \(500, 500\) image → css \(400, 400\) · changed 0\.5%/)
  assert.match(text, /2\/3 points changed pixels/)
  assert.equal(value.content[1].type, 'image')
  assert.deepEqual(commands.at(-1), { op: 'click_at', args: { points: [{ x: 100, y: 200 }, { x: 300, y: 400 }, { x: 500, y: 500 }] } })
})

test('click_at with view:none returns text only and explains the skipped screenshot', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_click_at')
  const value = await definition.execute({
    points: [{ x: 100, y: 200 }, { x: 300, y: 400 }],
    view: 'none',
    settle_ms: 80,
  }, { callId: 'c-none', signal: new AbortController().signal })
  assert.equal(value.content.length, 1)
  assert.equal(value.content[0].type, 'text')
  const text = value.content[0].text
  assert.match(text, /clicked 2 points with trusted input in 180ms/)
  assert.match(text, /change unknown \(no previous view\)/)
  assert.match(text, /view: skipped — no screenshot returned/)
  assert.match(text, /image coordinates still map to the previous view/)
  assert.doesNotMatch(text, /points changed pixels/)
  assert.doesNotMatch(text, /labels \(click by number\)/)
  assert.deepEqual(commands.at(-1), {
    op: 'click_at',
    args: { points: [{ x: 100, y: 200 }, { x: 300, y: 400 }], view: 'none', settle_ms: 80 },
  })
})

test('click_at rejects ambiguous, empty, and oversized point sets', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_click_at')
  const exec = { callId: 'c-invalid', signal: new AbortController().signal }
  await assert.rejects(() => definition.execute({}, exec), /requires a target/)
  // A coordinate-free call used to pass schema validation and burn a round trip
  // on a plain error; the message now names the fix and forbids a bare retry.
  await assert.rejects(
    () => definition.execute({ space: 'css', view: 'none', settle_ms: 300 }, exec),
    error => {
      assert.match(error.message, /requires a target/)
      assert.match(error.message, /\{"x":640,"y":360,"space":"css"\}/)
      assert.match(error.message, /do not retry without coordinates/)
      return true
    },
  )
  await assert.rejects(() => definition.execute({ y: 2 }, exec), /requires both x and y/)
  await assert.rejects(
    () => definition.execute({ x: 1, y: 2, points: [{ x: 3, y: 4 }] }, exec),
    /either x\/y or points, not both/,
  )
  await assert.rejects(() => definition.execute({ points: [] }, exec), /non-empty array/)
  await assert.rejects(
    () => definition.execute({ points: Array.from({ length: 21 }, (_, index) => ({ x: index, y: index })) }, exec),
    /at most 20 points/,
  )
  // A 19-point burst fits in one call now (the extension accepts up to 20).
  const burst = await definition.execute(
    { points: Array.from({ length: 19 }, (_, index) => ({ x: index * 10, y: index * 5 })) },
    exec,
  )
  assert.ok(burst.content.length >= 1)
  assert.equal(commands.at(-1).args.points.length, 19)
  await assert.rejects(() => definition.execute({ points: [{ x: 'a', y: 1 }] }, exec), /finite x and y/)
})

test('select and hover tools report their outcome', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const select = await fake.tools.get('browser_select_option').execute(
    { label: 4, option: 'Canada' },
    { callId: 'c-select', signal: new AbortController().signal },
  )
  assert.match(select.content[0].text, /selected "Canada" \(value "ca"\)/)

  const hover = await fake.tools.get('browser_hover').execute(
    { label: 5 },
    { callId: 'c-hover', signal: new AbortController().signal },
  )
  assert.match(hover.content[0].text, /hovered label 5: button "Menu"/)
  assert.match(hover.content[0].text, /\[6\] button "Menu item"/)
})

test('type tool types into a labelled field and reports the new value', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_type')
  const value = await definition.execute(
    { text: 'jane@example.com', label: 7 },
    { callId: 'c-type', signal: new AbortController().signal },
  )
  assert.equal(value.content[0].type, 'text')
  assert.match(value.content[0].text, /typed into \[7\] textbox "Email" · replace · 12 chars · dom/)
  assert.match(value.content[0].text, /value now "jane@example\.com"/)
  assert.equal(value.content[1].type, 'image')
  assert.deepEqual(commands.at(-1), { op: 'type', args: { text: 'jane@example.com', label: 7 } })
})

test('type tool supports focused append/submit and password previews', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_type')
  const exec = { callId: 'c-type-2', signal: new AbortController().signal }
  const focused = await definition.execute({ text: 'hello', mode: 'append', submit: true }, exec)
  assert.match(focused.content[0].text, /typed 5 chars into the focused element · append · trusted · submitted/)
  assert.match(focused.content[0].text, /value now "hello"/)
  assert.deepEqual(commands.at(-1), { op: 'type', args: { text: 'hello', mode: 'append', submit: true } })

  const password = await definition.execute({ text: 'supersecret', label: 8 }, exec)
  assert.match(password.content[0].text, /typed into \[8\] textbox "Password" · replace · 12 chars · trusted/)
  assert.match(password.content[0].text, /value now "\[password 12 chars\]"/)
  assert.doesNotMatch(password.content[0].text, /supersecret/)

  const unchanged = await definition.execute({ text: 'NOCHANGE', label: 7 }, exec)
  assert.match(unchanged.content[0].text, /result: NO VISIBLE CHANGE/)

  const focusFallback = await definition.execute({ text: 'FOCUS' }, exec)
  assert.match(focusFallback.content[0].text, /typed 5 chars into the focused element · append · trusted \(focused\)/)
  assert.match(focusFallback.content[0].text, /value now "hello"/)
})

test('type validation rejects non-string text and bad options', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_type')
  const exec = { callId: 'c-type-bad', signal: new AbortController().signal }
  await assert.rejects(() => definition.execute({ text: 5 }, exec), /requires a string text/)
  await assert.rejects(() => definition.execute({ text: 'x', label: 0 }, exec), /label must be a positive integer/)
  await assert.rejects(() => definition.execute({ text: 'x', mode: 'fill' }, exec), /replace" or "append"/)
  const cleared = await definition.execute({ text: '', label: 7 }, exec)
  assert.match(cleared.content[0].text, /typed into \[7\]/)
})

test('press_key reports the chord and rejects unknown modifiers', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_press_key')
  const exec = { callId: 'c-key', signal: new AbortController().signal }
  const trusted = await definition.execute({ key: 'KeyA', modifiers: ['ctrl'] }, exec)
  assert.match(trusted.content[0].text, /pressed ctrl\+KeyA · trusted/)
  assert.deepEqual(commands.at(-1), { op: 'press_key', args: { key: 'KeyA', modifiers: ['ctrl'] } })

  const synthetic = await definition.execute({ key: 'Enter' }, exec)
  assert.match(synthetic.content[0].text, /pressed Enter · synthetic/)
  assert.deepEqual(commands.at(-1), { op: 'press_key', args: { key: 'Enter' } })

  await assert.rejects(
    () => definition.execute({ key: 'KeyA', modifiers: ['hyper'] }, exec),
    /not one of ctrl, alt, shift, meta/,
  )
  await assert.rejects(() => definition.execute({ key: '' }, exec), /non-empty key name/)
  await assert.rejects(() => definition.execute({ key: 'KeyA', modifiers: 'ctrl' }, exec), /modifiers must be an array/)
})

test('navigate reports the destination, history moves, and timeouts', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_navigate')
  const exec = { callId: 'c-nav', signal: new AbortController().signal }
  const direct = await definition.execute({ url: 'https://example.test/docs' }, exec)
  assert.match(direct.content[0].text, /navigated to https:\/\/example\.test\/docs · loaded in 812ms/)
  assert.equal(direct.content[1].type, 'image')
  assert.deepEqual(commands.at(-1), { op: 'navigate', args: { url: 'https://example.test/docs' } })

  const newTab = await definition.execute({ url: 'https://example.test/docs', new_tab: true }, exec)
  assert.match(newTab.content[0].text, /new tab · loaded in 812ms/)
  assert.deepEqual(commands.at(-1), { op: 'navigate', args: { url: 'https://example.test/docs', new_tab: true } })

  const back = await definition.execute({ history: 'back' }, exec)
  assert.match(back.content[0].text, /navigated back to https:\/\/example\.test\/a · loaded in 120ms/)
  assert.deepEqual(commands.at(-1), { op: 'navigate', args: { history: 'back' } })

  const slow = await definition.execute({ url: 'https://example.test/slow' }, exec)
  assert.match(slow.content[0].text, /load timed out after 10000ms/)
  assert.match(slow.content[0].text, /use browser_wait_for/)
})

test('navigate validation rejects bad targets and combinations', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_navigate')
  const exec = { callId: 'c-nav-bad', signal: new AbortController().signal }
  await assert.rejects(() => definition.execute({}, exec), /requires url or history/)
  await assert.rejects(
    () => definition.execute({ url: 'https://example.test', history: 'back' }, exec),
    /either url or history/,
  )
  await assert.rejects(() => definition.execute({ history: 'sideways' }, exec), /history must be/)
  await assert.rejects(() => definition.execute({ url: 'ftp://example.test/x' }, exec), /only http and https/)
  await assert.rejects(() => definition.execute({ url: 'not a url' }, exec), /absolute http\(s\) URL/)
  await assert.rejects(() => definition.execute({ history: 'reload', new_tab: true }, exec), /new_tab is only valid with url/)
})

test('browser_docs validates its schema, forwards exactly, and formats every set_font status', async t => {
  const { server, url, commands } = await startFakeBridge({
    respond: (op, args) => {
      if (op !== 'docs') return undefined
      if (args.font === 'Already Sans') {
        return { ...DOCS_SET_FONT, docs: { ...DOCS_SET_FONT.docs, status: 'already_applied', fontAdded: false } }
      }
      if (args.font === 'Missing Sans') {
        return { ...DOCS_SET_FONT, docs: { ...DOCS_SET_FONT.docs, status: 'font_missing', fontAdded: false } }
      }
      if (args.font === 'Remove Sans') {
        return { ...DOCS_SET_FONT, docs: { ...DOCS_SET_FONT.docs, status: 'removed_text', fontAdded: false, removedText: args.text } }
      }
      if (args.font === 'Remove Bool') {
        return { ...DOCS_SET_FONT, docs: { ...DOCS_SET_FONT.docs, status: 'removed_text', fontAdded: false, removedText: true } }
      }
      return DOCS_SET_FONT
    },
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const tool = fake.tools.get('browser_docs')
  assert.deepEqual(tool.parameters.required, ['action', 'text', 'font'])
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.properties.action.enum, ['set_font'])
  assert.equal(tool.parameters.properties.text.minLength, 1)
  assert.equal(tool.parameters.properties.text.maxLength, 1000)
  assert.equal(tool.parameters.properties.replacement, undefined)
  assert.equal(tool.parameters.properties.edits, undefined)
  assert.equal(tool.parameters.properties.font.maxLength, 100)
  assert.equal(tool.parameters.properties.remove_if_missing.type, 'boolean')
  const single = fake.tools.get('browser_docs_replace_text')
  assert.deepEqual(single.parameters.required, ['text', 'replacement'])
  assert.equal(single.parameters.additionalProperties, false)
  const many = fake.tools.get('browser_docs_replace_many')
  assert.deepEqual(many.parameters.required, ['edits'])
  assert.equal(many.parameters.additionalProperties, false)
  assert.equal(many.parameters.properties.edits.maxItems, 200)
  assert.deepEqual(many.parameters.properties.edits.items.required, ['text', 'replacement'])
  const exec = { callId: 'c-docs', signal: new AbortController().signal }

  const applied = await tool.execute({ action: 'set_font', text: 'Exact heading', font: 'Syne', remove_if_missing: true }, exec)
  assert.deepEqual(commands.at(-1), {
    op: 'docs',
    args: { action: 'set_font', text: 'Exact heading', font: 'Syne', remove_if_missing: true },
  })
  assert.match(applied.content[0].text, /docs.status=applied docs.matchCount=1 docs.fontAdded=true docs.verifiedBy=toolbar/)
  assert.match(applied.content[0].text, /font applied to the unique matched text; toolbar verification passed/)
  assert.equal(applied.content.filter(block => block.type === 'image').length, 1)

  const already = await tool.execute({ action: 'set_font', text: 'Exact heading', font: 'Already Sans' }, exec)
  assert.deepEqual(commands.at(-1), { op: 'docs', args: { action: 'set_font', text: 'Exact heading', font: 'Already Sans' } })
  assert.match(already.content[0].text, /docs.status=already_applied docs.matchCount=1 docs.fontAdded=false docs.verifiedBy=toolbar/)
  assert.match(already.content[0].text, /font was already applied .* toolbar verification passed/)
  assert.equal(already.content.length, 2)

  const missing = await tool.execute({ action: 'set_font', text: 'Exact heading', font: 'Missing Sans' }, exec)
  assert.match(missing.content[0].text, /docs.status=font_missing/)
  assert.match(missing.content[0].text, /requested font is missing; the matched text was left unchanged/)
  assert.doesNotMatch(missing.content[0].text, /result: font applied/)
  assert.equal(missing.content.length, 2)

  const removed = await tool.execute({ action: 'set_font', text: 'Exact heading', font: 'Remove Sans' }, exec)
  assert.match(removed.content[0].text, /docs.status=removed_text/)
  assert.match(removed.content[0].text, /removed the matched text only, not the paragraph break/)
  assert.match(removed.content[0].text, /docs.removedText="Exact heading"/)
  assert.doesNotMatch(removed.content[0].text, /paragraph break.*removed/i)
  assert.equal(removed.content.length, 2)

  const removedBoolean = await tool.execute({ action: 'set_font', text: 'Exact heading', font: 'Remove Bool' }, exec)
  assert.match(removedBoolean.content[0].text, /docs.removedText=true/)
})

test('browser_docs_rename forwards a guarded rename and validates the title', async t => {
  const { server, url, commands } = await startFakeBridge({
    respond: (op, args) => op === 'docs' && args.action === 'rename' ? {
      ...DOCS_SET_FONT,
      docs: { action: 'rename', status: 'renamed', verifiedBy: 'document-title', title: args.title },
    } : undefined,
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())
  const tool = fake.tools.get('browser_docs_rename')
  assert.deepEqual(tool.parameters.required, ['title'])
  assert.equal(tool.parameters.additionalProperties, false)
  const exec = { callId: 'c-docs-rename', signal: new AbortController().signal }
  const result = await tool.execute({ title: ' Release notes ' }, exec)
  assert.deepEqual(commands.at(-1), { op: 'docs', args: { action: 'rename', title: 'Release notes' } })
  assert.match(result.content[0].text, /docs.status=renamed docs.title="Release notes" docs.verifiedBy=document-title/)
  assert.match(result.content[0].text, /title-field focus was verified before Enter/)
  await assert.rejects(() => tool.execute({ title: '   ' }, exec), /title must be a non-empty string/)
  await assert.rejects(() => tool.execute({ title: 'x'.repeat(201) }, exec), /at most 200 characters/)
  assert.equal(commands.length, 1)
})

test('browser_docs_replace_text forwards and formats exact deletion and replacement', async t => {
  const { server, url, commands } = await startFakeBridge({
    respond: (op, args) => {
      if (op !== 'docs' || args.action !== 'replace_text') return undefined
      return {
        ...DOCS_SET_FONT,
        docs: {
          action: 'replace_text',
          status: args.replacement ? 'replaced_text' : 'removed_text',
          matchCount: args.replacement ? 1 : 0,
          verifiedBy: 'find-counter',
          ...args.replacement ? {} : { removedText: args.text },
        },
      }
    },
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())
  const tool = fake.tools.get('browser_docs_replace_text')
  const exec = { callId: 'c-docs-replace', signal: new AbortController().signal }

  const removed = await tool.execute({ text: 'yea', replacement: '' }, exec)
  assert.deepEqual(commands.at(-1), { op: 'docs', args: { action: 'replace_text', text: 'yea', replacement: '' } })
  assert.match(removed.content[0].text, /docs.status=removed_text docs.matchCount=0 docs.verifiedBy=find-counter/)
  assert.match(removed.content[0].text, /removed the matched text only, not the paragraph break/)
  assert.doesNotMatch(removed.content[0].text, /fontAdded/)
  assert.equal(removed.content.filter(block => block.type === 'image').length, 1)

  const replaced = await tool.execute({ text: 'Old title', replacement: 'New title' }, exec)
  assert.deepEqual(commands.at(-1), { op: 'docs', args: { action: 'replace_text', text: 'Old title', replacement: 'New title' } })
  assert.match(replaced.content[0].text, /docs.status=replaced_text docs.matchCount=1 docs.verifiedBy=find-counter/)
  assert.match(replaced.content[0].text, /replaced the unique matched text; find-counter verification passed/)
  assert.doesNotMatch(replaced.content[0].text, /fontAdded/)
})

test('browser_docs forwards one replace_many call and formats complete and partial results', async t => {
  const { server, url, commands } = await startFakeBridge({
    respond: (op, args) => {
      if (op !== 'docs' || args.action !== 'replace_many') return undefined
      const failedIndex = args.edits.findIndex(edit => edit.text === 'missing')
      const appliedCount = failedIndex < 0 ? args.edits.length : failedIndex
      return {
        ...DOCS_SET_FONT,
        docs: {
          action: 'replace_many',
          status: failedIndex < 0 ? 'completed' : appliedCount > 0 ? 'partial' : 'failed',
          editCount: args.edits.length,
          appliedCount,
          remainingCount: failedIndex < 0 ? 0 : args.edits.length - failedIndex - 1,
          verifiedBy: 'find-counter',
          ...failedIndex < 0 ? {} : {
            failure: {
              index: failedIndex,
              text: 'missing',
              code: 'DOCS_MATCH_NOT_UNIQUE',
              stage: 'replace-match',
              message: 'Expected normalized 1 of 1, found 0 of 0',
            },
          },
        },
      }
    },
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())
  const tool = fake.tools.get('browser_docs_replace_many')
  const exec = { callId: 'c-docs-replace-many', signal: new AbortController().signal }

  const edits = [{ text: 'alpha', replacement: 'A' }, { text: 'beta ', replacement: '' }]
  const completed = await tool.execute({ edits }, exec)
  assert.deepEqual(commands.at(-1), { op: 'docs', args: { action: 'replace_many', edits } })
  assert.match(completed.content[0].text, /docs.status=completed docs.appliedCount=2\/2 docs.remainingCount=0/)
  assert.match(completed.content[0].text, /applied every requested edit in order/)
  assert.equal(completed.content.filter(block => block.type === 'image').length, 1)

  const partial = await tool.execute({
    edits: [{ text: 'alpha', replacement: 'A' }, { text: 'missing', replacement: '' }, { text: 'omega', replacement: 'O' }],
  }, exec)
  assert.equal(commands.length, 2)
  assert.match(partial.content[0].text, /docs.status=partial docs.appliedCount=1\/3 docs.remainingCount=1/)
  assert.match(partial.content[0].text, /batch incomplete; do not claim failed or unattempted edits completed/)
  assert.match(partial.content[0].text, /docs.failure=.*"index":1.*"text":"missing"/)
})

test('browser_docs_format validates its schema, forwards desired states, and formats complete and partial results', async t => {
  const { server, url, commands } = await startFakeBridge({
    delays: { docs: 150 },
    respond: (op, args) => {
      if (op !== 'docs' || args.action !== 'format') return undefined
      const attributes = ['paragraph_style', 'font_size', 'bold', 'italic', 'underline', 'font']
        .filter(attribute => args[attribute] !== undefined)
      const missing = args.font === 'Missing Sans'
      const results = attributes.map(attribute => ({
        attribute,
        value: args[attribute],
        status: missing && attribute === 'font' ? 'font_missing' : 'applied',
        verifiedBy: 'toolbar',
      }))
      const appliedCount = results.filter(result => result.status === 'applied').length
      return {
        ...DOCS_SET_FONT,
        docs: {
          action: 'format',
          status: missing ? 'partial' : 'completed',
          matchCount: 1,
          attributeCount: attributes.length,
          appliedCount,
          alreadyAppliedCount: 0,
          fontAdded: false,
          verifiedBy: 'toolbar',
          results,
          ...missing ? { failure: { attribute: 'font', code: 'DOCS_FONT_MISSING', message: 'Font is unavailable' } } : {},
        },
      }
    },
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 100 })
  t.after(() => fake.dispose())
  const tool = fake.tools.get('browser_docs_format')
  assert.deepEqual(tool.parameters.required, ['text'])
  assert.equal(tool.parameters.additionalProperties, false)
  assert.equal(tool.parameters.properties.font_size.maximum, 400)
  assert.ok(tool.parameters.properties.paragraph_style.enum.includes('Title'))
  const exec = { callId: 'c-docs-format', signal: new AbortController().signal }

  const completed = await tool.execute({
    text: 'Exact heading', paragraph_style: 'Title', font_size: 28, bold: true, italic: false, font: ' Syne ',
  }, exec)
  assert.deepEqual(commands.at(-1), {
    op: 'docs',
    args: { action: 'format', text: 'Exact heading', paragraph_style: 'Title', font_size: 28, bold: true, italic: false, font: 'Syne' },
  })
  assert.match(completed.content[0].text, /docs.status=completed docs.appliedCount=5\/5 docs.alreadyAppliedCount=0/)
  assert.match(completed.content[0].text, /every requested formatting state was verified/)
  assert.match(completed.content[0].text, /docs.results=.*"attribute":"bold"/)
  assert.equal(completed.content.filter(block => block.type === 'image').length, 1)

  const partial = await tool.execute({ text: 'Exact heading', bold: true, font: 'Missing Sans' }, exec)
  assert.equal(commands.length, 2)
  assert.match(partial.content[0].text, /docs.status=partial docs.appliedCount=1\/2/)
  assert.match(partial.content[0].text, /formatting incomplete; inspect the per-attribute results/)
  assert.match(partial.content[0].text, /docs.failure=.*"attribute":"font"/)
  assert.doesNotMatch(partial.content[0].text, /batch incomplete/)
})

test('browser_docs_read forwards export options and returns document content without an image', async t => {
  const { server, url, commands } = await startFakeBridge({
    respond: (op, args) => op === 'docs' && args.action === 'read' ? {
      op: 'docs',
      docs: {
        action: 'read', status: 'completed', format: args.format, chars: 24, returned: 24,
        truncated: false, content: 'TITLE: Heading\n1. first', verifiedBy: 'export',
      },
    } : undefined,
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())
  const tool = fake.tools.get('browser_docs_read')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.equal(tool.parameters.properties.max_chars.maximum, 100000)
  const exec = { callId: 'c-docs-read', signal: new AbortController().signal }
  const result = await tool.execute({ format: 'outline', max_chars: 500 }, exec)
  assert.deepEqual(commands.at(-1), { op: 'docs', args: { action: 'read', format: 'outline', max_chars: 500 } })
  assert.match(result.content[0].text, /docs.status=completed docs.format=outline docs.chars=24 docs.truncated=false docs.verifiedBy=export/)
  assert.match(result.content[0].text, /TITLE: Heading\n1\. first/)
  assert.equal(result.content.filter(block => block.type === 'image').length, 0)
  await tool.execute({}, exec)
  assert.deepEqual(commands.at(-1), { op: 'docs', args: { action: 'read', format: 'outline' } })
})

test('browser_docs_page_setup validates and forwards exact page settings', async t => {
  const { server, url, commands } = await startFakeBridge({
    respond: (op, args) => op === 'docs' && args.action === 'page_setup' ? {
      ...DOCS_SET_FONT,
      docs: {
        action: 'page_setup', status: 'completed', paperSize: 'Letter', orientation: 'portrait',
        margins: { Top: 1, Bottom: 1, Left: 1, Right: 1 }, verifiedBy: 'page-setup-dialog',
      },
    } : undefined,
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())
  const tool = fake.tools.get('browser_docs_page_setup')
  assert.equal(tool.isConcurrencySafe, undefined)
  assert.equal(tool.parameters.properties.margins.minProperties, 1)
  const result = await tool.execute({
    paper_size: 'Letter', orientation: 'portrait', margins: { top: 1, bottom: 1, left: 1, right: 1 },
  }, { callId: 'c-page-setup', signal: new AbortController().signal })
  assert.deepEqual(commands.at(-1), {
    op: 'docs',
    args: {
      action: 'page_setup', paper_size: 'Letter', orientation: 'portrait',
      margins: { Top: 1, Bottom: 1, Left: 1, Right: 1 },
    },
  })
  assert.match(result.content[0].text, /docs.status=completed docs.paperSize="Letter" docs.orientation="portrait" docs.verifiedBy=page-setup-dialog/)
  assert.match(result.content[0].text, /every requested paper-size, orientation, and margin value was verified/)
})

test('browser_docs_write forwards validated blocks and formats complete and partial results', async t => {
  const { server, url, commands } = await startFakeBridge({
    respond: (op, args) => {
      if (op !== 'docs' || args.action !== 'write') return undefined
      const failed = args.blocks.some(block => block.text === 'fail')
      return {
        ...DOCS_SET_FONT,
        docs: {
          action: 'write',
          status: failed ? 'partial' : 'completed',
          blockCount: args.blocks.length,
          attemptedCount: args.blocks.length,
          verifiedCount: failed ? 0 : args.blocks.length,
          verifiedBy: 'export',
          results: args.blocks.map((_, index) => ({ index, status: failed && index === 0 ? 'failed' : 'verified' })),
          ...failed ? { failure: { index: 0, code: 'DOCS_WRITE_VERIFY_FAILED', message: 'missing text' } } : {},
          outline: 'TITLE: Heading\n1. first\n• alpha',
        },
      }
    },
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())
  const tool = fake.tools.get('browser_docs_write')
  assert.deepEqual(tool.parameters.required, ['blocks'])
  assert.equal(tool.parameters.properties.blocks.maxItems, 50)
  assert.deepEqual(tool.parameters.properties.blocks.items.properties.list.enum, ['numbered', 'bulleted', 'checklist'])
  assert.ok(tool.parameters.properties.blocks.items.properties.paragraph_style.enum.includes('Title'))
  assert.equal(tool.parameters.properties.blocks.items.properties.runs.maxItems, 100)
  assert.equal(tool.parameters.properties.blocks.items.properties.blank.const, true)
  assert.equal(tool.parameters.properties.blocks.items.properties.page_break.const, true)
  const exec = { callId: 'c-docs-write', signal: new AbortController().signal }
  const blocks = [
    { text: 'Heading', paragraph_style: 'Title', font: ' Playfair Display ' },
    { blank: true },
    { items: ['first'], list: 'numbered' },
    { items: ['alpha'], list: 'bulleted' },
    { runs: [
      { text: 'Blue ', font: ' Merriweather ', bold: true, color: '#0000FF', highlight: 'none' },
      { text: 'mark', highlight: '#FFFF00' },
    ] },
  ]
  const completed = await tool.execute({ blocks }, exec)
  assert.deepEqual(commands.at(-1), {
    op: 'docs',
    args: {
      action: 'write',
      blocks: [
        { text: 'Heading', paragraph_style: 'Title', font: 'Playfair Display' },
        { blank: true },
        { items: ['first'], list: 'numbered' },
        { items: ['alpha'], list: 'bulleted' },
        { runs: [
          { text: 'Blue ', font: 'Merriweather', bold: true, color: '#0000ff', highlight: 'none' },
          { text: 'mark', highlight: '#ffff00' },
        ] },
      ],
    },
  })
  assert.match(completed.content[0].text, /docs.status=completed docs.verifiedCount=5\/5 docs.attemptedCount=5 docs.verifiedBy=export/)
  assert.match(completed.content[0].text, /preserved prefix were verified by document export/)
  assert.match(completed.content[0].text, /docs.outline=\nTITLE: Heading\n1\. first\n• alpha/)
  assert.equal(completed.content.filter(block => block.type === 'image').length, 1)

  await tool.execute({ blocks: [
    { page_break: true },
    { items: [{ text: 'done', checked: true }, 'pending'], list: 'checklist' },
  ] }, exec)
  assert.deepEqual(commands.at(-1), {
    op: 'docs',
    args: {
      action: 'write',
      blocks: [
        { page_break: true },
        { items: [{ text: 'done', checked: true }, { text: 'pending', checked: false }], list: 'checklist' },
      ],
    },
  })

  const partial = await tool.execute({ blocks: [{ text: 'fail' }] }, exec)
  assert.match(partial.content[0].text, /docs.status=partial docs.verifiedCount=0\/1/)
  assert.match(partial.content[0].text, /write incomplete; only blocks marked verified are confirmed/)
  assert.match(partial.content[0].text, /never retype the request blindly/)
})

test('Docs tools reject invalid actions and unbounded inputs before the bridge', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const exec = { callId: 'c-docs-bad', signal: new AbortController().signal }
  const rejected = [
    ['browser_docs', {}, /only supports action "set_font"/],
    ['browser_docs', { action: 'replace_text', text: 'x', replacement: '' }, /use browser_docs_replace_text/],
    ['browser_docs', { action: 'set_font', text: '', font: 'Syne' }, /text must be a non-empty string/],
    ['browser_docs', { action: 'set_font', text: '   ', font: 'Syne' }, /text must be a non-empty string/],
    ['browser_docs', { action: 'set_font', text: 'x'.repeat(1001), font: 'Syne' }, /at most 1000 characters/],
    ['browser_docs', { action: 'set_font', text: 'x', font: '' }, /font must be a non-empty string/],
    ['browser_docs', { action: 'set_font', text: 'x', font: 'F'.repeat(101) }, /at most 100 characters/],
    ['browser_docs', { action: 'set_font', text: 'x', font: 'Syne', remove_if_missing: 'yes' }, /remove_if_missing must be true or false/],
    ['browser_docs_format', { text: 'x' }, /at least one formatting attribute/],
    ['browser_docs_format', { text: ' ', bold: true }, /text must be a non-empty string/],
    ['browser_docs_format', { text: 'x', font_size: 0 }, /font_size must be an integer from 1 to 400/],
    ['browser_docs_format', { text: 'x', font_size: 401 }, /font_size must be an integer from 1 to 400/],
    ['browser_docs_format', { text: 'x', font_size: 1.5 }, /font_size must be an integer from 1 to 400/],
    ['browser_docs_format', { text: 'x', paragraph_style: 'Huge' }, /paragraph_style must be one of/],
    ['browser_docs_format', { text: 'x', bold: 'yes' }, /bold must be a boolean/],
    ['browser_docs_format', { text: 'x', font: ' ' }, /font must be a non-empty string/],
    ['browser_docs_format', { text: 'x', bold: true, surprise: true }, /unknown argument/],
    ['browser_docs_read', { format: 'pdf' }, /format must be outline, text, or html/],
    ['browser_docs_read', { max_chars: 99 }, /max_chars must be an integer from 100 to 100000/],
    ['browser_docs_page_setup', {}, /requires paper_size, orientation, or margins/],
    ['browser_docs_page_setup', { paper_size: 'A4' }, /paper_size must be Letter/],
    ['browser_docs_page_setup', { orientation: 'sideways' }, /orientation must be portrait or landscape/],
    ['browser_docs_page_setup', { margins: {} }, /at least one of top, bottom, left, right/],
    ['browser_docs_page_setup', { margins: { top: -1 } }, /numbers from 0 to 10 inches/],
    ['browser_docs_write', {}, /blocks must be an array/],
    ['browser_docs_write', { blocks: [] }, /blocks must be an array/],
    ['browser_docs_write', { blocks: [{ text: 'x', items: ['y'], list: 'bulleted' }] }, /exactly one of text, runs, items, blank:true, or page_break:true/],
    ['browser_docs_write', { blocks: [{ text: 'two\nlines' }] }, /one non-empty single-line paragraph/],
    ['browser_docs_write', { blocks: [{ blank: true, bold: true }] }, /blank cannot have text, list, or formatting attributes/],
    ['browser_docs_write', { blocks: [{ page_break: true, text: 'x' }] }, /exactly one of text, runs, items, blank:true, or page_break:true/],
    ['browser_docs_write', { blocks: [{ page_break: false }] }, /page_break must be true/],
    ['browser_docs_write', { blocks: [{ items: [{ text: 'x', checked: 'yes' }], list: 'checklist' }] }, /optional boolean checked state/],
    ['browser_docs_write', { blocks: [{ items: [{ text: 'x', checked: true }], list: 'numbered' }] }, /single-line string/],
    ['browser_docs_write', { blocks: [{ items: [], list: 'numbered' }] }, /items must contain 1 to 100 items/],
    ['browser_docs_write', { blocks: [{ items: ['x'], list: 'numbered', paragraph_style: 'Title' }] }, /list groups cannot set paragraph_style/],
    ['browser_docs_write', { blocks: [{ text: 'x', font_size: 0 }] }, /font_size must be an integer from 1 to 400/],
    ['browser_docs_write', { blocks: [{ runs: [] }] }, /runs must contain 1 to 100 runs/],
    ['browser_docs_write', { blocks: [{ runs: [{ text: 'x', paragraph_style: 'Title' }] }] }, /unknown argument/],
    ['browser_docs_write', { blocks: [{ runs: [{ text: 'x', color: 'blue' }] }] }, /six-digit hex color/],
    ['browser_docs_write', { blocks: [{ runs: [{ text: 'x', highlight: '#fff' }] }] }, /six-digit hex color/],
    ['browser_docs_write', { blocks: [{ runs: [{ text: 'x\ny' }] }] }, /single-line/],
    ['browser_docs_write', { blocks: [{ runs: [{ text: 'x' }], items: ['y'], list: 'bulleted' }] }, /exactly one of text, runs, items, blank:true, or page_break:true/],
    ['browser_docs_write', { blocks: [{ text: 'x' }], surprise: true }, /unknown argument/],
    ['browser_docs_replace_text', {}, /text must be a non-empty string/],
    ['browser_docs_replace_text', { text: 'x' }, /replacement must be a string/],
    ['browser_docs_replace_text', { text: 'x', replacement: 4 }, /replacement must be a string/],
    ['browser_docs_replace_text', { text: 'x', replacement: 'y'.repeat(1001) }, /at most 1000 characters/],
    ['browser_docs_replace_text', { text: 'same', replacement: 'same' }, /replacement must differ from text/],
    ['browser_docs_replace_many', {}, /edits must be an array/],
    ['browser_docs_replace_many', { edits: [] }, /edits must be an array/],
    ['browser_docs_replace_many', { edits: [null] }, /edits\[0\] must be an object/],
    ['browser_docs_replace_many', { edits: [{ text: '', replacement: '' }] }, /edits\[0\]\.text must be a non-empty string/],
    ['browser_docs_replace_many', { edits: [{ text: 'x' }] }, /edits\[0\]\.replacement must be a string/],
    ['browser_docs_replace_many', { edits: [{ text: 'same', replacement: 'same' }] }, /edits\[0\] replacement must differ from text/],
  ]
  let turn = 0
  for (const [toolName, args, pattern] of rejected) {
    fake.listeners.get('agent/inbox/claimed')({ message: { content: [{ type: 'text', text: `validation ${turn}` }] }, turn: ++turn })
    await assert.rejects(() => fake.tools.get(toolName).execute(args, exec), pattern)
  }
  assert.equal(commands.length, 0)
})

test('browser_docs uses a 60-second request budget instead of the configured default', async t => {
  const { server, url } = await startFakeBridge({ delays: { docs: 250 } })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 100 })
  t.after(() => fake.dispose())

  await waitFor(() => server.clients.size > 0)
  const result = await fake.tools.get('browser_docs').execute(
    { action: 'set_font', text: 'Exact heading', font: 'Syne' },
    { callId: 'c-docs-timeout', signal: new AbortController().signal },
  )
  assert.match(result.content[0].text, /docs.status=applied/)
  assert.equal(result.content.length, 2)
})

test('wait_for reports found and timed-out conditions', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_wait_for')
  const exec = { callId: 'c-wait', signal: new AbortController().signal }
  const found = await definition.execute({ text: 'READY' }, exec)
  assert.match(found.content[0].text, /waited for text "READY" · found after 812ms/)
  assert.equal(found.content[1].type, 'image')
  assert.deepEqual(commands.at(-1), { op: 'wait_for', args: { text: 'READY' } })

  const timeout = await definition.execute({ text: 'NEVER' }, exec)
  assert.match(timeout.content[0].text, /timed out after 10000ms \(text "NEVER" not found\)/)

  await definition.execute({ text: 'READY', timeout_ms: 15000 }, exec)
  assert.deepEqual(commands.at(-1), { op: 'wait_for', args: { text: 'READY', timeout_ms: 15000 } })
})

test('wait_for validation requires a condition, bounded values, and timeout_ms at least ms', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_wait_for')
  assert.match(definition.description, /must be at least ms/)
  assert.match(definition.description, /When omitted, a fixed ms wait still receives its full wait budget/)
  const exec = { callId: 'c-wait-bad', signal: new AbortController().signal }
  await assert.rejects(() => definition.execute({}, exec), /at least one condition/)
  await assert.rejects(() => definition.execute({ text: '' }, exec), /non-empty string/)
  await assert.rejects(() => definition.execute({ idle: false }, exec), /at least one condition/)
  await assert.rejects(() => definition.execute({ idle: 'yes' }, exec), /idle must be true or false/)
  await assert.rejects(() => definition.execute({ ms: -1 }, exec), /between 0 and 30000/)
  await assert.rejects(() => definition.execute({ ms: 40000 }, exec), /between 0 and 30000/)
  await assert.rejects(
    () => definition.execute({ text: 'x', timeout_ms: 500 }, exec),
    /timeout_ms must be an integer between 1000 and 30000/,
  )
  await assert.rejects(
    () => definition.execute({ ms: 15_000, timeout_ms: 10_000 }, exec),
    /timeout_ms must be greater than or equal to ms/,
  )
  assert.equal(commands.length, 0, 'all invalid waits, including timeout_ms < ms, fail before bridge traffic')
})

test('view modes are forwarded only when the model provides them', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const exec = { callId: 'c-view', signal: new AbortController().signal }
  await fake.tools.get('browser_click').execute({ label: 3, view: 'full' }, exec)
  assert.deepEqual(commands.at(-1), { op: 'click', args: { label: 3, view: 'full' } })

  await fake.tools.get('browser_type').execute({ text: 'hello', label: 7, view: 'compact' }, exec)
  assert.deepEqual(commands.at(-1), { op: 'type', args: { text: 'hello', label: 7, view: 'compact' } })

  await fake.tools.get('browser_click').execute({ label: 3 }, exec)
  assert.deepEqual(commands.at(-1), { op: 'click', args: { label: 3 } })

  await assert.rejects(() => fake.tools.get('browser_click').execute({ label: 3, view: 'mid' }, exec), /view must be one of/)
})

test('compact action results are text only with a label delta', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const value = await fake.tools.get('browser_click').execute(
    { label: 3, view: 'compact' },
    { callId: 'c-compact', signal: new AbortController().signal },
  )
  assert.equal(value.content.length, 1)
  assert.equal(value.content[0].type, 'text')
  const text = value.content[0].text
  assert.match(text, /clicked label 3: button "Sign in"/)
  assert.match(text, /result: changed \(dom-mutations:2\)/)
  assert.match(text, /labels \+1\/-1, 39 unchanged/)
  assert.match(text, /\+\[57\] button "Bold"/)
  assert.match(text, /view: compact — no screenshot returned/)
  assert.doesNotMatch(text, /labels \(click by number\)/)
})

test('none action results are text only and skip the view entirely', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const value = await fake.tools.get('browser_click').execute(
    { label: 3, view: 'none' },
    { callId: 'c-none-click', signal: new AbortController().signal },
  )
  assert.equal(value.content.length, 1)
  assert.equal(value.content[0].type, 'text')
  const text = value.content[0].text
  assert.match(text, /clicked label 3: button "Sign in"/)
  assert.match(text, /view: skipped — no screenshot returned/)
  assert.doesNotMatch(text, /labels unchanged|labels \+/)
  assert.doesNotMatch(text, /labels \(click by number\)/)
})

test('click_at compact keeps the point report and label delta without an image', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const value = await fake.tools.get('browser_click_at').execute({
    points: [{ x: 100, y: 200 }, { x: 300, y: 400 }],
    view: 'compact',
  }, { callId: 'c-at-compact', signal: new AbortController().signal })
  assert.equal(value.content.length, 1)
  const text = value.content[0].text
  assert.match(text, /clicked 2 points with trusted input in 180ms/)
  assert.match(text, /  \[1\] \(100, 200\) image → css \(80, 160\) · change unknown \(no previous view\)/)
  assert.match(text, /  \[2\] \(300, 400\) image → css \(240, 320\) · change unknown \(no previous view\)/)
  assert.doesNotMatch(text, /points changed pixels/)
  assert.doesNotMatch(text, /NO VISIBLE CHANGE/)
  assert.match(text, /labels \+1\/-1, 41 unchanged/)
  assert.match(text, /\+\[57\] button "Bold"/)
  assert.match(text, /view: compact — no screenshot returned/)
  assert.deepEqual(commands.at(-1), { op: 'click_at', args: { view: 'compact', points: [{ x: 100, y: 200 }, { x: 300, y: 400 }] } })
})

test('batch runs a sequence and returns one full view', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const actions = [
    { op: 'click', label: 3 },
    { op: 'type', text: 'hello', label: 7 },
    { op: 'press_key', key: 'Enter' },
  ]
  const value = await fake.tools.get('browser_batch').execute(
    { actions },
    { callId: 'c-batch', signal: new AbortController().signal },
  )
  const text = value.content[0].text
  assert.match(text, /batch: 3 actions · 3 executed without tool errors · 1240ms/)
  assert.match(text, /  \[1\] click · changed/)
  assert.match(text, /  \[2\] type "hello" · 5 chars · dom · changed/)
  assert.match(text, /  \[3\] press_key Enter · changed/)
  assert.match(text, /labels \(click by number\): 2/)
  assert.equal(value.content[1].type, 'image')
  const normalized = {
    op: 'batch',
    args: {
      actions: [
        { op: 'click', args: { label: 3 } },
        { op: 'type', args: { text: 'hello', label: 7 } },
        { op: 'press_key', args: { key: 'Enter' } },
      ],
    },
  }
  assert.deepEqual(commands.at(-1), normalized)

  // A nested args object is accepted too and normalises to the same wire shape.
  const nested = await fake.tools.get('browser_batch').execute({
    actions: [
      { op: 'click', args: { label: 3 } },
      { op: 'type', args: { text: 'hello', label: 7 } },
      { op: 'press_key', args: { key: 'Enter' } },
    ],
  }, { callId: 'c-batch-nested', signal: new AbortController().signal })
  assert.match(nested.content[0].text, /batch: 3 actions · 3 executed without tool errors · 1240ms/)
  assert.deepEqual(commands.at(-1), normalized)
})

test('batch stopped early reports the failure and stays text only', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const actions = [
    { op: 'click', label: 3 },
    { op: 'type', text: 'Jane', label: 10 },
    { op: 'type', text: 'Doe', label: 99 },
    { op: 'press_key', key: 'Tab' },
    { op: 'navigate', url: 'https://example.test/docs' },
    { op: 'wait_for', text: 'READY' },
  ]
  const value = await fake.tools.get('browser_batch').execute(
    { actions },
    { callId: 'c-batch-stop', signal: new AbortController().signal },
  )
  assert.equal(value.content.length, 1)
  const text = value.content[0].text
  assert.match(text, /batch: 3\/6 executed · FAILED at \[3\] · 850ms/)
  // Actions 1-2 already ran and are not rolled back; the model needs to know
  // that so it continues instead of replaying the whole batch.
  assert.match(text, /the first 2 action\(s\) already ran and were not rolled back/)
  assert.match(text, /continue from action \[3\]; do not re-run the whole batch/)
  assert.match(text, /  \[1\] click · changed/)
  assert.match(text, /  \[2\] type "Jane" · 5 chars · dom · changed/)
  assert.match(text, /  \[3\] FAILED UNKNOWN_LABEL — Label 99 is not in the current view\./)
  assert.match(text, /labels unchanged \(39\)/)
  assert.match(text, /view: compact — no screenshot returned/)
  assert.doesNotMatch(text, /press_key Tab/)
})

test('batch stop_on_error false continues and skips the view', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const actions = [
    { op: 'click', label: 3 },
    { op: 'click', label: 9 },
    { op: 'click', label: 3 },
    { op: 'navigate', url: 'https://example.test/docs' },
  ]
  const value = await fake.tools.get('browser_batch').execute(
    { actions, stop_on_error: false, view: 'none' },
    { callId: 'c-batch-off', signal: new AbortController().signal },
  )
  assert.equal(value.content.length, 1)
  const text = value.content[0].text
  assert.match(text, /batch: 4 actions · 3 executed without tool errors · 400ms/)
  assert.match(text, /  \[1\] click · changed/)
  assert.match(text, /  \[2\] FAILED DETACHED — Label 9 no longer exists\./)
  assert.match(text, /  \[3\] click · no visible change/)
  assert.match(text, /  \[4\] navigate · loaded/)
  assert.match(text, /view: skipped — no screenshot returned/)
  assert.deepEqual(commands.at(-1), {
    op: 'batch',
    args: {
      actions: [
        { op: 'click', args: { label: 3 } },
        { op: 'click', args: { label: 9 } },
        { op: 'click', args: { label: 3 } },
        { op: 'navigate', args: { url: 'https://example.test/docs' } },
      ],
      stop_on_error: false,
      view: 'none',
    },
  })
})

test('batch click_at reports dispatch instead of no visible change', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const value = await fake.tools.get('browser_batch').execute(
    { actions: [{ op: 'click_at', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }, { op: 'wait_for', text: 'READY' }] },
    { callId: 'c-batch-at', signal: new AbortController().signal },
  )
  const text = value.content[0].text
  assert.match(text, /batch: 2 actions · 2 executed without tool errors · 480ms/)
  assert.match(text, /  \[1\] click_at 2 points · dispatched/)
  assert.match(text, /  \[2\] wait_for text "READY" · found/)
  assert.match(text, /verification: 1 action\(s\) are UNVERIFIED/)
  assert.doesNotMatch(text, /NO VISIBLE CHANGE/)
})

test('batch validation rejects bad action lists', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_batch')
  const exec = { callId: 'c-batch-bad', signal: new AbortController().signal }
  await assert.rejects(() => definition.execute({}, exec), /requires an actions array/)
  await assert.rejects(() => definition.execute({ actions: 'click' }, exec), /requires an actions array/)
  await assert.rejects(() => definition.execute({ actions: [] }, exec), /at least one action/)
  await assert.rejects(
    () => definition.execute({ actions: Array.from({ length: 21 }, () => ({ op: 'click', label: 3 })) }, exec),
    /at most 20 actions/,
  )
  await assert.rejects(() => definition.execute({ actions: ['click'] }, exec), /must be an object with an op/)
  await assert.rejects(() => definition.execute({ actions: [{}] }, exec), /requires a string op/)
  await assert.rejects(() => definition.execute({ actions: [{ op: 'eval' }] }, exec), /unsupported op "eval"/)
  await assert.rejects(() => definition.execute({ actions: [{ op: 'batch', actions: [] }] }, exec), /cannot nest another browser_batch/)
  await assert.rejects(() => definition.execute({ actions: [{ op: 'screenshot' }] }, exec), /does not support the "screenshot" op/)
  await assert.rejects(() => definition.execute({ actions: [{ op: 'tabs' }] }, exec), /does not support the "tabs" op/)
  await assert.rejects(
    () => definition.execute({ actions: [{ op: 'click', label: 3 }], stop_on_error: 'yes' }, exec),
    /stop_on_error must be true or false/,
  )
  await assert.rejects(
    () => definition.execute({ actions: [{ op: 'click', label: 3 }], view: 'mid' }, exec),
    /view must be one of auto, full, compact, none/,
  )
})

test('batch uses a per-call timeout without changing other tools', async t => {
  const { server, url } = await startFakeBridge({ delays: { batch: 600, click: 600 } })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 250 })
  t.after(() => fake.dispose())

  await waitFor(() => server.clients.size > 0)
  const batch = await fake.tools.get('browser_batch').execute(
    { actions: [{ op: 'click', label: 3 }] },
    { callId: 'c-batch-timeout', signal: new AbortController().signal },
  )
  assert.match(batch.content[0].text, /batch: 1 actions · 1 executed without tool errors · 640ms/)

  await assert.rejects(
    () => fake.tools.get('browser_click').execute({ label: 3 }, { callId: 'c-click-timeout', signal: new AbortController().signal }),
    /click timed out after 250ms/,
  )
})

test('per-op timeouts cover navigate, wait_for, and delayed snapshots', async t => {
  const { server, url, commands } = await startFakeBridge({ delays: { batch: 0, navigate: 600, click: 600, wait_for: 600, snapshot: 600 } })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 250 })
  t.after(() => fake.dispose())

  await waitFor(() => server.clients.size > 0)
  const exec = { callId: 'c-op-timeout', signal: new AbortController().signal }
  // A flat timeout killed slow loads mid-flight (2026-10-23: three navigate
  // attempts to a slow university site plus a wait_for that asked for 15s and
  // was cut at 10s). navigate and wait_for get their own deadlines.
  const navigated = await fake.tools.get('browser_navigate').execute({ url: 'https://example.test/admissions' }, exec)
  assert.match(navigated.content[0].text, /navigated to/)
  const waited = await fake.tools.get('browser_wait_for').execute({ text: 'Stanford', timeout_ms: 15_000 }, exec)
  assert.ok(waited.content.length >= 1)
  // With no explicit timeout, the bridge deadline expands from the fixed wait
  // itself instead of cutting a valid long wait off at the configured default.
  const fixedWait = await fake.tools.get('browser_wait_for').execute({ ms: 30_000 }, exec)
  assert.ok(fixedWait.content.length >= 1)
  assert.deepEqual(commands.at(-1), { op: 'wait_for', args: { ms: 30_000 } })
  // browser_screenshot sends the snapshot op, whose delay needs the same kind of
  // extended deadline rather than the 250ms base.
  const snapshot = await fake.tools.get('browser_screenshot').execute({ delay_ms: 5_000 }, exec)
  assert.ok(snapshot.content.length >= 1)
  assert.deepEqual(commands.at(-1), { op: 'snapshot', args: { detail: 'normal', delay_ms: 5_000 } })
  // Everything else keeps the configured deadline.
  await assert.rejects(
    () => fake.tools.get('browser_click').execute({ label: 3 }, exec),
    /click timed out after 250ms/,
  )
})

test('views are numbered and skipped views name their coordinate basis', async t => {
  const { server, url } = await startFakeBridge({
    respond: (op, args) => op === 'snapshot' ? { ...SNAPSHOT, viewId: 7 }
      : op === 'click' ? { ...CLICK, view: 'none', changed: null, basisViewId: 7 }
        : undefined,
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const exec = { callId: 'c-view-id', signal: new AbortController().signal }
  const shot = await fake.tools.get('browser_screenshot').execute({}, exec)
  // The view number is the argument `view_id` takes, so it must be visible.
  assert.match(shot.content[0].text, /; view #7/)

  const skipped = await fake.tools.get('browser_click').execute({ label: 3, view: 'none' }, exec)
  assert.match(skipped.content[0].text, /image coordinates map to view #7/)
})

test('a canvas-editor type result reports dispatched input as UNVERIFIED', async t => {
  const { server, url } = await startFakeBridge({
    respond: op => op === 'type' ? {
      ...TYPE,
      changed: null,
      signals: [],
      typed: {
        dispatched: true,
        chars: 749,
        mode: 'replace',
        submitted: false,
        method: 'trusted',
        canvasEditor: true,
        measured: 'none',
        pageChanged: true,
      },
    } : undefined,
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const value = await fake.tools.get('browser_type').execute(
    { text: 'COLLEGE APPLICATION ESSAY PROMPTS' },
    { callId: 'c-canvas-type', signal: new AbortController().signal },
  )
  const text = value.content.map(block => block.text ?? '').join('\n')
  assert.match(text, /result: input dispatched to the canvas editor; document change is UNVERIFIED/)
  assert.match(text, /pageChanged=true is only a hint, not confirmation/)
  assert.match(text, /Use the returned fresh view for visual confirmation/)
  assert.match(text, /never retry unverified input blindly/)
  assert.doesNotMatch(text, /the field value did not change/)
  assert.doesNotMatch(text, /delivered|applied|value now|measured \+749 chars at page level/)
})

test('read_text on a canvas app explains itself instead of printing chrome text', async t => {
  const { server, url } = await startFakeBridge({
    respond: op => op === 'read_text' ? {
      ...READ_TEXT,
      text: '',
      totalChars: 0,
      textUnreliable: true,
      canvasApp: 'Google Docs',
      note: 'Google Docs renders its content to a canvas, so DOM text is unreliable here. Use browser_screenshot and the tab sidebar labels instead.',
      domText: 'Skip to content Inbox 1 visible tab named Tab 1',
    } : undefined,
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const value = await fake.tools.get('browser_read_text').execute({}, { callId: 'c-canvas-text', signal: new AbortController().signal })
  const text = value.content.map(block => block.text ?? '').join('\n')
  assert.match(text, /text unavailable — Google Docs renders its content to a canvas/)
  assert.match(text, /DOM text \(unreliable/)
  assert.doesNotMatch(text, /\[no rendered text found\]/)
  assert.doesNotMatch(text, /next_offset/)
})

test('a skipped-view action with a moved layout warns that coordinates are stale', async t => {
  const { server, url } = await startFakeBridge({
    respond: op => op === 'click' ? {
      ...CLICK,
      view: 'none',
      changed: null,
      layoutChanged: true,
      layoutShift: { maxDx: 0, maxDy: 75, movedCount: 7, structural: false },
    } : undefined,
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const value = await fake.tools.get('browser_click').execute({ label: 3, view: 'none' }, { callId: 'c-layout', signal: new AbortController().signal })
  const text = value.content.map(block => block.text ?? '').join('\n')
  assert.match(text, /layout moved since your last view \(7 elements\)/)
  assert.match(text, /up to 75px vertically/)
  assert.match(text, /coordinates you have are stale/)
})

test('click_at forwards view_id and reports the basis it mapped through', async t => {
  const { server, url, commands } = await startFakeBridge({
    respond: op => op === 'click_at' ? {
      ...CLICK_AT,
      basis: { viewId: 18, imageWidth: 640, imageHeight: 453, cssPerImagePx: 2.042 },
      basisAmbiguousWith: [{ viewId: 12, imageWidth: 1280, imageHeight: 906, cssX: 504, cssY: 1048, dx: 302, dy: 0 }],
    } : undefined,
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const exec = { callId: 'c-basis', signal: new AbortController().signal }
  const value = await fake.tools.get('browser_click_at').execute({ x: 100, y: 200, view_id: 18 }, exec)
  const forwarded = commands.find(command => command.op === 'click_at')
  assert.equal(forwarded.args.view_id, 18)
  const text = value.content.map(block => block.text ?? '').join('\n')
  assert.match(text, /mapped through view #18 \(640x453 image, css\/imagePx 2.042\)/)
  assert.match(text, /if you measured on view #12 \(1280x906 image\), this point lands about 302px away/)

  await assert.rejects(
    () => fake.tools.get('browser_click_at').execute({ x: 100, y: 200, view_id: 0 }, exec),
    /view_id must be a positive integer/,
  )
})

test('select tool reports the range and its preview', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_select')
  assert.equal(definition.name, 'browser_select')
  const value = await definition.execute({
    from: { x: 100, y: 100 },
    to: { x: 500, y: 200 },
  }, { callId: 'c-sel', signal: new AbortController().signal })
  assert.equal(value.content[0].type, 'text')
  assert.match(value.content[0].text, /selected 128 chars from \(100, 100\) to \(500, 200\) · "Bold heading text and more content"/)
  assert.equal(value.content[1].type, 'image')
  assert.deepEqual(commands.at(-1), { op: 'select', args: { from: { x: 100, y: 100 }, to: { x: 500, y: 200 } } })
})

test('canvas selection reports drag dispatch as UNVERIFIED', async t => {
  const { server, url } = await startFakeBridge({
    respond: op => op === 'select' ? {
      ...SELECT_RANGE,
      changed: null,
      signals: [],
      selected: {
        from: SELECT_RANGE.selected.from,
        to: SELECT_RANGE.selected.to,
        verified: false,
        collapsed: null,
      },
    } : undefined,
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const value = await fake.tools.get('browser_select').execute({
    from: { x: 100, y: 100 },
    to: { x: 500, y: 200 },
  }, { callId: 'c-sel-canvas', signal: new AbortController().signal })
  const text = value.content.map(block => block.text ?? '').join('\n')
  assert.match(text, /selection drag dispatched from \(100, 100\) to \(500, 200\); selection UNVERIFIED/)
  assert.match(text, /Before formatting or deleting, use the returned full fresh view to visually confirm the intended range/)
  assert.match(text, /Do not retry the drag blindly/)
  assert.doesNotMatch(text, /selection changed|selection collapsed|selected \d+ chars|NO VISIBLE CHANGE/)
  assert.equal(value.content[1].type, 'image')
})

test('select tool reports a collapsed selection', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const value = await fake.tools.get('browser_select').execute({
    from: { x: 10, y: 10 },
    to: { x: 10, y: 10 },
  }, { callId: 'c-sel-collapse', signal: new AbortController().signal })
  assert.match(value.content[0].text, /selection collapsed \(nothing selected\)/)
  assert.equal(value.content[1].type, 'image')
})

test('select compact and none views stay text only', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const exec = { callId: 'c-sel-view', signal: new AbortController().signal }
  const compact = await fake.tools.get('browser_select').execute({
    from: { x: 100, y: 100 },
    to: { x: 500, y: 200 },
    view: 'compact',
  }, exec)
  assert.equal(compact.content.length, 1)
  assert.match(compact.content[0].text, /selected 128 chars from \(100, 100\) to \(500, 200\)/)
  assert.match(compact.content[0].text, /labels unchanged \(42\)/)
  assert.match(compact.content[0].text, /view: compact — no screenshot returned/)
  assert.deepEqual(commands.at(-1), {
    op: 'select',
    args: { from: { x: 100, y: 100 }, to: { x: 500, y: 200 }, view: 'compact' },
  })

  const none = await fake.tools.get('browser_select').execute({
    from: { x: 100, y: 100 },
    to: { x: 500, y: 200 },
    view: 'none',
  }, exec)
  assert.equal(none.content.length, 1)
  assert.match(none.content[0].text, /selected 128 chars from \(100, 100\) to \(500, 200\)/)
  assert.match(none.content[0].text, /view: skipped — no screenshot returned/)
  assert.doesNotMatch(none.content[0].text, /labels unchanged/)
})

test('select validation rejects bad points, space, and view', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_select')
  const exec = { callId: 'c-sel-bad', signal: new AbortController().signal }
  await assert.rejects(() => definition.execute({}, exec), /requires a from point/)
  await assert.rejects(() => definition.execute({ from: 5, to: { x: 1, y: 2 } }, exec), /requires a from point/)
  await assert.rejects(() => definition.execute({ from: { x: 1, y: 2 } }, exec), /requires a to point/)
  await assert.rejects(
    () => definition.execute({ from: { x: 'a', y: 2 }, to: { x: 1, y: 2 } }, exec),
    /from requires finite x and y/,
  )
  await assert.rejects(
    () => definition.execute({ from: { x: 1, y: 2 }, to: { x: 1, y: 2 }, space: 'viewport' }, exec),
    /space must be "image" or "css"/,
  )
  await assert.rejects(
    () => definition.execute({ from: { x: 1, y: 2 }, to: { x: 1, y: 2 }, view: 'mid' }, exec),
    /view must be one of auto, full, compact, none/,
  )
})

test('batch accepts select and formats range and collapsed lines', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const actions = [
    { op: 'select', from: { x: 100, y: 100 }, to: { x: 500, y: 200 } },
    { op: 'select', from: { x: 10, y: 10 }, to: { x: 10, y: 10 } },
    { op: 'press_key', key: 'KeyB', modifiers: ['ctrl'] },
  ]
  const value = await fake.tools.get('browser_batch').execute(
    { actions },
    { callId: 'c-batch-select', signal: new AbortController().signal },
  )
  assert.equal(value.content.length, 1)
  const text = value.content[0].text
  assert.match(text, /batch: 3 actions · 3 executed without tool errors · 580ms/)
  assert.match(text, /  \[1\] select 128 chars · changed/)
  assert.match(text, /  \[2\] select · collapsed/)
  assert.match(text, /  \[3\] press_key KeyB · changed/)
  assert.match(text, /labels unchanged \(41\)/)
  assert.match(text, /view: compact — no screenshot returned/)
  assert.deepEqual(commands.at(-1), {
    op: 'batch',
    args: {
      actions: [
        { op: 'select', args: { from: { x: 100, y: 100 }, to: { x: 500, y: 200 } } },
        { op: 'select', args: { from: { x: 10, y: 10 }, to: { x: 10, y: 10 } } },
        { op: 'press_key', args: { key: 'KeyB', modifiers: ['ctrl'] } },
      ],
    },
  })
})

test('press_key accepts composite chords and merges explicit modifiers', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_press_key')
  assert.match(definition.description, /shift\+Tab/)
  assert.match(definition.parameters.properties.key.description, /composite chord/)
  const exec = { callId: 'c-chord', signal: new AbortController().signal }

  const shifted = await definition.execute({ key: 'shift+Tab' }, exec)
  assert.match(shifted.content[0].text, /pressed ctrl\+KeyA · trusted/)
  assert.deepEqual(commands.at(-1), { op: 'press_key', args: { key: 'Tab', modifiers: ['shift'] } })

  await definition.execute({ key: 'ctrl+Shift+ArrowLeft' }, exec)
  assert.deepEqual(commands.at(-1), { op: 'press_key', args: { key: 'ArrowLeft', modifiers: ['ctrl', 'shift'] } })

  await definition.execute({ key: 'meta+Enter', modifiers: ['ctrl'] }, exec)
  assert.deepEqual(commands.at(-1), { op: 'press_key', args: { key: 'Enter', modifiers: ['meta', 'ctrl'] } })

  // Explicit modifiers merge with chord modifiers without duplicates.
  await definition.execute({ key: 'shift+Tab', modifiers: ['shift', 'alt'] }, exec)
  assert.deepEqual(commands.at(-1), { op: 'press_key', args: { key: 'Tab', modifiers: ['shift', 'alt'] } })

  // The literal plus key is not a chord.
  await definition.execute({ key: '+' }, exec)
  assert.deepEqual(commands.at(-1), { op: 'press_key', args: { key: '+' } })

  await assert.rejects(() => definition.execute({ key: 'hyper+Tab' }, exec), /unknown modifier "hyper"/)
  await assert.rejects(() => definition.execute({ key: 'ctrl+' }, exec), /must end with exactly one key name/)
  await assert.rejects(() => definition.execute({ key: 'ctrl+Alt+Tab+Enter' }, exec), /unknown modifier "Tab"/)
  await assert.rejects(() => definition.execute({ key: 'ctrl+Tab', modifiers: ['hyper'] }, exec), /not one of ctrl, alt, shift, meta/)
})

test('batch normalizes composite press_key chords before forwarding', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_batch')
  const value = await definition.execute({
    actions: [
      { op: 'press_key', key: 'shift+Tab' },
      { op: 'press_key', args: { key: 'ctrl+Shift+ArrowLeft', modifiers: ['shift'] } },
    ],
  }, { callId: 'c-batch-chord', signal: new AbortController().signal })
  assert.match(value.content[0].text, /batch: 2 actions · 2 executed without tool errors/)
  assert.deepEqual(commands.at(-1), {
    op: 'batch',
    args: {
      actions: [
        { op: 'press_key', args: { key: 'Tab', modifiers: ['shift'] } },
        { op: 'press_key', args: { key: 'ArrowLeft', modifiers: ['ctrl', 'shift'] } },
      ],
    },
  })

  await assert.rejects(
    () => definition.execute({ actions: [{ op: 'press_key', key: 'hyper+Tab' }] }, { callId: 'c-batch-bad-chord', signal: new AbortController().signal }),
    /actions\[0\] press_key key "hyper\+Tab" has unknown modifier/,
  )
})

test('click_at surfaces off-screen points without counting them as misses', async t => {
  const { server, url } = await startFakeBridge({
    respond: (op, args) => op !== 'click_at' ? undefined
      : !Array.isArray(args.points) || args.points.length === 1 ? CLICK_AT_OFFSCREEN_SINGLE
        : CLICK_AT_OFFSCREEN,
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_click_at')
  const exec = { callId: 'c-offscreen', signal: new AbortController().signal }
  const multi = await definition.execute({ points: [{ x: 100, y: 200 }, { x: 300, y: 400 }, { x: 900, y: 700 }] }, exec)
  const text = multi.content[0].text
  assert.match(text, /clicked 3 points with trusted input in 210ms/)
  assert.match(text, /  \[1\] \(100, 200\) image → css \(80, 160\) · changed 1\.4%/)
  assert.match(text, /  \[3\] \(900, 700\) image → css \(720, 560\) · off-screen \(not clicked\)/)
  assert.match(text, /2\/2 points changed pixels/)
  assert.match(text, /1 point\(s\) were outside the visible viewport \(page scrolled\/clipped\) — scroll and take a fresh view/)
  assert.match(text, /warning: the page scrolled 60px since the last view — image coordinates are stale; take a fresh view before clicking again/)
  assert.doesNotMatch(text, /2\/3 points changed/)
  assert.doesNotMatch(text, /NO VISIBLE CHANGE/)

  const single = await definition.execute({ x: 900, y: 700 }, exec)
  const singleText = single.content[0].text
  assert.match(singleText, /result: the point was outside the visible viewport and was not clicked/)
  assert.match(singleText, /1 point\(s\) were outside the visible viewport \(page scrolled\/clipped\)/)
  assert.doesNotMatch(singleText, /NO VISIBLE CHANGE/)
})

test('click reports when it scrolled the page and asks for a fresh view', async t => {
  let clickCalls = 0
  const { server, url } = await startFakeBridge({
    respond: op => op !== 'click' ? undefined : clickCalls++ === 0 ? CLICK_SCROLLED : CLICK_SCROLLED_SMALL,
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_click')
  const exec = { callId: 'c-scrolled', signal: new AbortController().signal }
  const scrolled = await definition.execute({ label: 3 }, exec)
  assert.match(scrolled.content[0].text, /page scrolled 120px to reach the element; re-take a view before coordinate clicks/)
  const small = await definition.execute({ label: 9 }, exec)
  assert.doesNotMatch(small.content[0].text, /page scrolled/)
})

test('clipboard copy stores the selection or a label and reports a preview', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const tool = fake.tools.get('browser_clipboard')
  const exec = { callId: 'c-copy', signal: new AbortController().signal }
  const copy = await tool.execute({ action: 'copy' }, exec)
  assert.deepEqual(commands.at(-1), { op: 'clipboard', args: { action: 'copy', target: 'virtual', source: 'selection' } })
  assert.equal(copy.content.length, 1, 'copy is text only')
  assert.match(copy.content[0].text, /copied 1234 chars from the page selection to the virtual clipboard/)
  assert.match(copy.content[0].text, /preview: "Selected article opening sentence/)
  assert.match(copy.content[0].text, /action:"paste"/)

  const label = await tool.execute({ action: 'copy', label: 9 }, exec)
  assert.deepEqual(commands.at(-1), { op: 'clipboard', args: { action: 'copy', target: 'virtual', source: 'label', label: 9 } })
  assert.match(label.content[0].text, /copied 24 chars from label 9 to the virtual clipboard/)

  const system = await tool.execute({ action: 'copy', target: 'system' }, exec)
  assert.deepEqual(commands.at(-1), { op: 'clipboard', args: { action: 'copy', target: 'system', source: 'selection' } })
  assert.match(system.content[0].text, /to the system clipboard/)
})

test('clipboard read returns virtual text and reads the system clipboard only when asked', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const tool = fake.tools.get('browser_clipboard')
  const exec = { callId: 'c-read', signal: new AbortController().signal }
  const virtual = await tool.execute({ action: 'read' }, exec)
  assert.deepEqual(commands.at(-1), { op: 'clipboard', args: { action: 'read', target: 'virtual' } })
  assert.equal(virtual.content.length, 1, 'read is text only')
  assert.match(virtual.content[0].text, /read 1234 chars from the virtual clipboard/)
  assert.match(virtual.content[0].text, /returned the first 24 chars; the clipboard holds more/)
  assert.match(virtual.content[0].text, /source: the page selection/)
  assert.match(virtual.content[0].text, /ALPHA-MARKER\nBETA-MARKER/)

  const system = await tool.execute({ action: 'read', target: 'system' }, exec)
  assert.deepEqual(commands.at(-1), { op: 'clipboard', args: { action: 'read', target: 'system' } })
  assert.match(system.content[0].text, /read 24 chars from the system clipboard/)
  assert.match(system.content[0].text, /CLIPBOARD-SYSTEM-MARKER/)
  assert.doesNotMatch(system.content[0].text, /the clipboard holds more/)
})

test('clipboard write stores text and clear empties the virtual clipboard', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const tool = fake.tools.get('browser_clipboard')
  const exec = { callId: 'c-write', signal: new AbortController().signal }
  const write = await tool.execute({ action: 'write', text: 'hello world' }, exec)
  assert.deepEqual(commands.at(-1), { op: 'clipboard', args: { action: 'write', target: 'virtual', text: 'hello world' } })
  assert.match(write.content[0].text, /wrote 11 chars to the virtual clipboard/)
  assert.match(write.content[0].text, /preview: "hello world"/)

  const clear = await tool.execute({ action: 'clear' }, exec)
  assert.deepEqual(commands.at(-1), { op: 'clipboard', args: { action: 'clear', target: 'virtual' } })
  assert.equal(clear.content[0].text, 'cleared the virtual clipboard')
})

test('clipboard paste reports text pastes and trusted system Ctrl+V pastes', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const tool = fake.tools.get('browser_clipboard')
  const exec = { callId: 'c-paste', signal: new AbortController().signal }
  const pasted = await tool.execute({ action: 'paste', label: 7, mode: 'append' }, exec)
  assert.deepEqual(commands.at(-1), { op: 'clipboard', args: { action: 'paste', target: 'virtual', label: 7, mode: 'append' } })
  assert.equal(pasted.content.length, 2, 'the full paste view includes the image')
  assert.match(pasted.content[0].text, /pasted 16 chars from the virtual clipboard into \[7\] · append/)
  assert.match(pasted.content[0].text, /value now "jane@example.com"/)

  const compact = await tool.execute({ action: 'paste', view: 'compact' }, exec)
  assert.deepEqual(commands.at(-1), { op: 'clipboard', args: { action: 'paste', target: 'virtual', view: 'compact' } })
  assert.equal(compact.content.length, 1, 'compact paste is text only')
  assert.match(compact.content[0].text, /view: compact/)

  const rich = await tool.execute({ action: 'paste', target: 'system', label: 7 }, exec)
  assert.deepEqual(commands.at(-1), { op: 'clipboard', args: { action: 'paste', target: 'system', label: 7 } })
  assert.equal(rich.content.length, 2)
  assert.match(rich.content[0].text, /pasted the system clipboard into \[7\] via a trusted Ctrl\+V/)
  assert.match(rich.content[0].text, /the page inserted the rich content/)

  const systemText = await tool.execute({ action: 'paste', target: 'system', rich: false }, exec)
  assert.deepEqual(commands.at(-1), { op: 'clipboard', args: { action: 'paste', target: 'system', rich: false } })
  assert.match(systemText.content[0].text, /pasted 24 chars from the system clipboard into \[7\] · append/)
})

test('clipboard validation rejects bad calls before the bridge', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const tool = fake.tools.get('browser_clipboard')
  const exec = { callId: 'c-bad', signal: new AbortController().signal }
  const rejected = [
    [{}, /action must be one of/],
    [{ action: 'cut' }, /action must be one of/],
    [{ action: 'copy', target: 'disk' }, /target must be/],
    [{ action: 'copy', source: 'clipboard' }, /source must be/],
    [{ action: 'copy', source: 'label' }, /requires a label/],
    [{ action: 'copy', source: 'selection', label: 3 }, /only valid with copy source/],
    [{ action: 'read', source: 'label' }, /only valid with action "copy"/],
    [{ action: 'read', label: 3 }, /label is only valid/],
    [{ action: 'read', text: 'x' }, /text is only valid with action "write"/],
    [{ action: 'write' }, /requires a string text/],
    [{ action: 'write', text: 42 }, /requires a string text/],
    [{ action: 'write', text: '' }, /non-empty text/],
    [{ action: 'write', text: 'x'.repeat(100_001) }, /at most 100000/],
    [{ action: 'paste', mode: 'overwrite' }, /mode must be/],
    [{ action: 'read', mode: 'append' }, /mode is only valid/],
    [{ action: 'paste', rich: 'yes' }, /rich must be true or false/],
    [{ action: 'read', submit: true }, /submit is only valid/],
    [{ action: 'clear', target: 'system' }, /only empties the virtual clipboard/],
  ]
  for (const [args, pattern] of rejected) {
    await assert.rejects(() => tool.execute(args, exec), pattern, `expected ${JSON.stringify(args)} to be rejected`)
  }
  assert.equal(commands.length, 0, 'validation never reaches the bridge')
})

test('bridge failures keep the companion error code', async t => {
  const { server, url } = await startFakeBridge({
    failures: { click: { code: 'SIDE_PANEL_CLOSED', message: 'the side panel closed mid-command' } },
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  await assert.rejects(
    () => fake.tools.get('browser_click').execute({ label: 3 }, { callId: 'c-code', signal: new AbortController().signal }),
    error => {
      assert.equal(error.code, 'SIDE_PANEL_CLOSED')
      assert.match(error.message, /side panel closed mid-command/)
      return true
    },
  )
})

test('there is no per-turn call limit', async t => {
  const { server, url, commands, logEvents } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  // A legacy config value must be ignored: turns are unlimited by design. One
  // real task (ten university prompts, ten renamed document tabs) needs 80+
  // calls, and refusing call 81 discarded the working state.
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000, maxToolCallsPerTurn: 2 })
  t.after(() => fake.dispose())

  await waitFor(() => server.clients.size > 0)
  const click = fake.tools.get('browser_click')
  const exec = { callId: 'c-unlimited', signal: new AbortController().signal }
  for (let label = 1; label <= 60; label++) {
    const result = await click.execute({ label, view: 'none' }, exec)
    assert.ok(result.content.length >= 1)
  }
  assert.equal(commands.filter(command => command.op === 'click').length, 60)
  assert.equal(logEvents.filter(event => /^tool\.budget/.test(event.type)).length, 0)
  assert.equal(logEvents.filter(event => event.type === 'tool.loop.detected').length, 0)
})

test('observation repeats are allowed far past the mutating limit', async t => {
  const { server, url, logEvents } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000, maxRepeatedCalls: 3, maxObservationRepeats: 5 })
  t.after(() => fake.dispose())

  await waitFor(() => server.clients.size > 0)
  const screenshot = fake.tools.get('browser_screenshot')
  const exec = { callId: 'c-observe', signal: new AbortController().signal }
  // Watching asynchronous page state is normal usage: identical screenshots are
  // how the agent verifies a render, so they must not trip the 3-call breaker
  // that protects mutating actions (2026-10-23: a Docs rename could not be
  // verified because the third identical screenshot was refused).
  for (let index = 0; index < 5; index++) {
    assert.ok((await screenshot.execute({ detail: 'fast' }, exec)).content.length >= 1)
  }
  await assert.rejects(() => screenshot.execute({ detail: 'fast' }, exec), /LOOP_DETECTED/)
  const docsRead = fake.tools.get('browser_docs_read')
  for (let index = 0; index < 4; index++) assert.ok((await docsRead.execute({ format: 'outline' }, exec)).content.length >= 1)
  await waitFor(() => logEvents.some(event => event.type === 'tool.loop.detected'))
  const loop = logEvents.find(event => event.type === 'tool.loop.detected')
  assert.equal(loop.data.observation, true)
  assert.equal(loop.data.max, 5)
})

test('only unmodified navigation keys get the relaxed repeat allowance', async t => {
  const { server, url, logEvents } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000, maxRepeatedCalls: 2, maxNavigationRepeats: 4 })
  t.after(() => fake.dispose())

  await waitFor(() => server.clients.size > 0)
  const press = fake.tools.get('browser_press_key')
  assert.equal(press.parameters.properties.repeat, undefined)
  const exec = { callId: 'c-keys', signal: new AbortController().signal }
  const safeForms = [
    { key: 'ArrowDown' },
    { key: 'ArrowDown', modifiers: [] },
  ]
  for (const args of safeForms) {
    for (let index = 0; index < 4; index++) {
      assert.ok((await press.execute({ ...args }, exec)).content.length >= 1)
    }
    await assert.rejects(() => press.execute({ ...args }, exec), /LOOP_DETECTED/)
  }

  // Composite chords and modifier arrays must normalize to the same strict
  // classification. Shift selection is not navigation-safe.
  const strictForms = [
    { key: 'shift+ArrowDown' },
    { key: 'ArrowDown', modifiers: ['shift'] },
    { key: 'shift+Home' },
    { key: 'End', modifiers: ['SHIFT'] },
    { key: 'ctrl+ArrowDown' },
    { key: 'Home', modifiers: ['alt'] },
    { key: 'End', modifiers: ['meta'] },
    { key: 'Enter' },
  ]
  for (const args of strictForms) {
    for (let index = 0; index < 2; index++) {
      assert.ok((await press.execute({ ...args }, exec)).content.length >= 1)
    }
    await assert.rejects(() => press.execute({ ...args }, exec), /LOOP_DETECTED/)
  }

  const expectedLoops = safeForms.length + strictForms.length
  await waitFor(() => logEvents.filter(event => event.type === 'tool.loop.detected').length >= expectedLoops)
  const loops = logEvents.filter(event => event.type === 'tool.loop.detected')
  assert.equal(loops.length, expectedLoops)
  assert.deepEqual(loops.map(event => event.data.navigation), [
    ...safeForms.map(() => true),
    ...strictForms.map(() => false),
  ])
  assert.deepEqual(loops.map(event => event.data.max), [
    ...safeForms.map(() => 4),
    ...strictForms.map(() => 2),
  ])
})

test('a new user message resets repeat fingerprints even at the same numeric turn', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  await waitFor(() => server.clients.size > 0)
  const click = fake.tools.get('browser_click')
  const exec = { callId: 'c-reset', signal: new AbortController().signal }
  const claimed = fake.listeners.get('agent/inbox/claimed')
  claimed({ message: { id: 'session-a-message-1', content: [{ type: 'text', text: 'click it' }] }, turn: 1 })
  await click.execute({ label: 3 }, exec)
  await click.execute({ label: 3 }, exec)
  await click.execute({ label: 3 }, exec)
  await assert.rejects(() => click.execute({ label: 3 }, exec), /LOOP_DETECTED/)

  claimed({ message: { id: 'session-b-message-1', content: [{ type: 'text', text: 'click it again' }] }, turn: 1 })
  assert.ok((await click.execute({ label: 3 }, exec)).content.length >= 1)
  assert.equal(commands.filter(command => command.op === 'click').length, 4)
})

test('repeated identical calls fail with LOOP_DETECTED', async t => {
  const { server, url, commands, logEvents } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  await waitFor(() => server.clients.size > 0)
  const click = fake.tools.get('browser_click')
  const exec = { callId: 'c-loop', signal: new AbortController().signal }
  assert.ok((await click.execute({ label: 3 }, exec)).content.length >= 1)
  assert.ok((await click.execute({ label: 3 }, exec)).content.length >= 1)
  assert.ok((await click.execute({ label: 3 }, exec)).content.length >= 1)
  await assert.rejects(() => click.execute({ label: 3 }, exec), /LOOP_DETECTED/)
  assert.equal(commands.filter(command => command.op === 'click').length, 3)
  await waitFor(() => logEvents.some(event => event.type === 'tool.loop.detected'))

  // A different successful mutation starts a new repeat series, so routine
  // Enter/Ctrl+F/toolbar reuse later in the task is not a loop.
  assert.ok((await click.execute({ label: 9 }, exec)).content.length >= 1)
  assert.ok((await click.execute({ label: 3 }, exec)).content.length >= 1)
  assert.equal(commands.filter(command => command.op === 'click').length, 5)
})

test('Docs semantic loop guard covers validation failures and singleton batch aliases', async t => {
  const { server, url, commands, logEvents } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const exec = { callId: 'c-docs-loop', signal: new AbortController().signal }
  await assert.rejects(() => fake.tools.get('browser_docs_replace_text').execute({ replacement: '' }, exec), /text must be a non-empty string/)
  await assert.rejects(() => fake.tools.get('browser_docs').execute({ action: 'replace_text', replacement: '' }, exec), /only supports action/)
  await assert.rejects(() => fake.tools.get('browser_docs_replace_many').execute({ edits: [{ replacement: '' }] }, exec), /text must be a non-empty string/)
  await assert.rejects(
    () => fake.tools.get('browser_docs_replace_text').execute({ replacement: '' }, exec),
    /LOOP_DETECTED.*Do not switch replacement tools, batching modes, or targets.*Stop and report/,
  )
  assert.equal(commands.length, 0)
  await waitFor(() => logEvents.some(event => event.type === 'tool.loop.detected' && event.data.semanticTool === 'browser_docs_replace_text'))
})

test('Docs failure circuit stops cascades and resets on a new turn or success', async t => {
  const failures = { docs: { code: 'DOCS_MATCH_NOT_UNIQUE', message: 'missing target' } }
  const { server, url, commands, logEvents } = await startFakeBridge({
    failures,
    respond: (op, args) => op === 'docs' ? {
      ...DOCS_SET_FONT,
      docs: {
        action: args.action,
        status: args.action === 'replace_many' ? 'completed' : 'removed_text',
        matchCount: 0,
        appliedCount: args.action === 'replace_many' ? args.edits.length : undefined,
        editCount: args.action === 'replace_many' ? args.edits.length : undefined,
        remainingCount: 0,
        verifiedBy: 'find-counter',
      },
    } : undefined,
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())
  const tool = fake.tools.get('browser_docs_replace_text')
  const exec = { callId: 'c-docs-circuit', signal: new AbortController().signal }
  let index = 0
  const attempt = () => tool.execute({ text: `target-${index++}`, replacement: '' }, exec)

  for (let i = 0; i < 3; i += 1) await assert.rejects(attempt, /missing target/)
  await assert.rejects(attempt, /DOCS_FAILURE_CIRCUIT.*Stop and report/)
  assert.equal(commands.length, 3)

  fake.listeners.get('agent/inbox/claimed')({ message: { content: [{ type: 'text', text: 'new turn' }] }, turn: 2 })
  for (let i = 0; i < 2; i += 1) await assert.rejects(attempt, /missing target/)
  failures.docs = undefined
  await attempt()
  failures.docs = { code: 'DOCS_MATCH_NOT_UNIQUE', message: 'missing target' }
  for (let i = 0; i < 3; i += 1) await assert.rejects(attempt, /missing target/)
  await assert.rejects(attempt, /DOCS_FAILURE_CIRCUIT/)
  assert.equal(commands.length, 9)
  await waitFor(() => logEvents.filter(event => event.type === 'docs.failure.circuit').length === 2)
})

test('Auto reasoning stays low after consecutive no-progress results', async t => {
  const { server, url, logEvents } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  await waitFor(() => server.clients.size > 0)
  const claimed = fake.listeners.get('agent/inbox/claimed')
  claimed({ message: { content: [{ type: 'text', text: 'click the Bold button' }] }, turn: 1 })
  const request = fake.listeners.get('agent/request')
  const next = async () => ({ reasoningEffort: 'medium' })
  const payload = { agent: { session: { id: 'session-escalate' } }, turn: 1 }
  assert.equal((await request(payload, next)).reasoningEffort, 'low')

  const session = { id: 'session-escalate', surface: { nodes: [] } }
  const result = data => fake.listeners.get('session/event')(session, { type: 'tool/result', data })
  result({ turn: 1, message: { content: [{ type: 'text', text: 'Error: no such label' }], isError: true } })
  result({ turn: 1, message: { content: [{ type: 'text', text: 'result: NO VISIBLE CHANGE — the pixels did not change.' }] } })
  assert.equal((await request(payload, next)).reasoningEffort, 'low')

  result({ turn: 1, message: { content: [{ type: 'text', text: 'Error: still stuck' }], isError: true } })
  assert.equal((await request(payload, next)).reasoningEffort, 'low')
  assert.ok(!logEvents.some(event => event.type === 'reasoning.escalated'))
})

test('Auto reasoning stays low across successful and failed results', async t => {
  const { server, url, logEvents } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  await waitFor(() => server.clients.size > 0)
  fake.listeners.get('agent/inbox/claimed')({ message: { content: [{ type: 'text', text: 'click the Bold button' }] }, turn: 1 })
  const request = fake.listeners.get('agent/request')
  const next = async () => ({ reasoningEffort: 'medium' })
  const payload = { agent: { session: { id: 'session-reset' } }, turn: 1 }
  const session = { id: 'session-reset', surface: { nodes: [] } }
  const result = data => fake.listeners.get('session/event')(session, { type: 'tool/result', data })

  assert.equal((await request(payload, next)).reasoningEffort, 'low')
  result({ turn: 1, message: { content: [{ type: 'text', text: 'Error: no such label' }], isError: true } })
  result({ turn: 1, message: { content: [{ type: 'text', text: 'Error: no such label again' }], isError: true } })
  result({ turn: 1, message: { content: [{ type: 'text', text: 'clicked label 3: button "Bold"' }] } })
  result({ turn: 1, message: { content: [{ type: 'text', text: 'Error: still stuck' }], isError: true } })
  result({ turn: 1, message: { content: [{ type: 'text', text: 'Error: still stuck' }], isError: true } })
  assert.equal((await request(payload, next)).reasoningEffort, 'low')
  result({ turn: 1, message: { content: [{ type: 'text', text: 'Error: now three in a row' }], isError: true } })
  assert.equal((await request(payload, next)).reasoningEffort, 'low')
  assert.ok(!logEvents.some(event => event.type === 'reasoning.escalated'))
})

test('a manual reasoning policy is never escalated', async t => {
  const { server, url, logEvents } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000, reasoningPolicy: 'off' })
  t.after(() => fake.dispose())

  await waitFor(() => server.clients.size > 0)
  fake.listeners.get('agent/inbox/claimed')({ message: { content: [{ type: 'text', text: 'click the Bold button' }] }, turn: 1 })
  const request = fake.listeners.get('agent/request')
  const next = async () => ({ reasoningEffort: 'medium' })
  const payload = { agent: { session: { id: 'session-manual' } }, turn: 1 }
  const session = { id: 'session-manual', surface: { nodes: [] } }
  const result = data => fake.listeners.get('session/event')(session, { type: 'tool/result', data })

  assert.equal((await request(payload, next)).reasoningEffort, 'off')
  for (const text of ['Error: one', 'Error: two', 'Error: three']) {
    result({ turn: 1, message: { content: [{ type: 'text', text }], isError: true } })
  }
  assert.equal((await request(payload, next)).reasoningEffort, 'off')
  assert.ok(!logEvents.some(event => event.type === 'reasoning.escalated'))
})

function makeImageSession(seqs) {
  const offloaded = new Set()
  const appended = []
  const session = {
    id: 'image-session',
    surface: { nodes: seqs },
    eventAt: seq => ({ type: 'tool/result', seq }),
    deriveEventMessage: node => ({
      content: [{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg', offloaded: offloaded.has(node.seq) }],
    }),
    append: (type, data) => {
      appended.push({ type, data })
      if (type === 'image/offload') {
        for (const target of data.targets) offloaded.add(target.seq)
      }
      return { seq: 1000 + appended.length }
    },
  }
  return { session, appended, offloaded }
}

test('midturn image pruning uses hysteresis and turn/end still prunes', async t => {
  const { server, url, logEvents } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  await waitFor(() => server.clients.size > 0)
  const imageSession = makeImageSession(Array.from({ length: 11 }, (_, index) => index + 1))
  const handler = fake.listeners.get('session/event')
  const toolResult = () => handler(imageSession.session, {
    type: 'tool/result',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok' }] } },
  })

  // 11 live images > keep(2) + gap(8): the first mid-turn pass prunes down to 2.
  toolResult()
  await waitFor(() => imageSession.appended.length === 1)
  assert.equal(imageSession.appended[0].type, 'image/offload')
  assert.deepEqual(imageSession.appended[0].data.targets.map(target => target.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  await waitFor(() => logEvents.some(event => event.type === 'image.budget.midturn'))
  assert.deepEqual(logEvents.find(event => event.type === 'image.budget.midturn').data, {
    before: 11,
    after: 2,
    offloaded: 9,
    keep: 2,
    threshold: 8,
    targets: 9,
  })

  // Hysteresis: 8 new screenshots reach keep + 8 but do not cross it.
  for (const seq of [12, 13, 14, 15, 16, 17, 18, 19]) imageSession.session.surface.nodes.push(seq)
  toolResult()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(imageSession.appended.length, 1)

  // The ninth new screenshot crosses the gap and offloads back down to keep.
  imageSession.session.surface.nodes.push(20)
  toolResult()
  await waitFor(() => imageSession.appended.length === 2)
  assert.deepEqual(imageSession.appended[1].data.targets.map(target => target.seq), [10, 11, 12, 13, 14, 15, 16, 17, 18])

  // turn/end still prunes exactly to imageHistoryKeep without the hysteresis gap.
  for (const seq of [21, 22, 23]) imageSession.session.surface.nodes.push(seq)
  handler(imageSession.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await waitFor(() => imageSession.appended.length === 3)
  assert.equal(imageSession.appended[2].type, 'image/offload')
  assert.deepEqual(imageSession.appended[2].data.targets.map(target => target.seq), [19, 20, 21])
  await waitFor(() => logEvents.some(event => event.type === 'image.budget'))
  assert.deepEqual(logEvents.find(event => event.type === 'image.budget').data, {
    live: 5,
    offloaded: 3,
    keep: 2,
    targets: 3,
  })
})
