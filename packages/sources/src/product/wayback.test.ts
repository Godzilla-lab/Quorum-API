import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COMMERCIAL_FACT_MAX_AGE_DAYS, commercialFactsUsable, fetchArchived, findSnapshot, parseWaybackTimestamp } from './wayback.ts';
import { resolveProduct, type Unblocker } from './resolve.ts';
import type { SafeFetchResult } from '../http/safe-fetch.ts';

const NOW = Date.UTC(2026, 7, 22);
const now = () => NOW;

const routes = (map: Record<string, Partial<SafeFetchResult>>) =>
  (async (url: string) => {
    for (const [fragment, res] of Object.entries(map)) {
      if (url.includes(fragment)) return { ok: true, status: 200, headers: {}, body: '', url, ...res } as SafeFetchResult;
    }
    return { ok: false, status: 403, headers: {}, body: '', url, error: 'page returned 403' } as SafeFetchResult;
  }) as never;

const availability = (timestamp: string) => JSON.stringify({
  archived_snapshots: { closest: { available: true, timestamp, url: `http://web.archive.org/web/${timestamp}/https://x.example/p` } },
});

const PRODUCT_HTML = `<script type="application/ld+json">
  {"@type":"Product","name":"Wool Runners","category":"Running Shoes","brand":{"name":"Allbirds"},
   "offers":{"price":"98.00","priceCurrency":"USD"},
   "aggregateRating":{"ratingValue":"4.5","reviewCount":"9000"}}</script>`;

test('archive timestamps parse to real dates', () => {
  const d = parseWaybackTimestamp('20260605172231');
  assert.equal(d?.toISOString(), '2026-06-05T17:22:31.000Z');
  assert.equal(parseWaybackTimestamp('2026'), null);
  assert.equal(parseWaybackTimestamp('not-a-timestamp'), null);
});

test('a snapshot is found and forced to https', async () => {
  const snap = await findSnapshot('https://x.example/p', {
    fetch: routes({ 'archive.org/wayback/available': { body: availability('20260605172231') } }),
    now,
  });
  assert.ok(snap);
  assert.match(snap.url, /^https:/, 'a mixed scheme redirect costs a guard hop for nothing');
  assert.ok((snap.ageDays ?? 0) > 70 && (snap.ageDays ?? 0) < 90);
});

test('no snapshot is a null, not an error', async () => {
  const snap = await findSnapshot('https://x.example/p', {
    fetch: routes({ 'archive.org/wayback/available': { body: '{"archived_snapshots":{}}' } }), now,
  });
  assert.equal(snap, null);
});

/*
 * THE MEASURED CASE, 2026-08-22. Allbirds refused a direct fetch with a 403,
 * and the archive served a 2026-06 snapshot carrying full Product markup.
 */
test('a page that refuses a direct fetch is recovered from the archive', async () => {
  const r = await resolveProduct('https://www.allbirds.com/shop/wool-runners', {
    fetch: routes({
      'archive.org/wayback/available': { body: availability('20260605172231') },
      'web.archive.org/web/': { body: PRODUCT_HTML },
    }),
    now,
  });

  assert.equal(r.strategy, 'wayback');
  assert.equal(r.title, 'Wool Runners');
  assert.equal(r.category, 'running shoes');
  assert.equal(r.commercialFactsStale, false, 'a snapshot from ten weeks ago still has a usable price');
  assert.equal(r.price, 98);
});

/*
 * The catch that makes this tier honest. The Gymshark snapshot measured on the
 * same day was from 2019. Identity facts survive six years; a price does not.
 */
test('a years old snapshot yields identity but withholds commercial facts', async () => {
  const r = await resolveProduct('https://gymshark.com/shop/arrival-tshirt', {
    fetch: routes({
      'archive.org/wayback/available': { body: availability('20191014110340') },
      'web.archive.org/web/': { body: PRODUCT_HTML },
    }),
    now,
  });

  assert.equal(r.strategy, 'wayback');
  assert.equal(r.title, 'Wool Runners', 'a product name does not go stale');
  assert.equal(r.category, 'running shoes');
  assert.equal(r.commercialFactsStale, true);
  assert.equal(r.price, undefined, 'a 2019 price shown as today is the same mistake as an inferred duration');
  assert.equal(r.currency, undefined);
  assert.equal(r.ratingCount, undefined, 'a 2019 review count is not this product today');
});

test('the staleness cutoff is explicit', () => {
  assert.equal(COMMERCIAL_FACT_MAX_AGE_DAYS, 90);
  assert.equal(commercialFactsUsable({ url: '', timestamp: '', capturedAt: new Date(), ageDays: 30 }), true);
  assert.equal(commercialFactsUsable({ url: '', timestamp: '', capturedAt: new Date(), ageDays: 200 }), false);
  assert.equal(commercialFactsUsable({ url: '', timestamp: '', capturedAt: null, ageDays: null }), false,
    'an undatable snapshot cannot be shown to be fresh, so it is treated as stale');
});

/* The trail is what proves the ladder worked rather than quietly falling through. */
test('the trail records every rung that ran, in order', async () => {
  const r = await resolveProduct('https://x.example/products/thing', {
    fetch: routes({
      'archive.org/wayback/available': { body: availability('20260605172231') },
      'web.archive.org/web/': { body: PRODUCT_HTML },
    }),
    now,
  });

  assert.deepEqual(r.trail.map((t) => t.tier), ['shopify', 'direct', 'wayback']);
  assert.deepEqual(r.trail.map((t) => t.ok), [false, false, true]);
  assert.match(r.trail[1]?.note ?? '', /403/, 'and it says why each one failed');
});

test('the archive lookup can be skipped when a caller does not want the request', async () => {
  const r = await resolveProduct('https://x.example/p', { fetch: routes({}), useWayback: false, now });
  assert.equal(r.trail.some((t) => t.tier === 'wayback'), false);
  assert.equal(r.strategy, 'none');
});

/*
 * Paid unblockers are account specific and some carry resale questions, so the
 * interface ships and no implementation does. This proves the slot works.
 */
test('a caller supplied unblocker runs only after every free rung has failed', async () => {
  const calls: string[] = [];
  const unblocker: Unblocker = {
    id: 'test-unblocker',
    async fetchPage(url) { calls.push(url); return PRODUCT_HTML; },
  };

  const r = await resolveProduct('https://x.example/p', {
    fetch: routes({ 'archive.org/wayback/available': { body: '{"archived_snapshots":{}}' } }),
    unblocker, now,
  });

  assert.equal(r.strategy, 'unblocker');
  assert.equal(calls.length, 1, 'and only once, after free options were exhausted');
  assert.equal(r.trail.map((t) => t.tier).indexOf('unblocker'), r.trail.length - 1, 'last rung on the ladder');
});

test('an unblocker that throws does not take down the resolution', async () => {
  const unblocker: Unblocker = {
    id: 'flaky', async fetchPage() { throw new Error('vendor token expired'); },
  };
  const r = await resolveProduct('https://x.example/p', {
    fetch: routes({ 'archive.org/wayback/available': { body: '{"archived_snapshots":{}}' } }),
    unblocker, now,
  });
  assert.equal(r.strategy, 'none');
  assert.match(r.trail.find((t) => t.tier === 'unblocker')?.note ?? '', /token expired/);
});

/*
 * REGRESSION, measured 2026-08-22. Once safeFetch started identifying itself, a
 * store stopped returning 403 and started REDIRECTING to its category listing
 * page. The fetch then succeeded, the title tag read "Shop Sustainable Footwear
 * for Men", and the ladder stopped there, throwing away an archived copy that
 * had the real product with its brand, price, rating and photograph.
 *
 * A successful fetch of the wrong page is worse than a failed one, because
 * success is what halts a ladder.
 */
test('a title tag result never preempts an archive attempt', async () => {
  const listingPage = '<html><head><title>Shop Sustainable Footwear for Men</title></head><body></body></html>';

  const r = await resolveProduct('https://www.allbirds.com/shop/wool-runners', {
    fetch: routes({
      'archive.org/wayback/available': { body: availability('20260605172231') },
      'web.archive.org/web/': { body: PRODUCT_HTML },
      'allbirds.com/shop': { body: listingPage },
    }),
    now,
  });

  assert.equal(r.strategy, 'wayback', 'real markup beats a title tag, whichever one arrived first');
  assert.equal(r.title, 'Wool Runners');
  assert.equal(r.price, 98, 'and the price the listing page could never have given us');
  /* No shopify rung: the path is /shop/..., not /products/..., so that probe
   * correctly never fires. */
  assert.deepEqual(r.trail.map((t) => t.tier), ['direct', 'wayback']);
  assert.equal(r.trail.find((t) => t.tier === 'direct')?.ok, true, 'the direct fetch SUCCEEDED, and was still not good enough');
});

test('the title tag is used once every stronger rung has failed', async () => {
  const listingPage = '<html><head><title>Allbirds Men&#39;s Shoes</title></head></html>';

  const r = await resolveProduct('https://www.allbirds.com/shop/wool-runners', {
    fetch: routes({
      'archive.org/wayback/available': { body: '{"archived_snapshots":{}}' },
      'allbirds.com/shop': { body: listingPage },
    }),
    now,
  });

  assert.equal(r.strategy, 'title', 'weak is better than nothing, just never better than something');
  assert.equal(r.title, "Allbirds Men's Shoes", 'and entities are decoded before a reader sees them');
  assert.equal(r.trail[r.trail.length - 1]?.tier, 'title');
});
