import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as provider from '../../packages/dsh-browser-extension/lib/action-expect.js'
import * as executor from '../sidepanel/action-expect.js'

const VALID = {
  export_contains: 'marker',
  toolbar_style: { bold: true },
  dialog: 'open',
  text_landed: 'marker',
  pixel_changed: true,
}
const EXPECT_KEYS = Object.keys(VALID)

test('provider and extension expectation modules are byte-identical', async () => {
  const [providerSource, executorSource] = await Promise.all([
    readFile(new URL('../../packages/dsh-browser-extension/lib/action-expect.js', import.meta.url), 'utf8'),
    readFile(new URL('../sidepanel/action-expect.js', import.meta.url), 'utf8'),
  ])
  assert.equal(executorSource, providerSource)
})

test('operation schemas and runtime capabilities accept exactly the same keys', () => {
  for (const batch of [false, true]) {
    const capabilities = batch ? provider.ACTION_EXPECT_BATCH_CHECKS : provider.ACTION_EXPECT_DIRECT_CHECKS
    for (const [op, supported] of Object.entries(capabilities)) {
      const schema = provider.actionExpectSchemaForOperation(op, { batch })
      assert.deepEqual(Object.keys(schema.properties).sort(), [...supported].sort(), `${op} batch=${batch}`)
      assert.deepEqual(executor.actionExpectSchemaForOperation(op, { batch }), schema)
      for (const key of EXPECT_KEYS) {
        const checked = provider.validateActionExpect({ [key]: VALID[key] }, { supportedChecks: supported })
        assert.equal(checked.ok, supported.includes(key), `${op}.${key} batch=${batch}`)
        if (!supported.includes(key)) assert.equal(checked.errors[0].code, 'EXPECT_UNSUPPORTED')
      }
    }
  }
})

test('toolbar schema removes unsupported attributes and all text schemas require non-whitespace', () => {
  const style = provider.ACTION_EXPECT_SCHEMA.properties.toolbar_style
  assert.deepEqual(Object.keys(style.properties).sort(), [...provider.ACTION_TOOLBAR_ATTRIBUTES].sort())
  assert.equal(style.properties.color, undefined)
  assert.equal(style.properties.highlight, undefined)
  assert.equal(style.properties.font.pattern, '\\S')
  assert.equal(provider.ACTION_EXPECT_SCHEMA.properties.text_landed.pattern, '\\S')
  assert.equal(provider.ACTION_EXPECT_SCHEMA.properties.export_contains.pattern, '\\S')
  for (const expectation of [
    { text_landed: '   ' },
    { export_contains: '\n\t' },
    { toolbar_style: { font: '   ' } },
    { toolbar_style: { color: '#aabbcc' } },
    { toolbar_style: { highlight: 'none' } },
  ]) {
    assert.equal(provider.validateActionExpect(expectation).ok, false, JSON.stringify(expectation))
  }
})

test('batch item schema conditions mirror per-operation batch capabilities', () => {
  const conditions = provider.actionExpectBatchItemConditions()
  for (const [index, op] of Object.keys(provider.ACTION_EXPECT_BATCH_CHECKS).entries()) {
    assert.equal(conditions[index].if.properties.op.const, op)
    assert.deepEqual(
      Object.keys(conditions[index].then.properties.expect.properties).sort(),
      [...provider.ACTION_EXPECT_BATCH_CHECKS[op]].sort(),
    )
    assert.equal(conditions[index].then.properties.args.type, 'object')
    assert.deepEqual(
      Object.keys(conditions[index].then.properties.args.properties.expect.properties).sort(),
      [...provider.ACTION_EXPECT_BATCH_CHECKS[op]].sort(),
    )
  }
  const unsupported = conditions.at(-1)
  assert.deepEqual(unsupported.if.properties.op.enum, ['hover', 'select_option', 'scroll', 'wait_for', 'navigate', 'select'])
  assert.equal(unsupported.then.properties.expect, false)
  assert.equal(unsupported.then.properties.args.properties.expect, false)
})
