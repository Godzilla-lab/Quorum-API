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

const LIMITS: QuotaLimits = {
  reportsPerWindow: 2, lookupsPerWindow: 5, concurrentReports: 3, windowMs: 60_000,
  reportWindowMs: 3_600_000,
  /* A dollar each, so the per key and instance ceilings can be crossed
   * separately and the tests can tell which one refused. */
  spendPerKeyUsd: 1, spendTotalUsd: 2.5, spendWindowMs: 3_600_000,
};
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
  /* A refused report quotes the report window, which is an hour. */
  assert.ok(third.retryAfterSeconds > 0 && third.retryAfterSeconds <= 3600);
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

  /* And the window still rolls on schedule rather than being pushed out.
   * Reports roll HOURLY: a minute later is still inside the same window. */
  assert.equal(q.check('k', 'reports', at(60_001)).allowed, false);
  assert.equal(q.check('k', 'reports', at(3_600_001)).allowed, true);
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
  assert.equal(q.check('k', 'reports', at(3_599_999)).allowed, false);
  assert.equal(q.check('k', 'reports', at(3_600_000)).allowed, true);
  assert.equal(q.snapshot('k', 0, at(3_600_001)).reports.used, 1, 'the new window starts from this request');
});

/*
 * THE DEFECT THIS SEPARATION ENDED, found 2026-08-25: reports rolled inside
 * the same sixty second window as lookups, so the documented twenty an hour
 * was actually twenty a minute, or 1,200 an hour. A loop stopper that
 * permits 1,200 loops an hour stops nothing.
 */
test('REPORTS ROLL HOURLY WHILE LOOKUPS ROLL PER MINUTE, INDEPENDENTLY', () => {
  const q = createQuotas(LIMITS);
  q.check('k', 'reports', at(0));
  q.check('k', 'reports', at(1));
  for (let i = 0; i < 5; i++) q.check('k', 'lookups', at(2 + i));

  /* A minute later the lookups window has rolled and the reports have not. */
  assert.equal(q.check('k', 'lookups', at(61_000)).allowed, true, 'lookups rolled');
  assert.equal(q.check('k', 'reports', at(61_000)).allowed, false, 'reports did not');

  const snap = q.snapshot('k', 0, at(61_000));
  assert.ok(snap.reportsPeriodEnd - snap.reportsPeriodStart === 3600, 'the reports window states its own hour');
  assert.ok(snap.periodEnd - snap.periodStart === 60, 'beside the request minute');
});

test('SEEDED REPORTS SURVIVE THE RESTART THE FREE TIER GUARANTEES', () => {
  /* Every recycle used to hand every key a fresh twenty. The boot replay
   * seeds the counter from persisted snapshots, over enforcing (the seeded
   * window starts now) rather than refilling after a crash. */
  const q = createQuotas(LIMITS);
  q.seedReports([{ keyLabel: 'k', count: 2 }], at(0));
  assert.equal(q.check('k', 'reports', at(1)).allowed, false, 'the pre-restart reports still count');
  assert.equal(q.check('k', 'lookups', at(2)).allowed, true, 'lookups are untouched by the seed');
  assert.equal(q.snapshot('k', 0, at(3)).reports.used, 2);

  /* Garbage in the ledger seeds nothing rather than corrupting a counter. */
  const clean = createQuotas(LIMITS);
  clean.seedReports([
    { keyLabel: 'k', count: 0 },
    { keyLabel: 'k', count: -3 },
    { keyLabel: 'k', count: 1.5 },
  ], at(0));
  assert.equal(clean.check('k', 'reports', at(1)).allowed, true);
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

/* ------------------------------------------------------------------ */
/* spend, the only limit here that bounds a bill                       */
/* ------------------------------------------------------------------ */

test('A RATE LIMIT DOES NOT BOUND SPEND, WHICH IS WHY THIS EXISTS', () => {
  /*
   * The whole point, stated as a test. Under the request limits alone this key
   * is free to keep going; it is the budget that stops it.
   */
  const q = createQuotas(LIMITS);
  q.charge('k', 1, at(0));
  assert.equal(q.check('k', 'lookups', at(1)).allowed, true, 'requests are still fine');
  assert.equal(q.canSpend('k', at(2)).allowed, false, 'and money is not');
});

test('a key may spend up to its allowance and no further', () => {
  const q = createQuotas(LIMITS);
  assert.equal(q.canSpend('k', at(0)).allowed, true);
  q.charge('k', 0.75, at(1));

  const partial = q.canSpend('k', at(2));
  assert.equal(partial.allowed, true);
  assert.equal(partial.keyRemainingUsd, 0.25);

  q.charge('k', 0.25, at(3));
  const spent = q.canSpend('k', at(4));
  assert.equal(spent.allowed, false);
  assert.equal(spent.refusedBy, 'per-key');
});

test('THE INSTANCE BUDGET IS THE ONE THAT MATTERS WHEN ADS ARE OPEN TO EVERYONE', () => {
  /*
   * Three keys with a dollar each is three dollars, and the vendor balance does
   * not care how many keys there are. Without the instance ceiling the real
   * limit is per key times key count, which is not a limit.
   */
  const q = createQuotas(LIMITS);
  q.charge('a', 1, at(0));
  q.charge('b', 1, at(1));
  q.charge('c', 0.5, at(2));

  const fourth = q.canSpend('d', at(3));
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.refusedBy, 'instance', 'this key has spent nothing and is still refused');
  assert.equal(fourth.keyRemainingUsd, 1, 'and it is told its own allowance is untouched');
});

test('the two refusals are named apart, because only one is the caller to solve', () => {
  const q = createQuotas(LIMITS);
  q.charge('a', 1, at(0));
  assert.equal(q.canSpend('a', at(1)).refusedBy, 'per-key');
  q.charge('b', 1.5, at(2));
  assert.equal(q.canSpend('c', at(3)).refusedBy, 'instance');
});

test('A BUDGET OF ZERO DISABLES METERED WORK, WHICH IS THE DEFAULT', () => {
  /* An operator who has not thought about a budget has one of zero, so
   * forgetting produces a report without ads rather than a bill. */
  const q = createQuotas({ ...LIMITS, spendPerKeyUsd: 0, spendTotalUsd: 0 });
  const decision = q.canSpend('k', at(0));
  assert.equal(decision.allowed, false);
  assert.equal(decision.refusedBy, 'disabled');
  assert.equal(DEFAULT_LIMITS.spendPerKeyUsd, 0);
  assert.equal(DEFAULT_LIMITS.spendTotalUsd, 0);
});

test('one budget of zero is enough to disable it, not both', () => {
  assert.equal(createQuotas({ ...LIMITS, spendTotalUsd: 0 }).canSpend('k', at(0)).refusedBy, 'disabled');
  assert.equal(createQuotas({ ...LIMITS, spendPerKeyUsd: 0 }).canSpend('k', at(0)).refusedBy, 'disabled');
});

test('THE SPEND WINDOW ROLLS ON ITS OWN SCHEDULE, NOT THE REQUEST WINDOW', () => {
  /* A budget is daily and a rate is per minute. Sharing one window would reset
   * the budget sixty times an hour, which is no budget at all. */
  const q = createQuotas(LIMITS);
  q.charge('k', 1, at(0));
  assert.equal(q.canSpend('k', at(60_001)).allowed, false, 'a minute later the money is still spent');
  assert.equal(q.canSpend('k', at(3_600_001)).allowed, true, 'an hour later it is not');
});

test('spend is reported in usage, lifetime rather than windowed', () => {
  const q = createQuotas(LIMITS);
  q.charge('k', 0.4, at(0));
  q.charge('k', 0.3, at(3_600_001));
  /* The window rolled between them, so the budget sees 0.3 and the bill sees
   * both. A caller asking what it cost wants the total. */
  assert.equal(q.snapshot('k', 0, at(3_600_002)).spendUsd, 0.7);
  assert.equal(q.canSpend('k', at(3_600_003)).keyRemainingUsd, 0.7);
});

/* ------------------------------------------------------------------ */
/* the ledger hooks                                                    */
/* ------------------------------------------------------------------ */

test('every charge reaches the persistence hook, and refused amounts never do', () => {
  const written: { keyLabel: string; usd: number }[] = [];
  const q = createQuotas(LIMITS, { onCharge: (keyLabel, usd) => written.push({ keyLabel, usd }) });
  q.charge('k', 0.25, at(0));
  q.charge('k', 0, at(1));
  q.charge('k', -3, at(2));
  q.charge('k', Number.NaN, at(3));
  assert.deepEqual(written, [{ keyLabel: 'k', usd: 0.25 }],
    'only the real charge is a fact worth appending');
});

/*
 * The restart fix. The ledger remembers, seedSpend replays, and a rebooted
 * instance refuses metered work exactly where the crashed one would have.
 */
test('seeded spend counts against both budgets as if it had been charged here', () => {
  const q = createQuotas(LIMITS);
  q.seedSpend([{ keyLabel: 'a', totalUsd: 0.8 }, { keyLabel: 'b', totalUsd: 0.9 }], at(0));

  assert.ok(Math.abs(q.canSpend('a', at(1)).keyRemainingUsd - 0.2) < 1e-9, 'the key allowance remembers');
  const instance = q.canSpend('a', at(2)).instanceRemainingUsd;
  assert.ok(Math.abs(instance - 0.8) < 1e-9, 'the instance budget remembers every key: 2.5 - 0.8 - 0.9');
});

test('seeding nothing changes nothing', () => {
  const q = createQuotas(LIMITS);
  q.seedSpend([], at(0));
  q.seedSpend([{ keyLabel: 'k', totalUsd: 0 }, { keyLabel: 'k', totalUsd: -1 }], at(0));
  assert.equal(q.canSpend('k', at(1)).keyRemainingUsd, 1, 'the full allowance stands');
});
