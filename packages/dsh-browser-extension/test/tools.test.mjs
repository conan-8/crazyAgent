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

test('registers the provider, guidance, and the sixteen browser tools', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  assert.equal(String(fake.getProvider()), 'extension-current-window')
  assert.deepEqual([...fake.tools.keys()].sort(), [
    'browser_batch',
    'browser_click',
    'browser_click_at',
    'browser_clipboard',
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
  assert.equal(fake.sections.length, 1)
  const guidance = fake.sections[0].text
  assert.match(guidance, /untrusted data/)
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
  assert.match(guidance, /verify the current state in a fresh view before undoing/)
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
  await assert.rejects(() => definition.execute({}, exec), /requires x and y, or a non-empty points array/)
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

test('wait_for validation requires a condition and bounded values', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_wait_for')
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
  assert.match(text, /batch: 3 actions · 3 succeeded · 1240ms/)
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
  assert.match(nested.content[0].text, /batch: 3 actions · 3 succeeded · 1240ms/)
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
  assert.match(text, /batch: 4 actions · 3 succeeded · 400ms/)
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
  assert.match(text, /batch: 2 actions · 2 succeeded · 480ms/)
  assert.match(text, /  \[1\] click_at 2 points · dispatched/)
  assert.match(text, /  \[2\] wait_for text "READY" · found/)
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
  assert.match(batch.content[0].text, /batch: 1 actions · 1 succeeded · 640ms/)

  await assert.rejects(
    () => fake.tools.get('browser_click').execute({ label: 3 }, { callId: 'c-click-timeout', signal: new AbortController().signal }),
    /browser command timed out after 250ms/,
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
  assert.match(text, /batch: 3 actions · 3 succeeded · 580ms/)
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
  assert.match(value.content[0].text, /batch: 2 actions · 2 succeeded/)
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

test('tool budget stops a turn and resets for a new turn', async t => {
  const { server, url, commands, logEvents } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000, maxToolCallsPerTurn: 2 })
  t.after(() => fake.dispose())

  await waitFor(() => server.clients.size > 0)
  const tabs = fake.tools.get('browser_tabs')
  const exec = { callId: 'c-budget', signal: new AbortController().signal }
  await tabs.execute({}, exec)
  await tabs.execute({}, exec)
  await assert.rejects(() => tabs.execute({}, exec), /TURN_BUDGET_EXCEEDED/)
  assert.equal(commands.filter(command => command.op === 'tabs.list').length, 2)
  await waitFor(() => logEvents.some(event => event.type === 'tool.budget.exceeded'))
  assert.equal(logEvents.find(event => event.type === 'tool.budget.exceeded').data.max, 2)

  // Claiming a new turn resets the budget and the repeat fingerprints.
  const claimed = fake.listeners.get('agent/inbox/claimed')
  claimed({ message: { content: [{ type: 'text', text: 'list the tabs again' }] }, turn: 2 })
  const afterReset = await tabs.execute({}, exec)
  assert.match(afterReset.content[0].text, /tab\(s\)/)
  assert.equal(commands.filter(command => command.op === 'tabs.list').length, 3)
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

  // A different call is still allowed.
  assert.ok((await click.execute({ label: 9 }, exec)).content.length >= 1)
})

test('reasoning escalates after three consecutive no-progress results', async t => {
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
  const first = await request(payload, next)
  assert.equal(first.reasoningEffort, 'off')

  const session = { id: 'session-escalate', surface: { nodes: [] } }
  const result = data => fake.listeners.get('session/event')(session, { type: 'tool/result', data })
  result({ turn: 1, message: { content: [{ type: 'text', text: 'Error: no such label' }], isError: true } })
  result({ turn: 1, message: { content: [{ type: 'text', text: 'result: NO VISIBLE CHANGE — the pixels did not change.' }] } })
  assert.equal((await request(payload, next)).reasoningEffort, 'off')

  result({ turn: 1, message: { content: [{ type: 'text', text: 'Error: still stuck' }], isError: true } })
  assert.equal((await request(payload, next)).reasoningEffort, 'low')
  await waitFor(() => logEvents.some(event => event.type === 'reasoning.escalated'))
  assert.deepEqual(logEvents.find(event => event.type === 'reasoning.escalated').data, {
    turn: 1,
    from: 'off',
    to: 'low',
    noProgress: 3,
  })
})

test('a successful result resets the no-progress escalation run', async t => {
  const { server, url } = await startFakeBridge()
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

  assert.equal((await request(payload, next)).reasoningEffort, 'off')
  result({ turn: 1, message: { content: [{ type: 'text', text: 'Error: no such label' }], isError: true } })
  result({ turn: 1, message: { content: [{ type: 'text', text: 'Error: no such label again' }], isError: true } })
  // A successful tool result resets the consecutive run.
  result({ turn: 1, message: { content: [{ type: 'text', text: 'clicked label 3: button "Bold"' }] } })
  result({ turn: 1, message: { content: [{ type: 'text', text: 'Error: still stuck' }], isError: true } })
  result({ turn: 1, message: { content: [{ type: 'text', text: 'Error: still stuck' }], isError: true } })
  assert.equal((await request(payload, next)).reasoningEffort, 'off')
  result({ turn: 1, message: { content: [{ type: 'text', text: 'Error: now three in a row' }], isError: true } })
  assert.equal((await request(payload, next)).reasoningEffort, 'low')
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
