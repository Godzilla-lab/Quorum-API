import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCostMeter, type CostEntry } from './cost.ts';
import { LONG_CONTEXT_TOKENS, RATES, isCallRate } from './rates.ts';

const meter = (over: Partial<Parameters<typeof createCostMeter>[0]> = {}) =>
  createCostMeter({ label: 'test', now: () => 1_700_000_000_000, ...over });

/*
 * EXPECTATIONS ARE DERIVED FROM THE RATE TABLE, NEVER HARDCODED.
 *
 * They used to be hardcoded, and on 2026-08-22 the Apify rate was re-measured
 * from $0.0058 to $0.00076 per ad, which broke eight tests in this file at
 * once. None of them had found a bug: a test that bakes in a price is testing
 * the rate table, and the rate table is a record of measurements that are
 * SUPPOSED to move when a vendor reprices.
 *
 * What these tests are actually for is the meter's arithmetic, so they compute
 * the same way it does: round each entry to integer micro dollars, then sum.
 */
const AD_KEY = 'apify.fb-ads-item';
const AD_RATE = (() => {
  const rate = RATES[AD_KEY];
  if (!rate || !isCallRate(rate)) throw new Error(`${AD_KEY} is not a per call rate`);
  return rate.perCall;
})();
const MICROS = 1_000_000;
/*
 * Expectations are accumulated in micros here for the same reason the meter
 * does it: computing `adsUsd(10) * 2` in the test drifts to
 * 0.015200000000000002 while the meter returns 0.0152. The first version of
 * this helper made exactly that mistake, and the failure was the meter being
 * right rather than wrong.
 */
const adMicros = (n: number): number => Math.round(AD_RATE * n * MICROS);
const fromMicros = (m: number): number => m / MICROS;
/* One charge of n units: the meter multiplies first, then rounds once. */
const adsUsd = (n: number): number => fromMicros(adMicros(n));

test('the ad rate is a verified measurement and carries the date it was taken', () => {
  const rate = RATES[AD_KEY]!;
  assert.equal(rate.verified, true, 'an unverified rate must never be used to price a report');
  assert.match(rate.asOf, /^\d{4}-\d{2}-\d{2}$/);
});

test('a flat vendor charge matches the rate table', () => {
  const m = meter();
  const usd = m.charge(AD_KEY, 30);
  assert.equal(usd, AD_RATE * 30);
  assert.equal(m.total(), adsUsd(30));
});

test('an unknown vendor key charges zero and is flagged rather than throwing', () => {
  const m = meter();
  assert.equal(m.charge('vendor.we.have.not.priced'), 0);
  assert.equal(m.hasUnverified(), true, 'it must show as a question mark in the report, not a crash');
  assert.match(m.report(), /rate not confirmed/);
});

test('a known but unverified rate is flagged', () => {
  const m = meter();
  m.usage('gpt-5.6-sol', { input_tokens: 1000, output_tokens: 100 }, 'reseller');
  assert.equal(m.hasUnverified(), true);
});

test('cached and cache write tokens are billed, not ignored', () => {
  const m = meter();
  /* claude-sonnet-5 is $3.00 per 1M in. 1M total input across three buckets. */
  m.usage('claude-sonnet-5', {
    input_tokens: 400_000,
    cache_read_input_tokens: 400_000,
    cache_creation_input_tokens: 200_000,
    output_tokens: 0,
  }, 'anthropic');
  assert.equal(Number(m.total().toFixed(4)), 3.0, 'counting only input_tokens would under report a cached run');
});

/*
 * The long context cliff. Crossing the threshold bills the WHOLE request at the
 * higher rate, so a prompt one token over costs double one token under, not a
 * fraction more.
 */
test('long context applies to the whole request, not to the excess', () => {
  const under = meter();
  under.usage('grok-4.6', { input_tokens: LONG_CONTEXT_TOKENS - 1, output_tokens: 0 }, 'xai');

  const over = meter();
  over.usage('grok-4.6', { input_tokens: LONG_CONTEXT_TOKENS, output_tokens: 0 }, 'xai');

  assert.ok(over.total() > under.total() * 1.99, 'crossing the line roughly doubles the bill');
  assert.equal(over.breakdown()[0]?.usd && over.toJSON().totalUsd > 0, true);
});

test('output tokens are billed at the long rate too once the prompt crosses', () => {
  const m = meter();
  /* grok-4.6 long: in 4.00, out 12.00 per 1M. */
  m.usage('grok-4.6', { input_tokens: LONG_CONTEXT_TOKENS, output_tokens: 100_000 }, 'xai');
  const expected = (LONG_CONTEXT_TOKENS / 1e6) * 4.0 + (100_000 / 1e6) * 12.0;
  assert.equal(Number(m.total().toFixed(6)), Number(expected.toFixed(6)));
});

/*
 * The regression that made every report price at $0.00: a row naming only the
 * model cannot answer who actually billed us.
 */
test('the provider is recorded alongside the model', () => {
  const seen: CostEntry[] = [];
  const m = meter({ sink: (e) => seen.push(e) });
  m.usage('claude-opus-5', { input_tokens: 1000, output_tokens: 100 }, 'anthropic');
  assert.equal(seen[0]?.provider, 'anthropic');
});

test('the sink receives every entry as it is recorded', () => {
  const seen: CostEntry[] = [];
  const m = meter({ sink: (e) => seen.push(e) });
  m.charge(AD_KEY, 5);
  m.usage('claude-haiku-4-5', { input_tokens: 100, output_tokens: 10 }, 'anthropic');
  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.kind, 'call');
  assert.equal(seen[1]?.kind, 'llm');
});

test('a sink that throws does not take down a working run', () => {
  const m = meter({ sink: () => { throw new Error('metering backend is down'); } });
  assert.doesNotThrow(() => m.charge(AD_KEY, 1));
  assert.ok(m.total() > 0, 'the spend is still recorded locally');
});

/* The spend cap. A route guard cannot stop a job already inside a retry loop. */
test('canSpend refuses once the estimate would cross the cap', () => {
  const m = meter({ capUsd: 1.0 });
  assert.equal(m.canSpend(0.5), true);

  m.charge(AD_KEY, 100);
  const left = fromMicros(MICROS - adMicros(100));
  assert.equal(m.remaining(), left);

  assert.equal(m.canSpend(left), true, 'spending exactly the remaining budget is allowed');
  assert.equal(m.canSpend(left + 0.01), false, 'the guard is asked BEFORE the call, not after');
  assert.equal(m.overCap(), false, 'refusing to spend is not the same as having overspent');
});

test('an uncapped meter always allows spend and reports infinite headroom', () => {
  const m = meter();
  assert.equal(m.canSpend(1_000_000), true);
  assert.equal(m.remaining(), Infinity);
  assert.equal(m.overCap(), false);
});

test('overCap becomes true once recorded spend reaches the cap', () => {
  const m = meter({ capUsd: adsUsd(10) });
  m.charge(AD_KEY, 10);                         // exactly the cap
  assert.equal(m.overCap(), true);
  assert.equal(m.remaining(), 0);
  assert.match(m.report(), /spend cap/);
});

test('breakdown groups by key and orders by spend', () => {
  const m = meter();
  m.charge(AD_KEY, 10);
  m.charge(AD_KEY, 10);                         // same key again
  m.usage('claude-opus-5', { input_tokens: 1_000_000, output_tokens: 0 }, 'anthropic'); // $5.00

  const lines = m.breakdown();
  assert.equal(lines.length, 2, 'two keys, three calls');
  assert.equal(lines[0]?.key, 'claude-opus-5', 'biggest line first');
  assert.equal(lines[1]?.calls, 20, 'the two apify charges are summed');
  assert.equal(lines[1]?.usd, fromMicros(adMicros(10) * 2));
});

test('a meter that spent nothing reports zero without claiming it is verified', () => {
  const m = meter();
  assert.equal(m.total(), 0);
  assert.equal(m.hasUnverified(), false);
  assert.deepEqual(m.breakdown(), []);
  assert.equal(m.toJSON().totalUsd, 0);
});

/*
 * Regression, 2026-08-22. Money was accumulated in floating point, so a cap set
 * to the exact value of ten charges never tripped.
 *
 * The rate has since been re-measured and the drift survives the change, which
 * is the point: at the old $0.0058 the product came to 0.057999999999999996,
 * and at today's $0.00076 it comes to 0.007600000000000001. Neither equals its
 * decimal. Both assertions below failed before the meter moved to integer micro
 * dollars.
 */
test('a cap trips exactly, without floating point drift', () => {
  assert.notEqual(AD_RATE * 10, adsUsd(10), 'float multiplication really does drift here');

  const m = meter({ capUsd: adsUsd(10) });
  m.charge(AD_KEY, 10);
  assert.equal(m.total(), adsUsd(10), 'the total must be the decimal, not the float near it');
  assert.equal(m.overCap(), true, 'the cap must trip on the exact boundary');
});

test('drift does not accumulate across many small charges', () => {
  const m = meter();
  let floatSum = 0;
  for (let i = 0; i < 1000; i++) { m.charge(AD_KEY, 1); floatSum += AD_RATE; }
  const exact = fromMicros(adMicros(1) * 1000);
  assert.equal(m.total(), exact);
  assert.notEqual(floatSum, exact, 'summing 1000 floats lands near but not on it');
});

test('remaining budget is exact rather than nearly right', () => {
  const m = meter({ capUsd: 5 });
  m.charge(AD_KEY, 100);
  assert.equal(m.remaining(), 5 - adsUsd(100), 'the free cap arithmetic in the docs depends on this');
});

/*
 * Regression, 2026-08-22, found while re-deriving these tests after a vendor
 * repricing. `breakdown()` summed line totals in floating point while `total()`
 * summed in micro dollars, so a report could print line items that did not add
 * up to its own total.
 */
test('the breakdown lines add up to the total, exactly', () => {
  const m = meter();
  m.charge(AD_KEY, 10);
  m.charge(AD_KEY, 10);
  m.charge('brightdata.unlocker', 3);
  m.usage('claude-opus-5', { input_tokens: 12_345, output_tokens: 678 }, 'anthropic');

  const lines = m.breakdown();
  const summed = lines.reduce((n, l) => n + Math.round(l.usd * 1_000_000), 0) / 1_000_000;
  assert.equal(summed, m.total(), 'the lines and the total are the same money');
  assert.equal(lines.find((l) => l.key === AD_KEY)?.usd, fromMicros(adMicros(10) * 2));
});
