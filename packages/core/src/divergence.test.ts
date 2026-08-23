/*
 * The gap between attested and voice evidence.
 *
 * Every competitor holds one kind of evidence. A recall aggregator has
 * regulators and no buyers; a listening tool has buyers and no regulators.
 * Holding both is what makes this question askable at all.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doc, SourceId } from '@quorum/corpus';
import { corroborate } from './corroborate.ts';
import { attestedSilence, notableGaps, tierGap } from './divergence.ts';

const doc = (source: SourceId, id: string, channel = 'somewhere'): Doc => ({
  receiptId: `rc_${id.padStart(16, '0')}`,
  source, kind: 'comment', externalId: id, category: 'kettle',
  channel, text: 'the handle gets hot enough to burn', score: 1,
  url: `https://example.test/${id}`, createdUtc: 1, harvestedAt: 1,
});

const gapFor = (records: Doc[]) => tierGap(corroborate('burns', records), records);

test('buyers reporting something nobody attested to is the finding worth having', () => {
  const gap = gapFor([doc('reddit', 'a'), doc('reddit', 'b', 'elsewhere'), doc('appstore', 'c')]);
  assert.equal(gap.divergence, 'voice-without-attestation');
  assert.equal(gap.voice, 3);
  assert.equal(gap.attested, 0);
  /* Either an emerging issue nobody has acted on, or a preference rather than a
   * defect. The report says which is unknown and hands over the receipts. */
  assert.match(gap.reason, /unacted on or it is a preference/);
  assert.equal(gap.voiceReceiptIds.length, 3);
});

test('one or two buyers is thin, not a gap', () => {
  /* A gap needs enough on the voice side to be a pattern rather than a person. */
  assert.equal(gapFor([doc('reddit', 'a')]).divergence, 'thin');
  assert.equal(gapFor([doc('reddit', 'a'), doc('reddit', 'b')]).divergence, 'thin');
});

test('a regulator acting while nobody discusses it means the market may not know', () => {
  const gap = gapFor([doc('cpsc', 'r1', 'Acme Corp')]);
  assert.equal(gap.divergence, 'attestation-without-voice');
  assert.equal(gap.attested, 1);
  assert.equal(gap.voice, 0);
  assert.match(gap.reason, /market may not know/);
});

test('both sides present is the strongest statement the product can make', () => {
  const gap = gapFor([doc('cpsc', 'r1', 'Acme Corp'), doc('reddit', 'a'), doc('reddit', 'b')]);
  assert.equal(gap.divergence, 'corroborated-across-tiers');
  assert.equal(gap.attested, 1);
  assert.equal(gap.voice, 2);
  assert.match(gap.reason, /both sides of the market/);
});

test('transactional evidence is counted and never mistaken for either side', () => {
  /* A price is observable and is neither a regulator attesting nor a buyer
   * speaking, so it must not tip the comparison in either direction. */
  const gap = gapFor([doc('shopify', 's1'), doc('wayback', 's2')]);
  assert.equal(gap.transactional, 2);
  assert.equal(gap.attested, 0);
  assert.equal(gap.voice, 0);
  assert.equal(gap.divergence, 'thin');
});

test('context never counts as a voice, however much of it there is', () => {
  const gap = gapFor([doc('wikipedia', 'w1'), doc('producthunt', 'w2'), doc('jobs', 'w3')]);
  assert.equal(gap.voice, 0, 'a pageview is not somebody saying the handle burns');
  assert.equal(gap.divergence, 'thin');
});

test('one utterance held under two categories is counted once, not as a gap', () => {
  /* The same record twice would manufacture a gap that is not there. */
  const same = doc('reddit', 'a');
  const gap = gapFor([same, { ...same, category: 'other' }]);
  assert.equal(gap.voice, 1);
});

test('thin comparisons are dropped, agreement is kept', () => {
  const gaps = [
    gapFor([doc('reddit', 'a')]),
    gapFor([doc('cpsc', 'r1'), doc('reddit', 'b')]),
  ];
  const notable = notableGaps(gaps);
  assert.equal(notable.length, 1);
  assert.equal(notable[0]?.divergence, 'corroborated-across-tiers');
});

/*
 * Silence as a result rather than as an absence. Every competitor returns an
 * empty array here, which reads as a failed query rather than as a clean record.
 */
test('silence is reported only when regulators actually answered', () => {
  const found = attestedSilence(['cpsc', 'openfda', 'eu-safety-gate'], 0);
  assert.ok(found);
  assert.equal(found.meaningful, true);
  assert.match(found.reason, /3 regulators that answered/);
});

test('silence with no regulator run is not a result, it is a gap in the run', () => {
  /* A source that was skipped or degraded proves nothing, and claiming a clean
   * record on the strength of it would be the worst kind of false negative. */
  assert.equal(attestedSilence([], 0), null);
});

test('silence is not claimed when something was in fact found', () => {
  assert.equal(attestedSilence(['cpsc'], 1), null);
});
