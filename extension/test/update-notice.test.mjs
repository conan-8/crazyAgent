import test from 'node:test'
import assert from 'node:assert/strict'
import { completedUpdateNotice, settingsUpdateAction, settingsUpdateDetails, updateNotice } from '../sidepanel/update-notice.js'

test('pending and installing updates promise automatic installation and restart', () => {
  assert.deepEqual(updateNotice({ state: 'pending', latest: '2.5.1' }), {
    key: 'pending:2.5.1',
    tone: 'info',
    text: 'Update v2.5.1 ready; installs when crazyAgent is idle.',
  })
  assert.deepEqual(updateNotice({ state: 'installing', latest: 'v2.5.1' }), {
    key: 'installing:2.5.1',
    tone: 'info',
    text: 'Updating to v2.5.1… Companion will restart.',
  })
})

test('an unsupervised installation explains why an update cannot install itself', () => {
  const notice = updateNotice({ state: 'available', latest: '2.5.1' })
  assert.equal(notice.tone, 'info')
  assert.match(notice.text, /supervisor/u)
  assert.match(notice.text, /install automatically/u)
})

test('failures are bounded plain text and quiet states have no banner', () => {
  const notice = updateNotice({ state: 'error', reason: 'x'.repeat(400) })
  assert.equal(notice.tone, 'error')
  assert.equal(notice.text, `Automatic update failed: ${'x'.repeat(240)}`)
  for (const state of ['disabled', 'idle', 'current', 'ineligible']) {
    assert.equal(updateNotice({ state }), null)
  }
  assert.equal(updateNotice(null), null)
  assert.equal(updateNotice([]), null)
})

test('Settings gets a current version and a valid last-update timestamp', () => {
  const last = { from: '2.5.1', to: '2.5.2', at: '2026-11-17T20:00:00.000Z' }
  assert.deepEqual(settingsUpdateDetails({ current: 'v2.5.2', last }, '2.5.1'), {
    version: '2.5.2',
    updatedAt: '2026-11-17T20:00:00.000Z',
  })
  assert.deepEqual(settingsUpdateDetails(null, 'v2.5.2'), { version: '2.5.2', updatedAt: null })
  assert.deepEqual(settingsUpdateDetails({ current: 'invalid', last: null }, '2.5.2'), { version: '2.5.2', updatedAt: null })
  assert.deepEqual(settingsUpdateDetails({ current: '2.5.2', last: { at: 'not a date' } }), { version: '2.5.2', updatedAt: null })
  assert.deepEqual(settingsUpdateDetails(undefined, undefined), { version: null, updatedAt: null })
})

test('a completed update has one stable announcement key', () => {
  const last = { from: '2.5.0', to: '2.5.1', at: '2026-11-17T20:00:00.000Z' }
  assert.deepEqual(completedUpdateNotice({ last }), {
    key: '2.5.0:2.5.1:2026-11-17T20:00:00.000Z',
    text: 'Updated to v2.5.1; companion restarted.',
  })
  assert.equal(completedUpdateNotice({ last: { ...last, to: 'not a version' } }), null)
  assert.equal(completedUpdateNotice({ last: { ...last, at: 'invalid' } }), null)
  assert.equal(completedUpdateNotice({}), null)
})

test('settingsUpdateAction maps manual update button label, state, and tone cleanly', () => {
  assert.equal(settingsUpdateAction(null, { connected: false }).disabled, true)
  assert.equal(settingsUpdateAction({ state: 'idle' }, { connected: true }).label, 'Check for updates')
  assert.equal(settingsUpdateAction({ state: 'current', current: '2.6.1' }).statusText, 'Up to date (v2.6.1).')
  const checking = settingsUpdateAction({ state: 'checking' })
  assert.equal(checking.label, 'Checking…')
  assert.equal(checking.disabled, true)
  assert.equal(updateNotice({ state: 'checking' }), null)

  const pending = settingsUpdateAction({ state: 'pending', latest: '2.7.0' })
  assert.equal(pending.label, 'Update to v2.7.0')
  assert.equal(pending.action, 'install')
  assert.equal(pending.primary, true)
  assert.equal(pending.disabled, false)

  const installing = settingsUpdateAction({ state: 'installing', latest: '2.7.0' })
  assert.equal(installing.label, 'Updating…')
  assert.equal(installing.disabled, true)

  const available = settingsUpdateAction({ state: 'available', latest: '2.7.0' })
  assert.equal(available.action, 'check')
  assert.match(available.statusText, /npm run dev/u)

  assert.equal(settingsUpdateAction({ state: 'disabled', reason: 'off' }).disabled, true)
  assert.match(settingsUpdateAction({ state: 'ineligible', reason: 'branch' }).statusText, /branch/u)
  const errored = settingsUpdateAction({ state: 'error', reason: 'offline' })
  assert.equal(errored.tone, 'error')
  assert.equal(errored.disabled, false)
})
