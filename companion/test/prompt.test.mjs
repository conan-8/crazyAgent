import test from 'node:test'
import assert from 'node:assert/strict'
import { CONFIRM_MODE_GUIDANCE, MARATHON_MODE_GUIDANCE, buildPromptBlocks, formatViewText, isDocsDocumentUrl, normalizeImageAttachments, normalizePlanSeed, promptStats } from '../prompt.mjs'
import { CORE_GUIDANCE, DOCS_MODE_GUIDANCE } from '../../packages/dsh-browser-extension/lib/guidance.js'

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

test('marathon mode adds checklist instructions only when armed', () => {
  const now = new Date('2026-11-09T12:00:00.000Z')
  const ordinary = buildPromptBlocks(view(), 'Complete the long task', now)[0].text
  const plannedBlocks = buildPromptBlocks(view(), 'Complete the long task', now, [], { planMode: true })
  const planned = plannedBlocks[0].text
  assert.doesNotMatch(ordinary, /<marathon_mode>|browser_plan/)
  assert.ok(planned.includes(MARATHON_MODE_GUIDANCE))
  assert.match(planned, /Marathon mode is on/)
  assert.match(planned, /every turn while the switch stays on/)
  assert.match(planned, /expected_revision:0/)
  assert.match(planned, /independent final-state verification/)
  assert.match(planned, /user_input_needed:true/)
  assert.ok(planned.indexOf('<marathon_mode>') < planned.indexOf('Complete the long task'))
  assert.ok(planned.endsWith('Complete the long task'))
  assert.equal(plannedBlocks.length, 2)
  assert.equal(plannedBlocks[1].data, 'AAAA')
  // M2 budget: the fixed part stays small; it is per-turn text outside the
  // 17,100-character core+Docs ceiling.
  assert.ok(MARATHON_MODE_GUIDANCE.length <= 1_500, `marathon guidance fixed part must stay under 1500 chars, got ${MARATHON_MODE_GUIDANCE.length}`)
})

test('a carried plan appends its open items inside the marathon block, capped at eight lines', () => {
  const now = new Date('2026-11-16T12:00:00.000Z')
  const seed = {
    revision: 4,
    items: [
      { content: 'Fill the shipping form', status: 'in_progress' },
      { content: 'Verify the confirmation page', status: 'pending' },
      { content: 'Already done', status: 'completed' },
      { content: 'Blocked on login', status: 'blocked' },
    ],
  }
  const text = buildPromptBlocks(view(), 'keep going with the shipment', now, [], { planMode: true, marathon: { seed } })[0].text
  assert.ok(text.includes(MARATHON_MODE_GUIDANCE.replace('</marathon_mode>', '')), 'the fixed guidance stays intact')
  assert.match(text, /Carried plan, revision 4 \(2 open\)/)
  assert.match(text, /use expected_revision:4/)
  // M2 tuning: continuation-fidelity wording (general, no task knowledge).
  assert.match(text, /Completed items are final: never repeat their actions or re-submit anything already accepted\./)
  assert.match(text, /Resume from the first open item below\./)
  assert.match(text, /When unsure what is already done, read the current page state before acting rather than redoing work\./)
  assert.match(text, /If it is a different task, replace the plan with acknowledge_open_removal:true and a reason\./)
  assert.match(text, /- \[in_progress\] Fill the shipping form/)
  assert.match(text, /- \[pending\] Verify the confirmation page/)
  assert.ok(!text.includes('- [completed]'), 'only open items are listed')
  assert.ok(!text.includes('- [blocked]'))
  assert.ok(text.indexOf('Carried plan') < text.indexOf('keep going with the shipment'))
  assert.ok(text.endsWith('keep going with the shipment'))

  // More than eight open items: the list caps at eight lines plus a note.
  const many = { revision: 9, items: Array.from({ length: 12 }, (_, i) => ({ content: `Step ${i + 1}`, status: i === 0 ? 'in_progress' : 'pending' })) }
  const manyText = buildPromptBlocks(view(), 'continue', now, [], { planMode: true, marathon: { seed: many } })[0].text
  const itemLines = manyText.split('\n').filter(line => /^- \[(pending|in_progress)\]/.test(line))
  assert.equal(itemLines.length, 8)
  assert.match(manyText, /…and 4 more open item\(s\) not listed\./)
  assert.match(manyText, /Carried plan, revision 9 \(12 open\)/)

  // No seed / invalid seed: the fixed block alone, never a guessed list.
  const plain = buildPromptBlocks(view(), 'x', now, [], { planMode: true })[0].text
  assert.ok(plain.includes(MARATHON_MODE_GUIDANCE))
  assert.ok(!plain.includes('Carried plan'))
  for (const bad of [null, {}, { revision: -1, items: seed.items }, { revision: 1.5, items: seed.items }, { revision: 1, items: [] }, { revision: 1, items: [{ content: 'x', status: 'done' }] }, { revision: 1, items: 'no' }]) {
    const badText = buildPromptBlocks(view(), 'x', now, [], { planMode: true, marathon: { seed: bad } })[0].text
    assert.ok(!badText.includes('Carried plan'), JSON.stringify(bad))
    assert.ok(badText.includes(MARATHON_MODE_GUIDANCE))
  }
})

test('confirm mode adds the approval instructions only when the setting is on', () => {
  const now = new Date('2026-11-11T12:00:00.000Z')
  const ordinary = buildPromptBlocks(view(), 'Submit the form', now)[0].text
  const armed = buildPromptBlocks(view(), 'Submit the form', now, [], { confirmMode: true })[0].text
  assert.doesNotMatch(ordinary, /<confirm_mode>|agent_request_confirmation/)
  assert.ok(armed.includes(CONFIRM_MODE_GUIDANCE))
  assert.match(armed, /overrides picking a default instead of asking/)
  assert.match(armed, /submits for grading or review/)
  assert.match(armed, /Never perform it in the same turn/)
  assert.match(armed, /<user_confirmation decision="approve">/)
  assert.ok(armed.indexOf('<confirm_mode>') < armed.indexOf('Submit the form'))
  assert.ok(armed.endsWith('Submit the form'))
  // Conditional guidance stays outside the standing-guidance ceiling and small.
  assert.ok(CONFIRM_MODE_GUIDANCE.length <= 600, `confirm guidance must stay under 600 chars, got ${CONFIRM_MODE_GUIDANCE.length}`)
  // Both conditional blocks can ride one turn, each before the user text.
  const both = buildPromptBlocks(view(), 'Plan and submit', now, [], { planMode: true, confirmMode: true })[0].text
  assert.ok(both.includes(MARATHON_MODE_GUIDANCE))
  assert.ok(both.includes(CONFIRM_MODE_GUIDANCE))
  assert.ok(both.endsWith('Plan and submit'))
})

test('isDocsDocumentUrl accepts only Google Docs document URLs', () => {
  for (const url of [
    'https://docs.google.com/document/d/abc123/edit',
    'https://docs.google.com/document/d/abc123/edit?tab=t.0',
    'https://docs.google.com/document/u/0/d/abc123/edit',
    'https://docs.google.com/document/u/2/d/abc123/pub',
  ]) assert.equal(isDocsDocumentUrl(url), true, url)
  for (const url of [
    'https://docs.google.com/spreadsheets/d/abc/edit',
    'https://docs.google.com/presentation/d/abc/edit',
    'https://docs.google.com/document/',
    'https://example.com/document/d/abc/edit',
    'http://docs.google.com/document/d/abc/edit',
    'https://docs.google.com.evil.test/document/d/abc/edit',
    'chrome://extensions',
    '', null, undefined, 42,
  ]) assert.equal(isDocsDocumentUrl(url), false, String(url))
})

test('docs mode appends the conditional Docs block only when armed, alongside plan and confirm', () => {
  const now = new Date('2026-11-16T12:00:00.000Z')
  const ordinary = buildPromptBlocks(view(), 'Edit the page', now)[0].text
  assert.doesNotMatch(ordinary, /<docs_mode>/u)
  const armed = buildPromptBlocks(view(), 'Edit the document', now, [], { docsMode: true })[0].text
  assert.ok(armed.includes(DOCS_MODE_GUIDANCE))
  assert.ok(armed.indexOf('<docs_mode>') < armed.indexOf('Edit the document'))
  assert.ok(armed.endsWith('Edit the document'))
  // All three conditionals can ride one turn, each before the user text.
  const all = buildPromptBlocks(view(), 'Plan, confirm, edit', now, [], { planMode: true, confirmMode: true, docsMode: true })[0].text
  assert.ok(all.includes(MARATHON_MODE_GUIDANCE))
  assert.ok(all.includes(CONFIRM_MODE_GUIDANCE))
  assert.ok(all.includes(DOCS_MODE_GUIDANCE))
  assert.ok(all.endsWith('Plan, confirm, edit'))
  // The split keeps a Docs turn within the old standing ceiling, and the
  // standing core is materially smaller than the pre-D2 guidance.
  assert.ok(CORE_GUIDANCE.length + DOCS_MODE_GUIDANCE.length <= 17_100)
  assert.ok(CORE_GUIDANCE.length < 12_000, `core guidance should leave headroom, got ${CORE_GUIDANCE.length}`)
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

test('V8: normalizePlanSeed keeps a blocked-item reason; buildPromptBlocks accepts the carried seed', () => {
  const seed = {
    revision: 4,
    items: [
      { content: 'Fill the shipping form', status: 'in_progress' },
      { content: 'Blocked on login', status: 'blocked', reason: 'sign-in wall blocks the form' },
    ],
  }
  const normalized = normalizePlanSeed(seed)
  assert.ok(normalized, 'seed with reason accepted (not silently empty)')
  assert.equal(normalized.items[1].reason, 'sign-in wall blocks the form')
  // reason on a non-blocked item fails closed.
  assert.equal(normalizePlanSeed({ revision: 4, items: [{ content: 'x', status: 'in_progress', reason: 'no' }] }), null)
  // prompt composition: the carried plan is formatted (open items listed); the
  // blocked item's reason is preserved in the seed but blocked items are not listed.
  const now = new Date('2026-11-16T12:00:00.000Z')
  const text = buildPromptBlocks(view(), 'continue', now, [], { planMode: true, marathon: { seed } })[0].text
  assert.match(text, /Carried plan, revision 4 \(1 open\)/)
  assert.match(text, /- \[in_progress\] Fill the shipping form/)
  assert.ok(!text.includes('- [blocked]'), 'blocked items are not listed in the carried prompt')
})
