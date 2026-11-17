import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SLASH_ALIASES,
  SLASH_COMMANDS,
  SLASH_QUERY_MAX_CHARS,
  matchSlashCommands,
  nextSlashIndex,
  resolveSlashCommand,
  slashQuery,
} from '../sidepanel/slash.js'

/* ---------------------------------------------------------------- */
/* trigger detection: only a single leading slash token opens the menu */
/* ---------------------------------------------------------------- */

test('slash drafts are a single leading slash plus letters', () => {
  assert.equal(slashQuery('/'), '')
  assert.equal(slashQuery('/n'), 'n')
  assert.equal(slashQuery('/new'), 'new')
  assert.equal(slashQuery('/MODEL'), 'model')
})

test('ordinary prose and token-like text never open the menu', () => {
  for (const value of [
    '',
    'new',
    '/new chat',
    '/new ',
    '/new\n',
    '/usr/local/bin',
    ' /new',
    'check /new',
    '/new!',
    '/new2',
    '/new-extra',
    `/${'n'.repeat(SLASH_QUERY_MAX_CHARS + 1)}`,
  ]) {
    assert.equal(slashQuery(value), null, JSON.stringify(value))
  }
  assert.equal(slashQuery(undefined), null)
  assert.equal(slashQuery(null), null)
  assert.equal(slashQuery(42), null)
})

/* ---------------------------------------------------------------- */
/* filtering                                                         */
/* ---------------------------------------------------------------- */

test('commands filter by name prefix in display order', () => {
  assert.deepEqual(matchSlashCommands('').map(command => command.id), ['new', 'model', 'marathon'])
  assert.deepEqual(matchSlashCommands('n').map(command => command.id), ['new'])
  assert.deepEqual(matchSlashCommands('M').map(command => command.id), ['model', 'marathon'])
  assert.deepEqual(matchSlashCommands('mo').map(command => command.id), ['model'])
  assert.deepEqual(matchSlashCommands('ma').map(command => command.id), ['marathon'])
  assert.deepEqual(matchSlashCommands('MARATHON').map(command => command.id), ['marathon'])
  // The legacy /plan alias is unlisted: no prefix filter ever shows it.
  assert.deepEqual(matchSlashCommands('p'), [])
  assert.deepEqual(matchSlashCommands('pl'), [])
  assert.deepEqual(matchSlashCommands('plan'), [])
  assert.deepEqual(matchSlashCommands('x'), [])
  assert.deepEqual(matchSlashCommands().map(command => command.id), ['new', 'model', 'marathon'])
})

test('command definitions are unique, display-ready slash tokens', () => {
  const ids = SLASH_COMMANDS.map(command => command.id)
  const usages = SLASH_COMMANDS.map(command => command.usage)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(new Set(usages).size, usages.length)
  for (const command of SLASH_COMMANDS) {
    assert.ok(command.usage.startsWith('/'), command.usage)
    assert.equal(command.usage, `/${command.id}`)
    assert.ok(command.description.length > 0, command.id)
    assert.deepEqual(Object.isFrozen(command), true, 'commands are immutable')
  }
  assert.deepEqual(Object.isFrozen(SLASH_COMMANDS), true)
})

/* ---------------------------------------------------------------- */
/* send fallback: only an exact trigger runs a command               */
/* ---------------------------------------------------------------- */

test('only an exact slash token resolves to a command on send', () => {
  assert.equal(resolveSlashCommand('/new')?.id, 'new')
  assert.equal(resolveSlashCommand('/NEW')?.id, 'new')
  assert.equal(resolveSlashCommand('/model')?.id, 'model')
  assert.equal(resolveSlashCommand('/marathon')?.id, 'marathon')
  assert.equal(resolveSlashCommand('/MARATHON')?.id, 'marathon')
  for (const value of ['', '/', '/n', '/new ', ' /new', '/new chat', '/model\n', 'new', '/models', '/marathon ', ' /marathon', '/marathon task', '/marathon\n', 'marathon', '/marathons']) {
    assert.equal(resolveSlashCommand(value), null, JSON.stringify(value))
  }
  assert.equal(resolveSlashCommand(undefined), null)
})

test('the legacy /plan alias resolves to marathon without being listed', () => {
  const marathon = SLASH_COMMANDS.find(command => command.id === 'marathon')
  assert.deepEqual(SLASH_ALIASES, { '/plan': 'marathon' })
  assert.equal(resolveSlashCommand('/plan'), marathon)
  assert.equal(resolveSlashCommand('/PLAN'), marathon)
  // Still exact-token only: prose and near-misses never run the alias.
  for (const value of ['/plan ', ' /plan', '/plan task', '/plan\n', 'plan', '/plans', '/pl']) {
    assert.equal(resolveSlashCommand(value), null, JSON.stringify(value))
  }
  // The alias never appears in the palette.
  assert.ok(!SLASH_COMMANDS.some(command => command.usage === '/plan'))
  assert.ok(!matchSlashCommands('').some(command => command.usage === '/plan'))
})

/* ---------------------------------------------------------------- */
/* keyboard selection                                                */
/* ---------------------------------------------------------------- */

test('selection moves with wrapping and clamps to valid rows', () => {
  assert.equal(nextSlashIndex(0, 2, 1), 1)
  assert.equal(nextSlashIndex(1, 2, 1), 0)
  assert.equal(nextSlashIndex(0, 2, -1), 1)
  assert.equal(nextSlashIndex(1, 2, -1), 0)
  assert.equal(nextSlashIndex(0, 1, 1), 0)
  assert.equal(nextSlashIndex(0, 1, -1), 0)
  assert.equal(nextSlashIndex(4, 2, 1), 1)
  assert.equal(nextSlashIndex(-3, 2, 1), 0)
  assert.equal(nextSlashIndex(0, 0, 1), 0)
  assert.equal(nextSlashIndex(1, 3, 0), 1)
  assert.equal(nextSlashIndex(Number.NaN, 2, 1), 1)
})