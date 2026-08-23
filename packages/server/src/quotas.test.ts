/*
 * Quotas.
 *
 * The two tests that matter are the ones a naive limiter gets wrong: a refused
 * request must not extend its own window, and the two meters must not share a
 * budget. Both are cheap to get right here and expensive to discover in
 * production, where the symptom of the first is a client that can never get
 * back in and the symptom of the second is evidence lookups starving because
 * somebody queued reports.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LIMITS, createQuotas, meterFor, type QuotaLimits } from './quotas.ts';

const LIMITS: QuotaLimits = { reportsPerWindow: 2, lookupsPerWindow: 5, concurrentReports: 3, windowMs: 60_000 };
const at = (ms: number): number => 1_700_000_000_000 + ms;

/* ------------------------------------------------------------------ */
/* the limit                                                           */
/* ------------------------------------------------------------------ */

test('a key is allowed up to its limit and refused after it', () => {
  const q = createQuotas(LIMITS);
  assert.equal(q.check('k', 'reports', at(0)).allowed, true);
  assert.equal(q.check('k', 'reports', at(1)).allowed, true);

  const third = q.check('k', 'reports', at(2));
  assert.equal(third.allowed, false);
  assert.equal(third.state.used, 2);
  assert.equal(third.state.remaining, 0);
  assert.ok(third.retryAfterSeconds > 0 && third.retryAfterSeconds <= 60);
});

test('A REFUSED REQUEST IS NOT COUNTED, OR A RETRY LOOP BECOMES A BAN', () => {
  /*
   * Counting refusals would push `used` further past the limit on every retry
   * and, with a sliding window, extend the wait indefinitely. A client in a
   * tight retry loop would never be let back in.
   */
  const q = createQuotas(LIMITS);
  q.check('k', 'reports', at(0));
  q.check('k', 'reports', at(1));
  for (let i = 0; i < 50; i++) q.check('k', 'reports', at(2 + i));

  const after = q.snapshot('k', 0, at(100));
  assert.equal(after.reports.used, 2, 'fifty refusals added nothing');

  /* And the window still rolls on schedule rather than being pushed out. */
  assert.equal(q.check('k', 'reports', at(60_001)).allowed, true);
});

test('THE TWO METERS DO NOT SHARE A BUDGET', () => {
  /*
   * A report is minutes of upstream work and a lookup is one indexed read.
   * One shared limit either starves lookups or leaves reports unprotected,
   * which is why the spec specified two before this was built.
   */
  const q = createQuotas(LIMITS);
  q.check('k', 'reports', at(0));
  q.check('k', 'reports', at(1));
  assert.equal(q.check('k', 'reports', at(2)).allowed, false, 'reports are exhausted');
  assert.equal(q.check('k', 'lookups', at(3)).allowed, true, 'and lookups are untouched');
});

test('keys are counted separately, so one caller cannot exhaust another', () => {
  const q = createQuotas(LIMITS);
  q.check('a', 'reports', at(0));
  q.check('a', 'reports', at(1));
  assert.equal(q.check('a', 'reports', at(2)).allowed, false);
  assert.equal(q.check('b', 'reports', at(3)).allowed, true);
});

test('the window rolls, and rolls clean', () => {
  const q = createQuotas(LIMITS);
  q.check('k', 'reports', at(0));
  q.check('k', 'reports', at(1));
  assert.equal(q.check('k', 'reports', at(59_999)).allowed, false);
  assert.equal(q.check('k', 'reports', at(60_000)).allowed, true);
  assert.equal(q.snapshot('k', 0, at(60_001)).reports.used, 1, 'the new window starts from this request');
});

test('HEALTHZ IS EXEMPT, BECAUSE A BUSY INSTANCE MUST STILL SAY IT IS ALIVE', () => {
  /* Rate limiting the health check means a load balancer removes an instance
   * for being busy, which is precisely backwards. */
  const q = createQuotas({ ...LIMITS, lookupsPerWindow: 1 });
  for (let i = 0; i < 100; i++) {
    assert.equal(q.check('k', 'exempt', at(i)).allowed, true);
  }
  assert.equal(q.check('k', 'lookups', at(200)).allowed, true, 'and exempt calls consumed no budget');
});

/* ------------------------------------------------------------------ */
/* what a route counts against                                         */
/* ------------------------------------------------------------------ */

test('only starting a report counts as a report', () => {
  assert.equal(meterFor('POST', '/v1/reports'), 'reports');
  /* Polling one is a read. Charging the expensive meter for it would punish a
   * caller for following the Retry-After we sent them. */
  assert.equal(meterFor('GET', '/v1/reports/rep_1'), 'lookups');
  assert.equal(meterFor('GET', '/v1/evidence/rc_1'), 'lookups');
  assert.equal(meterFor('POST', '/v1/evidence/search'), 'lookups');
  assert.equal(meterFor('GET', '/v1/healthz'), 'exempt');
});

test('AN UNKNOWN ROUTE STILL LANDS IN A METER', () => {
  /* Defaulting to unmetered would mean a route added later is unlimited until
   * somebody remembers this file. */
  assert.equal(meterFor('GET', '/v1/something/new'), 'lookups');
  assert.equal(meterFor('POST', '/v1/whatever'), 'lookups');
});

/* ------------------------------------------------------------------ */
/* usage                                                               */
/* ------------------------------------------------------------------ */

test('usage reports both quotas, concurrency and spend', () => {
  const q = createQuotas(LIMITS);
  q.check('k', 'reports', at(0));
  q.check('k', 'lookups', at(1));
  q.check('k', 'lookups', at(2));
  q.charge('k', 0.0125, at(3));

  const usage = q.snapshot('k', 2, at(4));
  assert.equal(usage.keyPrefix, 'k');
  assert.deepEqual(usage.reports, { used: 1, limit: 2, remaining: 1 });
  assert.deepEqual(usage.lookups, { used: 2, limit: 5, remaining: 3 });
  assert.deepEqual(usage.concurrentReports, { running: 2, limit: 3 });
  assert.equal(usage.spendUsd, 0.0125);
  assert.ok(usage.periodEnd > usage.periodStart);
});

test('THE SNAPSHOT CARRIES A LABEL AND COULD NOT CARRY A KEY', () => {
  /* The server only ever holds a hash and a label, so there is nothing here to
   * leak even by accident. Asserted so a future change cannot quietly pass the
   * presented key through. */
  const q = createQuotas(LIMITS);
  const usage = q.snapshot('key-1', 0, at(0));
  assert.equal(usage.keyPrefix, 'key-1');
  assert.doesNotMatch(JSON.stringify(usage), /[0-9a-f]{32}/, 'something key shaped is in the usage body');
});

test('a nonsense charge is ignored rather than corrupting the total', () => {
  const q = createQuotas(LIMITS);
  q.charge('k', Number.NaN, at(0));
  q.charge('k', -5, at(1));
  q.charge('k', Infinity, at(2));
  assert.equal(q.snapshot('k', 0, at(3)).spendUsd, 0);
});

test('asking for usage does not itself consume quota', () => {
  const q = createQuotas(LIMITS);
  q.snapshot('k', 0, at(0));
  q.snapshot('k', 0, at(1));
  assert.equal(q.snapshot('k', 0, at(2)).lookups.used, 0);
});

/* ------------------------------------------------------------------ */
/* the shipped numbers                                                 */
/* ------------------------------------------------------------------ */

test('the defaults are the ones the measurements justify', () => {
  /*
   * 600 lookups a minute is 10 a second, roughly a tenth of what the smallest
   * instance serves, so one key cannot take the machine. 20 reports an hour
   * is generous for a human and stops a loop, and is anyway above what two
   * concurrent runs can actually complete.
   */
  assert.equal(DEFAULT_LIMITS.lookupsPerWindow, 600);
  assert.equal(DEFAULT_LIMITS.reportsPerWindow, 20);
  assert.equal(DEFAULT_LIMITS.windowMs, 60_000);
  assert.ok(DEFAULT_LIMITS.lookupsPerWindow > DEFAULT_LIMITS.reportsPerWindow * 10,
    'a lookup is orders of magnitude cheaper than a report and the limits should say so');
});
