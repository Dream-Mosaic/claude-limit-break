import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isClaudePanelTab, selectClaudePanelTab } from '../src/panelTab';

// The runtime prefix confirmed by test/integration/panelReopen.itest.ts.
const CLAUDE_VIEW_TYPE = 'mainThreadWebview-claudeVSCodePanel-1';

test('isClaudePanelTab matches on the prefixed runtime viewType', () => {
  assert.equal(isClaudePanelTab({ viewType: CLAUDE_VIEW_TYPE, label: 'Claude Code' }), true);
});

test('isClaudePanelTab rejects an unrelated webview', () => {
  assert.equal(isClaudePanelTab({ viewType: 'mainThreadWebview-markdown.preview', label: 'Preview' }), false);
});

test('selectClaudePanelTab returns the one Claude tab among others', () => {
  const tabs = [
    { viewType: 'mainThreadWebview-markdown.preview', label: 'Preview' },
    { viewType: CLAUDE_VIEW_TYPE, label: 'Claude Code' },
  ];
  assert.deepEqual(selectClaudePanelTab(tabs), { viewType: CLAUDE_VIEW_TYPE, label: 'Claude Code' });
});

test('selectClaudePanelTab finds nothing to act on with zero Claude tabs', () => {
  const tabs = [{ viewType: 'mainThreadWebview-markdown.preview', label: 'Preview' }];
  assert.equal(selectClaudePanelTab(tabs), undefined);
});

test('selectClaudePanelTab refuses to guess between two Claude tabs', () => {
  const tabs = [
    { viewType: CLAUDE_VIEW_TYPE, label: 'Claude Code' },
    { viewType: CLAUDE_VIEW_TYPE, label: 'Claude Code (2)' },
  ];
  assert.equal(selectClaudePanelTab(tabs), undefined, 'no tab-to-session link means no safe pick between two');
});

test('selectClaudePanelTab on an empty tab list', () => {
  assert.equal(selectClaudePanelTab([]), undefined);
});
