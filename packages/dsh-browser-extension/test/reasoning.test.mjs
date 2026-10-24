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
    assert.equal(autoEffort(classifyPrompt(text)), 'low', text)
  }
})

test('synthesize still wins over act for question and report prompts', () => {
  assert.equal(classifyPrompt('summarize and fix the page'), 'synthesize')
  assert.equal(classifyPrompt('why should I delete it all?'), 'synthesize')
})

test('auto effort is low for every classification', () => {
  for (const classification of ['navigate', 'inspect', 'synthesize', 'rapid', 'act']) {
    assert.equal(autoEffort(classification), 'low', classification)
    assert.equal(effortFor('auto', classification), 'low', classification)
  }
})

test('act classification does not slow down reading or synthesis', () => {
  assert.equal(classifyPrompt('what is on this page?'), 'inspect')
  assert.equal(autoEffort('inspect'), 'low')
  assert.equal(classifyPrompt('go to docs and summarize'), 'synthesize')
  assert.equal(autoEffort('synthesize'), 'low')
})

test('explicit policy overrides classification', () => {
  for (const classification of ['navigate', 'inspect', 'synthesize', 'rapid', 'act']) {
    for (const policy of ['off', 'low', 'medium', 'high']) {
      assert.equal(effortFor(policy, classification), policy, `${policy}/${classification}`)
    }
  }
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
    assert.equal(autoEffort(classifyPrompt(text)), 'low', text)
  }
})

test('classifies short work prompts whose verb is not first as act', () => {
  // 2026-10-23 run: these ran at low and cost 286-467 output tokens per call
  // against 101-176 on browser-work turns under the former off policy.
  for (const text of [
    'its a bit cramped, format it nicely',
    'format the entire document nicely. each question should be spaced apart.',
    'im doing engineering so remove the stuff i dont need to do',
    'unify the formatting. some is small some is bold some is serif',
    'make it nice serif font, bold necessary stuff',
    'do it and do it fast',
    'do that for the other tabs too',
  ]) {
    assert.equal(classifyPrompt(text), 'act', text)
  }
  // Short prompts that only ask for information stay inspectable.
  for (const text of [
    'list my tabs',
    'find the super matt email',
    'go to my email and see the newest one',
    'whats your name',
    'go to my emails and check what there is to respond to',
  ]) {
    const classified = classifyPrompt(text)
    assert.ok(classified === 'inspect' || classified === 'navigate', `${text} -> ${classified}`)
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

// The prompts below are verbatim `turn.start` events from
// .dsh-home/browser-agent/logs/*/events.jsonl (65 logged turns). They are the
// evidence for the classification changes documented in lib/reasoning.js.

test('logged manipulation turns are act/low even with an observational side verb', () => {
  // A read word used to cancel `act` wherever it appeared. Here "check it" is a
  // side remark on top of the leading imperative, not a request for a report.
  const prompts = [
    'add a few paragraphs',
    'add a few paragraphs to the doc and check it',
    'write a title and subtite too. be quick and hasty with it',
    'write a title',
    'type the heading',
    'open each tab procedurally',
    'click the Bold button and check it worked',
    'export part studio. id you dont know how, use google in a new tab',
    'export it for me',
    'you can do it. please try.',
    'Reply with exactly one word: pong',
  ]
  for (const text of prompts) {
    assert.equal(classifyPrompt(text), 'act', text)
    assert.equal(autoEffort(classifyPrompt(text)), 'low', text)
  }
})

test('logged retry nudges stay act with low reasoning', () => {
  const prompts = [
    'alright one last try',
    'yo one more time\\',
    'ok try again =, see if you can do better!',
    'alright one last try! good luck',
    'ok ill give you one more try. lets beat it',
    'ok try again!',
  ]
  for (const text of prompts) {
    assert.equal(classifyPrompt(text), 'act', text)
    assert.equal(autoEffort(classifyPrompt(text)), 'low', text)
  }
})

test('logged reading turns stay inspect with low reasoning', () => {
  // These turns need the page contents read and turned into an answer, so the
  // inner "check"/"see"/"find" must not make them action turns.
  const prompts = [
    'go to my emails and check what there is to respond to',
    'go to my emails and see',
    'go to my email and see the newest one',
    'check each courses calendar to see',
    'ok can you go to my schoology and check what homewoerk i have',
    'find the super matt email.',
    'go to my emails, find the email i sent myself, then add an html email as a reply. Make sure it looks nice.',
    'click the link and tell me where it goes',
    'add a few paragraphs and tell me what you wrote',
    // "scroll"/"open" only reach the content here; the reading is the task.
    'scroll and see everything',
    'open the dashboard and check the numbers',
    'whats your name',
  ]
  for (const text of prompts) {
    assert.equal(classifyPrompt(text), 'inspect', text)
    assert.equal(autoEffort(classifyPrompt(text)), 'low', text)
  }
})

test('logged navigation and game turns request low reasoning', () => {
  for (const text of ['go to a google doc and click through the menus.', 'go to a new tab google docs']) {
    assert.equal(classifyPrompt(text), 'navigate', text)
    assert.equal(autoEffort(classifyPrompt(text)), 'low', text)
  }
  // Typing a title after navigating is browser work whichever side of the
  // act/navigate line it lands on.
  const titleInNewDoc = 'go to a new doc and make a title. do it quickly.'
  assert.ok(['act', 'navigate'].includes(classifyPrompt(titleInNewDoc)), titleInNewDoc)
  assert.equal(autoEffort(classifyPrompt(titleInNewDoc)), 'low', titleInNewDoc)
  // "first 20" is a quantity, not a synthesis request; opening the emails is
  // browser manipulation.
  const openEmails = 'go to email and click open each email, first 20'
  assert.notEqual(classifyPrompt(openEmails), 'synthesize', openEmails)
  assert.equal(autoEffort(classifyPrompt(openEmails)), 'low', openEmails)
  const game = 'do it as quickly as possible, the game'
  assert.equal(classifyPrompt(game), 'rapid')
  assert.equal(autoEffort(classifyPrompt(game)), 'low')
})

test('long-form writing is synthesize/low, short page authoring is act/low', () => {
  const prompts = [
    'write a paragraph about my summer and explain the theme',
    'write a paragraph about the museum trip',
    'draft an email to my boss',
    'compose a cover letter',
    'write me a list of steps',
  ]
  for (const text of prompts) {
    assert.equal(classifyPrompt(text), 'synthesize', text)
    assert.equal(autoEffort(classifyPrompt(text)), 'low', text)
  }
  // Short typing into a page is an edit, not content synthesis.
  for (const text of ['write a title', 'type the heading', 'write a title and subtitle']) {
    assert.equal(classifyPrompt(text), 'act', text)
    assert.equal(autoEffort(classifyPrompt(text)), 'low', text)
  }
})

test('speed adjectives do not push a non-game prompt to rapid', () => {
  assert.equal(classifyPrompt('read the page as fast as you can and tell me the title'), 'inspect')
  assert.equal(classifyPrompt('be quick and hasty with it'), 'inspect')
})

test('browsing and observing prompts are not mistaken for navigation', () => {
  // "browse the headlines" reads page content even though it opens with "go".
  assert.equal(classifyPrompt('go to the news site and browse the headlines'), 'inspect')
  assert.equal(classifyPrompt('go to my email and find the latest invoice'), 'inspect')
  assert.equal(classifyPrompt('open the dashboard and check the numbers'), 'inspect')
})

test('ambiguous short continuations stay inspect (conservative)', () => {
  // "more", "wrong", "hi" could continue a reading turn or an action turn; the
  // classifier is stateless, so it keeps them inspectable when unsure.
  for (const text of ['more', 'wrong', 'hi', 'what else can you do']) {
    assert.equal(classifyPrompt(text), 'inspect', text)
    assert.equal(autoEffort(classifyPrompt(text)), 'low', text)
  }
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