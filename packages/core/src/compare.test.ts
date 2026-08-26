/*
 * Comparison.
 *
 * The tests that matter here are the refusals. Anybody can print two numbers
 * side by side; the value is in the cases where this one declines to, because
 * a comparison names a second company and a wrong number about somebody else's
 * product is the most expensive kind this repo can print.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { corroborate } from './corroborate.ts';
import {
  COMPARE_RECEIPTS_PER_SIDE, MIN_COMPARE_RECORDS,
  compareSides, hasCallableTerms, type CompareSide,
} from './compare.ts';
import type { Doc } from '@quorum/corpus';

let counter = 0;
function doc(text: string, channel: string): Doc {
  const externalId = `c${counter++}`;
  return {
    receiptId: `rc_${externalId}`,
    source: 'reddit',
    kind: 'comment',
    externalId,
    category: 'shoes',
    channel,
    text,
    score: 2,
    url: `https://r.test/${externalId}`,
    createdUtc: 1_700_000_000,
    harvestedAt: 1_700_000_000,
  };
}

/* `n` records for a term, each in its own channel so channel spread never
 * quietly decides a verdict a test meant to set with the record count. */
const claim = (term: string, n: number) =>
  corroborate(term, Array.from({ length: n }, (_, i) => doc(`${term} problem, voice ${i}`, `r/${term}${i}`)));

function side(subject: string, corpusRecords: number, claims: Record<string, number>): CompareSide {
  return {
    subject,
    category: subject,
    corpusRecords,
    claims: Object.entries(claims).map(([term, n]) => claim(term, n)),
  };
}

/* ------------------------------------------------------------------ */
/* what it refuses to say                                              */
/* ------------------------------------------------------------------ */

test('A COUNT IS NEVER COMPARED, ONLY A SHARE OF EACH CORPUS', () => {
  /*
   * The bug this module exists to prevent. Side A holds 14 sizing records and
   * side B holds 6, so the naive comparison says A is worse. A's corpus is
   * four times the size, so sizing is a SMALLER part of what is said about it.
   * The count difference measures how hard we looked in each place.
   */
  const result = compareSides([
    side('shoe a', 800, { sizing: 14 }),
    side('shoe b', 200, { sizing: 6 }),
  ], ['sizing']);

  const term = result.terms[0]!;
  assert.equal(term.sides[0]?.subject, 'shoe b', 'ranked by share, not by count');
  assert.equal(term.sides[0]?.records, 6, 'and the smaller count is the louder side');
  assert.ok(term.sides[0]!.sharePct > term.sides[1]!.sharePct);
});

test('A GAP INSIDE THE SAMPLING NOISE IS NOT A DIFFERENCE', () => {
  /* 8% against 6.7% on corpora of 50 and 60 records. Real arithmetic, and
   * nothing a reader should act on. */
  const result = compareSides([
    side('shoe a', 50, { sizing: 4 }),
    side('shoe b', 60, { sizing: 4 }),
  ], ['sizing']);

  const term = result.terms[0]!;
  assert.equal(term.louder, null);
  assert.ok(term.deltaPp <= term.noisePp, `${term.deltaPp} vs ${term.noisePp}`);
  assert.match(term.reason, /noise floor/);
});

test('A SIDE WE HOLD ALMOST NOTHING FOR IS NOT COMPARED AT ALL', () => {
  const result = compareSides([
    side('shoe a', 400, { sizing: 40 }),
    side('shoe b', MIN_COMPARE_RECORDS - 1, { sizing: 1 }),
  ], ['sizing']);

  const term = result.terms[0]!;
  assert.equal(term.louder, null);
  assert.match(term.reason, /not comparable/);
  assert.match(term.reason, /shoe b holds 29 records/);
  assert.deepEqual(result.thinSides, [{ subject: 'shoe b', corpusRecords: 29 }]);
});

test('HOLDING NOTHING IS REPORTED AS HOLDING NOTHING, NEVER AS A CLEAN SHEET', () => {
  const result = compareSides([
    side('shoe a', 400, { sizing: 40 }),
    side('shoe b', 400, {}),
  ], ['sizing']);

  const term = result.terms[0]!;
  assert.equal(term.louder, 'shoe a');
  assert.equal(term.sides[1]?.verdict, 'no-records', 'a third state, never folded into weak-signal');
  assert.match(term.reason, /holds no record of it, which is not evidence that it is fine/);
});

test('THE LOUDER SIDE IS NOT NAMED WHEN ITS OWN CLAIM IS BELOW THE THRESHOLD', () => {
  /*
   * Doctrine: a claim under the corroboration threshold is never printed as a
   * finding. "Shoe a is louder about sizing" is a claim about the market like
   * any other, and two records do not support it however wide the gap looks.
   */
  const result = compareSides([
    side('shoe a', 40, { sizing: 2 }),
    side('shoe b', 400, {}),
  ], ['sizing']);

  const term = result.terms[0]!;
  assert.equal(term.sides[0]?.verdict, 'weak-signal');
  assert.equal(term.louder, null);
  assert.match(term.reason, /weak signal at 2 records/);
});

test('a term neither side holds is called as such, not as a tie', () => {
  const result = compareSides([
    side('shoe a', 400, { sizing: 40 }),
    side('shoe b', 400, { sizing: 40 }),
  ], ['durability']);

  assert.equal(result.terms[0]?.louder, null);
  assert.match(result.terms[0]!.reason, /neither side holds a record/);
});

test('one side is not a comparison', () => {
  const result = compareSides([side('shoe a', 400, { sizing: 40 })], ['sizing']);
  assert.equal(result.terms[0]?.louder, null);
  assert.match(result.terms[0]!.reason, /needs two sides/);
  assert.equal(hasCallableTerms(result), false);
});

/* ------------------------------------------------------------------ */
/* what it does say                                                    */
/* ------------------------------------------------------------------ */

test('a real difference is called, and every side carries receipts to fetch back', () => {
  const result = compareSides([
    side('shoe a', 300, { sizing: 45 }),
    side('shoe b', 300, { sizing: 6 }),
  ], ['sizing']);

  const term = result.terms[0]!;
  assert.equal(term.louder, 'shoe a');
  assert.ok(term.deltaPp > term.noisePp);
  assert.match(term.reason, /15\.0% of what is said about shoe a against 2\.0% for shoe b/);
  assert.equal(hasCallableTerms(result), true);

  for (const s of term.sides) {
    assert.ok(s.sampleReceiptIds.length > 0, `${s.subject} cited nothing`);
    assert.ok(s.sampleReceiptIds.length <= COMPARE_RECEIPTS_PER_SIDE);
    for (const id of s.sampleReceiptIds) assert.match(id, /^rc_/);
  }
});

test('the baseline stays the subject the run was about, wherever it ranks', () => {
  const result = compareSides([
    side('shoe a', 300, { sizing: 3 }),
    side('shoe b', 300, { sizing: 45 }),
  ], ['sizing']);

  assert.equal(result.baseline, 'shoe a', 'first side in, whatever the shares say');
  assert.equal(result.terms[0]?.sides[0]?.subject, 'shoe b', 'and the table is still ranked');
});

test('three sides compare the loudest against the runner up, not against the floor', () => {
  const result = compareSides([
    side('shoe a', 300, { sizing: 45 }),
    side('shoe b', 300, { sizing: 42 }),
    side('shoe c', 300, { sizing: 1 }),
  ], ['sizing']);

  const term = result.terms[0]!;
  assert.equal(term.sides.length, 3);
  assert.equal(term.louder, null, 'the top two are a point apart, and the floor is irrelevant');
  assert.match(term.reason, /noise floor/);
});

test('every term asked about gets a row, in the order asked', () => {
  const result = compareSides([
    side('shoe a', 300, { sizing: 45, comfort: 9 }),
    side('shoe b', 300, { sizing: 6, comfort: 30 }),
  ], ['sizing', 'comfort', 'durability']);

  assert.deepEqual(result.terms.map((t) => t.term), ['sizing', 'comfort', 'durability']);
  assert.equal(result.terms[0]?.louder, 'shoe a');
  assert.equal(result.terms[1]?.louder, 'shoe b');
  assert.equal(result.terms[2]?.louder, null);
});
