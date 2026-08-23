import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brandCandidates } from './brands.ts';

/*
 * A HEURISTIC MUST SHOW ITS WORKING.
 *
 * This extractor is a capitalised word count, and on a real "running shoes" run
 * it offered Google, American, China, Clark and Ignition as brands. That output
 * is fine as a candidate list and was being printed as a finding, with counts
 * and nothing to check. The receipts are what make it honest.
 */
test('a candidate carries the receipts it was extracted from', () => {
  const candidates = brandCandidates([
    { text: 'I switched to Hoka last year and my knees thank me', channel: 'r/running', receiptId: 'rc_1111111111111111' },
    { text: 'Hoka runs narrow for me', channel: 'r/trailrunning', receiptId: 'rc_2222222222222222' },
  ]);

  const hoka = candidates.find((c) => c.name.toLowerCase() === 'hoka');
  assert.ok(hoka, 'the brand named in both records should be a candidate');
  assert.equal(hoka.records, 2);
  assert.deepEqual([...hoka.receiptIds].sort(), ['rc_1111111111111111', 'rc_2222222222222222']);
});

test('a candidate from a record with no id carries no id, rather than a fabricated one', () => {
  const [candidate] = brandCandidates([
    { text: 'Hoka is comfortable', channel: 'a' },
    { text: 'Hoka again', channel: 'b' },
  ]);
  assert.deepEqual(candidate?.receiptIds, []);
});
