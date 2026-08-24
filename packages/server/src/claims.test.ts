/*
 * The hosted claims path, which had zero tests while both composition bugs of
 * the 2026-08-23 audit lived in it. These run against a real sqlite corpus,
 * because the path under test IS the composition: search, stance filter,
 * corroborate, and now synthesis behind its fabrication gate.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openSqliteCorpus, receiptId, type CorpusDriver } from '@quorum/corpus';
import type { AskModel } from '@quorum/core';
import { computeClaims } from './claims.ts';

async function seeded(): Promise<CorpusDriver> {
  const corpus = openSqliteCorpus({ path: ':memory:' });
  await corpus.addDocs([
    { source: 'reddit', kind: 'comment', externalId: 'a', channel: 'runningshoegeeks', text: 'the sizing runs small, size up half', score: 9, url: 'https://e.test/a', createdUtc: 1_700_000_000 },
    { source: 'reddit', kind: 'comment', externalId: 'b', channel: 'running', text: 'sizing was tight on me too', score: 4, url: 'https://e.test/b', createdUtc: 1_700_000_100 },
    { source: 'hackernews', kind: 'comment', externalId: 'c', channel: 'Ask HN', text: 'sizing runs a full size small in my experience', score: 2, url: 'https://e.test/c', createdUtc: 1_700_000_200 },
  ], 'running shoes');
  return corpus;
}

test('without a model, the report is arithmetic and says no synthesis ran', async () => {
  const corpus = await seeded();
  try {
    const claims = await computeClaims({
      corpus, category: 'running shoes', terms: ['sizing'],
      retrieval: null, subjectResolved: false,
    });
    assert.equal(claims.findings.length, 1, 'three receipts clear the threshold');
    assert.equal(claims.synthesis, null);
    assert.deepEqual(claims.rejected, []);
  } finally { await corpus.close(); }
});

test('with a model, its claims pass the fabrication gate and carry their cost', async () => {
  const corpus = await seeded();
  const ask: AskModel = async () => ({
    ok: true,
    model: 'test/model',
    json: { claims: [{ term: 'sizing', claim: 'Buyers consistently report this runs small.', evidence_ids: ['c0', 'c1', 'c2'] }] },
    usage: { inputTokens: 1000, outputTokens: 100 },
  });
  try {
    const claims = await computeClaims({
      corpus, category: 'running shoes', terms: ['sizing'],
      retrieval: null, subjectResolved: false,
      askModel: ask, subjectTitle: 'Trail X',
    });
    const synthesis = claims.synthesis as {
      model: string; costUsd: number;
      claims: { verdict: string; receipts: { receiptId: string }[] }[];
      fabrication: { clean: boolean };
    };
    assert.equal(synthesis.model, 'test/model');
    assert.equal(synthesis.claims[0]?.verdict, 'finding');
    assert.equal(synthesis.fabrication.clean, true);
    assert.ok(synthesis.costUsd >= 0, 'a cost is computed, zero for an unpriced test model');

    /* Every receipt the model cites resolves to a seeded record and is part
     * of the receiptCheck total. */
    const check = claims.receiptCheck as { cited: number; resolved: number; unresolved: string[] };
    assert.equal(check.unresolved.length, 0);
    const seededIds = new Set([
      receiptId('reddit', 'a'), receiptId('reddit', 'b'), receiptId('hackernews', 'c'),
    ]);
    for (const c of synthesis.claims) {
      for (const r of c.receipts) {
        assert.ok(seededIds.has(r.receiptId), `${r.receiptId} is not a record this corpus holds`);
      }
    }
  } finally { await corpus.close(); }
});

test('a model quoting words nobody said lands in rejected, not in findings', async () => {
  const corpus = await seeded();
  const ask: AskModel = async () => ({
    ok: true,
    model: 'test/model',
    json: {
      claims: [{
        term: 'sizing',
        claim: 'One buyer wrote "these gave me blisters within a mile" about the fit.',
        evidence_ids: ['c0'],
      }],
    },
    usage: { inputTokens: 500, outputTokens: 50 },
  });
  try {
    const claims = await computeClaims({
      corpus, category: 'running shoes', terms: ['sizing'],
      retrieval: null, subjectResolved: false, askModel: ask,
    });
    const rejected = claims.rejected as { verdict: string; unsupportedQuotes: string[] }[];
    assert.equal(rejected.length, 1, 'a fabricated quote is a rejection, reported rather than tidied away');
    assert.equal(rejected[0]?.verdict, 'rejected');
    assert.ok(rejected[0]!.unsupportedQuotes.length > 0);
  } finally { await corpus.close(); }
});

/* The live 2026-08-24 case: the transport THREW rather than failing, and the
 * whole report died. An exception of any shape must degrade, not propagate. */
test('an askModel that throws still returns the arithmetic report', async () => {
  const corpus = await seeded();
  const ask: AskModel = async () => {
    throw new TypeError('Invalid character in header content ["authorization"]');
  };
  try {
    const claims = await computeClaims({
      corpus, category: 'running shoes', terms: ['sizing'],
      retrieval: null, subjectResolved: false, askModel: ask,
    });
    assert.equal(claims.findings.length, 1, 'the findings owed nothing model shaped');
    const synthesis = claims.synthesis as { error?: string; claims: unknown[]; costUsd: number };
    assert.match(synthesis.error ?? '', /Invalid character/);
    assert.equal(synthesis.costUsd, 0);
  } finally { await corpus.close(); }
});

test('a model being down costs the prose and nothing else', async () => {
  const corpus = await seeded();
  const ask: AskModel = async () => ({ ok: false, error: 'provider unreachable' });
  try {
    const claims = await computeClaims({
      corpus, category: 'running shoes', terms: ['sizing'],
      retrieval: null, subjectResolved: false, askModel: ask,
    });
    assert.equal(claims.findings.length, 1, 'the arithmetic findings are untouched');
    const synthesis = claims.synthesis as { error?: string; claims: unknown[]; costUsd: number };
    assert.equal(synthesis.error, 'provider unreachable');
    assert.deepEqual(synthesis.claims, []);
    assert.equal(synthesis.costUsd, 0, 'a failed call charges nothing');
  } finally { await corpus.close(); }
});
