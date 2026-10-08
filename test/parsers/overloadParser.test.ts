import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectOverload } from '../../src/parsers/overloadParser';
import { detectLimit } from '../../src/parsers/limitParser';

test('detects transient server failures', () => {
  const positives = [
    'API Error: 500 Internal Server Error',
    'API Error: 503 Service Unavailable',
    'API Error: 529 {"type":"overloaded_error","message":"Overloaded"}',
    'Overloaded',
    'Request failed: fetch failed',
    'Error: connect ECONNRESET',
    'Error: socket hang up',
    'The request timed out',
  ];
  for (const text of positives) {
    assert.ok(detectOverload(text), text);
  }
});

test('a 429 is a rate limit and belongs to the limit parser', () => {
  assert.equal(detectOverload('API Error: 429 Too Many Requests'), undefined);
  assert.equal(detectOverload('Error 429: rate limit exceeded, try again in 2 hours'), undefined);
});

test('ignores prose and source code discussing server errors', () => {
  const negatives = [
    'const RULES = [{ id: "overloaded", re: /529/ }];',
    'I think the API was overloaded earlier in the queue.',
    'describe("overload", () => { expect(status).toBe(503); });',
    'Claude finished the task successfully.',
  ];
  for (const text of negatives) {
    assert.equal(detectOverload(text), undefined, text);
  }
});

test('reports the status code when one is present', () => {
  assert.equal(detectOverload('API Error: 503 Service Unavailable')?.status, 503);
  assert.equal(detectOverload('API Error: 529 Overloaded')?.status, 529);
});

test('rejects text longer than the notice cap', () => {
  assert.equal(detectOverload('API Error: 500 ' + 'x'.repeat(500)), undefined);
});

test('recognises a bare socket hang up, which is how Node prints it', () => {
  assert.ok(detectOverload('socket hang up'));
  assert.ok(detectOverload('Error: socket hang up'), 'prefixed form must keep working');
});

test('the added marker does not admit prose about sockets', () => {
  assert.equal(detectOverload('the socket layer hangs up on idle connections'), undefined);
});

// Claude Code's own in-flight retry must not also be scheduled. The PARENS form with
// a "Retrying in"/"attempt k/n" suffix is that retry; the COLON form with no such
// suffix is terminal and actionable.

test('an in-flight retry (parens form, "Retrying in"/"attempt k/n") must not schedule anything', () => {
  const positives = [
    // Exact spec string.
    'API Error (529 {"type":"error"}) · Retrying in 5s · attempt 3/10',
    // Close variants: other codes, other second counts, attempt 10/10, no JSON body.
    'API Error (500) · Retrying in 30s · attempt 10/10',
    'API Error (503 {"type":"error","message":"Service Unavailable"}) · Retrying in 12s · attempt 1/5',
  ];
  for (const text of positives) {
    assert.equal(detectOverload(text), undefined, text);
  }
});

test('the colon form with no retry suffix stays terminal and actionable', () => {
  assert.ok(detectOverload('API Error: 529 Overloaded'), 'colon form with no suffix must still fire');
});

// The transient-429 render disclaims being a usage limit in its own text and routes
// to overload instead of being dropped by both parsers.

const TRANSIENT_429 = 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited';

test('a transient 429 that disclaims being a usage limit routes to overload', () => {
  const hit = detectOverload(TRANSIENT_429);
  assert.ok(hit, 'must be detected as overload');
  assert.equal(hit.rule, 'transient-429');
});

test('the transient-429 render never arms a usage-limit timer, trusted or not', () => {
  assert.equal(detectLimit(TRANSIENT_429, new Date(), 24, { trusted: false }), undefined, 'untrusted path');
  assert.equal(detectLimit(TRANSIENT_429, new Date(), 24, { trusted: true }), undefined, 'trusted (flagged) path');
});

// "Computer went to sleep mid-response" and its sibling renders (dropped connection,
// stalled stream) route to overload as retry-class interruptions. Anchored on the
// "API Error:" head so prose that merely mentions sleep never matches.

test('sleep/stream-interruption renders route to overload', () => {
  const positives: [string, string][] = [
    // Exact spec string.
    ['API Error: Your computer went to sleep mid-response. The response above may be incomplete.', 'spec string'],
    ['API Error: Your computer went to sleep before a response was produced. Try again.', '2-autoretry-resume.md:296-297'],
    ['API Error: The response stopped arriving. The response above may be incomplete.', '1-autoretry-detection.md:81 (stalled stream)'],
    ['API Error: Connection lost mid-response. The response above may be incomplete.', '1-autoretry-detection.md:81 (dropped connection)'],
    ['API Error: Connection lost before a response was produced. Try again.', '1-autoretry-detection.md:81 (dropped connection)'],
    ['API Error: Server error mid-response. The response above may be incomplete.', '1-autoretry-detection.md:81'],
    ['API Error: The response stalled before a response was produced. Try again.', '1-autoretry-detection.md:81 (stalled stream)'],
  ];
  for (const [text, source] of positives) {
    const hit = detectOverload(text);
    assert.ok(hit, `${source}: ${text}`);
    assert.equal(hit.rule, 'stream-interrupted', source);
  }
});

test('prose merely mentioning sleep, without the API Error: head, never matches', () => {
  assert.equal(
    detectOverload('My computer went to sleep mid-response earlier today, is that a problem?'),
    undefined,
  );
});

test('the exact stream-interruption wording without the API Error: head does not match, even when other overload vocabulary is present', () => {
  // Isolates the head anchor: this text clears looksLikeOverloadMessage (it has
  // "error") and carries the sleep phrase, but with a bare "error:" instead of
  // "API Error:".
  assert.equal(
    detectOverload('There was an error: your computer went to sleep mid-response, apparently.'),
    undefined,
  );
});

// The transient-429 and stream-interrupted rules are anchored to a line start
// (matchesApiErrorLine, per physical line of the raw text), so "API Error:"
// mid-sentence in prose or inside a quoted shell argument does not fire.

test('mid-sentence "API Error:" for the stream-interrupted wording does not fire', () => {
  assert.equal(
    detectOverload(
      'Added a rule so API Error: Your computer went to sleep mid-response. The response above may be incomplete.',
    ),
    undefined,
  );
});

test('mid-sentence "API Error:" for the transient-429 wording does not fire', () => {
  assert.equal(
    detectOverload(
      'When Claude Code prints API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited we should back off.',
    ),
    undefined,
  );
});

test('a quoted shell argument echoing the sleep-interruption wording does not fire', () => {
  // The Bash tool_use `command` shape: a shell string literal, not a banner
  // line of its own.
  assert.equal(detectOverload('echo "API Error: Your computer went to sleep mid-response."'), undefined);
});

test('the verbatim renders still fire at the true start of the string', () => {
  assert.equal(detectOverload(TRANSIENT_429)?.rule, 'transient-429');
  assert.equal(
    detectOverload('API Error: Your computer went to sleep mid-response. The response above may be incomplete.')
      ?.rule,
    'stream-interrupted',
  );
});

test('the verbatim renders still fire on their own physical line, after a real newline', () => {
  const preceded = (banner: string) => `Some preceding context.\n${banner}`;
  assert.equal(detectOverload(preceded(TRANSIENT_429))?.rule, 'transient-429');
  assert.equal(
    detectOverload(
      preceded('API Error: Your computer went to sleep mid-response. The response above may be incomplete.'),
    )?.rule,
    'stream-interrupted',
  );
});

test('the message glyph Claude Code prefixes a banner line with is still accepted', () => {
  assert.equal(
    detectOverload('⏺ API Error: Your computer went to sleep mid-response. The response above may be incomplete.')
      ?.rule,
    'stream-interrupted',
  );
});

// Every transient render Claude Code documents. Each is the text of a FLAGGED entry;
// whether the entry is Claude Code's own is decided before detectOverload is called.

const STATUS_LINK = 'If it persists, check https://status.claude.com.';

/** [render, rule that must claim it, status it must report]. */
const DOCUMENTED_RENDERS: [string, string, number | undefined][] = [
  [
    `API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment. ${STATUS_LINK}`,
    'overloaded',
    529,
  ],
  [
    `API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment. ${STATUS_LINK}`,
    'api-error-status',
    500,
  ],
  [
    `API Error: Overloaded. This is a server-side issue, usually temporary — try again in a moment. ${STATUS_LINK}`,
    'overloaded',
    undefined,
  ],
  [
    `API Error: Request rejected (429) · this may be a temporary capacity issue. ${STATUS_LINK}`,
    'rejected-429',
    undefined,
  ],
  ['API Error: Server is temporarily limiting requests (not your usage limit)', 'transient-429', undefined],
  [
    'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
    'transient-429',
    undefined,
  ],
  [
    'API Error: No response from API (waited 3m, then 10m on the retry). If a proxy or gateway on your network holds responses until they complete, raise API_TIMEOUT_MS or CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS to wait longer.',
    'no-response',
    undefined,
  ],
  [
    'API Error: Connection to the API was lost (ECONNRESET). This is usually temporary — try again.',
    'connection-error',
    undefined,
  ],
  ['Request timed out', 'timeout', undefined],
  ['API Error: Server error mid-response. The response above may be incomplete.', 'stream-interrupted', undefined],
  ['API Error: Connection lost mid-response. The response above may be incomplete.', 'stream-interrupted', undefined],
  [
    'API Error: Your computer went to sleep mid-response. The response above may be incomplete.',
    'stream-interrupted',
    undefined,
  ],
  ['API Error: The response stopped arriving. The response above may be incomplete.', 'stream-interrupted', undefined],
  [
    'API Error: Part of the response never arrived. The response above may be incomplete.',
    'stream-interrupted',
    undefined,
  ],
  [
    'API Error: The response stream was malformed. The response above may be incomplete.',
    'stream-interrupted',
    undefined,
  ],
];

for (const [render, rule, status] of DOCUMENTED_RENDERS) {
  test(`the documented render is an overload (${rule}): ${render.slice(0, 60)}`, () => {
    const hit = detectOverload(render);
    assert.ok(hit, render);
    assert.equal(hit.rule, rule);
    assert.equal(hit.status, status);
    // Claude Code writes a usage limit as a different text altogether; none of
    // these may also arm a limit timer, trusted (flagged) or not.
    assert.equal(detectLimit(render, new Date(), 24, { trusted: true }), undefined, 'trusted limit path');
    assert.equal(detectLimit(render, new Date(), 24, { trusted: false }), undefined, 'untrusted limit path');
  });
}

test('the documented renders are still found on a line of their own, after other text and the message glyph', () => {
  for (const [render, rule] of DOCUMENTED_RENDERS) {
    assert.equal(detectOverload(`Some preceding context.\n⏺ ${render}`)?.rule, rule, render);
  }
});

test('the "//" in "https://status.claude.com" is what dropped the documented renders', () => {
  const withLink = `API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment. ${STATUS_LINK}`;
  // The control: the same sentence with only the scheme's "//" removed, so nothing
  // else in the text (error wording, em dash, length) is what drops the linked one.
  const withoutScheme = withLink.replace('https://', '');
  assert.equal(detectOverload(withoutScheme)?.rule, 'api-error-status', 'control: no "//" in the text');
  assert.equal(detectOverload(withLink)?.rule, 'api-error-status', 'a URL\'s "//" is not a code comment');
});

test('a real comment marker beside a banner still marks it as quoted source code', () => {
  assert.equal(detectOverload('API Error: 529 Overloaded // retry with backoff'), undefined);
  assert.equal(detectOverload('API Error: 529 Overloaded /* retry */'), undefined);
  // A link in the same line does not excuse the marker beside it.
  assert.equal(detectOverload('API Error: 529 Overloaded, see https://status.claude.com // TODO'), undefined);
});

test('"Request rejected (429)" carrying a usage-limit message stays a limit, not an overload', () => {
  // Real transcript: the same "Request rejected (429)" head, but the API's message is a
  // usage limit with a reset time. Only the "temporary capacity issue" tail is an overload.
  const usageLimit = 'API Error: Request rejected (429) · Claude AI usage limit reached|1789071998';
  assert.equal(detectOverload(usageLimit), undefined);
  assert.equal(
    detectLimit(usageLimit, new Date(1789071998 * 1000 - 3_600_000), 24, { trusted: true })?.rule,
    'epoch',
    'the limit parser still owns it',
  );
});

test('the no-response and request-rejected renders are anchored on their "API Error:" head', () => {
  assert.equal(
    detectOverload(
      'Added a rule so API Error: No response from API (waited 3m, then 10m on the retry) is retried.',
    ),
    undefined,
  );
  assert.equal(
    detectOverload(
      `When Claude Code prints API Error: Request rejected (429) · this may be a temporary capacity issue. ${STATUS_LINK} we back off.`,
    ),
    undefined,
  );
});

test('a connection loss is recognised whatever the OS error code', () => {
  // The code is interpolated into the render (`Connection to the API was lost
  // (${code})`), so ECONNRESET is one of several.
  for (const code of ['EPIPE', 'ETIMEDOUT', 'ECONNABORTED', 'ENETUNREACH']) {
    const hit = detectOverload(`API Error: Connection to the API was lost (${code}). This is usually temporary — try again.`);
    assert.equal(hit?.rule, 'connection-error', code);
  }
});

// Not transient, so a resume would only loop until the budget gives up.
const NOT_TRANSIENT_RENDERS = [
  'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
  "There's an issue with the selected model (claude-x). It may not exist or you may not have access to it. Run --model to pick a different model.",
  'API Error: Usage credits required for 1M context · turn on usage credits at claude.ai/settings/usage, or use --model to switch to standard context',
  "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
];

for (const render of NOT_TRANSIENT_RENDERS) {
  test(`a render that is not transient is neither an overload nor a limit: ${render.slice(0, 50)}`, () => {
    assert.equal(detectOverload(render), undefined, 'overload');
    assert.equal(detectLimit(render, new Date(), 24, { trusted: true }), undefined, 'limit, flagged');
    assert.equal(detectLimit(render, new Date(), 24, { trusted: false }), undefined, 'limit, unflagged');
  });
}

// A "Retrying in ..." line is Claude Code still retrying, so nothing is scheduled on
// top of it - with or without an attempt counter, in either unit spelling.
const IN_FLIGHT_RETRY_LINES = [
  'API Error (529 {"type":"error"}) · Retrying in 12s',
  'API Error (529 {"type":"error"}) · Retrying in 5s · attempt 3/10',
  'API Error (529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}) · Retrying in 1 seconds… (attempt 1/10)',
  'API Error: 500 Internal server error · Retrying in 20 seconds',
];

for (const line of IN_FLIGHT_RETRY_LINES) {
  test(`a "Retrying in" line is Claude Code still retrying: ${line.slice(-46)}`, () => {
    assert.equal(detectOverload(line), undefined, line);
  });
}

test('the same 529 without a "Retrying in" suffix is still terminal (control for the retry exclusion)', () => {
  assert.equal(detectOverload('API Error (529 {"type":"error"})')?.rule, 'api-error-status');
  assert.equal(detectOverload('API Error: 500 Internal server error')?.rule, 'api-error-status');
});

// The URL taken out before the code check stops at characters that end a link in
// source, so a glued-on comment marker still marks the text as quoted source.
test('a code marker glued onto a link still marks the text as quoted source', () => {
  for (const text of [
    'x = "https://a.com";//API Error: 529 Overloaded',
    'API Error: 529 Overloaded https://a.com/*x*/',
    "url = 'https://a.com'//API Error: 529 Overloaded",
    'API Error: 529 Overloaded (https://a.com)// see docs',
    'API Error: 529 Overloaded x = https://a.com;//retry',
    "API Error: 529 Overloaded 'https://a.com'=>retry",
    'API Error: 529 Overloaded https://a.com;return retry',
    'API Error: 529 Overloaded (https://a.com)=>retry',
  ]) {
    assert.equal(detectOverload(text), undefined, text);
  }
});

test('a link that ends a documented render sentence is still not a code marker', () => {
  const render = `API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment. ${STATUS_LINK}`;
  assert.equal(detectOverload(render)?.rule, 'api-error-status');
  assert.equal(detectOverload(`${render.slice(0, -1)} (https://status.claude.com/incidents/abc?x=1&y=2).`)?.rule, 'api-error-status');
});
