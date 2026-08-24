import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doc } from '@quorum/corpus';
import { corroborate } from './corroborate.ts';
import type { RetrievalResult, SourceOutcome } from './retrieve.ts';
import { assessSufficiency } from './sufficiency.ts';

const doc = (receiptId: string): Doc => ({
  receiptId, source: 'reddit', kind: 'comment', externalId: receiptId,
  category: 'c', channel: 'r/running', text: 't', score: 1, url: 'u',
  createdUtc: 0, harvestedAt: 0,
});

function outcome(over: Partial<SourceOutcome> = {}): SourceOutcome {
  return {
    sourceId: 'reddit', status: 'ok', queriesPlanned: 1, queriesRun: 1,
    recordsSeen: 0, recordsGated: 0, recordsWritten: 0, elapsedMs: 1, ...over,
  };
}

function retrieval(over: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    category: 'c', outcomes: [], totalWritten: 0, totalSeen: 0, elapsedMs: 1,
    degraded: [], stoppedEarly: null, ...over,
  };
}

test('a finding means the question was answered', () => {
  const claims = [corroborate('sizing', [doc('a'), doc('b'), doc('c')])];
  const s = assessSufficiency({
    retrieval: retrieval({ totalSeen: 10, totalWritten: 10 }),
    claims, corpusRecords: 10, subjectResolved: true,
  });
  assert.equal(s.verdict, 'sufficient');
  assert.equal(s.findings, 1);
  assert.deepEqual(s.suggestions, []);
});

/*
 * The honest middle. Records exist and none of them cleared the bar, which is
 * a state a good report should be willing to end in rather than reaching for
 * something to say.
 */
test('records without corroboration is thin, and says how far short it fell', () => {
  const claims = [corroborate('sizing', [doc('a'), doc('b')])];
  const s = assessSufficiency({
    retrieval: retrieval({ totalSeen: 40, totalWritten: 12 }),
    claims, corpusRecords: 12, subjectResolved: true,
  });
  assert.equal(s.verdict, 'thin');
  assert.match(s.reason, /12 records held/);
  assert.match(s.suggestions.join(' '), /needs 3 independent receipts, and the strongest here has 2/);
});

/*
 * Measured live 2026-08-22. This is the case that produced 73 supermarket
 * comments in a "wool runner" report before the gate was fixed, and then 73
 * rejections after. The rejection is our gate working, and the advice has to
 * say so rather than telling someone to look harder.
 */
test('rejecting everything we found is reported as our gate, not as an empty market', () => {
  const s = assessSufficiency({
    retrieval: retrieval({
      totalSeen: 73, totalWritten: 0,
      outcomes: [outcome({ recordsSeen: 73, recordsGated: 73 })],
    }),
    claims: [corroborate('sizing', [])], corpusRecords: 0, subjectResolved: false,
  });
  assert.equal(s.verdict, 'insufficient');
  assert.match(s.reason, /every one of the 73 records found was rejected as off topic/);
  assert.match(s.suggestions.join(' '), /too broad/);
  assert.equal(s.rejected, 73);
});

test('finding nowhere to look is a different answer, with different advice', () => {
  const s = assessSufficiency({
    retrieval: retrieval({ totalSeen: 0, totalWritten: 0, outcomes: [outcome()] }),
    claims: [corroborate('sizing', [])], corpusRecords: 0, subjectResolved: false,
  });
  assert.equal(s.verdict, 'insufficient');
  assert.match(s.reason, /no records were found anywhere we looked/);
  assert.match(s.suggestions.join(' '), /--communities/);
  assert.match(s.suggestions.join(' '), /may genuinely have no public discussion yet/);
  assert.doesNotMatch(s.suggestions.join(' '), /too broad/, 'nothing was rejected, so that advice would mislead');
});

test('a resolved subject is not told to supply a url it already has', () => {
  const withUrl = assessSufficiency({
    retrieval: retrieval({ outcomes: [outcome()] }),
    claims: [], corpusRecords: 0, subjectResolved: true,
  });
  assert.doesNotMatch(withUrl.suggestions.join(' '), /pass the product URL/);

  const without = assessSufficiency({
    retrieval: retrieval({ outcomes: [outcome()] }),
    claims: [], corpusRecords: 0, subjectResolved: false,
  });
  assert.match(without.suggestions.join(' '), /pass the product URL/);
});

test('a missing leg is named, since it explains part of the gap', () => {
  const s = assessSufficiency({
    retrieval: retrieval({
      totalSeen: 20, totalWritten: 5,
      degraded: [{ source: 'hackernews', reason: 'empty', impact: 'x' }],
    }),
    claims: [corroborate('sizing', [doc('a')])], corpusRecords: 5, subjectResolved: true,
  });
  assert.equal(s.verdict, 'thin');
  assert.match(s.suggestions.join(' '), /hackernews contributed nothing/);
});

/*
 * The symmetric alarm. Measured live: a run on the subject "love" stored 2544
 * of 2544 records seen, printed findings from all of them, and this module
 * called it sufficient with nothing else to say. A gate that rejects nothing
 * on thousands of records has collapsed, and the report has to say so even
 * while the verdict stays sufficient.
 */
test('a gate that rejects nothing on a large run is flagged, even when sufficient', () => {
  const claims = [corroborate('sizing', [doc('a'), doc('b'), doc('c')])];
  const s = assessSufficiency({
    retrieval: retrieval({ totalSeen: 2544, totalWritten: 2544 }),
    claims, corpusRecords: 2544, subjectResolved: false,
  });
  assert.equal(s.verdict, 'sufficient');
  assert.match(s.warnings.join(' '), /rejects nothing/);
  assert.match(s.warnings.join(' '), /single common word/);
});

test('a healthy pass rate raises no warning', () => {
  const claims = [corroborate('sizing', [doc('a'), doc('b'), doc('c')])];
  const s = assessSufficiency({
    retrieval: retrieval({ totalSeen: 2604, totalWritten: 1746 }),
    claims, corpusRecords: 1746, subjectResolved: true,
  });
  assert.deepEqual(s.warnings, []);
});

test('a small scoped run passing everything is health, not collapse', () => {
  const s = assessSufficiency({
    retrieval: retrieval({ totalSeen: 5, totalWritten: 5 }),
    claims: [corroborate('sizing', [doc('a')])], corpusRecords: 5, subjectResolved: true,
  });
  assert.deepEqual(s.warnings, [], 'five for five from a regulator queried by name is fine');
});

test('a run where nearly everything was vouched for by its container is flagged', () => {
  const claims = [corroborate('sizing', [doc('a'), doc('b'), doc('c')])];
  const s = assessSufficiency({
    retrieval: retrieval({
      totalSeen: 400, totalWritten: 300,
      outcomes: [outcome({ recordsSeen: 400, recordsWritten: 300, recordsChannelVouched: 280 })],
    }),
    claims, corpusRecords: 300, subjectResolved: false,
  });
  assert.match(s.warnings.join(' '), /never name the subject themselves/);
});

test('a healthy share of elliptical comments in scoped communities is not flagged', () => {
  const claims = [corroborate('sizing', [doc('a'), doc('b'), doc('c')])];
  const s = assessSufficiency({
    retrieval: retrieval({
      totalSeen: 500, totalWritten: 300,
      outcomes: [outcome({ recordsSeen: 500, recordsWritten: 300, recordsChannelVouched: 120 })],
    }),
    claims, corpusRecords: 300, subjectResolved: true,
  });
  assert.deepEqual(s.warnings, [], '"Same, had to size up" inside a shoe community is the product working');
});

test('an offline run with a warm corpus is still assessed', () => {
  const s = assessSufficiency({
    retrieval: null,
    claims: [corroborate('sizing', [doc('a'), doc('b'), doc('c')])],
    corpusRecords: 400, subjectResolved: true,
  });
  assert.equal(s.verdict, 'sufficient');
  assert.equal(s.seen, 0, 'nothing was retrieved, and that is not a failure');
});
