/*
 * Amazon reviews, against a captured response: 8 real reviews of a real
 * product, taken unedited through the pinned actor on 2026-08-26, the same
 * run whose billing delta verified the rates in core/rates.ts.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createAmazonReviewsSource, extractAsin, reviewDate, reviewRating } from './index.ts';
import { runSourceConformance } from '../conformance.ts';
import type { Ctx, SourceRecord } from '../source.ts';

const dir = fileURLToPath(new URL('.', import.meta.url));
const REVIEWS = readFileSync(join(dir, 'fixtures/reviews.json'), 'utf8');

const ctx = (over: Partial<Ctx> = {}): Ctx => ({
  env: { APIFY_TOKEN: 'test-token' },
  cost: { charge: () => 0, canSpend: () => true },
  ...over,
});

/* A fetch that returns the fixture and records what it was asked. */
function routed(body = REVIEWS, status = 200) {
  const calls: { url: string; body: string }[] = [];
  const fetch = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ?? '' });
    return status === 200
      ? { ok: true as const, status, body, headers: {} }
      : { ok: false as const, status, body, error: `status ${status}`, headers: {} };
  }) as never;
  return { fetch, calls };
}

const PLAN = {
  category: 'wireless earbuds',
  productTitle: 'Apple AirPods',
  productUrl: 'https://www.amazon.com/dp/B07PXGQC1Q',
  terms: ['battery'],
};

runSourceConformance('amazon', () => ({
  source: createAmazonReviewsSource({ fetch: routed().fetch }),
  configuredEnv: { APIFY_TOKEN: 'x' },
  planInput: PLAN,
}));

async function run(source = createAmazonReviewsSource({ fetch: routed().fetch })): Promise<SourceRecord[]> {
  const queries = await source.plan(PLAN);
  const out: SourceRecord[] = [];
  for (const q of queries) for await (const r of source.retrieve(q, ctx())) out.push(r);
  return out;
}

test('the ASIN comes out of the url shapes Amazon actually uses', () => {
  assert.equal(extractAsin('https://www.amazon.com/dp/B07PXGQC1Q'), 'B07PXGQC1Q');
  assert.equal(extractAsin('https://www.amazon.co.uk/gp/product/b07pxgqc1q?th=1'), 'B07PXGQC1Q');
  assert.equal(extractAsin('https://www.amazon.com/product-reviews/B07PXGQC1Q/'), 'B07PXGQC1Q');
  assert.equal(extractAsin('B07PXGQC1Q'), 'B07PXGQC1Q');
  assert.equal(extractAsin('https://cocojewelry.com/products/pendant'), null,
    'a non Amazon subject plans nothing rather than guessing');
  assert.equal(extractAsin(''), null);
});

test('a subject that is not an Amazon product plans zero queries', async () => {
  const source = createAmazonReviewsSource({ fetch: routed().fetch });
  const queries = await source.plan({ ...PLAN, productUrl: 'https://cocojewelry.com/products/x' });
  assert.deepEqual(queries, [], 'no discovery by scraping: absence, not a guess');
});

test('records carry stars, real text, a per review date and a resolvable url', async () => {
  const records = await run();
  assert.ok(records.length >= 5, `only ${records.length} records from an 8 review fixture`);
  for (const r of records) {
    assert.equal(r.source, 'amazon');
    assert.equal(r.kind, 'comment');
    assert.ok((r.score ?? 0) >= 1 && (r.score ?? 0) <= 5, `star rating out of range: ${r.score}`);
    assert.ok((r.text ?? '').length >= 40);
    assert.match(r.url ?? '', /^https:\/\/www\.amazon\./);
    assert.ok((r.createdUtc ?? 0) >= 1_500_000_000, `review date missing or implausible: ${r.createdUtc}`);
    assert.match(r.channel ?? '', /\(us\)$/, 'one channel per product per marketplace');
  }
  const distinct = new Set(records.map((r) => r.createdUtc));
  assert.ok(distinct.size > 1, 'dates are per review, not one timestamp copied around');
});

test('the prose date parses and garbage stays honestly undated', () => {
  assert.equal(reviewDate({ date: 'Reviewed in the United States on August 7, 2024' }) > 0, true);
  assert.equal(reviewDate({ date: 'Reviewed somewhere, sometime' }), 0);
  assert.equal(reviewDate({}), 0);
  assert.equal(reviewRating({ rating: 5 }), 5);
  assert.equal(reviewRating({ rating: 0 }), 0);
  assert.equal(reviewRating({}), 0);
});

test('every review charges the meter, and the run start charges once', async () => {
  const charges: string[] = [];
  const source = createAmazonReviewsSource({ fetch: routed().fetch });
  const queries = await source.plan(PLAN);
  for (const q of queries) {
    for await (const _ of source.retrieve(q, ctx({
      cost: { charge: (key: string) => { charges.push(key); return 0; }, canSpend: () => true },
    }))) { /* drain */ }
  }
  assert.equal(charges.filter((k) => k === 'apify.amazon-review-run').length, 1);
  assert.equal(charges.filter((k) => k === 'apify.amazon-review-item').length, 8,
    'charged for every review the vendor returned, survivors or not');
});

test('the spend cap is asked before the vendor is called', async () => {
  const { fetch, calls } = routed();
  const logged: string[] = [];
  const source = createAmazonReviewsSource({ fetch });
  const queries = await source.plan(PLAN);
  for (const q of queries) {
    for await (const _ of source.retrieve(q, ctx({
      cost: { charge: () => 0, canSpend: () => false },
      log: (l) => logged.push(l),
    }))) { /* drain */ }
  }
  assert.equal(calls.length, 0, 'no call was made, so nothing could have been billed');
  assert.match(logged.join(' '), /spend cap/);
});

test('a missing token degrades to nothing, and a vendor error is a log line, not a throw', async () => {
  const source = createAmazonReviewsSource({ fetch: routed().fetch });
  const queries = await source.plan(PLAN);
  const out: SourceRecord[] = [];
  for (const q of queries) {
    for await (const r of source.retrieve(q, ctx({ env: {} }))) out.push(r);
  }
  assert.equal(out.length, 0);

  const down = createAmazonReviewsSource({ fetch: routed('', 503).fetch });
  const logged: string[] = [];
  for (const q of await down.plan(PLAN)) {
    for await (const r of down.retrieve(q, ctx({ log: (l) => logged.push(l) }))) out.push(r);
  }
  assert.equal(out.length, 0);
  assert.match(logged.join(' '), /503/);
});
