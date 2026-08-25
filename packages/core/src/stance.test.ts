/*
 * Stance. The fixture in the first test is the live 2026-08-23 record that
 * motivated the module: a glowing review counted as a problems receipt.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doc } from '@quorum/corpus';
import { evidenceRowsFor, mentionsAllNegated, splitEvidenceRows } from './stance.ts';

let n = 0;
const doc = (text: string): Doc => ({
  receiptId: `rc_${String(n).padStart(16, '0')}`, source: 'reddit', kind: 'comment',
  externalId: `s${n++}`, category: 'running shoes', channel: 'r/running', text,
  score: 1, url: 'https://e.test', createdUtc: 1, harvestedAt: 1,
});

test('praise wearing the complaint word is not a problems receipt', () => {
  const praise = doc(
    'I took these out for a 15 mile long run. I really liked the shoes. The foam was great, and I had absolutely no problem picking up the pace.',
  );
  assert.equal(mentionsAllNegated('problems', praise.text), true);
  assert.deepEqual(evidenceRowsFor('problems', [praise]), []);
});

test('a real complaint stays, and so does a mixed one', () => {
  const complaint = doc('The problem is the heel counter, it shredded two pairs of socks.');
  const mixed = doc('No problems with the sole, but a real problem showed up at the heel.');
  const kept = evidenceRowsFor('problems', [complaint, mixed]);
  assert.equal(kept.length, 2, 'one unnegated mention is enough to count');
});

test('negation does not reach across a long sentence', () => {
  const distant = doc('It is not, whatever the marketing says about the outsole compound, the problem I expected.');
  /* "not" sits nine words before "problem", far outside the window, so the
   * record keeps counting. The window is deliberately short: an over eager
   * negation filter throws away real complaints, which is a worse error. */
  assert.equal(mentionsAllNegated('problems', distant.text), false);
});

test('terms where negation is still evidence are untouched', () => {
  const price = doc('Honestly not worth the price at all.');
  const durability = doc('These are not durable, dead at 200 miles.');
  assert.deepEqual(evidenceRowsFor('price', [price]), [price], '"not worth the price" IS price evidence');
  assert.deepEqual(evidenceRowsFor('durability', [durability]), [durability]);
});

test('multi word complaint terms resolve by their complaint word', () => {
  const praise = doc('Two hundred miles in and no battery issues whatsoever.');
  assert.deepEqual(evidenceRowsFor('issues', [praise]), []);
});

/*
 * The split, added 2026-08-25: the negated records used to be silently
 * discarded, which threw the disagreement away. Now both sides come back and
 * the caller counts them against each other.
 */
test('THE SPLIT RETURNS BOTH SIDES AND LOSES NOTHING', () => {
  const rows = [
    doc('the sole separated after two weeks, real problems'),
    doc('had absolutely no problems with these, six months in'),
    doc('no issues at all, no problems, would buy again'),
  ];
  const { supporting, refuting } = splitEvidenceRows('problems', rows);
  assert.equal(supporting.length, 1);
  assert.equal(refuting.length, 2);
  assert.equal(supporting.length + refuting.length, rows.length, 'a partition, not a filter');
  assert.deepEqual(evidenceRowsFor('problems', rows), supporting,
    'the old entry point is the supporting half, unchanged for its callers');
});

test('a term outside the complaint set refutes nothing', () => {
  const rows = [doc('the sizing runs small'), doc('sizing is not accurate at all')];
  const { supporting, refuting } = splitEvidenceRows('sizing', rows);
  assert.equal(supporting.length, 2);
  assert.deepEqual(refuting, [],
    'claim level polarity is not guessed at lexically, so nothing is counted against');
});
