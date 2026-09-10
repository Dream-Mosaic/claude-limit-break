import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRACE_MS, stallVerdict } from '../src/stallWatch';

test('a transcript that grew proves the resume took', () => {
  assert.equal(stallVerdict({ bytesAtLaunch: 500, bytesNow: 900 }), 'grew');
});

test('one more byte is still growth: any turn at all is the evidence wanted', () => {
  assert.equal(stallVerdict({ bytesAtLaunch: 500, bytesNow: 501 }), 'grew');
});

test('a transcript that did not move is a stall, not a success', () => {
  assert.equal(stallVerdict({ bytesAtLaunch: 500, bytesNow: 500 }), 'stalled');
});

test('a transcript that cannot be read is a stall: growth is proven, never assumed', () => {
  assert.equal(stallVerdict({ bytesAtLaunch: 500, bytesNow: undefined }), 'stalled');
});

test('a transcript that shrank is a stall, not growth', () => {
  // Nothing should truncate a transcript, but a smaller file is certainly not
  // evidence that the resumed session wrote a turn.
  assert.equal(stallVerdict({ bytesAtLaunch: 500, bytesNow: 100 }), 'stalled');
});

test('an empty transcript that stays empty is a stall', () => {
  // The launch-time read can fail and be recorded as zero; a session that then
  // writes nothing must not read as growth from 0 to 0.
  assert.equal(stallVerdict({ bytesAtLaunch: 0, bytesNow: 0 }), 'stalled');
});

test('the grace period is scheduling advice, not part of the verdict', () => {
  // stallVerdict takes no clock on purpose. When it re-checked the elapsed
  // time against this constant, a caller that shortened its timer got "too
  // soon" for healthy resumes and could not tell them from stalls.
  assert.equal(typeof GRACE_MS, 'number');
  assert.ok(GRACE_MS > 0);
  assert.equal(stallVerdict.length, 1, 'the verdict depends on bytes alone');
});
