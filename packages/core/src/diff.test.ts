/*
 * Report diff.
 *
 * The property that matters most here is the one about NOT knowing: a diff
 * computed against a truncated snapshot must refuse to name new receipts rather
 * than name some of them. A partial list of what is new reads exactly like a
 * complete one, and there is nothing in the output to tell a reader otherwise.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { corroborate, withEvidence, type ClaimWithEvidence } from './index.ts';
import { receiptId, type Doc } from '@quorum/corpus';
import {
  MAX_SNAPSHOT_IDS, SNAPSHOT_VERSION,
  diffReports, isNotable, parseSnapshot, reportSnapshot,
  type ReportSnapshot,
} from './diff.ts';

let counter = 0;
function doc(text: string, channel: string): Doc {
  const externalId = `d${counter++}`;
  return {
    receiptId: receiptId('reddit', externalId),
    source: 'reddit',
    kind: 'comment',
    externalId,
    category: 'shoes',
    channel,
    text,
    score: 1,
    url: `https://r.test/${externalId}`,
    createdUtc: 1_700_000_000,
    harvestedAt: 1_700_000_000,
  };
}

const claim = (term: string, docs: Doc[]): ClaimWithEvidence =>
  withEvidence(corroborate(term, docs), docs);

const DAY = 86_400;

function snapshot(over: Partial<ReportSnapshot> = {}): ReportSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    category: 'shoes',
    createdAt: 1_787_000_000,
    corpusRecords: 10,
    claims: [],
    attestedRecords: 0,
    themes: [],
    trends: [],
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* the events worth waking somebody for                                */
/* ------------------------------------------------------------------ */

test('A CLAIM CROSSING THE THRESHOLD IS THE EVENT, AND THE NEW RECEIPTS ARE NAMED', () => {
  const two = [doc('sizing runs small', 'r/a'), doc('sizing is off', 'r/b')];
  const four = [...two, doc('sizing wrong for me', 'r/c'), doc('sizing chart lies', 'r/d')];

  const before = reportSnapshot({
    category: 'shoes', createdAt: 1_787_000_000, corpusRecords: 10,
    claims: [claim('sizing', two)], attestedRecords: 0, themes: [], trends: [],
  });
  const after = reportSnapshot({
    category: 'shoes', createdAt: 1_787_000_000 + 2 * DAY, corpusRecords: 15,
    claims: [claim('sizing', four)], attestedRecords: 0, themes: [], trends: [],
  });

  const diff = diffReports(before, after);
  const change = diff.claims[0]!;
  assert.equal(change.promoted, true);
  assert.equal(change.before?.verdict, 'weak-signal');
  assert.equal(change.after.verdict, 'finding');
  assert.equal(change.recordsAdded, 2);
  assert.equal(diff.corpusGrowth, 5);
  assert.equal(diff.ageDays, 2);

  /* NAMED, not counted. A reader has to be able to fetch the new thing. */
  assert.deepEqual(
    [...change.newReceiptIds].sort(),
    [four[2]!.receiptId, four[3]!.receiptId].sort(),
  );
  assert.equal(change.receiptsExact, true);
  assert.equal(isNotable(diff), true);
});

test('A DEMOTION IS REPORTED AS LOUDLY AS A PROMOTION', () => {
  /*
   * Records are appended and never rewritten, so this should be impossible. It
   * is not: a takedown removes a record, and a change to the gate moves the bar
   * under a claim that never moved itself. Those are the moments somebody most
   * needs to be told.
   */
  const three = [doc('a', 'r/a'), doc('b', 'r/b'), doc('c', 'r/c')];
  const before = reportSnapshot({
    category: 'shoes', createdAt: 1_787_000_000, corpusRecords: 10,
    claims: [claim('sizing', three)], attestedRecords: 0, themes: [], trends: [],
  });
  const after = reportSnapshot({
    category: 'shoes', createdAt: 1_787_000_000 + DAY, corpusRecords: 9,
    claims: [claim('sizing', three.slice(0, 2))], attestedRecords: 0, themes: [], trends: [],
  });

  const change = diffReports(before, after).claims[0]!;
  assert.equal(change.demoted, true);
  assert.equal(change.promoted, false);
  assert.equal(change.recordsAdded, -1);
});

test('a new attested record outranks everything and is counted separately', () => {
  const diff = diffReports(
    snapshot({ attestedRecords: 0 }),
    snapshot({ attestedRecords: 3, createdAt: 1_787_000_000 + DAY }),
  );
  assert.equal(diff.attestedAdded, 3);
  assert.equal(isNotable(diff), true);
});

test('a trend changing direction is a change about a change', () => {
  const diff = diffReports(
    snapshot({ trends: [{ term: 'sizing', direction: 'steady' }] }),
    snapshot({ trends: [{ term: 'sizing', direction: 'rising' }] }),
  );
  assert.deepEqual(diff.trendChanges, [{ term: 'sizing', before: 'steady', after: 'rising' }]);
});

test('a trend that stayed the same is not a change', () => {
  const diff = diffReports(
    snapshot({ trends: [{ term: 'sizing', direction: 'rising' }] }),
    snapshot({ trends: [{ term: 'sizing', direction: 'rising' }] }),
  );
  assert.deepEqual(diff.trendChanges, []);
});

test('a topic nobody had raised before is new, and one that was is not', () => {
  const diff = diffReports(
    snapshot({ themes: ['toe box'] }),
    snapshot({ themes: ['toe box', 'sole separation'] }),
  );
  assert.deepEqual(diff.newThemes, ['sole separation']);
});

/* ------------------------------------------------------------------ */
/* refusing to claim what it cannot know                               */
/* ------------------------------------------------------------------ */

test('A TRUNCATED SNAPSHOT NAMES NO NEW RECEIPTS, RATHER THAN NAMING SOME', () => {
  /*
   * The ids stored per claim are capped. Diffing against a partial list would
   * report every id that happened to fall outside the cap as new, which is not
   * new at all and is indistinguishable in the output from one that is.
   */
  const many = Array.from({ length: MAX_SNAPSHOT_IDS + 50 }, (_, i) => doc(`sizing ${i}`, `r/${i % 7}`));
  const before = reportSnapshot({
    category: 'shoes', createdAt: 1_787_000_000, corpusRecords: 400,
    claims: [claim('sizing', many)], attestedRecords: 0, themes: [], trends: [],
  });
  assert.equal(before.claims[0]?.truncated, true);
  assert.equal(before.claims[0]?.receiptIds.length, MAX_SNAPSHOT_IDS);

  const after = reportSnapshot({
    category: 'shoes', createdAt: 1_787_000_000 + DAY, corpusRecords: 420,
    claims: [claim('sizing', [...many, doc('one more', 'r/z')])], attestedRecords: 0, themes: [], trends: [],
  });

  const change = diffReports(before, after).claims[0]!;
  assert.equal(change.receiptsExact, false);
  assert.deepEqual(change.newReceiptIds, [], 'a partial list of new ids reads as a complete one');
  /* The count is still real and is still reported. */
  assert.equal(change.recordsAdded, 1);
});

test('A QUESTION ASKED FOR THE FIRST TIME IS NOT A CHANGE IN THE MARKET', () => {
  const three = [doc('a', 'r/a'), doc('b', 'r/b'), doc('c', 'r/c')];
  const after = reportSnapshot({
    category: 'shoes', createdAt: 1_787_000_000 + DAY, corpusRecords: 10,
    claims: [claim('durability', three)], attestedRecords: 0, themes: [], trends: [],
  });

  const change = diffReports(snapshot(), after).claims[0]!;
  assert.equal(change.before, null);
  assert.equal(change.promoted, false, 'it did not cross anything, it was never measured');
  assert.deepEqual(change.newReceiptIds, [], 'and its receipts are not all new evidence');
  assert.equal(change.receiptsExact, false);
});

test('nothing happening is not notable, so nothing is printed and no webhook fires', () => {
  const three = [doc('a', 'r/a'), doc('b', 'r/b'), doc('c', 'r/c')];
  const same = reportSnapshot({
    category: 'shoes', createdAt: 1_787_000_000, corpusRecords: 10,
    claims: [claim('sizing', three)], attestedRecords: 0, themes: [], trends: [],
  });
  const later = { ...same, createdAt: same.createdAt + DAY };

  const diff = diffReports(same, later);
  assert.equal(isNotable(diff), false);
  assert.equal(diff.claims[0]?.recordsAdded, 0);
});

/* ------------------------------------------------------------------ */
/* a stored snapshot is data, not a contract                           */
/* ------------------------------------------------------------------ */

test('a snapshot survives a json round trip', () => {
  const original = reportSnapshot({
    category: 'shoes', createdAt: 1_787_000_000, corpusRecords: 10,
    claims: [claim('sizing', [doc('a', 'r/a')])], attestedRecords: 2,
    themes: [], trends: [],
  });
  assert.deepEqual(parseSnapshot(JSON.parse(JSON.stringify(original))), original);
});

test('A SNAPSHOT FROM AN OLDER BUILD IS REFUSED RATHER THAN MISREAD', () => {
  /* A row outlives the code that wrote it, and a diff across two incompatible
   * shapes is a wrong number with a date on it. */
  assert.equal(parseSnapshot({ ...snapshot(), version: 0 }), null);
  assert.equal(parseSnapshot({ ...snapshot(), version: SNAPSHOT_VERSION + 1 }), null);
});

test('a half written or hand edited row degrades to no comparison', () => {
  for (const bad of [null, undefined, 'nope', 42, [], {}, { version: SNAPSHOT_VERSION }]) {
    assert.equal(parseSnapshot(bad), null, JSON.stringify(bad));
  }
  /* Missing claims array is fatal; a malformed entry inside it is skipped. */
  assert.equal(parseSnapshot({ ...snapshot(), claims: 'lots' }), null);
  const partial = parseSnapshot({
    ...snapshot(),
    claims: [{ term: 'sizing', records: 3 }, { records: 2 }, 'junk'],
  });
  assert.equal(partial?.claims.length, 1);
  assert.deepEqual(partial?.claims[0]?.receiptIds, []);
});

test('an empty findings object is not a snapshot', () => {
  /* What `saveReport` writes when a caller passes nothing, which every row
   * written before snapshots existed contains. */
  assert.equal(parseSnapshot({}), null);
});
