import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTurnEndEntry } from '../../src/parsers/inputParser';

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
