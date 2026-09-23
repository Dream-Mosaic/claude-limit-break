import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReopenOffer, chooseReopenCommand } from '../src/reopenOffer';

const SESSION = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';

test('no live panel means no offer at all', () => {
  assert.equal(buildReopenOffer(SESSION, false, true, 'notify'), undefined);
  assert.equal(buildReopenOffer(SESSION, false, false, 'notify'), undefined);
  assert.equal(buildReopenOffer(SESSION, false, true, 'reopen'), undefined);
});

test('a live panel with a reopenable tab offers a button', () => {
  const offer = buildReopenOffer(SESSION, true, true, 'notify');
  assert.ok(offer);
  assert.equal(offer.button, 'Reopen session tab');
  assert.equal(offer.reopen, false, 'notify must not act on its own');
  assert.ok(offer.message.includes(SESSION.slice(0, 8)), 'the message must name the session');
});

test('the notification names the risk, not the stale view', () => {
  // The experiment (docs/research/2026-09-20-panel-fork-experiment.md) found
  // the cost is a dropped turn, not an out-of-date scrollback. A message that
  // only says "this tab is out of date" invites the exact action that loses
  // the turn.
  const offer = buildReopenOffer(SESSION, true, true, 'notify');
  assert.ok(offer);
  assert.match(offer.message, /before you type/i);
  assert.match(offer.message, /drop|lose|lost/i);
});

test('a live panel that cannot be reopened is text only', () => {
  const offer = buildReopenOffer(SESSION, true, false, 'notify');
  assert.ok(offer);
  assert.equal(offer.button, undefined);
  assert.equal(offer.reopen, false);
  assert.ok(offer.message.includes(SESSION.slice(0, 8)));
});

test('reopen mode acts instead of offering a button', () => {
  const offer = buildReopenOffer(SESSION, true, true, 'reopen');
  assert.ok(offer);
  assert.equal(offer.reopen, true);
  assert.equal(offer.button, undefined, 'nothing left to press once it has been done');
  assert.ok(offer.message.includes(SESSION.slice(0, 8)));
});

test('reopen mode falls back to the warning when there is no way to reopen', () => {
  // Same position as notify-without-a-command: there is a stale tab and no
  // means to act on it, so the user has to be told rather than left to type
  // into it.
  const offer = buildReopenOffer(SESSION, true, false, 'reopen');
  assert.ok(offer);
  assert.equal(offer.reopen, false);
  assert.equal(offer.button, undefined);
  assert.match(offer.message, /before you type/i);
});

test('chooseReopenCommand picks claude-vscode.reopenClosedSession when present', () => {
  assert.equal(
    chooseReopenCommand(['workbench.action.files.save', 'claude-vscode.reopenClosedSession']),
    'claude-vscode.reopenClosedSession',
  );
});

test('chooseReopenCommand finds nothing when the Claude Code extension is not installed', () => {
  assert.equal(chooseReopenCommand(['workbench.action.files.save']), undefined);
});

test('chooseReopenCommand never falls back to workbench.action.reopenClosedEditor', () => {
  // test/integration/panelReopen.itest.ts proved that command does not
  // restore a closed webview panel through its serializer, so it must never
  // be treated as usable here even when it is (as it always is) present.
  assert.equal(chooseReopenCommand(['workbench.action.reopenClosedEditor']), undefined);
});
