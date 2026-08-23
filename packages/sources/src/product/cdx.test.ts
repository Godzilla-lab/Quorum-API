/*
 * CDX rows here are CAPTURED, from a live query against
 * `allbirds.com/products*` on 2026-08-22 that returned 4000 distinct urls
 * spanning 2016-03-05 to 2026-08-19.
 *
 * The url shapes below are real and are the reason this parser is not a
 * one liner: the archive holds the same product under an http scheme with a
 * port, under https with and without www, and with query strings attached.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { SafeFetchResult } from '../http/safe-fetch.ts';
import {
  archivedContentUrl, catalogueHistory, cdxUrl, listSnapshots, normaliseProductUrl,
} from './cdx.ts';

const FIXTURE = readFileSync(new URL('./fixtures/cdx-products.json', import.meta.url), 'utf8');
const okFetch = (body: string): (() => Promise<SafeFetchResult>) => async () => ({
  ok: true, status: 200, headers: {}, body, url: 'https://web.archive.org/cdx/search/cdx',
});

test('the captured rows parse into snapshots with real dates', async () => {
  const result = await listSnapshots('allbirds.com/products*', { fetch: okFetch(FIXTURE), limit: 500 });
  assert.equal(result.ok, true);
  assert.ok(result.snapshots.length > 5);
  for (const s of result.snapshots) {
    assert.match(s.timestamp, /^\d{14}$/);
    assert.ok(s.capturedAt instanceof Date);
    assert.ok(s.digest.length > 0);
  }
});

/*
 * The archive holds one product under several urls. Counting them separately
 * would invent a catalogue several times larger than the store actually is.
 */
test('scheme, www, port, trailing slash and query all collapse to one product', () => {
  const key = 'allbirds.com/products/insoles-mens';
  assert.equal(normaliseProductUrl('http://www.allbirds.com:80/products/insoles-mens'), key);
  assert.equal(normaliseProductUrl('https://allbirds.com/products/insoles-mens'), key);
  assert.equal(normaliseProductUrl('https://www.allbirds.com/products/insoles-mens/'), key);
  assert.equal(normaliseProductUrl('https://allbirds.com/products/insoles-mens?variant=42'), key);
});

test('an unparseable url is dropped rather than becoming a phantom product', () => {
  assert.equal(normaliseProductUrl('not a url'), '');
  assert.equal(catalogueHistory([
    { timestamp: '20200101000000', original: 'not a url', status: '200', digest: 'd', capturedAt: new Date() },
  ]).length, 0);
});

/*
 * The product mortality signal: a delisted product vanishes from a live
 * catalogue with no trace, so "what did they launch and then kill" is normally
 * unanswerable. Here it is a lastSeen that stopped moving.
 */
test('catalogue history reports when each product was first and last seen alive', () => {
  const snap = (ts: string, url: string) => ({
    timestamp: ts, original: url, status: '200', digest: `d${ts}`,
    capturedAt: new Date(`${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T00:00:00Z`),
  });
  const history = catalogueHistory([
    snap('20200101000000', 'https://www.allbirds.com/products/wool-runner'),
    snap('20260101000000', 'https://allbirds.com/products/wool-runner'),
    snap('20220601000000', 'http://www.allbirds.com:80/products/wool-runner/'),
    snap('20180101000000', 'https://allbirds.com/products/discontinued-thing'),
    snap('20190101000000', 'https://allbirds.com/products/discontinued-thing'),
  ]);

  assert.equal(history.length, 2, 'three urls for one product is one product');

  const live = history.find((h) => h.url.endsWith('wool-runner'))!;
  assert.equal(live.captures, 3);
  assert.equal(live.firstSeen?.getUTCFullYear(), 2020);
  assert.equal(live.lastSeen?.getUTCFullYear(), 2026);

  const dead = history.find((h) => h.url.endsWith('discontinued-thing'))!;
  assert.equal(dead.lastSeen?.getUTCFullYear(), 2019, 'it stopped being seen, which is the signal');
  assert.equal(history[0]?.url, live.url, 'most recently alive first');
});

/*
 * Both exploratory queries on 2026-08-22 came back exactly at the limit set,
 * 2000 and then 4000, and both times the obvious reading was "that is the
 * total". A bounded result that does not say it was bounded reads as complete
 * coverage.
 */
test('hitting the limit is reported, never silently presented as the total', async () => {
  const rows = JSON.parse(FIXTURE) as unknown[];
  const dataRows = rows.length - 1;

  const capped = await listSnapshots('x', { fetch: okFetch(FIXTURE), limit: dataRows });
  assert.equal(capped.truncated, true);

  const roomy = await listSnapshots('x', { fetch: okFetch(FIXTURE), limit: dataRows + 1 });
  assert.equal(roomy.truncated, false);
});

/* A slow archive is the normal case, so every failure is a value. */
test('a failed call returns an error rather than throwing', async () => {
  const result = await listSnapshots('x', {
    fetch: async () => ({ ok: false, status: 0, headers: {}, body: '', url: '', error: 'request timed out' }),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.snapshots, []);
  assert.match(result.error ?? '', /timed out/);
});

test('a non json body is an error rather than a crash', async () => {
  const result = await listSnapshots('x', { fetch: okFetch('<html>too busy</html>') });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /not json/);
});

/* Nothing archived is a real answer about the world, not a failure. */
test('an empty result is ok and empty, not an error', async () => {
  const result = await listSnapshots('x', { fetch: okFetch('[]') });
  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshots, []);
  assert.equal(result.truncated, false);
});

test('the query asks for exactly the fields the parser reads', () => {
  const url = new URL(cdxUrl('allbirds.com/products', { prefix: true, onlyOk: true, limit: 50 }));
  assert.equal(url.searchParams.get('output'), 'json');
  assert.equal(url.searchParams.get('fl'), 'timestamp,original,statuscode,digest');
  assert.equal(url.searchParams.get('matchType'), 'prefix');
  assert.equal(url.searchParams.get('filter'), 'statuscode:200');
  assert.equal(url.searchParams.get('limit'), '50');
});

/* The archive accepts only one collapse field, so urls win. See the module. */
test('url collapsing wins when both collapses are asked for', () => {
  const url = new URL(cdxUrl('x', { collapseUrls: true, collapseDigest: true }));
  assert.equal(url.searchParams.get('collapse'), 'urlkey');
  assert.equal(new URL(cdxUrl('x', { collapseDigest: true })).searchParams.get('collapse'), 'digest');
});

/*
 * Without `id_` the archive injects its toolbar and rewrites every url in the
 * page, which corrupts JSON-LD and turns product image urls into archive urls.
 */
test('archived content is fetched raw, without the archive rewriting the page', () => {
  const url = archivedContentUrl({
    timestamp: '20260819053954',
    original: 'https://allbirds.com/products/wool-runner',
    status: '200', digest: 'abc', capturedAt: null,
  });
  assert.equal(url, 'https://web.archive.org/web/20260819053954id_/https://allbirds.com/products/wool-runner');
  assert.match(url, /\d{14}id_\//);
});
