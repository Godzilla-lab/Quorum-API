/*
 * Trend.
 *
 * The first test is the one that matters, because it is the bug this module
 * exists to prevent: a term whose raw count doubled while its share of the
 * conversation fell. That case was measured on a real corpus on 2026-08-22 and
 * the naive implementation reported it as RISING.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DateHistogram } from '@receipts/corpus';
import {
  MIN_WINDOW_RECORDS, monthsWindow, notableTrends, shareOfVoice, trendFor,
} from './trend.ts';

/* 15 August 2026, so the windows are Jun/Jul/Aug against Mar/Apr/May. */
const NOW = Date.UTC(2026, 7, 15);

const histogram = (counts: Record<string, number>, undated = 0): DateHistogram => ({
  buckets: Object.entries(counts).map(([period, records]) => ({ period, records })),
  undated,
});

const trend = (term: Record<string, number>, total: Record<string, number>, undated = 0) =>
  trendFor({
    term: 'price',
    termHistogram: histogram(term, undated),
    categoryHistogram: histogram(total),
    nowMs: NOW,
  });

/* ------------------------------------------------------------------ */
/* the defect this module exists to prevent                            */
/* ------------------------------------------------------------------ */

test('A TERM WHOSE COUNT ROSE AND WHOSE SHARE FELL IS NOT RISING', async () => {
  /*
   * The measured case, 2026-08-22: `price` went from 5 records to 15 and the
   * naive implementation called it RISING. The corpus went from 157 records to
   * 717 over the same period, so its share fell from 3.2% to 2.1%. What rose
   * was our harvesting.
   */
  const result = trend(
    { '2026-03': 2, '2026-04': 2, '2026-05': 1, '2026-06': 5, '2026-07': 5, '2026-08': 5 },
    { '2026-03': 50, '2026-04': 52, '2026-05': 55, '2026-06': 239, '2026-07': 239, '2026-08': 239 },
  );

  assert.equal(result.recent.records, 15, 'three times as many records');
  assert.equal(result.prior.records, 5);
  assert.ok(result.recent.sharePct < result.prior.sharePct, 'and a smaller share of the conversation');
  assert.notEqual(result.direction, 'rising', 'THE WHOLE POINT');
  assert.equal(result.direction, 'steady');
});

test('a term whose share genuinely grew is rising', async () => {
  /* The measured `sizing` case: 1.3% of 157 to 6.7% of 717. */
  const result = trend(
    { '2026-03': 1, '2026-04': 1, '2026-05': 0, '2026-06': 16, '2026-07': 16, '2026-08': 16 },
    { '2026-03': 50, '2026-04': 52, '2026-05': 55, '2026-06': 239, '2026-07': 239, '2026-08': 239 },
  );
  assert.equal(result.direction, 'rising');
  assert.ok(result.deltaPp > 4, `expected a real move, got ${result.deltaPp}`);
  assert.match(result.reason, /% of 717 records now, against/);
});

test('a term whose share collapsed is fading, even as the corpus grows', async () => {
  const result = trend(
    { '2026-03': 20, '2026-04': 20, '2026-05': 20, '2026-06': 5, '2026-07': 5, '2026-08': 5 },
    { '2026-03': 50, '2026-04': 52, '2026-05': 55, '2026-06': 239, '2026-07': 239, '2026-08': 239 },
  );
  assert.equal(result.direction, 'fading');
  assert.ok(result.deltaPp < 0);
});

/* ------------------------------------------------------------------ */
/* refusing to speak                                                   */
/* ------------------------------------------------------------------ */

test('A THIN WINDOW REPORTS UNKNOWN RATHER THAN A DIRECTION', async () => {
  /* Two records out of four is 50% and means nothing whatsoever. */
  const result = trend(
    { '2026-06': 2 },
    { '2026-03': 4, '2026-04': 0, '2026-05': 0, '2026-06': 4 },
  );
  assert.equal(result.direction, 'unknown');
  assert.match(result.reason, /too few to compare a share against/);
  assert.equal(result.deltaPp, 0, 'and no number is offered that could be quoted');
});

test('a thin window is named, so a reader knows which half is missing', async () => {
  const early = trend(
    { '2026-06': 10 },
    { '2026-03': 3, '2026-06': 200, '2026-07': 200 },
  );
  assert.match(early.reason, /earlier window/);

  const late = trend(
    { '2026-03': 10 },
    { '2026-03': 200, '2026-04': 200, '2026-06': 4 },
  );
  assert.match(late.reason, /recent window/);
});

test('the thin threshold is the one the module documents', async () => {
  const enough = Math.ceil(MIN_WINDOW_RECORDS / 3);
  const justEnough = trend(
    { '2026-03': 1, '2026-06': 1 },
    { '2026-03': enough, '2026-04': enough, '2026-05': enough, '2026-06': enough, '2026-07': enough, '2026-08': enough },
  );
  assert.notEqual(justEnough.direction, 'unknown');
});

test('A CHANGE INSIDE THE NOISE FLOOR IS STEADY, AND SAYS HOW CLOSE IT WAS', async () => {
  /* 10 of 300 against 9 of 300. A real difference in count, no information. */
  const result = trend(
    { '2026-03': 3, '2026-04': 3, '2026-05': 3, '2026-06': 4, '2026-07': 3, '2026-08': 3 },
    { '2026-03': 100, '2026-04': 100, '2026-05': 100, '2026-06': 100, '2026-07': 100, '2026-08': 100 },
  );
  assert.equal(result.direction, 'steady');
  assert.ok(result.noisePp > 0, 'the floor it had to clear is reported, not hidden');
  assert.ok(Math.abs(result.deltaPp) <= result.noisePp);
  assert.match(result.reason, /inside the .*pp this much evidence can tell apart from chance/);
});

test('the same delta clears the floor once there is enough evidence behind it', async () => {
  /* Identical shares, ten times the records. Confidence comes from n. */
  const shares = { '2026-03': 30, '2026-04': 30, '2026-05': 30, '2026-06': 45, '2026-07': 45, '2026-08': 45 };
  const totals = { '2026-03': 1000, '2026-04': 1000, '2026-05': 1000, '2026-06': 1000, '2026-07': 1000, '2026-08': 1000 };
  const big = trend(shares, totals);
  assert.equal(big.direction, 'rising');

  const small = trend(
    { '2026-03': 3, '2026-04': 3, '2026-05': 3, '2026-06': 4, '2026-07': 5, '2026-08': 5 },
    { '2026-03': 100, '2026-04': 100, '2026-05': 100, '2026-06': 100, '2026-07': 100, '2026-08': 100 },
  );
  assert.equal(small.direction, 'steady', 'the same 1.4pp move, a tenth of the evidence');
});

/* ------------------------------------------------------------------ */
/* absence                                                             */
/* ------------------------------------------------------------------ */

test('NOBODY RAISING IT WHERE THERE WAS ROOM TO IS A FINDING, NOT A DELTA', async () => {
  const result = trend(
    { '2026-06': 4, '2026-07': 4 },
    { '2026-03': 60, '2026-04': 60, '2026-05': 60, '2026-06': 100, '2026-07': 100, '2026-08': 100 },
  );
  assert.equal(result.direction, 'new');
  assert.match(result.reason, /nobody raised this in 180 records from 2026-03 to 2026-05, and 8 have since/);
});

test('one mention after nothing is not new, because one mention is not a pattern', async () => {
  const result = trend(
    { '2026-06': 1 },
    { '2026-03': 60, '2026-04': 60, '2026-05': 60, '2026-06': 100, '2026-07': 100, '2026-08': 100 },
  );
  assert.notEqual(result.direction, 'new');
});

test('silence in a period we barely saw is unknown, not new', async () => {
  /* Absence only means something when there was room to be present. */
  const result = trend(
    { '2026-06': 20 },
    { '2026-03': 5, '2026-06': 300, '2026-07': 300 },
  );
  assert.equal(result.direction, 'unknown');
});

/* ------------------------------------------------------------------ */
/* dates                                                               */
/* ------------------------------------------------------------------ */

test('a partial current month does not read as a collapse', async () => {
  /*
   * The report runs on the 15th, so August holds half a month of records. A
   * count would show a cliff; a share does not, because the numerator and the
   * denominator are cut by the same amount.
   */
  const result = trend(
    { '2026-03': 10, '2026-04': 10, '2026-05': 10, '2026-06': 10, '2026-07': 10, '2026-08': 5 },
    { '2026-03': 100, '2026-04': 100, '2026-05': 100, '2026-06': 100, '2026-07': 100, '2026-08': 50 },
  );
  assert.equal(result.direction, 'steady');
  assert.equal(result.recent.sharePct.toFixed(1), result.prior.sharePct.toFixed(1));
});

test('undated records are carried through so a trend built on few can be doubted', async () => {
  const result = trend(
    { '2026-06': 10, '2026-07': 10, '2026-08': 10 },
    { '2026-03': 100, '2026-04': 100, '2026-05': 100, '2026-06': 100, '2026-07': 100, '2026-08': 100 },
    412,
  );
  assert.equal(result.undated, 412);
});

test('the window walks calendar months, so December to January needs no special case', () => {
  assert.deepEqual(monthsWindow(Date.UTC(2026, 0, 15), 3), ['2025-11', '2025-12', '2026-01']);
  assert.deepEqual(monthsWindow(Date.UTC(2026, 0, 15), 3, 3), ['2025-08', '2025-09', '2025-10']);
  /* The 31st of a month, where naive month arithmetic overflows into the month
   * after next because February has no 31st. */
  assert.deepEqual(monthsWindow(Date.UTC(2026, 2, 31), 1), ['2026-03']);
  assert.deepEqual(monthsWindow(Date.UTC(2026, 2, 31), 1, 1), ['2026-02']);
});

test('the windows are reported so a reader can check the arithmetic', () => {
  const result = trend(
    { '2026-06': 10 },
    { '2026-03': 100, '2026-04': 100, '2026-05': 100, '2026-06': 100, '2026-07': 100, '2026-08': 100 },
  );
  assert.equal(result.recent.from, '2026-06');
  assert.equal(result.recent.to, '2026-08');
  assert.equal(result.prior.from, '2026-03');
  assert.equal(result.prior.to, '2026-05');
  assert.equal(result.recent.total, 300);
});

test('an empty corpus is unknown rather than a division by zero', () => {
  const result = trend({}, {});
  assert.equal(result.direction, 'unknown');
  assert.equal(result.recent.sharePct, 0);
  assert.ok(Number.isFinite(result.deltaPp));
});

/* ------------------------------------------------------------------ */
/* share of voice, and what gets printed                               */
/* ------------------------------------------------------------------ */

test('share of voice gives a count the denominator it was missing', () => {
  const ranked = shareOfVoice([
    { term: 'comfort', records: 6 },
    { term: 'sizing', records: 15 },
    { term: 'price', records: 0 },
  ], 200);

  assert.deepEqual(ranked.map((s) => s.term), ['sizing', 'comfort', 'price'], 'loudest first');
  assert.equal(ranked[0]?.rank, 1);
  assert.equal(ranked[0]?.sharePct, 7.5);
  assert.equal(ranked[2]?.sharePct, 0, 'and zero is a share, not a gap');
});

test('share of voice against an empty category is zero rather than infinity', () => {
  const ranked = shareOfVoice([{ term: 'sizing', records: 0 }], 0);
  assert.equal(ranked[0]?.sharePct, 0);
});

test('only a change is news, and the rest stays on the json', () => {
  const trends = [
    trend({ '2026-06': 40, '2026-07': 40, '2026-08': 40 }, { '2026-03': 300, '2026-04': 300, '2026-05': 300, '2026-06': 300, '2026-07': 300, '2026-08': 300 }),
    trend({ '2026-03': 30, '2026-04': 30, '2026-05': 30, '2026-06': 31, '2026-07': 30, '2026-08': 30 }, { '2026-03': 300, '2026-04': 300, '2026-05': 300, '2026-06': 300, '2026-07': 300, '2026-08': 300 }),
    trend({ '2026-06': 2 }, { '2026-03': 4, '2026-06': 4 }),
  ];
  assert.deepEqual(trends.map((t) => t.direction), ['new', 'steady', 'unknown']);
  assert.equal(notableTrends(trends).length, 1, 'steady and unknown are true and are not news');
});
