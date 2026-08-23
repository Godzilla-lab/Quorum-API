/*
 * Attested records are findings by existence.
 *
 * FOUND BY RUNNING IT, 2026-08-22. A "knee brace" report retrieved twelve real
 * FDA enforcement reports, stored all twelve, and answered "no evidence" to
 * every question, because the questions said "defects" and the recalls said
 * "sterile barrier compromised".
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doc, SourceId } from '@receipts/corpus';
import { attestedFindings } from './attested.ts';

const doc = (source: SourceId, id: string, channel: string, text = 'a long enough body of text to be a real record about the product'): Doc => ({
  receiptId: `rc_${id.padStart(16, '0')}`,
  source, kind: 'post', externalId: id, category: 'knee brace',
  channel, text, score: 0, url: `https://example.test/${id}`, createdUtc: 1, harvestedAt: 1,
});

test('a corpus with no attested record returns null rather than an empty block', () => {
  assert.equal(attestedFindings([doc('reddit', 'a', 'r/running')]), null);
});

test('two records from two named parties is a finding on its own', () => {
  const found = attestedFindings([
    doc('cpsc', 'a', 'Acme Corp'),
    doc('openfda', 'b', 'Zimmer, Inc.'),
  ]);
  assert.ok(found);
  assert.equal(found.records, 2);
  assert.equal(found.parties, 2);
  /* Two attested records clear the bar that three forum comments clear,
   * because a named party accepted consequences for saying it. */
  assert.equal(found.corroboration.verdict, 'finding');
  assert.equal(found.corroboration.basis, 'attested');
});

test('one attested record is a weak signal, not silence and not a finding', () => {
  const found = attestedFindings([doc('cpsc', 'a', 'Acme Corp')]);
  assert.ok(found, 'one recall is still worth showing');
  assert.equal(found.corroboration.verdict, 'weak-signal');
});

test('voice records never enter the attested block, however many there are', () => {
  const found = attestedFindings([
    doc('cpsc', 'a', 'Acme Corp'),
    ...Array.from({ length: 20 }, (_, i) => doc('reddit', `v${i}`, 'r/running')),
  ]);
  assert.ok(found);
  assert.equal(found.records, 1, 'twenty comments must not be counted as attestation');
});

test('two recalls against one firm is one firm, not two independent parties', () => {
  const found = attestedFindings([
    doc('cpsc', 'a', 'Acme Corp'),
    doc('cpsc', 'b', 'Acme Corp'),
  ]);
  assert.ok(found);
  assert.equal(found.records, 2);
  assert.equal(found.parties, 1, 'the party count is what tells a reader it is one company');
});

test('the block carries readable evidence and every id for checking', () => {
  const found = attestedFindings([
    doc('cpsc', 'a', 'Acme Corp', 'Acme recalls the widget because the strap can fail under load'),
    doc('openfda', 'b', 'Zimmer, Inc.', 'Zimmer recalls a knee brace after a sterile barrier was compromised'),
  ]);
  assert.ok(found);
  assert.equal(found.evidence.length, 2);
  assert.match(found.evidence[0]!.excerpt, /\w/, 'a reader must not have to fetch to find out what it says');
  assert.equal(found.receiptIds.length, 2);
  for (const e of found.evidence) assert.equal(e.tier, 'A');
});

test('a transactional record is not attestation, however factual it is', () => {
  /* A price is observable and it is still not a named party accepting
   * consequences for a statement. Widening this would make the block mean less
   * every time it fired. */
  assert.equal(attestedFindings([doc('shopify', 'a', 'store'), doc('wayback', 'b', 'archive')]), null);
});
