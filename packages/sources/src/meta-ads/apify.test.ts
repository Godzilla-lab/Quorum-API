/*
 * Every assertion here runs against ads CAPTURED FROM THE LIVE VENDOR on
 * 2026-08-22, never against a payload written by hand.
 *
 * That rule exists because of a specific failure: the Hacker News adapter once
 * filtered on `points >= 2` for comments, matched ZERO of 6,903 available
 * comments in production, and passed its tests the whole time because the
 * fixture invented a field the API does not return. A hand written ad payload
 * would hide exactly the bugs this file is for.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { CostMeterLike, Ctx } from '../source.ts';
import type { SafeFetchResult } from '../http/safe-fetch.ts';
import { creativeType } from './creative.ts';
import { adHaystack, createMetaAdsApifySource, normaliseAd } from './apify.ts';

const ADS = JSON.parse(
  readFileSync(new URL('./fixtures/ad-library-search.json', import.meta.url), 'utf8'),
) as Record<string, unknown>[];

/* The day the fixture was captured. */
const CAPTURED_AT = Math.floor(Date.parse('2026-08-22T12:00:00Z') / 1000);

const byId = (id: string) => ADS.find((a) => a['ad_archive_id'] === id)!;

function meter(): CostMeterLike & { charges: string[]; allow: boolean } {
  const state = {
    charges: [] as string[],
    allow: true,
    charge(key: string, count = 1): number { for (let i = 0; i < count; i++) state.charges.push(key); return 0; },
    canSpend(): boolean { return state.allow; },
  };
  return state;
}

function ctx(over: Partial<Ctx> = {}): Ctx & { cost: ReturnType<typeof meter> } {
  const cost = meter();
  return { env: { APIFY_TOKEN: 'test-token' }, cost, ...over } as Ctx & { cost: ReturnType<typeof meter> };
}

const okFetch = (rows: unknown): (() => Promise<SafeFetchResult>) => async () => ({
  ok: true, status: 200, headers: {}, body: JSON.stringify(rows), url: 'https://api.apify.com/',
});

test('the fixture covers all eight branches it was captured for', () => {
  assert.equal(ADS.length, 8);
  const types = ADS.map((a) => creativeType(a));
  assert.ok(types.includes('video'), 'a video ad');
  assert.ok(types.includes('static'), 'a static ad');
  assert.ok(types.includes(null), 'an ad we cannot type');
});

/*
 * The most expensive bug in this module's history, re-measured. `display_format`
 * names DELIVERY MODES, not creative types.
 */
test('display_format cannot type most ads, and the media arrays rescue them', () => {
  const untypable = ADS.filter((a) => {
    const df = String((a['snapshot'] as Record<string, unknown>)?.['display_format'] ?? '').toUpperCase();
    return df !== 'VIDEO' && df !== 'IMAGE';
  });
  assert.ok(untypable.length >= 3, `expected several DPA/DCO/CAROUSEL ads, got ${untypable.length}`);
  const rescued = untypable.filter((a) => creativeType(a) !== null);
  assert.ok(rescued.length >= untypable.length - 1, 'the media arrays must type almost all of them');
});

test('an ad we cannot type stays null and never joins a bucket', () => {
  const untyped = ADS.filter((a) => creativeType(a) === null);
  assert.equal(untyped.length, 1);
  const record = normaliseAd(untyped[0]!, CAPTURED_AT)!;
  assert.equal(record.creative, null, 'a ratio computed over guesses is worse than no ratio');
});

/*
 * CALIBRATION. First measured 2026-08-13, replicated 2026-08-22 at 19 active
 * versus 11 inactive with a perfect correlation.
 */
test('a live ad never keeps its end date, because that is a read timestamp', () => {
  const active = ADS.filter((a) => a['is_active'] === true);
  assert.ok(active.length > 0);
  for (const raw of active) {
    assert.notEqual(raw['end_date'], null, 'the vendor does supply one');
    const record = normaliseAd(raw, CAPTURED_AT)!;
    assert.equal(record.endDate, null, `ad ${String(raw['ad_archive_id'])} kept a read timestamp as an end date`);
    assert.notEqual(record.durationConfidence, 'reported',
      'claiming reported provenance for a duration nobody reported is the failure this guards');
  }
});

test('a stopped ad keeps its real end date and reports a reported duration', () => {
  const stopped = ADS.filter((a) => a['is_active'] === false && typeof a['end_date'] === 'number' && typeof a['start_date'] === 'number');
  assert.ok(stopped.length > 0);
  for (const raw of stopped) {
    const record = normaliseAd(raw, CAPTURED_AT)!;
    assert.equal(record.endDate, raw['end_date']);
    assert.equal(record.durationConfidence, 'reported');
    assert.ok((record.daysRunning ?? -1) >= 0);
  }
});

test('a live ad with a start date is observed, never reported', () => {
  const live = ADS.find((a) => a['is_active'] === true && typeof a['start_date'] === 'number')!;
  const record = normaliseAd(live, CAPTURED_AT)!;
  assert.equal(record.durationConfidence, 'observed');
  assert.equal(record.daysRunning, Math.floor((CAPTURED_AT - (live['start_date'] as number)) / 86_400));
});

test('platforms are lowercased so two sources cannot disagree on casing', () => {
  const record = normaliseAd(ADS[0]!, CAPTURED_AT)!;
  assert.ok(record.platforms!.length > 0);
  for (const p of record.platforms!) assert.equal(p, p.toLowerCase());
});

test('an ad with no archive id is dropped rather than stored without an identity', () => {
  assert.equal(normaliseAd({ page_name: 'x' }, CAPTURED_AT), null);
});

test('the haystack carries the copy a reader would match against', () => {
  const hay = adHaystack(byId('866569929827744'));
  assert.match(hay, /Cholesterol Relief Community/);
  assert.ok(hay.length > 50);
});

/* A missing key degrades a run and never fails it. */
test('unconfigured without a token, and it does not throw', () => {
  const source = createMetaAdsApifySource();
  assert.equal(source.configured({}), false);
  assert.equal(source.configured({ APIFY_TOKEN: 'x' }), true);
});

test('every ad the vendor returned charges the meter, including ones we then drop', async () => {
  const source = createMetaAdsApifySource({ fetch: okFetch(ADS), now: () => CAPTURED_AT });
  await source.plan({ category: 'running shoes', productTitle: 'running shoes', productUrl: '', terms: [] });
  const c = ctx();
  const out = [];
  for await (const r of source.retrieve({ text: 'running shoes' }, c)) out.push(r);

  assert.equal(c.cost.charges.length, ADS.length,
    'we were billed for every ad returned, so the meter records every ad returned');
  assert.ok(out.length <= ADS.length);
});

test('the spend cap stops the call before a byte moves', async () => {
  let called = false;
  const source = createMetaAdsApifySource({
    fetch: async () => { called = true; return okFetch(ADS)(); },
  });
  await source.plan({ category: 'running shoes', productTitle: 'running shoes', productUrl: '', terms: [] });
  const c = ctx();
  c.cost.allow = false;
  const out = [];
  for await (const r of source.retrieve({ text: 'running shoes' }, c)) out.push(r);

  assert.equal(called, false, 'the meter cannot prevent a call it does not make, so we ask first');
  assert.equal(out.length, 0);
});

test('a vendor failure degrades the run rather than throwing', async () => {
  const logs: string[] = [];
  const source = createMetaAdsApifySource({
    fetch: async () => ({ ok: false, status: 503, headers: {}, body: '', url: '', error: 'vendor down' }),
  });
  await source.plan({ category: 'running shoes', productTitle: 'running shoes', productUrl: '', terms: [] });
  const out = [];
  for await (const r of source.retrieve({ text: 'x' }, ctx({ log: (m) => logs.push(m) }))) out.push(r);
  assert.deepEqual(out, []);
  assert.match(logs.join(' '), /vendor down/);
});

test('a response that is not json degrades rather than throwing', async () => {
  const source = createMetaAdsApifySource({
    fetch: async () => ({ ok: true, status: 200, headers: {}, body: '<html>rate limited</html>', url: '' }),
  });
  const out = [];
  for await (const r of source.retrieve({ text: 'x' }, ctx())) out.push(r);
  assert.deepEqual(out, []);
});

/*
 * Scoping to one advertiser is the precise path, so the imprecise backstop gate
 * must not then throw away the ads we deliberately asked for.
 */
test('a scoped query keeps every ad, because the scoping already happened', async () => {
  const source = createMetaAdsApifySource({ fetch: okFetch(ADS), now: () => CAPTURED_AT });
  await source.plan({ category: 'running shoes', productTitle: 'running shoes', productUrl: '', terms: [] });
  const out = [];
  for await (const r of source.retrieve({ text: 'Clarks', scope: '123456' }, ctx())) out.push(r);
  assert.equal(out.length, ADS.length);
});

test('a citation points a reader at the ad itself', () => {
  const record = normaliseAd(ADS[0]!, CAPTURED_AT)!;
  const cite = createMetaAdsApifySource().cite(record);
  assert.match(cite.url, /facebook\.com\/ads\/library/);
  assert.ok(cite.label.includes(record.advertiser));
});
