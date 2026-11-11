/**
 * A1 seed scenario: download a file from the page, then upload that file
 * through a named file input and send it.
 *
 * Independent checks: the bytes the fixture server received in the multipart
 * POST, the bytes saved in the harness-owned Downloads folder (the only folder
 * the agent's file tools may use in an eval run), and the file inputs' own
 * state read over CDP. The source of truth is e2e/fixtures/payload.txt.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'download-upload'
export const fixture = 'files.html'
export const prompt = 'Download the payload file linked on this page, then attach that downloaded file to the Visible attachment input and click Send attachment.'
export const maxTurnSeconds = 150

const PAYLOAD = readFileSync(fileURLToPath(new URL('../fixtures/payload.txt', import.meta.url)))

/** Parse the first file part of a multipart body: { filename, content } or null. */
function filePart(body) {
  const headerEnd = body.indexOf('\r\n\r\n')
  if (headerEnd < 0) return null
  const header = body.subarray(0, headerEnd).toString('utf8')
  const filename = /filename="([^"]*)"/u.exec(header)?.[1]
  const boundary = /^(--[^\r\n]+)/u.exec(header)?.[1]
  if (!filename || !boundary) return null
  const contentStart = headerEnd + 4
  const contentEnd = body.indexOf(`\r\n${boundary}`, contentStart)
  if (contentEnd < 0) return null
  return { filename, content: body.subarray(contentStart, contentEnd) }
}

async function inputs(ctx) {
  return ctx.evaluate(`(() => {
    const describe = input => input ? { name: input.files[0]?.name ?? null, size: input.files[0]?.size ?? 0 } : null
    const shadow = document.getElementById('shadow-host')?.shadowRoot?.querySelector('input')
    return {
      visible: describe(document.getElementById('visible-file')),
      hidden: describe(document.getElementById('hidden-file')),
      other: describe(document.getElementById('other-file')),
      shadow: describe(shadow),
      state: document.getElementById('state')?.textContent ?? null,
    }
  })()`)
}

export async function check(ctx) {
  const uploads = ctx.requests()
    .filter(request => request.method === 'POST' && request.path === '/upload')
    .map(request => filePart(Buffer.from(request.body, request.bodyEncoding === 'utf8' ? 'utf8' : 'base64')))
  const downloads = ctx.downloads()
  const page = await inputs(ctx)
  const downloadedPayload = downloads.filter(file => file.bytes.equals(PAYLOAD)).map(file => file.name)
  const matching = uploads.filter(part => part?.content.equals(PAYLOAD))
  const evidence = {
    uploads: uploads.map(part => (part === null ? null : { filename: part.filename, size: part.content.length, matchesPayload: part.content.equals(PAYLOAD) })),
    downloads: downloads.map(file => ({ name: file.name, size: file.size, matchesPayload: file.bytes.equals(PAYLOAD) })),
    payloadSize: PAYLOAD.length,
    inputs: page,
  }
  const others = [page.hidden, page.other, page.shadow].filter(input => input !== null && input.name !== null)
  const visibleHoldsPayload = page.visible?.size === PAYLOAD.length
  if (uploads.length === 0) return { status: 'fail', reasons: ['nothing was uploaded'], evidence }
  if (matching.length === 0) return { status: 'fail', reasons: ['no uploaded file matches the payload bytes'], evidence }
  const problems = []
  if (uploads.length !== 1) problems.push(`${uploads.length} uploads, expected exactly 1`)
  if (downloadedPayload.length === 0) problems.push('the payload was never saved to Downloads')
  if (!visibleHoldsPayload) problems.push('the Visible attachment input does not hold the payload')
  if (others.length > 0) problems.push(`other file inputs were filled: ${others.map(input => input.name).join(', ')}`)
  if (problems.length === 0) {
    return { status: 'pass', reasons: ['downloaded bytes, the Visible input, and the one upload all match the payload'], evidence }
  }
  return { status: 'partial', reasons: problems, evidence }
}

/** Plausible-but-wrong: the page posts the payload itself; nothing was downloaded or attached. */
export async function tamper(ctx) {
  await ctx.evaluate(`(async () => {
    const blob = await (await fetch('/payload.txt')).blob()
    const data = new FormData()
    data.append('file', new File([blob], 'payload.txt', { type: 'text/plain' }))
    await fetch('/upload', { method: 'POST', body: data })
    return true
  })()`)
}

/** Positive control: save the payload to Downloads, attach it to the Visible input, send. */
export async function solve(ctx) {
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const path = join(ctx.downloadsDir, 'payload.txt')
  writeFileSync(path, PAYLOAD)
  const { root } = await ctx.cdp('DOM.getDocument', { depth: 0 })
  const { nodeId } = await ctx.cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '#visible-file' })
  await ctx.cdp('DOM.setFileInputFiles', { nodeId, files: [path] })
  await ctx.evaluate(`(async () => {
    document.getElementById('visible-file').dispatchEvent(new Event('change', { bubbles: true }))
    document.getElementById('send').click()
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (/^uploaded:/u.test(document.getElementById('state').textContent)) return true
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return false
  })()`)
}
