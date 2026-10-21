import test from 'node:test'
import assert from 'node:assert/strict'
import { autoEffort, classifyPrompt, effortFor, stripViewHeader } from '../lib/reasoning.js'

test('strips the current-view header before classifying', () => {
  const text = '<current_view>\ntab 1 "x" https://x\nscroll document y=0/0\n</current_view>\n\nscroll down'
  assert.equal(stripViewHeader(text), 'scroll down')
})

test('classifies pure navigation as navigate', () => {
  for (const text of ['scroll down', 'list my tabs', 'go to my emails', 'switch to the github tab', 'open the docs tab']) {
    assert.equal(classifyPrompt(text), 'navigate', text)
  }
})

test('keeps reading and reporting at inspect or synthesize', () => {
  assert.equal(classifyPrompt('what is on this page?'), 'inspect')
  assert.equal(classifyPrompt('go to the google docs tab and tell me whats there'), 'inspect')
  assert.equal(classifyPrompt('scroll down and tell me which marker is visible'), 'inspect')
  assert.equal(classifyPrompt('tell me all about the emails on this page'), 'synthesize')
  assert.equal(classifyPrompt('compare these two tabs and explain the differences'), 'synthesize')
  assert.equal(classifyPrompt('a'.repeat(400)), 'synthesize')
})

test('classifies reactive game prompts as rapid', () => {
  assert.equal(classifyPrompt('play the canvas game and click the dots'), 'rapid')
  assert.equal(classifyPrompt('restart the game and click the dots as they appear'), 'rapid')
  assert.equal(classifyPrompt('whack the moles as fast as you can'), 'rapid')
})

test('auto effort is off for navigation and rapid bursts', () => {
  assert.equal(autoEffort('navigate'), 'off')
  assert.equal(autoEffort('rapid'), 'off')
  assert.equal(autoEffort('inspect'), 'low')
  assert.equal(autoEffort('synthesize'), 'low')
  assert.equal(effortFor('auto', 'rapid'), 'off')
})

test('rapid classification does not slow down reading or synthesis', () => {
  assert.equal(classifyPrompt('what is on this page?'), 'inspect')
  assert.equal(autoEffort('inspect'), 'low')
  assert.equal(classifyPrompt('go to docs and summarize'), 'synthesize')
  assert.equal(autoEffort('synthesize'), 'low')
})

test('explicit policy overrides classification', () => {
  assert.equal(effortFor('off', 'synthesize'), 'off')
  assert.equal(effortFor('high', 'navigate'), 'high')
  assert.equal(effortFor('medium', 'inspect'), 'medium')
  assert.equal(effortFor('auto', 'navigate'), 'off')
  assert.equal(effortFor('high', 'rapid'), 'high')
  assert.equal(effortFor('medium', 'rapid'), 'medium')
  assert.equal(effortFor('low', 'rapid'), 'low')
  assert.equal(effortFor('off', 'rapid'), 'off')
})
