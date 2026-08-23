/*
 * `receipts verify`, against a real SQLite corpus.
 *
 * This is the anti fabrication gate pointed at somebody else's output instead
 * of our own. Every research API in 2026 returns citations a calling agent
 * cannot check; this command is the check.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openSqliteCorpus, type CorpusDriver } from '@receipts/corpus';
import { readClaims, renderVerify, verifyClaims } from './verify.ts';

const scratch = mkdtempSync(join(tmpdir(), 'receipts-verify-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

async function seeded(): Promise<{ corpus: CorpusDriver; ids: string[] }> {
  const corpus = openSqliteCorpus({ path: join(scratch, `c-${Math.floor(performance.now() * 1000)}.db`) });
  await corpus.addDocs([
    { source: 'reddit', kind: 'comment', externalId: 'a', channel: 'r/running', text: 'these run small and I sized up half a size', score: 4, url: 'https://e.test/a', createdUtc: 1 },
    { source: 'reddit', kind: 'comment', externalId: 'b', channel: 'r/trail', text: 'the sizing is genuinely strange on these', score: 3, url: 'https://e.test/b', createdUtc: 1 },
    { source: 'hackernews', kind: 'comment', externalId: 'c', channel: 'a thread', text: 'I had to return mine because of the fit', score: 0, url: 'https://e.test/c', createdUtc: 1 },
  ], 'shoes');
  const rows = await corpus.byCategory('shoes');
  return { corpus, ids: rows.map((r) => r.receiptId) };
}

test('a report whose ids all resolve is clean and exits zero', async () => {
  const { corpus, ids } = await seeded();
  try {
    const result = await verifyClaims({ label: 'test', claims: [{ term: 'sizing', text: 'Sizing runs small.', receiptIds: ids }] }, corpus);
    assert.equal(result.clean, true);
    assert.equal(result.claims[0]?.resolved, 3);
    assert.equal(result.claims[0]?.verdict, 'finding');
  } finally { await corpus.close(); }
});

test('an invented id is named, and cannot contribute to the count', async () => {
  const { corpus, ids } = await seeded();
  try {
    const result = await verifyClaims({
      label: 'test',
      claims: [{ term: 'sizing', text: 'Sizing runs small.', receiptIds: [ids[0]!, 'rc_deadbeefdeadbeef', 'rc_0000000000000000'] }],
    }, corpus);

    assert.equal(result.clean, false);
    assert.deepEqual(result.claims[0]?.fabricated, ['rc_deadbeefdeadbeef', 'rc_0000000000000000']);
    /* Three ids cited, one real. The count is one, not three. */
    assert.equal(result.claims[0]?.records, 1);
    assert.equal(result.claims[0]?.verdict, 'weak-signal');
    assert.equal(result.claims[0]?.demoted, true, 'it only cleared the bar with ids that do not exist');
  } finally { await corpus.close(); }
});

test('a quote that appears in none of the cited records rejects the claim', async () => {
  const { corpus, ids } = await seeded();
  try {
    const result = await verifyClaims({
      label: 'test',
      claims: [{ term: 'sizing', text: 'One buyer said "these disintegrated after a week of light use".', receiptIds: ids }],
    }, corpus);

    assert.equal(result.claims[0]?.verdict, 'rejected');
    assert.equal(result.claims[0]?.unsupportedQuotes.length, 1);
    /* Every id resolved. The claim still fails, because a real citation under a
     * sentence nobody said is the more dangerous of the two failures. */
    assert.equal(result.claims[0]?.resolved, 3);
  } finally { await corpus.close(); }
});

test('a quote reflowed across lines is still the same quote', async () => {
  const { corpus, ids } = await seeded();
  try {
    const result = await verifyClaims({
      label: 'test',
      claims: [{ term: 'sizing', text: 'A buyer said "these   run small\nand I sized up half a size".', receiptIds: ids }],
    }, corpus);
    /* Whitespace and case are not fabrication. Changing a word is. */
    assert.deepEqual(result.claims[0]?.unsupportedQuotes, []);
  } finally { await corpus.close(); }
});

/*
 * The point of the command is checking output we did not produce, so it has to
 * read the shapes other people emit rather than only our own.
 */
test('it reads our own output shape', () => {
  const claims = readClaims({ claims: [{ term: 'sizing', receiptIds: ['rc_1', 'rc_2'] }] });
  assert.equal(claims.length, 1);
  assert.deepEqual(claims[0]?.receiptIds, ['rc_1', 'rc_2']);
});

test('it reads a findings array with claim text and evidence_ids', () => {
  const claims = readClaims({
    findings: [{ term: 'sizing', claim: 'Runs small.', evidence_ids: ['rc_1'] }],
  });
  assert.equal(claims[0]?.text, 'Runs small.');
  assert.deepEqual(claims[0]?.receiptIds, ['rc_1']);
});

test('it reads receipts given as objects rather than strings', () => {
  const claims = readClaims({ claims: [{ term: 'x', receipts: [{ receiptId: 'rc_1' }, { receiptId: 'rc_2' }] }] });
  assert.deepEqual(claims[0]?.receiptIds, ['rc_1', 'rc_2']);
});

test('a claim citing nothing is reported rather than skipped', async () => {
  const { corpus } = await seeded();
  try {
    const result = await verifyClaims({ label: 'test', claims: [{ term: 'price', text: 'Price is the top complaint.', receiptIds: [] }] }, corpus);
    /* It cannot be fabricated and it also cannot be supported. Saying so is the
     * honest answer, and silently dropping it would hide an unsourced claim. */
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0]?.cited, 0);
    assert.equal(result.claims[0]?.verdict, 'weak-signal');
  } finally { await corpus.close(); }
});

test('the rendered report names what was invented', async () => {
  const { corpus, ids } = await seeded();
  try {
    const result = await verifyClaims({
      label: 'somebody-elses-report.json',
      claims: [{ term: 'sizing', text: 'Runs small.', receiptIds: [ids[0]!, 'rc_deadbeefdeadbeef'] }],
    }, corpus);
    const text = renderVerify(result);
    assert.match(text, /somebody-elses-report\.json/);
    assert.match(text, /rc_deadbeefdeadbeef/);
    assert.match(text, /1 invented id/);
  } finally { await corpus.close(); }
});
