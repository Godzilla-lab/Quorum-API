import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openSqliteCorpus } from '@quorum/corpus';
import { labelledBreakdowns } from './labelled.ts';

async function seeded(n: number) {
  const corpus = openSqliteCorpus({ path: ':memory:' });
  const issues = ['Closing an account', 'Managing an account', 'Problem with a purchase'];
  await corpus.addDocs(Array.from({ length: n }, (_, i) => ({
    source: 'cfpb' as const, kind: 'post' as const, externalId: `c${i}`, channel: 'Chime Financial Inc',
    text: `complaint ${i} about my account and what chime did with it`, createdUtc: 1_700_000_000 + i,
    facets: { issue: issues[i % 3]!, company_response: i % 4 === 0 ? 'Closed with monetary relief' : 'Closed with explanation', timely: 'Yes' },
  })), 'chime');
  /* Voice from a forum has no labels and must not appear anywhere here. */
  await corpus.addDocs([{ source: 'reddit', kind: 'comment', externalId: 'r1', channel: 'r/chime', text: 'chime closed my account too', createdUtc: 1_700_000_000 }], 'chime');
  return corpus;
}

test('a breakdown tallies the regulator\'s labels with a visible denominator and receipts', async () => {
  const corpus = await seeded(12);
  try {
    const blocks = await labelledBreakdowns(corpus, 'chime');
    assert.deepEqual(blocks.map((b) => b.key), ['issue', 'company_response', 'timely']);
    const issue = blocks[0]!;
    assert.equal(issue.source, 'cfpb');
    assert.equal(issue.records, 12, 'the denominator is the records carrying the key');
    assert.deepEqual(issue.values.map((v) => v.records), [4, 4, 4]);
    assert.ok(issue.values.every((v) => Math.abs(v.share - 1 / 3) < 1e-9));
    assert.ok(issue.values.every((v) => v.receiptIds.length === 3), 'three receipts per value to open');
    const response = blocks[1]!;
    assert.deepEqual(response.values.map((v) => [v.value, v.records]), [['Closed with explanation', 9], ['Closed with monetary relief', 3]]);
    const resolved = await corpus.getByReceiptIds(response.values[1]!.receiptIds);
    assert.ok(resolved.every((d) => d.facets?.['company_response'] === 'Closed with monetary relief'), 'receipts are the rows counted');
  } finally { await corpus.close(); }
});

test('below the floor nothing is tallied, so six anecdotes never wear a percentage', async () => {
  const corpus = await seeded(6);
  try {
    assert.deepEqual(await labelledBreakdowns(corpus, 'chime'), []);
    assert.equal((await labelledBreakdowns(corpus, 'chime', { minRecords: 5 })).length, 3, 'the floor is a dial for tests, not a constant');
  } finally { await corpus.close(); }
});

test('a category with no labelled source is silent', async () => {
  const corpus = openSqliteCorpus({ path: ':memory:' });
  try {
    await corpus.addDocs([{ source: 'reddit', kind: 'comment', externalId: 'r1', channel: 'r/running', text: 'these shoes run small', createdUtc: 1_700_000_000 }], 'running shoes');
    assert.deepEqual(await labelledBreakdowns(corpus, 'running shoes'), []);
  } finally { await corpus.close(); }
});
