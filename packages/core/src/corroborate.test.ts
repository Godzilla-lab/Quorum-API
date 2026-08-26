import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doc } from '@quorum/corpus';
import { corroborate, findingsOnly } from './corroborate.ts';

function doc(over: Partial<Doc> & { receiptId: string }): Doc {
  return {
    source: 'reddit',
    kind: 'comment',
    externalId: over.receiptId,
    category: 'running shoes',
    channel: 'r/running',
    /* Distinct per receipt unless a test says otherwise: identical text is
     * deliberately counted as one voice, so a shared default here would turn
     * every counting test into a dedupe test. */
    text: `they run small, says ${over.receiptId}`,
    score: 4,
    url: 'https://example.test/1',
    createdUtc: 1_700_000_000,
    harvestedAt: 1_700_000_100,
    ...over,
  };
}

/*
 * Receipt ids name (source, externalId), not the words, so byte identical
 * text can arrive under two ids: the same S-1 boilerplate under two
 * accessions, measured live 2026-08-26, counted as two independent records.
 * One text is one voice however many ids carry it.
 */
test('byte identical text under different receipt ids counts once', () => {
  const result = corroborate('sizing', [
    doc({ receiptId: 'rc_a', text: 'inventory may be sold out in periods of high demand' }),
    doc({ receiptId: 'rc_b', text: 'inventory may be sold out in periods of high demand', channel: 'other-filer' }),
    doc({ receiptId: 'rc_c', text: 'inventory may be sold out  in periods of high demand ' }),
  ]);
  assert.equal(result.records, 1, 'one voice, however many accessions filed it');
  assert.equal(result.channels, 1, 'a copied text cannot widen the channel spread');
  assert.deepEqual(result.receiptIds, ['rc_a', 'rc_b', 'rc_c'],
    'every id still lists and resolves, so the dedupe is visible rather than silent');
  assert.equal(result.verdict, 'weak-signal');
});

test('a text counted in support never also counts as refutation', () => {
  const result = corroborate('sizing', [doc({ receiptId: 'rc_a', text: 'fits fine either way' })], {
    refuting: [doc({ receiptId: 'rc_z', text: 'fits fine either way' })],
  });
  assert.equal(result.refuting.records, 0, 'one utterance must never count on both sides');
  assert.deepEqual(result.refuting.receiptIds, ['rc_z']);
});

test('below the threshold is a weak signal, never a finding', () => {
  const result = corroborate('sizing', [doc({ receiptId: 'rc_a' }), doc({ receiptId: 'rc_b' })]);
  assert.equal(result.records, 2);
  assert.equal(result.verdict, 'weak-signal');
});

test('at the threshold it becomes a finding', () => {
  const result = corroborate('sizing', [
    doc({ receiptId: 'rc_a' }), doc({ receiptId: 'rc_b' }), doc({ receiptId: 'rc_c', channel: 'r/trailrunning' }),
  ]);
  assert.equal(result.records, 3);
  assert.equal(result.verdict, 'finding');
  assert.equal(result.threshold, 3);
});

/*
 * The channel floor, set 2026-08-26. A live category held 532 records from 2
 * channels, and one subreddit can put any volume behind a claim without a
 * second room ever hearing of it. One channel is one room.
 */
test('any number of records from one channel is a weak signal, basis preserved', () => {
  const result = corroborate('sizing', [
    doc({ receiptId: 'rc_a' }), doc({ receiptId: 'rc_b' }), doc({ receiptId: 'rc_c' }),
    doc({ receiptId: 'rc_d' }), doc({ receiptId: 'rc_e' }),
  ]);
  assert.equal(result.records, 5);
  assert.equal(result.channels, 1);
  assert.equal(result.verdict, 'weak-signal', 'volume without breadth does not promote');
  assert.equal(result.basis, 'receipt-count', 'the basis survives so a report can show why it came close');
});

test('two channels clear the floor', () => {
  const result = corroborate('sizing', [
    doc({ receiptId: 'rc_a' }), doc({ receiptId: 'rc_b' }), doc({ receiptId: 'rc_c', channel: 'r/trailrunning' }),
  ]);
  assert.equal(result.channels, 2);
  assert.equal(result.verdict, 'finding');
});

test('refutation is held to the same channel floor', () => {
  const result = corroborate('sizing', [
    doc({ receiptId: 'rc_a' }), doc({ receiptId: 'rc_b' }), doc({ receiptId: 'rc_c', channel: 'r/trailrunning' }),
  ], {
    refuting: [
      doc({ receiptId: 'rc_x' }), doc({ receiptId: 'rc_y' }), doc({ receiptId: 'rc_z' }),
    ],
  });
  assert.equal(result.refuting.records, 3);
  assert.equal(result.verdict, 'finding',
    'three disagreeing voices in one room do not contest what three rooms agreed on');
});

/*
 * The rule this module exists for. The same utterance harvested under two
 * categories is two rows and one voice, and counting rows would count the
 * person twice.
 */
test('the same receipt under two categories counts once', () => {
  const result = corroborate('sizing', [
    doc({ receiptId: 'rc_a', category: 'running shoes' }),
    doc({ receiptId: 'rc_a', category: 'trail shoes' }),
    doc({ receiptId: 'rc_a', category: 'sneakers' }),
  ]);
  assert.equal(result.records, 1);
  assert.equal(result.verdict, 'weak-signal', 'one voice cited three times is not corroboration');
  assert.deepEqual(result.receiptIds, ['rc_a']);
});

test('every counted receipt is listed, so a reader can fetch any of them back', () => {
  const result = corroborate('sizing', [
    doc({ receiptId: 'rc_a' }), doc({ receiptId: 'rc_b' }), doc({ receiptId: 'rc_a' }),
  ]);
  assert.deepEqual(result.receiptIds, ['rc_a', 'rc_b']);
  assert.equal(result.receiptIds.length, result.records);
});

test('channels are namespaced by source, so two sources cannot collide on a channel name', () => {
  const result = corroborate('sizing', [
    doc({ receiptId: 'rc_a', source: 'reddit', channel: 'general' }),
    doc({ receiptId: 'rc_b', source: 'hackernews', channel: 'general' }),
  ]);
  assert.equal(result.channels, 2);
});

test('source spread reports records and channels per source, busiest first', () => {
  const result = corroborate('sizing', [
    doc({ receiptId: 'rc_a', source: 'reddit', channel: 'r/running' }),
    doc({ receiptId: 'rc_b', source: 'reddit', channel: 'r/runningshoegeeks' }),
    doc({ receiptId: 'rc_c', source: 'reddit', channel: 'r/running' }),
    doc({ receiptId: 'rc_d', source: 'hackernews', channel: 'Ask HN' }),
  ]);
  assert.deepEqual(result.sources, [
    { source: 'reddit', records: 3, channels: 2 },
    { source: 'hackernews', records: 1, channels: 1 },
  ]);
});

test('no evidence is an empty weak signal rather than a crash', () => {
  const result = corroborate('durability', []);
  assert.equal(result.records, 0);
  assert.equal(result.channels, 0);
  assert.deepEqual(result.sources, []);
  assert.equal(result.verdict, 'weak-signal');
});

test('the threshold is overridable and the applied value is reported', () => {
  const result = corroborate('sizing', [doc({ receiptId: 'rc_a' })], { minReceipts: 1, minChannelsForFinding: 1 });
  assert.equal(result.verdict, 'finding');
  assert.equal(result.threshold, 1);
});

test('findingsOnly drops everything under the threshold', () => {
  const strong = corroborate('sizing', [doc({ receiptId: 'rc_a' }), doc({ receiptId: 'rc_b' }), doc({ receiptId: 'rc_c', channel: 'r/trailrunning' })]);
  const weak = corroborate('smell', [doc({ receiptId: 'rc_d' })]);
  assert.deepEqual(findingsOnly([strong, weak]).map((c) => c.term), ['sizing']);
});

/*
 * Tier weighting. Added rather than substituted: everything above this line
 * still passes unchanged, because every source in it is tier C.
 */

test('the receipt count route is untouched, so parity with the engine still holds', () => {
  const r = corroborate('sizing', [
    doc({ receiptId: 'rc_a' }), doc({ receiptId: 'rc_b' }), doc({ receiptId: 'rc_c', channel: 'r/trailrunning' }),
  ]);
  assert.equal(r.verdict, 'finding');
  assert.equal(r.basis, 'receipt-count');
  assert.deepEqual(r.tiers, { A: 0, B: 0, C: 3, D: 0 });
});

/*
 * The point of the second route. A recall notice and a forum thread saying the
 * same thing are more independent than three comments in one thread, so two
 * records land where three of one kind would be needed.
 */
test('an attested record plus a voice record is a finding on two receipts', () => {
  const r = corroborate('defects', [
    doc({ receiptId: 'rc_a', source: 'cpsc', channel: 'recall' }),
    doc({ receiptId: 'rc_b', source: 'reddit' }),
  ]);
  assert.equal(r.records, 2);
  assert.equal(r.verdict, 'finding');
  assert.equal(r.basis, 'cross-tier');
});

test('a transactional record plus a voice record also lands', () => {
  const r = corroborate('price', [
    doc({ receiptId: 'rc_a', source: 'shopify', channel: 'catalogue' }),
    doc({ receiptId: 'rc_b', source: 'hackernews' }),
  ]);
  assert.equal(r.verdict, 'finding');
  assert.equal(r.basis, 'cross-tier');
});

/* Two voice sources are still one tier, so the old threshold governs. */
test('two different voice sources do not cross a tier', () => {
  const r = corroborate('sizing', [
    doc({ receiptId: 'rc_a', source: 'reddit' }),
    doc({ receiptId: 'rc_b', source: 'hackernews' }),
  ]);
  assert.equal(r.verdict, 'weak-signal');
  assert.equal(r.basis, 'none');
});

/*
 * Context never promotes. A spike in pageviews is not somebody saying a shoe
 * runs small, and this is the assertion that keeps a report from sounding
 * confident about noise.
 */
test('tier D cannot promote a claim, however much of it there is', () => {
  const r = corroborate('demand', [
    doc({ receiptId: 'rc_a', source: 'wikipedia' }),
    doc({ receiptId: 'rc_b', source: 'gdelt' }),
    doc({ receiptId: 'rc_c', source: 'openalex' }),
    doc({ receiptId: 'rc_d', source: 'producthunt' }),
    doc({ receiptId: 'rc_e', source: 'jobs' }),
  ]);
  assert.equal(r.records, 5, 'the records are held and shown');
  assert.equal(r.tiers.D, 5);
  assert.equal(r.verdict, 'weak-signal', 'five context records still prove nothing');
});

test('context alongside real evidence neither helps nor hurts', () => {
  const withContext = corroborate('sizing', [
    doc({ receiptId: 'rc_a', source: 'reddit' }),
    doc({ receiptId: 'rc_b', source: 'reddit', channel: 'r/trailrunning' }),
    doc({ receiptId: 'rc_d', source: 'wikipedia' }),
  ]);
  assert.equal(withContext.verdict, 'weak-signal', 'two voice records plus context is still two');

  const withThird = corroborate('sizing', [
    doc({ receiptId: 'rc_a', source: 'reddit' }),
    doc({ receiptId: 'rc_b', source: 'reddit', channel: 'r/trailrunning' }),
    doc({ receiptId: 'rc_c', source: 'reddit', channel: 'r/runningshoegeeks' }),
    doc({ receiptId: 'rc_d', source: 'wikipedia' }),
  ]);
  assert.equal(withThird.verdict, 'finding');
  assert.equal(withThird.basis, 'receipt-count');
});

/*
 * Two government records are two independent attestations. Requiring a third
 * because they happen to share a tier calls real evidence a weak signal, which
 * is the mistake the first version of this rule made.
 */
test('two attested records land without needing a third of anything', () => {
  const r = corroborate('recalls', [
    doc({ receiptId: 'rc_a', source: 'cpsc' }),
    doc({ receiptId: 'rc_b', source: 'nhtsa' }),
  ]);
  assert.equal(r.verdict, 'finding');
  assert.equal(r.basis, 'attested');
});

test('two transactional records do NOT get the attested shortcut', () => {
  const r = corroborate('price', [
    doc({ receiptId: 'rc_a', source: 'shopify' }),
    doc({ receiptId: 'rc_b', source: 'wayback' }),
  ]);
  assert.equal(r.verdict, 'weak-signal',
    'an observable state is not an attestation, so the threshold still governs');
});

test('one attested record alone is not corroboration', () => {
  const r = corroborate('recalls', [doc({ receiptId: 'rc_a', source: 'cpsc' })]);
  assert.equal(r.verdict, 'weak-signal');
  assert.equal(r.basis, 'none');
});

/*
 * DISAGREEMENT IS PART OF THE ARITHMETIC, added 2026-08-25 after an outside
 * evaluator pointed out that eight records reporting a problem and seven
 * saying "no problems at all" printed as a finding on eight records with the
 * disagreement thrown away. For a product whose pitch is that corroboration
 * is arithmetic, that was the arithmetic failing where it matters most.
 */
test('BOTH SIDES PAST THE THRESHOLD IS CONTESTED, NEVER A FINDING', () => {
  const r = corroborate('problems', [
    doc({ receiptId: 'rc_a', channel: 'running' }),
    doc({ receiptId: 'rc_b', channel: 'trailrunning' }),
    doc({ receiptId: 'rc_c', channel: 'shoes' }),
  ], {
    refuting: [
      doc({ receiptId: 'rc_x', channel: 'running' }),
      doc({ receiptId: 'rc_y', channel: 'sneakers' }),
      doc({ receiptId: 'rc_z', channel: 'shoes' }),
    ],
  });
  assert.equal(r.verdict, 'contested');
  assert.equal(r.records, 3, 'the supporting count is intact');
  assert.equal(r.refuting.records, 3, 'and the disagreement travels beside it');
  assert.deepEqual(r.refuting.receiptIds, ['rc_x', 'rc_y', 'rc_z']);
});

test('disagreement below the threshold shapes nothing', () => {
  /* One "works fine for me" must not un-say a corroborated pattern any more
   * than one complaint may state one. */
  const r = corroborate('problems', [
    doc({ receiptId: 'rc_a', channel: 'running' }),
    doc({ receiptId: 'rc_b', channel: 'trailrunning' }),
    doc({ receiptId: 'rc_c', channel: 'shoes' }),
  ], { refuting: [doc({ receiptId: 'rc_x' })] });
  assert.equal(r.verdict, 'finding');
  assert.equal(r.refuting.records, 1, 'reported, so a caller can see it, never gated on alone');
});

test('ONLY the disagreement past the threshold is refuted', () => {
  const r = corroborate('problems', [doc({ receiptId: 'rc_a' })], {
    refuting: [
      doc({ receiptId: 'rc_x', channel: 'running' }),
      doc({ receiptId: 'rc_y', channel: 'sneakers' }),
      doc({ receiptId: 'rc_z', channel: 'shoes' }),
    ],
  });
  assert.equal(r.verdict, 'refuted');
  assert.equal(r.records, 1);
});

test('a receipt can never count both for and against a claim', () => {
  const r = corroborate('problems', [
    doc({ receiptId: 'rc_a' }), doc({ receiptId: 'rc_b' }), doc({ receiptId: 'rc_c' }),
  ], {
    refuting: [doc({ receiptId: 'rc_a' }), doc({ receiptId: 'rc_x' }), doc({ receiptId: 'rc_x' })],
  });
  assert.equal(r.records, 3);
  assert.equal(r.refuting.records, 1, 'rc_a already counted for, rc_x deduped to one voice');
});

test('no refuting rows means an empty refutation, and findingsOnly still excludes division', () => {
  const plain = corroborate('sizing', [
    doc({ receiptId: 'rc_a', channel: 'a' }),
    doc({ receiptId: 'rc_b', channel: 'b' }),
    doc({ receiptId: 'rc_c', channel: 'c' }),
  ]);
  assert.equal(plain.verdict, 'finding');
  assert.deepEqual(plain.refuting, { records: 0, channels: 0, receiptIds: [] });

  const contested = corroborate('problems', [
    doc({ receiptId: 'rc_a', channel: 'a' }),
    doc({ receiptId: 'rc_b', channel: 'b' }),
    doc({ receiptId: 'rc_c', channel: 'c' }),
  ], {
    refuting: [
      doc({ receiptId: 'rc_x', channel: 'a' }),
      doc({ receiptId: 'rc_y', channel: 'b' }),
      doc({ receiptId: 'rc_z', channel: 'c' }),
    ],
  });
  assert.deepEqual(findingsOnly([plain, contested]).map((c) => c.term), ['sizing'],
    'a contested claim never reaches a renderer as a finding');
});
