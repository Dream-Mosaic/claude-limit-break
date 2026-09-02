import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectInputNeeded,
  detectInputNeededInLines,
  isTurnEndEntry,
} from '../../src/parsers/inputParser';

test('detects every permission-prompt wording', () => {
  const positives = [
    'No, and tell Claude what to do differently',
    'Do you want to proceed?',
    'Do you want to make this edit to limitParser.ts?',
    'Do you want to create README.md?',
    'Would you like to proceed?',
    'Waiting for your input',
    'Awaiting confirmation',
  ];
  for (const text of positives) {
    assert.ok(detectInputNeeded(text), text);
  }
});

test('ignores the user typing a question into the input box', () => {
  const buf = '> do you want to proceed with the refactor';
  assert.equal(detectInputNeededInLines(buf), undefined);
});

test('a numbered choice inside a permission box is the prompt, not typing', () => {
  const buf = '❯ 1. Yes\n  2. No, and tell Claude what to do differently';
  assert.ok(detectInputNeededInLines(buf));
});

test('an assistant end_turn entry hands the conversation back', () => {
  assert.ok(isTurnEndEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } }));
});

test('a sidechain end_turn does not, because sub-agents end turns constantly', () => {
  assert.equal(
    isTurnEndEntry({ type: 'assistant', message: { stop_reason: 'end_turn' }, isSidechain: true }),
    false,
  );
});

test('a tool_use stop reason is mid-turn', () => {
  assert.equal(isTurnEndEntry({ type: 'assistant', message: { stop_reason: 'tool_use' } }), false);
});

test('a user entry is never a turn end', () => {
  assert.equal(isTurnEndEntry({ type: 'user', message: { stop_reason: 'end_turn' } }), false);
});
