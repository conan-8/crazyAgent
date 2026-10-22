import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatLabelsHint,
  formatTabCandidates,
  isAmbiguousTabMatch,
  isRectFullyVisible,
  mapClickPoints,
  matchTabQuery,
  parseClickAtArgs,
  parsePressKeyArgs,
  staleScrollInfo,
} from '../sidepanel/browser.js'

/* ---------------------------------------------------------------- */
/* click_at: burst cap and off-screen marking                        */
/* ---------------------------------------------------------------- */

test('parseClickAtArgs accepts a 19-point burst and rejects more than 20', () => {
  const points = Array.from({ length: 19 }, (_, index) => ({ x: 10 + index, y: 20 + index }))
  const request = parseClickAtArgs({ points })
  assert.equal(request.points.length, 19)
  assert.equal(request.space, 'image')
  assert.equal(request.view, 'full')

  assert.throws(
    () => parseClickAtArgs({ points: [...points, { x: 1, y: 1 }, { x: 2, y: 2 }] }),
    error => error.code === 'BAD_POINTS' && /1 to 20/.test(error.message),
  )
  assert.throws(() => parseClickAtArgs({ points: [] }), error => error.code === 'BAD_POINTS')
  assert.throws(
    () => parseClickAtArgs({ x: 1, y: 2, points: [{ x: 1, y: 2 }] }),
    error => error.code === 'BAD_POINTS',
  )
  assert.throws(
    () => parseClickAtArgs({ points: [{ x: 1, y: Number.NaN }] }),
    error => error.code === 'BAD_POINTS' && /points\[0\]/.test(error.message),
  )
})

test('mapClickPoints clamps on-screen points and never clamps off-screen ones', () => {
  const viewport = { width: 1280, height: 720 }
  const mapped = mapClickPoints(
    [{ x: 100, y: 200 }, { x: 5000, y: 200 }, { x: 100, y: -50 }, { x: 1281, y: 719 }],
    'css',
    viewport,
  )
  assert.deepEqual(mapped[0], { space: 'css', x: 100, y: 200, cssX: 100, cssY: 200, offScreen: false })
  assert.equal(mapped[1].offScreen, true)
  assert.equal(mapped[1].cssX, 5000, 'off-screen points report their raw coordinate, not the viewport edge')
  assert.equal(mapped[2].offScreen, true)
  assert.equal(mapped[3].offScreen, false, 'a point up to 2px outside the viewport is still clickable')
  assert.equal(mapped[3].cssX, 1279, 'on-screen points keep the clamp')
})

test('mapClickPoints applies the stored image scale for image-space points', () => {
  const viewport = { width: 1280, height: 720 }
  // A 640px-wide image on a 1280px viewport: each image pixel is 2 CSS px.
  const mapped = mapClickPoints([{ x: 320, y: 180 }, { x: 700, y: 10 }], 'image', viewport, 2)
  assert.equal(mapped[0].cssX, 640)
  assert.equal(mapped[0].cssY, 360)
  assert.equal(mapped[0].offScreen, false)
  assert.equal(mapped[1].offScreen, true, 'an image point beyond the screenshot width is off-screen')
})

test('staleScrollInfo flags scroll drift above 40px only', () => {
  assert.equal(staleScrollInfo({ y: 100 }, { y: 140 }), undefined, 'exactly 40px is still current')
  assert.deepEqual(staleScrollInfo({ y: 100 }, { y: 141 }), { fromY: 100, toY: 141, dy: 41 })
  assert.deepEqual(staleScrollInfo({ y: 100 }, { y: 1411 }), { fromY: 100, toY: 1411, dy: 1311 })
  assert.deepEqual(staleScrollInfo({ y: 900 }, { y: 800 }), { fromY: 900, toY: 800, dy: -100 })
  assert.equal(staleScrollInfo(undefined, { y: 10 }), undefined)
  assert.equal(staleScrollInfo({ y: 10 }, undefined), undefined)
  assert.deepEqual(staleScrollInfo({ y: 0 }, { y: 41 }, 40), { fromY: 0, toY: 41, dy: 41 })
})

/* ---------------------------------------------------------------- */
/* click scroll policy                                               */
/* ---------------------------------------------------------------- */

test('isRectFullyVisible keeps the page still when the target is inside', () => {
  const viewport = { width: 1280, height: 720 }
  assert.equal(isRectFullyVisible({ top: 100, left: 200, bottom: 140, right: 320, width: 120, height: 40 }, viewport), true)
  assert.equal(
    isRectFullyVisible({ top: 700, left: 200, bottom: 760, right: 320, width: 120, height: 60 }, viewport),
    false,
    'partially below the viewport still needs a scroll',
  )
  assert.equal(
    isRectFullyVisible({ top: 1, left: 200, bottom: 40, right: 320, width: 120, height: 39 }, viewport),
    false,
    'a 4px margin keeps edge targets from touching the border',
  )
  assert.equal(
    isRectFullyVisible({ top: 100, left: 200, bottom: 140, right: 320, width: 0, height: 0 }, viewport),
    false,
    'a zero-size box is never visible',
  )
})

/* ---------------------------------------------------------------- */
/* press_key: composite strings                                      */
/* ---------------------------------------------------------------- */

test('parsePressKeyArgs accepts composite key strings', () => {
  const tab = parsePressKeyArgs({ key: 'shift+Tab' })
  assert.equal(tab.key, 'Tab')
  assert.deepEqual(tab.modifiers, ['shift'])
  assert.equal(tab.mask, 8)
  assert.equal(tab.spec.code, 'Tab')

  const arrow = parsePressKeyArgs({ key: 'ctrl+Shift+ArrowLeft' })
  assert.equal(arrow.key, 'ArrowLeft')
  assert.deepEqual(arrow.modifiers, ['ctrl', 'shift'])
  assert.equal(arrow.mask, 2 | 8)

  const meta = parsePressKeyArgs({ key: 'meta+Enter' })
  assert.equal(meta.key, 'Enter')
  assert.deepEqual(meta.modifiers, ['meta'])
  assert.equal(meta.mask, 4)
  assert.equal(meta.spec.keyCode, 13)
})

test('parsePressKeyArgs merges composite modifiers with the legacy array and dedupes', () => {
  const merged = parsePressKeyArgs({ key: 'ctrl+Tab', modifiers: ['shift', 'CTRL'] })
  assert.deepEqual(merged.modifiers, ['ctrl', 'shift'])
  assert.equal(merged.mask, 2 | 8)

  const lower = parsePressKeyArgs({ key: 'ALT+shift+t' })
  assert.equal(lower.key, 't')
  assert.deepEqual(lower.modifiers, ['alt', 'shift'])
  assert.equal(lower.mask, 1 | 8)
})

test('parsePressKeyArgs keeps the legacy single-key and modifier-array paths', () => {
  const enter = parsePressKeyArgs({ key: 'Enter' })
  assert.equal(enter.key, 'Enter')
  assert.deepEqual(enter.modifiers, [])
  assert.equal(enter.mask, 0)

  const plain = parsePressKeyArgs({ key: 'k', modifiers: ['ctrl'] })
  assert.equal(plain.key, 'k')
  assert.deepEqual(plain.modifiers, ['ctrl'])
  assert.equal(plain.mask, 2)

  const question = parsePressKeyArgs({ key: '?' })
  assert.equal(question.spec.key, '?')
  assert.equal(question.mask, 8, 'shifted characters still imply shift without echoing it')
  assert.deepEqual(question.modifiers, [])

  const plus = parsePressKeyArgs({ key: '+' })
  assert.equal(plus.key, '+', 'a lone + is the plus character, not a composite separator')
})

test('parsePressKeyArgs rejects malformed composite strings with BAD_KEY', () => {
  assert.throws(
    () => parsePressKeyArgs({ key: 'hyper+Tab' }),
    error => error.code === 'BAD_KEY' && /hyper/.test(error.message),
  )
  assert.throws(
    () => parsePressKeyArgs({ key: 'ctrl+' }),
    error => error.code === 'BAD_KEY',
  )
  assert.throws(
    () => parsePressKeyArgs({ key: 'ctrl+shift' }),
    error => error.code === 'BAD_KEY' && /modifier/.test(error.message),
  )
  assert.throws(
    () => parsePressKeyArgs({ key: 'Tab', modifiers: ['hyper'] }),
    error => error.code === 'BAD_KEY' && /hyper/.test(error.message),
  )
})

/* ---------------------------------------------------------------- */
/* tab query ambiguity                                               */
/* ---------------------------------------------------------------- */

const TABS = [
  { id: 1, index: 0, title: 'Cool Document Board', url: 'https://docs.example.test/board' },
  { id: 2, index: 1, title: 'Cool Document Archive', url: 'https://archive.example.test/cool' },
  { id: 3, index: 2, title: 'Inbox (1,824) - yiconan885@gmail.com - Gmail', url: 'https://mail.google.com/mail/u/0/' },
  { id: 4, index: 3, title: 'Cool Document', url: 'https://docs.example.test/exact' },
]

test('matchTabQuery returns the best candidates for ambiguity reporting', () => {
  const ambiguous = matchTabQuery(TABS, 'Cool Document')
  assert.equal(ambiguous.matchCount, 3)
  assert.equal(ambiguous.candidates.length, 3)
  assert.equal(ambiguous.candidates[0].id, 4, 'the exact match sorts first')
  assert.equal(ambiguous.score, 100)
  assert.equal(isAmbiguousTabMatch(ambiguous), false, 'an exact title match is never ambiguous')

  const prefix = matchTabQuery(TABS.slice(0, 2), 'cool document')
  assert.equal(prefix.matchCount, 2)
  assert.equal(prefix.score, 80)
  assert.equal(isAmbiguousTabMatch(prefix), true, 'several prefix matches with no exact match are ambiguous')

  assert.equal(isAmbiguousTabMatch(matchTabQuery(TABS, 'Gmail')), false, 'a single match is not ambiguous')
  assert.equal(isAmbiguousTabMatch(undefined), false)
})

test('formatTabCandidates names ids, titles, and URLs', () => {
  const match = matchTabQuery(TABS.slice(0, 2), 'cool')
  const text = formatTabCandidates(match.candidates)
  assert.match(text, /^1 "Cool Document Board" https:\/\/docs\.example\.test\/board/)
  assert.match(text, /; 2 "Cool Document Archive" /)
  assert.equal(formatTabCandidates(match.candidates, 1).includes(';'), false, 'candidate list is capped')
})

/* ---------------------------------------------------------------- */
/* stale-label retry hint                                            */
/* ---------------------------------------------------------------- */

test('formatLabelsHint caps the label list and length', () => {
  const labels = Array.from({ length: 40 }, (_, index) => ({
    id: index + 1,
    role: 'button',
    text: `Action ${index + 1} ${'x'.repeat(48)}`,
  }))
  const hint = formatLabelsHint(labels)
  assert.match(hint, /^Current labels: \[1\] button "Action 1 /)
  const listed = hint.split('; [')
  assert.ok(listed.length <= 25, `lists at most 25 labels (${listed.length})`)
  assert.ok(hint.length <= 1_300, `hint stays near 1200 chars (${hint.length})`)
  assert.match(hint, /more$/, 'truncation is reported')
})

test('formatLabelsHint puts the failed element first and handles empty lists', () => {
  const labels = [
    { id: 5, role: 'link', text: 'Home' },
    { id: 6, role: 'button', text: 'Continue' },
    { id: 7, role: 'button', text: 'Continue to checkout' },
  ]
  const hint = formatLabelsHint(labels, { preferText: 'Continue' })
  assert.match(hint, /^Current labels: \[6\] button "Continue"; \[7\] button "Continue to checkout"; \[5\] link "Home"$/)
  assert.equal(formatLabelsHint([]), 'Current labels: none visible on the page right now.')
  assert.equal(
    formatLabelsHint([{ id: 1, role: 'button', text: 'Go' }], { maxLabels: 1, maxChars: 20 }).startsWith('Current labels:'),
    true,
  )
})