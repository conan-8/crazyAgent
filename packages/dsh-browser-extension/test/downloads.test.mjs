import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createDownloadsFolder } from '../lib/downloads.js'

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'crazyagent-downloads-test-'))
  const root = join(parent, 'Downloads')
  const outside = join(parent, 'outside.txt')
  await mkdir(root)
  await writeFile(outside, 'outside')
  t.after(() => rm(parent, { recursive: true, force: true }))
  return { parent, root, outside }
}

test('resolves regular files and nested relative names inside Downloads', async t => {
  const { root } = await fixture(t)
  await mkdir(join(root, 'nested'))
  await writeFile(join(root, 'nested', 'report.txt'), 'report')
  const folder = createDownloadsFolder(root)
  const file = await folder.resolveUpload('nested/report.txt')
  assert.equal(file.path, join(root, 'nested', 'report.txt'))
  assert.equal(file.filename, 'nested/report.txt')
  assert.equal(file.size, 6)
  assert.equal(file.root, root)
  assert.deepEqual(await folder.verifyDownload(file.path), file)
})

test('rejects absolute paths, traversal, missing files, and directories', async t => {
  const { root, outside } = await fixture(t)
  const folder = createDownloadsFolder(root)
  await assert.rejects(folder.resolveUpload(outside), error => error.code === 'DOWNLOADS_FILENAME_INVALID')
  await assert.rejects(folder.resolveUpload('../outside.txt'), error => error.code === 'DOWNLOADS_OUTSIDE_FOLDER')
  await assert.rejects(folder.resolveUpload('missing.txt'), error => error.code === 'DOWNLOADS_FILE_NOT_FOUND')
  await assert.rejects(folder.resolveUpload('.'), error => error.code === 'DOWNLOADS_NOT_A_FILE')
  await assert.rejects(folder.verifyDownload(outside), error => error.code === 'DOWNLOADS_OUTSIDE_FOLDER')
})

test('allows symlinks whose final file stays inside and rejects escapes', async t => {
  const { root, outside } = await fixture(t)
  await writeFile(join(root, 'inside.txt'), 'inside')
  await symlink(join(root, 'inside.txt'), join(root, 'inside-link.txt'))
  await symlink(outside, join(root, 'outside-link.txt'))
  const folder = createDownloadsFolder(root)
  const file = await folder.resolveUpload('inside-link.txt')
  assert.equal(file.filename, 'inside.txt')
  assert.equal(file.size, 6)
  await assert.rejects(folder.resolveUpload('outside-link.txt'), error => error.code === 'DOWNLOADS_OUTSIDE_FOLDER')
})

test('validates the configured root before any browser operation', async t => {
  const { root } = await fixture(t)
  assert.throws(() => createDownloadsFolder('relative/Downloads'), error => error.code === 'DOWNLOADS_FOLDER_INVALID')
  const folder = createDownloadsFolder(join(root, 'missing'))
  await assert.rejects(folder.resolveUpload('file.txt'), error => error.code === 'DOWNLOADS_FOLDER_UNAVAILABLE')
})

test('defaults to the home Downloads folder and keeps per-call errors precise', async () => {
  const fallback = createDownloadsFolder(undefined)
  assert.equal(fallback.root, resolve(homedir(), 'Downloads'))
  assert.ok(isAbsolute(fallback.root))
  const unavailable = createDownloadsFolder(join(tmpdir(), 'crazyagent-missing-downloads-dir'))
  await assert.rejects(unavailable.list(), error => error.code === 'DOWNLOADS_FOLDER_UNAVAILABLE')
})

test('finds regular files in bounded subdirectory levels without following directory symlinks', async t => {
  const { root } = await fixture(t)
  await mkdir(join(root, 'reports', 'q1'), { recursive: true })
  await writeFile(join(root, 'reports', 'q1', 'nested.txt'), 'nested')
  await writeFile(join(root, 'top.txt'), 'top')
  await mkdir(join(root, 'real-dir'))
  await writeFile(join(root, 'real-dir', 'linked.txt'), 'linked')
  await symlink(join(root, 'real-dir'), join(root, 'dir-link'))
  const folder = createDownloadsFolder(root)

  const found = await folder.list({ limit: 10 })
  const names = found.files.map(file => file.filename)
  assert.ok(names.includes('reports/q1/nested.txt'), JSON.stringify(names))
  assert.ok(names.includes('top.txt'))
  assert.ok(names.includes('real-dir/linked.txt'))
  assert.equal(names.some(name => name.startsWith('dir-link/')), false, 'directory symlinks must not be walked')
  assert.equal(found.scanTruncated, false)

  // Nested names keep the same normalized search matching as top-level files.
  const searched = await folder.list({ query: 'nested.txt', limit: 10 })
  assert.equal(searched.totalMatches, 1)
  assert.equal(searched.files[0].filename, 'reports/q1/nested.txt')

  // Deeper than the documented three subdirectory levels is not listed.
  await mkdir(join(root, 'a', 'b', 'c', 'd'), { recursive: true })
  await writeFile(join(root, 'a', 'b', 'c', 'd', 'deep.txt'), 'deep')
  const deeper = await folder.list({ limit: 10 })
  assert.equal(deeper.files.some(file => file.filename.endsWith('deep.txt')), false)
})

test('lists exact actual filenames with normalized search and bounded results', async t => {
  const { root, outside } = await fixture(t)
  await writeFile(join(root, 'Chapter+2+Review+Package-Oct25.docx'), 'review')
  await writeFile(join(root, 'other.txt'), 'other')
  await symlink(outside, join(root, 'escape.txt'))
  const folder = createDownloadsFolder(root)
  const matches = await folder.list({ query: 'chapter 2 review', limit: 10 })
  assert.equal(matches.totalMatches, 1)
  assert.equal(matches.truncated, false)
  assert.equal(matches.files[0].filename, 'Chapter+2+Review+Package-Oct25.docx')
  assert.equal(matches.files[0].size, 6)
  const bounded = await folder.list({ limit: 1 })
  assert.equal(bounded.files.length, 1)
  assert.equal(bounded.totalMatches, 2)
  assert.equal(bounded.truncated, true)
  assert.equal((await folder.list({ query: 'missing' })).totalMatches, 0)
  await assert.rejects(folder.list({ limit: 0 }), error => error.code === 'DOWNLOADS_QUERY_INVALID')
  await assert.rejects(folder.list({ query: 'x'.repeat(201) }), error => error.code === 'DOWNLOADS_QUERY_INVALID')
})
