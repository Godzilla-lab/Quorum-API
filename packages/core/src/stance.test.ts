/*
 * Stance. The fixture in the first test is the live 2026-08-23 record that
 * motivated the module: a glowing review counted as a problems receipt.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doc } from '@quorum/corpus';
import { evidenceRowsFor, mentionsAllNegated } from './stance.ts';

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
