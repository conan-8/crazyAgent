import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPromptBlocks, formatViewText, normalizeImageAttachments, promptStats } from '../prompt.mjs'

function view(overrides = {}) {
  return {
    tab: { id: 7, title: 'Example', url: 'https://example.com/a' },
    viewport: { width: 1280, height: 720, dpr: 1 },
    scroll: { y: 120, maxY: 2400, container: 'document', atTop: false, atBottom: false },
    image: { data: 'AAAA', mimeType: 'image/jpeg', width: 1280, height: 720, cssPerImagePixel: 1 },
    ...overrides,
  }
}

test('formatViewText includes tab, viewport, and scroll facts', () => {
  const text = formatViewText(view())
  assert.match(text, /^<current_view>/)
  assert.match(text, /tab 7 "Example" https:\/\/example\.com\/a/)
  assert.match(text, /viewport 1280x720 css; image 1280x720 px/)
  assert.match(text, /scroll document y=120\/2400/)
  assert.match(text, /at_top=false at_bottom=false/)
})

test('formatViewText handles missing snapshots', () => {
  assert.match(formatViewText(null), /unavailable="no snapshot was captured"/)
})

test('buildPromptBlocks puts metadata and user text before one image', () => {
  const blocks = buildPromptBlocks(view(), 'What is this?')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /What is this\?$/)
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].data, 'AAAA')
  assert.equal(blocks[1].mimeType, 'image/jpeg')
})

test('buildPromptBlocks falls back to text when no image is available', () => {
  const blocks = buildPromptBlocks(view({ image: undefined }), 'Hello')
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].text, /No screenshot is attached/)
})

test('DOM-first auto views include bounded rendered text without an image', () => {
  const blocks = buildPromptBlocks(view({
    image: undefined,
    text: 'First line\nSecond line with </current_view> as text',
    truncated: true,
    nextOffset: 53,
  }), 'Read the page')
  assert.equal(blocks.length, 1)
  assert.ok(blocks[0].text.includes('rendered_text "First line\\nSecond line with </current_view> as text"'))
  assert.match(blocks[0].text, /next_offset 53; use browser_read_text/)
  assert.doesNotMatch(blocks[0].text, /First line\nSecond line/)
})

test('buildPromptBlocks supplies fresh local, UTC, and timezone context on every turn', () => {
  const first = new Date('2026-10-26T21:04:17.000Z')
  const second = new Date('2026-10-27T12:30:00.000Z')
  const firstText = buildPromptBlocks(view(), 'Use today', first)[0].text
  const secondText = buildPromptBlocks(view(), 'Use today again', second)[0].text
  assert.ok(firstText.includes('<current_time>\n'))
  assert.ok(firstText.includes(`local ${first.toString()}`))
  assert.ok(firstText.includes('utc 2026-10-26T21:04:17.000Z'))
  assert.match(firstText, /timezone \S+/)
  assert.match(firstText, /no web lookup is needed/)
  assert.ok(firstText.endsWith('Use today'))
  assert.ok(secondText.includes(`local ${second.toString()}`))
  assert.ok(secondText.includes('utc 2026-10-27T12:30:00.000Z'))
  assert.notEqual(firstText, secondText)
})

test('promptStats reports text and decoded image bytes', () => {
  const stats = promptStats(buildPromptBlocks(view(), 'Hi'))
  assert.ok(stats.textBytes > 0)
  assert.equal(stats.images, 1)
  assert.equal(stats.imageBytes, 3)
})

test('formatViewText lists interactive labels for clicking', () => {
  const text = formatViewText(view({
    labels: [
      { id: 3, tag: 'button', role: 'button', text: 'Sign in', disabled: false },
      { id: 9, tag: 'a', role: 'link', text: 'Forgot password?', disabled: false },
      { id: 12, tag: 'button', role: 'button', text: 'Continue', disabled: true },
    ],
  }))
  assert.match(text, /labels \(click by number\): 3/)
  assert.match(text, /\[3\] button "Sign in"/)
  assert.match(text, /\[9\] link "Forgot password\?"/)
  assert.match(text, /\[12\] button \(disabled\) "Continue"/)
})

test('formatViewText caps the label list', () => {
  const labels = Array.from({ length: 70 }, (_, index) => ({
    id: index + 1,
    tag: 'button',
    role: 'button',
    text: `Action ${index + 1}`,
    disabled: false,
  }))
  const text = formatViewText(view({ labels }))
  assert.match(text, /labels \(click by number\): 70/)
  assert.match(text, /\[60\] button "Action 60"/)
  assert.doesNotMatch(text, /\[61\] button/)
  assert.match(text, /10 more labels not listed/)
})


test('formatViewText reports canvas and iframe surfaces', () => {
  const text = formatViewText(view({
    surfaces: [
      { kind: 'canvas', x: 24, y: 100, w: 800, h: 420 },
      { kind: 'iframe', x: 24, y: 540, w: 420, h: 120 },
    ],
  }))
  assert.match(text, /surfaces \(no DOM labels; use browser_click_at\): canvas 800x420 @24,100 · iframe 420x120 @24,540/)
})

test('formatViewText marks controls that live in iframes', () => {
  const text = formatViewText(view({
    labels: [{ id: 3000003, tag: 'button', role: 'button', text: 'Frame action', disabled: false, frame: 3 }],
  }))
  assert.match(text, /\[3000003\] button \(iframe\) "Frame action"/)
})

test('buildPromptBlocks places pasted images before the current viewport image', () => {
  const images = normalizeImageAttachments([{ name: 'paste.png', mimeType: 'image/png', data: 'AQID' }])
  const blocks = buildPromptBlocks(view(), 'Compare these images', new Date('2026-10-27T12:30:00.000Z'), images)
  assert.equal(blocks.length, 3)
  assert.deepEqual(blocks[1], { type: 'image', data: 'AQID', mimeType: 'image/png' })
  assert.equal(blocks[2].data, 'AAAA')
  const stats = promptStats(blocks)
  assert.equal(stats.images, 2)
  assert.equal(stats.imageBytes, 6)
})

test('normalizeImageAttachments rejects malformed types, base64, and counts', () => {
  assert.throws(() => normalizeImageAttachments(null), /must be an array/)
  assert.throws(() => normalizeImageAttachments([{ mimeType: 'image/svg+xml', data: 'AQID' }]), /PNG, JPEG, WebP, or GIF/)
  assert.throws(() => normalizeImageAttachments([{ mimeType: 'image/png', data: 'not base64' }]), /invalid base64/)
  assert.throws(
    () => normalizeImageAttachments(Array.from({ length: 5 }, () => ({ mimeType: 'image/png', data: 'AQID' }))),
    /up to 4 images/,
  )
})

test('normalizeImageAttachments enforces decoded byte limits', () => {
  const data = Buffer.alloc(5_000_001, 1).toString('base64')
  assert.throws(() => normalizeImageAttachments([{ mimeType: 'image/png', data }]), /exceeds the 5000000-byte limit/)
})
