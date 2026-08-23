import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isReceiptId, receiptId } from './receipt-id.ts';

test('an id is stable for the same record', () => {
  assert.equal(receiptId('reddit', 't1_abc123'), receiptId('reddit', 't1_abc123'));
});

test('an id is 19 characters: rc_ plus 16 hex', () => {
  const id = receiptId('reddit', 't1_abc123');
  assert.match(id, /^rc_[0-9a-f]{16}$/);
  assert.equal(id.length, 19);
});

test('different sources with the same external id do not collide', () => {
  assert.notEqual(receiptId('reddit', 'abc'), receiptId('youtube', 'abc'));
});

/*
 * The separator test. Without a NUL boundary, ("ab","c") and ("a","bc") would
 * both hash the string "abc" and produce one id for two unrelated records.
 */
test('field boundaries are unambiguous', () => {
  assert.notEqual(receiptId('ab', 'c'), receiptId('a', 'bc'));
});

/*
 * The load bearing property. A comment harvested under two categories must
 * resolve to ONE receipt, or corroboration counts the same human twice and
 * prints a number nobody said.
 */
test('the id names the utterance, not the row, so category cannot enter it', () => {
  const underRunningShoes = receiptId('reddit', 't1_same');
  const underTrailShoes = receiptId('reddit', 't1_same');
  assert.equal(underRunningShoes, underTrailShoes);
});

test('empty inputs are rejected rather than hashed into a plausible id', () => {
  assert.throws(() => receiptId('', 'abc'), /source/);
  assert.throws(() => receiptId('reddit', ''), /externalId/);
});

test('isReceiptId accepts real ids and rejects near misses', () => {
  assert.equal(isReceiptId(receiptId('reddit', 'x')), true);
  assert.equal(isReceiptId('rc_8f2a1'), false, 'the old short form is not valid');
  assert.equal(isReceiptId('rc_ABCDEF0123456789'), false, 'uppercase hex is not our format');
  assert.equal(isReceiptId('rc_0123456789abcdef0'), false, 'one character too long');
  assert.equal(isReceiptId('c12'), false, 'a prompt ordinal is not a receipt id');
  assert.equal(isReceiptId(null), false);
  assert.equal(isReceiptId(12345), false);
});

/*
 * Not a proof, just a smoke test that the hash spreads. A real collision at this
 * scale would mean the digest is broken, not that the bit count is wrong.
 */
test('no collisions across 50k synthetic records', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50_000; i++) seen.add(receiptId('reddit', `t1_${i}`));
  assert.equal(seen.size, 50_000);
});
