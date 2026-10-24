import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canvasBasisError,
  canvasBatchError,
  canvasBurstError,
  canvasEditorForUrl,
  compareLayoutFingerprints,
  deriveLayoutShiftOutcome,
  deriveTypeVerdict,
  findCoordinateBasisMismatch,
  formatMissingLabelMessage,
  inspectLabelAssignment,
  mapClickPoints,
  parseClickAtArgs,
  resolveCanvasImageBasis,
  resolveImageBasis,
  summarizeContentProbe,
} from '../sidepanel/browser.js'

/* ---------------------------------------------------------------- */
/* FIX 1: label-less typing must not claim "no change" on a canvas   */
/* ---------------------------------------------------------------- */

/**
 * @param {Array<Record<string, any>>} frames
 */
const probeFrames = frames => frames.map(frame => ({ frameId: frame.frameId, result: frame }))

test('summarizeContentProbe sums page signals and prefers the readable focused frame', () => {
  const summary = summarizeContentProbe(probeFrames([
    {
      frameId: 0,
      textLen: 120,
      mutations: 2,
      focus: { tag: 'iframe', readable: false, measurable: false, chars: 0, hasFocus: true },
    },
    {
      frameId: 3,
      textLen: 800,
      mutations: 5,
      focus: { tag: 'div', type: '', readable: true, measurable: true, hasFocus: true, chars: 40, preview: 'doc text' },
    },
  ]))
  assert.equal(summary.textLen, 920, 'text lengths add across frames')
  assert.equal(summary.mutations, 7)
  assert.equal(summary.frameCount, 2)
  assert.equal(summary.focus.frameId, 3, 'the real editor inside the iframe wins over the parent iframe element')
  assert.equal(summary.focus.chars, 40)
})

test('summarizeContentProbe never prefers a measurable background frame over real focus', () => {
  const summary = summarizeContentProbe(probeFrames([
    {
      frameId: 7,
      textLen: 50,
      mutations: 0,
      focus: { tag: 'input', readable: true, measurable: true, hasFocus: false, chars: 99, preview: 'background' },
    },
    {
      frameId: 0,
      textLen: 50,
      mutations: 0,
      focus: { tag: 'iframe', readable: false, measurable: false, hasFocus: true, chars: 0 },
    },
  ]))
  assert.equal(summary.focus.frameId, 0)
  assert.equal(summary.focus.hasFocus, true)
})

test('summarizeContentProbe tolerates missing and malformed frames', () => {
  assert.deepEqual(summarizeContentProbe(undefined), { textLen: 0, mutations: 0, focus: undefined, frameCount: 0 })
  assert.deepEqual(summarizeContentProbe([]), { textLen: 0, mutations: 0, focus: undefined, frameCount: 0 })
  const summary = summarizeContentProbe(probeFrames([{ frameId: 1, textLen: 'nope', mutations: -4 }]))
  assert.equal(summary.textLen, 0)
  assert.equal(summary.mutations, 0)
  assert.equal(summary.focus, undefined)
})

test('deriveTypeVerdict verifies a normal input from its value change', () => {
  const before = {
    textLen: 100,
    mutations: 0,
    focus: { frameId: 0, tag: 'input', type: 'text', measurable: true, chars: 5, preview: 'hello' },
  }
  const after = {
    textLen: 140,
    mutations: 3,
    focus: { frameId: 0, tag: 'input', type: 'text', measurable: true, chars: 40, preview: 'hello world' },
  }
  assert.deepEqual(deriveTypeVerdict(before, after), {
    changed: true,
    charsAdded: 35,
    measured: 'field',
    canvasEditor: false,
    fieldChanged: true,
    pageChanged: true,
    targetKind: 'input:text',
  })
})

test('deriveTypeVerdict returns false only for a measured field that really stayed the same', () => {
  const quiet = {
    textLen: 100,
    mutations: 0,
    focus: { frameId: 0, tag: 'textarea', type: '', measurable: true, chars: 12, preview: 'same text' },
  }
  const verdict = deriveTypeVerdict(quiet, { ...quiet, focus: { ...quiet.focus } })
  assert.equal(verdict.changed, false)
  assert.equal(verdict.measured, 'field')
  assert.equal(verdict.charsAdded, 0)
})

test('deriveTypeVerdict detects a same-length contenteditable edit by its preview', () => {
  const before = {
    textLen: 20,
    mutations: 0,
    focus: { frameId: 0, tag: 'div', measurable: true, chars: 5, preview: 'aaaaa' },
  }
  const after = {
    textLen: 20,
    mutations: 1,
    focus: { frameId: 0, tag: 'div', measurable: true, chars: 5, preview: 'bbbbb' },
  }
  const verdict = deriveTypeVerdict(before, after)
  assert.equal(verdict.changed, true)
  assert.equal(verdict.measured, 'field')
  assert.equal(verdict.canvasEditor, false)
})

test('deriveTypeVerdict never treats aggregate page text as canvas delivery', () => {
  const body = { tag: 'body', type: '', readable: false, measurable: false, chars: 0, preview: '', hasFocus: true }
  const before = { textLen: 5_000, mutations: 0, focus: body }
  const after = { textLen: 5_749, mutations: 14, focus: body }
  assert.deepEqual(deriveTypeVerdict(before, after), {
    changed: null,
    charsAdded: null,
    measured: 'none',
    canvasEditor: true,
    fieldChanged: null,
    pageChanged: true,
    targetKind: 'body',
  })
})

test('deriveTypeVerdict keeps an unchanged field unknown when the page visibly mutated', () => {
  // The focused input did not change, but the page did: a richer widget may
  // have consumed the events, so this is not the clean "nothing happened" case.
  const focus = { frameId: 0, tag: 'input', type: 'text', measurable: true, chars: 4, preview: 'same' }
  const before = { textLen: 100, mutations: 0, focus: { ...focus } }
  const after = { textLen: 130, mutations: 6, focus: { ...focus } }
  const verdict = deriveTypeVerdict(before, after)
  assert.equal(verdict.changed, null)
  assert.equal(verdict.measured, 'field')
  assert.equal(verdict.fieldChanged, false)
})

test('deriveTypeVerdict keeps canvas typing unknown (null, never false) when the page is quiet', () => {
  const body = { tag: 'iframe', type: '', readable: false, measurable: false, chars: 0, preview: '' }
  const before = { textLen: 5_000, mutations: 0, focus: body }
  const after = { textLen: 5_000, mutations: 0, focus: { ...body } }
  const verdict = deriveTypeVerdict(before, after)
  assert.equal(verdict.changed, null, 'zero readable chars is not evidence that nothing landed')
  assert.equal(verdict.measured, 'none')
  assert.equal(verdict.canvasEditor, true)
  assert.equal(verdict.targetKind, 'iframe')
})

test('deriveTypeVerdict treats a tiny event-target editable as canvas-like, not measurable', () => {
  // The hidden docs-texteventtarget-iframe body is contenteditable but 1px: its
  // empty value must not be read as "the field value did not change".
  const buffer = { tag: 'body', type: '', readable: true, measurable: false, chars: 0, preview: '' }
  const before = { textLen: 3_000, mutations: 0, focus: buffer }
  const after = { textLen: 3_000, mutations: 0, focus: { ...buffer } }
  assert.equal(deriveTypeVerdict(before, after).changed, null)
})

test('deriveTypeVerdict stays unknown when focus moves between frames', () => {
  const before = {
    textLen: 100,
    mutations: 0,
    focus: { frameId: 0, tag: 'input', measurable: true, chars: 5, preview: 'a' },
  }
  const after = {
    textLen: 100,
    mutations: 0,
    focus: { frameId: 3, tag: 'input', measurable: true, chars: 5, preview: 'b' },
  }
  assert.equal(deriveTypeVerdict(before, after).changed, null, 'different frames are different fields')
})

test('deriveTypeVerdict rejects matching tag/type when element identity changed', () => {
  const before = {
    textLen: 100,
    mutations: 0,
    focus: { frameId: 0, tag: 'input', type: 'text', identity: 'form/input[0]', measurable: true, chars: 5, preview: 'aaaaa' },
  }
  const after = {
    textLen: 105,
    mutations: 2,
    focus: { frameId: 0, tag: 'input', type: 'text', identity: 'form/input[1]', measurable: true, chars: 5, preview: 'bbbbb' },
  }
  assert.equal(deriveTypeVerdict(before, after).changed, null)
  assert.equal(deriveTypeVerdict(before, after).canvasEditor, true)
})

test('deriveTypeVerdict treats mutations only as an unverified page hint', () => {
  const body = { tag: 'body', readable: false, measurable: false, chars: 0, preview: '' }
  const before = { textLen: 500, mutations: 0, focus: body }
  const after = { textLen: 500, mutations: 9, focus: body }
  const verdict = deriveTypeVerdict(before, after)
  assert.equal(verdict.changed, null)
  assert.equal(verdict.measured, 'none')
  assert.equal(verdict.pageChanged, true)
  assert.equal(verdict.charsAdded, null)
})

test('deriveTypeVerdict is null when a probe is missing', () => {
  assert.equal(deriveTypeVerdict(undefined, undefined).changed, null)
  const probe = {
    textLen: 10,
    mutations: 0,
    focus: { tag: 'input', measurable: true, chars: 1, preview: 'x' },
  }
  assert.equal(deriveTypeVerdict(probe, undefined).changed, null)
})

/* ---------------------------------------------------------------- */
/* FIX 2: skipped-view actions must notice that the layout moved     */
/* ---------------------------------------------------------------- */

/** @param {string} text @param {number} x @param {number} y */
const control = (text, x, y) => ({ tag: 'button', text, x, y, w: 100, h: 24 })

test('compareLayoutFingerprints reports no shift for an identical layout', () => {
  const layout = [control('Alpha', 20, 100), control('Beta', 20, 140)]
  const shift = compareLayoutFingerprints(layout, layout.map(item => ({ ...item })))
  assert.equal(shift.layoutChanged, false)
  assert.equal(shift.movedCount, 0)
  assert.equal(shift.structural, false)
})

test('compareLayoutFingerprints catches rows shifted by an expanding element', () => {
  const before = [control('Row 1', 20, 100), control('Row 2', 20, 200), control('Row 3', 20, 300)]
  const after = before.map(item => ({ ...item, y: item.y + 75 }))
  const shift = compareLayoutFingerprints(before, after)
  assert.equal(shift.layoutChanged, true)
  assert.equal(shift.movedCount, 3)
  assert.equal(shift.maxDy, 75)
  assert.equal(shift.maxDx, 0)
  assert.deepEqual(shift.moved[0], { tag: 'button', text: 'Row 1', dx: 0, dy: 75 })
})

test('compareLayoutFingerprints ignores movement below the threshold', () => {
  const before = [control('Row 1', 20, 100)]
  const after = [{ ...before[0], y: 105 }]
  assert.equal(compareLayoutFingerprints(before, after).layoutChanged, false)
  assert.equal(compareLayoutFingerprints(before, after, 2).layoutChanged, true, 'a custom threshold still catches it')
})

test('compareLayoutFingerprints treats added elements as structural, not as drift', () => {
  const before = [control('Alpha', 20, 100)]
  const after = [control('Alpha', 20, 100), control('New action', 20, 140)]
  const shift = compareLayoutFingerprints(before, after)
  assert.equal(shift.layoutChanged, false, 'a menu appearing is not by itself a coordinate shift')
  assert.equal(shift.structural, true)
})

test('compareLayoutFingerprints treats changed text as structural, not as drift', () => {
  const before = [control('Assignment 1', 20, 100)]
  const after = [control('Assignment 2', 20, 100)]
  const shift = compareLayoutFingerprints(before, after)
  assert.equal(shift.layoutChanged, false)
  assert.equal(shift.structural, true)
})

test('compareLayoutFingerprints pairs duplicate labels in document order', () => {
  const before = [control('Row', 20, 100), control('Row', 20, 180)]
  const after = [control('Row', 20, 130), control('Row', 20, 210)]
  const shift = compareLayoutFingerprints(before, after)
  assert.equal(shift.layoutChanged, true)
  assert.equal(shift.movedCount, 2)
  assert.equal(shift.maxDy, 30)
})

test('compareLayoutFingerprints refuses to guess when a duplicate group changed size', () => {
  const before = [control('Row', 20, 100), control('Row', 20, 180)]
  const after = [control('Row', 20, 130)]
  const shift = compareLayoutFingerprints(before, after)
  assert.equal(shift.layoutChanged, false)
  assert.equal(shift.structural, true)
})

test('compareLayoutFingerprints is safe with missing or malformed input', () => {
  assert.equal(compareLayoutFingerprints(undefined, undefined).layoutChanged, false)
  assert.equal(compareLayoutFingerprints(undefined, [control('A', 1, 1)]).layoutChanged, false)
  assert.equal(compareLayoutFingerprints([null, 3, 'x'], [control('A', 1, 1)]).layoutChanged, false)
})

test('deriveLayoutShiftOutcome formats the stale-coordinate instruction from stored metrics', () => {
  const stored = {
    fingerprint: {
      layout: [control('Row 1', 20, 100), control('Row 2', 20, 200)],
    },
  }
  const metrics = {
    fingerprint: {
      layout: [control('Row 1', 20, 175), control('Row 2', 20, 275)],
    },
  }
  const shift = deriveLayoutShiftOutcome(stored, metrics)
  assert.equal(shift.layoutChanged, true)
  assert.equal(shift.layoutShift.maxDy, 75)
  assert.equal(shift.layoutShift.movedCount, 2)
  assert.match(shift.layoutNote, /take a fresh view/u)
  assert.match(shift.layoutNote, /75px/u)
})

test('deriveLayoutShiftOutcome invalidates structural menu and control changes', () => {
  const stored = { fingerprint: { layout: [control('Font list', 20, 100)] } }
  const metrics = { fingerprint: { layout: [control('Font list', 20, 100), control('More fonts', 20, 140)] } }
  const shift = deriveLayoutShiftOutcome(stored, metrics)
  assert.equal(shift.layoutChanged, true)
  assert.equal(shift.layoutShift.structural, true)
  assert.match(shift.layoutNote, /added, removed, or renamed/u)
  assert.match(shift.layoutNote, /take a fresh view/u)
})

test('deriveLayoutShiftOutcome is quiet before any view or without a shift', () => {
  const metrics = { fingerprint: { layout: [control('Row 1', 20, 100)] } }
  assert.deepEqual(deriveLayoutShiftOutcome(undefined, metrics), { layoutChanged: false })
  const stored = { fingerprint: { layout: [control('Row 1', 20, 100)] } }
  assert.deepEqual(deriveLayoutShiftOutcome(stored, metrics), { layoutChanged: false })
  assert.deepEqual(deriveLayoutShiftOutcome({ fingerprint: {} }, metrics), { layoutChanged: false })
})

/* ---------------------------------------------------------------- */
/* FIX 3: read_text must not present canvas DOM text as the page     */
/* ---------------------------------------------------------------- */

test('canvasEditorForUrl recognizes the known Google canvas editors', () => {
  assert.equal(canvasEditorForUrl('https://docs.google.com/document/d/abc/edit'), 'Google Docs')
  assert.equal(canvasEditorForUrl('https://docs.google.com/document'), 'Google Docs')
  assert.equal(canvasEditorForUrl('https://docs.google.com/document?tab=t.0'), 'Google Docs')
  assert.equal(canvasEditorForUrl('https://docs.google.com/spreadsheets/d/abc/edit#gid=0'), 'Google Sheets')
  assert.equal(canvasEditorForUrl('https://docs.google.com/presentation/d/abc/edit'), 'Google Slides')
})

test('canvasEditorForUrl ignores non-canvas pages and near-miss URLs', () => {
  assert.equal(canvasEditorForUrl('https://classroom.google.com/u/1/w/abc/t/all'), undefined)
  assert.equal(canvasEditorForUrl('https://docs.google.com/'), undefined)
  assert.equal(canvasEditorForUrl('https://docs.google.com/forms/d/e/abc/viewform'), undefined)
  assert.equal(canvasEditorForUrl('https://example.com/document/d/abc'), undefined)
  assert.equal(canvasEditorForUrl(undefined), undefined)
  assert.equal(canvasEditorForUrl(''), undefined)
})

test('canvasEditorForUrl accepts a custom list and ignores a malformed pattern', () => {
  const editors = [
    { name: 'Excalidraw', pattern: '^https://excalidraw\\.com/' },
    { name: 'Broken', pattern: '([' },
  ]
  assert.equal(canvasEditorForUrl('https://excalidraw.com/#room', editors), 'Excalidraw')
  assert.equal(canvasEditorForUrl('https://example.com/', editors), undefined)
})

test('canvasBatchError rejects dependent Docs work before execution', () => {
  const url = 'https://docs.google.com/document/d/abc/edit'
  const actions = [{ op: 'press_key' }, { op: 'type' }, { op: 'click' }]
  assert.equal(canvasBatchError(url, actions).code, 'CANVAS_BATCH_UNSUPPORTED')
  assert.equal(canvasBatchError(url, actions.slice(0, 1)), undefined, 'a single action gets one final full view')
  assert.equal(canvasBatchError(url, [{ op: 'wait_for' }, { op: 'wait_for' }]), undefined, 'read-only waits are safe')
  assert.equal(canvasBatchError('https://example.com/', actions), undefined, 'ordinary pages keep batches')
})

test('canvasBurstError rejects multi-point Docs clicks but not game bursts', () => {
  const url = 'https://docs.google.com/document/d/abc/edit'
  assert.equal(canvasBurstError(url, 2).code, 'CANVAS_BURST_UNSUPPORTED')
  assert.equal(canvasBurstError(url, 1), undefined)
  assert.equal(canvasBurstError('https://example.com/game', 20), undefined)
})

test('resolveCanvasImageBasis accepts only the newest usable canvas view', () => {
  const newest = { viewId: 9, imageWidth: 640 }
  const older = { viewId: 8, imageWidth: 1280 }
  assert.equal(resolveCanvasImageBasis(undefined, [newest, older]).basis, newest)
  assert.equal(resolveCanvasImageBasis(9, [newest, older]).basis, newest)
  assert.equal(resolveCanvasImageBasis(8, [newest, older]).error.code, 'STALE_VIEW')
  assert.equal(resolveCanvasImageBasis(undefined, []).error.code, 'NO_VIEW')
})

test('canvasBasisError rejects scroll, viewport, URL, and structural drift', () => {
  const url = 'https://docs.google.com/document/d/abc/edit'
  const basis = {
    viewId: 9,
    url,
    imageWidth: 640,
    imageHeight: 424,
    viewport: { width: 1307, height: 866 },
    scroll: { x: 0, y: 0 },
    fingerprint: { layout: [control('Font list', 100, 70)] },
  }
  const metrics = {
    url,
    viewport: { width: 1307, height: 866 },
    fingerprint: { layout: [control('Font list', 100, 70)] },
  }
  assert.equal(canvasBasisError(basis, metrics, { x: 0, y: 0 }), undefined)
  assert.match(canvasBasisError(basis, metrics, { x: 0, y: 3 }).message, /scrolled/u)
  assert.equal(canvasBasisError(basis, { ...metrics, viewport: { width: 640, height: 866 } }, { x: 0, y: 0 }).code, 'STALE_VIEW')
  assert.equal(canvasBasisError(basis, { ...metrics, url: `${url}#other` }, { x: 0, y: 0 }).code, 'STALE_VIEW')
  const structural = { ...metrics, fingerprint: { layout: [control('Font list', 100, 70), control('New menu', 100, 100)] } }
  assert.match(canvasBasisError(basis, structural, { x: 0, y: 0 }).message, /layout changed/u)
})

/* ---------------------------------------------------------------- */
/* FIX 4: hallucinated label ids must say they were never assigned   */
/* ---------------------------------------------------------------- */

/** Build a registry-shaped object with the given frame/local id pairs. */
const registryOf = entries => ({
  labels: new Map(entries.map(([frameId, localId]) => [frameId * 100_000 + localId, { frameId, localId }])),
})

test('inspectLabelAssignment distinguishes assigned ids from ids never handed out', () => {
  const registry = registryOf([[0, 1], [0, 2], [0, 64], [0, 65], [0, 89]])
  const stale = inspectLabelAssignment(65, registry)
  assert.equal(stale.everAssigned, true)
  assert.equal(stale.maxLocalId, 89)
  assert.equal(stale.frameId, 0)
  const hallucinated = inspectLabelAssignment(999, registry)
  assert.equal(hallucinated.everAssigned, false)
  assert.equal(hallucinated.localId, 999)
  assert.equal(hallucinated.maxLocalId, 89)
  assert.equal(hallucinated.hasAnyLabels, true)
})

test('inspectLabelAssignment maps subframe ids back to their frame range', () => {
  const registry = registryOf([[0, 5], [2, 1], [2, 6]])
  const assigned = inspectLabelAssignment(200_005, registry)
  assert.equal(assigned.everAssigned, true)
  assert.equal(assigned.frameId, 2)
  assert.equal(assigned.maxLocalId, 6)
  assert.equal(assigned.frameLabels, 2)
  assert.equal(inspectLabelAssignment(200_009, registry).everAssigned, false)
  assert.equal(inspectLabelAssignment(100_001, registry).everAssigned, false, 'a frame that never labelled has no ids')
})

test('inspectLabelAssignment handles no registry, empty registry, and local id zero', () => {
  assert.deepEqual(inspectLabelAssignment(7, undefined), {
    frameId: 0,
    localId: 7,
    maxLocalId: 0,
    frameLabels: 0,
    everAssigned: false,
    hasAnyLabels: false,
  })
  assert.equal(inspectLabelAssignment(7, { labels: new Map() }).hasAnyLabels, false)
  assert.equal(inspectLabelAssignment(100_000, registryOf([[1, 1]])).localId, 0, 'an id on a frame boundary is local id zero')
  assert.equal(inspectLabelAssignment(100_000, registryOf([[1, 1]])).everAssigned, false)
})

test('formatMissingLabelMessage names the valid range for a never-assigned id', () => {
  const registry = registryOf([[0, 1], [0, 89]])
  const described = formatMissingLabelMessage(999, inspectLabelAssignment(999, registry))
  assert.equal(described.kind, 'never-assigned')
  assert.match(described.message, /Label 999 was never assigned/u)
  assert.match(described.message, /1\.\.89/u)
  assert.match(described.message, /browser_click_at/u)
})

test('formatMissingLabelMessage keeps the stale wording for assigned ids', () => {
  const described = formatMissingLabelMessage(65, inspectLabelAssignment(65, registryOf([[0, 89]])))
  assert.equal(described.kind, 'stale')
  assert.match(described.message, /not in the current view/u)
})

test('formatMissingLabelMessage says no labels exist when the page was never labelled', () => {
  const described = formatMissingLabelMessage(999, inspectLabelAssignment(999, undefined))
  assert.equal(described.kind, 'no-labels')
  assert.match(described.message, /no labels have been handed out/u)
})

test('formatMissingLabelMessage explains subframe label ranges', () => {
  const registry = registryOf([[2, 6]])
  const described = formatMissingLabelMessage(200_009, inspectLabelAssignment(200_009, registry))
  assert.equal(described.kind, 'never-assigned')
  assert.match(described.message, /frame 2/u)
  assert.match(described.message, /200001\.\.200006/u)
})

/* ---------------------------------------------------------------- */
/* FIX 5: image-space clicks must name the view they map through     */
/* ---------------------------------------------------------------- */

const viewBasis = (viewId, imageWidth, imageHeight, viewportWidth = 1307, viewportHeight = 925) => ({
  viewId,
  url: 'https://example.com/',
  imageWidth,
  imageHeight,
  viewport: { width: viewportWidth, height: viewportHeight },
})

test('resolveImageBasis leaves CSS-space clicks alone', () => {
  assert.deepEqual(resolveImageBasis({ space: 'css', viewId: 12, points: [{ x: 1, y: 2 }] }, [viewBasis(12, 1280, 906)]), {})
  assert.deepEqual(resolveImageBasis({ space: 'css' }, []), {}, 'CSS coordinates never need a recorded image')
})

test('resolveImageBasis refuses image coordinates before any screenshot', () => {
  const resolved = resolveImageBasis({ space: 'image', points: [{ x: 1, y: 2 }] }, [])
  assert.equal(resolved.error.code, 'NO_VIEW')
  assert.match(resolved.error.message, /screenshot/u)
})

test('resolveImageBasis uses the newest capture by default', () => {
  const newest = viewBasis(18, 640, 453)
  const older = viewBasis(12, 1280, 906)
  const resolved = resolveImageBasis({ space: 'image', points: [{ x: 1, y: 2 }] }, [newest, older])
  assert.equal(resolved.basis.viewId, 18)
  assert.equal(resolved.error, undefined)
})

test('resolveImageBasis honors an explicit view_id even when newer views exist', () => {
  const newest = viewBasis(18, 640, 453)
  const older = viewBasis(12, 1280, 906)
  assert.equal(resolveImageBasis({ space: 'image', viewId: 12 }, [newest, older]).basis.viewId, 12)
  const unknown = resolveImageBasis({ space: 'image', viewId: 4 }, [newest, older])
  assert.equal(unknown.error.code, 'NO_VIEW')
  assert.match(unknown.error.message, /View 4 is not a recent view/u)
})

test('resolveImageBasis ignores malformed history entries', () => {
  const resolved = resolveImageBasis({ space: 'image' }, [{ viewId: 'nope' }, { viewId: 3, imageWidth: 0 }, viewBasis(21, 1280, 906)])
  assert.equal(resolved.basis.viewId, 21)
})

test('findCoordinateBasisMismatch catches coordinates measured on a larger image', () => {
  // View #12 is the 1280px capture (scale 1.021); view #18 is a 640px "fast"
  // capture of the same viewport (scale 2.042). A point measured on #12 lands
  // off-screen when mapped through #18 — strong evidence it is stale.
  const current = viewBasis(18, 640, 453)
  const older = viewBasis(12, 1280, 906)
  const mismatch = findCoordinateBasisMismatch([{ x: 247, y: 514 }], current, [current, older])
  assert.equal(mismatch.stale.length, 1)
  assert.equal(mismatch.stale[0].index, 0)
  assert.equal(mismatch.stale[0].from.viewId, 12)
  assert.equal(mismatch.stale[0].from.imageWidth, 1280)
  assert.equal(mismatch.ambiguous.length, 0)
})

test('findCoordinateBasisMismatch reports ambiguity when a point fits both bases', () => {
  const current = viewBasis(18, 640, 453)
  const older = viewBasis(12, 1280, 906)
  const mismatch = findCoordinateBasisMismatch([{ x: 100, y: 100 }], current, [current, older])
  assert.equal(mismatch.stale.length, 0)
  assert.equal(mismatch.ambiguous.length, 1)
  assert.equal(mismatch.ambiguous[0].alternatives[0].viewId, 12)
  assert.equal(mismatch.ambiguous[0].alternatives[0].imageWidth, 1280)
  assert.ok(Math.abs(mismatch.ambiguous[0].alternatives[0].dx) >= 8)
})

test('findCoordinateBasisMismatch ignores differences too small to matter', () => {
  const current = viewBasis(18, 640, 453)
  const older = viewBasis(12, 1280, 906)
  const mismatch = findCoordinateBasisMismatch([{ x: 2, y: 2 }], current, [current, older])
  assert.equal(mismatch.stale.length, 0)
  assert.equal(mismatch.ambiguous.length, 0)
})

test('findCoordinateBasisMismatch ignores same-scale captures', () => {
  const current = viewBasis(18, 1280, 906)
  const sameScale = viewBasis(12, 1280, 906)
  const mismatch = findCoordinateBasisMismatch([{ x: 100, y: 100 }, { x: 900, y: 700 }], current, [current, sameScale])
  assert.equal(mismatch.stale.length, 0)
  assert.equal(mismatch.ambiguous.length, 0)
})

test('findCoordinateBasisMismatch stays quiet without a second basis', () => {
  const current = viewBasis(18, 640, 453)
  assert.deepEqual(findCoordinateBasisMismatch([{ x: 5000, y: 5000 }], current, [current]), { stale: [], ambiguous: [] })
  assert.deepEqual(findCoordinateBasisMismatch([{ x: 1, y: 2 }], undefined, [current]), { stale: [], ambiguous: [] })
})

test('CSS-space clicks do not depend on any stored image scale', () => {
  // The same CSS point must map identically no matter which screenshot basis
  // exists, which is why image-scale fixes must never touch space:"css".
  const mapped = mapClickPoints([{ x: 100, y: 200 }], 'css', { width: 1307, height: 925 }, 2.042)
  assert.equal(mapped[0].cssX, 100)
  assert.equal(mapped[0].cssY, 200)
  assert.equal(mapped[0].offScreen, false)
})

test('parseClickAtArgs parses and validates view_id', () => {
  assert.equal(parseClickAtArgs({ x: 10, y: 20 }).viewId, undefined)
  assert.equal(parseClickAtArgs({ x: 10, y: 20, view_id: 12 }).viewId, 12)
  assert.equal(parseClickAtArgs({ points: [{ x: 1, y: 2 }], view_id: '7' }).viewId, 7)
  assert.equal(parseClickAtArgs({ x: 1, y: 2, space: 'css', view_id: 9 }).viewId, 9)
  for (const bad of [0, -3, 1.5, 'abc']) {
    assert.throws(
      () => parseClickAtArgs({ x: 1, y: 2, view_id: bad }),
      error => error.code === 'BAD_VIEW',
      `view_id ${JSON.stringify(bad)} must be rejected`,
    )
  }
})