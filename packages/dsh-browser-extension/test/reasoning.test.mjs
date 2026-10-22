import test from 'node:test'
import assert from 'node:assert/strict'
import { autoEffort, classifyPrompt, effortFor, escalateEffort, shouldEscalate, stripViewHeader } from '../lib/reasoning.js'

test('strips the current-view header before classifying', () => {
  const text = '<current_view>\ntab 1 "x" https://x\nscroll document y=0/0\n</current_view>\n\nscroll down'
  assert.equal(stripViewHeader(text), 'scroll down')
})

test('classifies pure navigation as navigate', () => {
  for (const text of ['list my tabs', 'go to my emails', 'switch to the github tab', 'jump to the docs']) {
    assert.equal(classifyPrompt(text), 'navigate', text)
  }
})

test('keeps reading and reporting at inspect or synthesize', () => {
  assert.equal(classifyPrompt('what is on this page?'), 'inspect')
  assert.equal(classifyPrompt('go to the google docs tab and tell me whats there'), 'inspect')
  assert.equal(classifyPrompt('scroll down and tell me which marker is visible'), 'inspect')
  assert.equal(classifyPrompt('tell me all about the emails on this page'), 'synthesize')
  assert.equal(classifyPrompt('compare these two tabs and explain the differences'), 'synthesize')
  assert.equal(classifyPrompt('summarize this page'), 'synthesize')
  assert.equal(classifyPrompt('a'.repeat(400)), 'synthesize')
})

test('classifies reactive game prompts as rapid', () => {
  assert.equal(classifyPrompt('play the canvas game and click the dots'), 'rapid')
  assert.equal(classifyPrompt('restart the game and click the dots as they appear'), 'rapid')
  assert.equal(classifyPrompt('whack the moles as fast as you can'), 'rapid')
})

test('classifies short imperative work prompts as act', () => {
  const prompts = [
    'delete it all',
    'ok now add some comments, and try to be faster this time.',
    'fix the issues outlined by the comments and resolve them one by one',
    'reply to my email to myself',
    'scroll down',
    'open the docs tab',
    'click the Bold button',
    'fill in the form and submit it',
  ]
  for (const text of prompts) {
    assert.equal(classifyPrompt(text), 'act', text)
    assert.equal(autoEffort(classifyPrompt(text)), 'off', text)
  }
})

test('synthesize still wins over act for question and report prompts', () => {
  assert.equal(classifyPrompt('summarize and fix the page'), 'synthesize')
  assert.equal(classifyPrompt('why should I delete it all?'), 'synthesize')
})

test('auto effort is off for navigation, action, and rapid turns', () => {
  assert.equal(autoEffort('navigate'), 'off')
  assert.equal(autoEffort('act'), 'off')
  assert.equal(autoEffort('rapid'), 'off')
  assert.equal(autoEffort('inspect'), 'low')
  assert.equal(autoEffort('synthesize'), 'low')
  assert.equal(effortFor('auto', 'rapid'), 'off')
  assert.equal(effortFor('auto', 'act'), 'off')
})

test('act classification does not slow down reading or synthesis', () => {
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
  assert.equal(effortFor('high', 'act'), 'high')
  assert.equal(effortFor('medium', 'act'), 'medium')
  assert.equal(effortFor('low', 'act'), 'low')
  assert.equal(effortFor('off', 'act'), 'off')
})

test('classifies common editing and formatting verbs as act', () => {
  const prompts = [
    'change the heading to red',
    'update the status field',
    'modify the second row',
    'insert a row below this one',
    'put the cursor at the end',
    'make the title bigger',
    'resize the image to half width',
    'center the heading',
    'centre this paragraph',
    'upload the resume file',
    'attach the pdf to the email',
    'replace the title with the new one',
    'format the selected paragraph',
    'apply the heading 2 style',
    'align the image to the left',
    'bold the selected text',
    'italicize this word',
    'underline the heading',
    'increase the font size',
    'decrease the zoom level',
    'rename the document to notes',
    'please update the date field',
    'can you make the font larger',
  ]
  for (const text of prompts) {
    assert.equal(classifyPrompt(text), 'act', text)
    assert.equal(autoEffort(classifyPrompt(text)), 'off', text)
  }
})

test('classifies short follow-up corrections as act', () => {
  const prompts = [
    'smaller',
    'bigger',
    'again',
    'try again',
    'not that one',
    'you gotta scroll up',
    'scroll down',
    'go back',
    'undo that',
    'the other one',
    'the next one',
    'continue',
  ]
  for (const text of prompts) {
    assert.equal(classifyPrompt(text), 'act', text)
  }
})

test('questions and report prompts still win over follow-up detection', () => {
  assert.equal(classifyPrompt('is it smaller?'), 'inspect')
  assert.equal(classifyPrompt('what now?'), 'inspect')
  assert.equal(classifyPrompt('why is it bigger?'), 'synthesize')
  assert.equal(classifyPrompt('tell me again'), 'inspect')
  assert.equal(classifyPrompt('update me on what changed'), 'inspect')
  assert.equal(classifyPrompt('scroll down and tell me which marker is visible'), 'inspect')
  // A long prompt that mentions "again" is not a short correction.
  assert.equal(classifyPrompt('read the page and explain the whole flow again so I understand it'), 'synthesize')
})

test('escalateEffort turns off into low and leaves other efforts alone', () => {
  assert.equal(escalateEffort('off'), 'low')
  assert.equal(escalateEffort('low'), 'low')
  assert.equal(escalateEffort('medium'), 'medium')
  assert.equal(escalateEffort('high'), 'high')
})

test('shouldEscalate needs three consecutive no-progress results', () => {
  assert.equal(shouldEscalate(0), false)
  assert.equal(shouldEscalate(2), false)
  assert.equal(shouldEscalate(3), true)
  assert.equal(shouldEscalate(4), true)
  assert.equal(shouldEscalate(2, 2), true)
  assert.equal(shouldEscalate(undefined), false)
})