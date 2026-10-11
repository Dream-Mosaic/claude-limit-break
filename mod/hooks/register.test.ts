import { test, expect, mock } from 'claude-code/testing';

// The engine spells a path as the host does (C:\h\x on Windows), so the fake files are keyed by a neutral spelling.
const norm = (p: string) => p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/');

test('a valid control message is consumed and becomes a user prompt', async ($, on) => {
  mock.env(on, { HOME: '/h' });
  const clock = mock.clock(on, { now: 1_000 });
  const logged: string[] = [];
  on('ui.log', ($, e) => { logged.push(JSON.stringify(e)); return { value: undefined }; });
  const files = new Map<string, string>();
  on('fs.write', ($, e) => { files.set(norm(e.path), e.text); return { value: undefined }; });
  on('fs.read', ($, e) => {
    const text = files.get(norm(e.path));
    if (text === undefined) throw new Error('ENOENT');
    return { value: text };
  });
  on('session.id', () => ({ value: 'S1' }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('session.cwd', () => ({ value: '/w' }));
  const submitted: string[] = [];
  on('prompt.submit', ($, e) => { submitted.push(e.text); return { text: e.text }; });
  // The extension's control file.
  files.set('/h/.limit-break/control/S1.json', JSON.stringify({ protocol: 1, entries: [{ jobId: 'j1', nonce: 'n1', expiresAtMs: 60_000 }] }));
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false });
  const text = '<cross-session-message from="uds:limit-break" from-name="limit-break">\n[limit-break-control v1] {"jobId":"j1","nonce":"n1","prompt":"[Limit Break] continue"}\n</cross-session-message>';
  const result = await $.session.receive({ origin: { kind: 'peer' }, text });
  await clock.settle();
  expect(logged).toEqual([]);
  expect(result).toEqual({ consumed: 'limit-break control message' });
  expect(submitted).toEqual(['[Limit Break] continue']);
});
