/*
 * App Store reviews, against captured responses: 50 real reviews of a real app
 * and a real search result set, both taken unedited on 2026-08-22.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createAppStoreSource, reviewDate, reviewRating, reviewText, reviewUrl } from './index.ts';
import { runSourceConformance } from '../conformance.ts';
import type { Ctx, SourceRecord } from '../source.ts';

const dir = fileURLToPath(new URL('.', import.meta.url));
const REVIEWS = readFileSync(join(dir, 'fixtures/customer-reviews.json'), 'utf8');
const SEARCH = readFileSync(join(dir, 'fixtures/app-search.json'), 'utf8');

const ctx = (over: Partial<Ctx> = {}): Ctx =>
  ({ env: {}, cost: { charge: () => 0, canSpend: () => true }, ...over });

/* Routes by url, so one fake serves both the search and the feed. */
const routed = (search = SEARCH, reviews = REVIEWS, status = 200) => (async (url: string) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {},
  body: url.includes('/search') ? search : reviews,
  url,
})) as never;

async function run(source: ReturnType<typeof createAppStoreSource>, title = 'Notion'): Promise<SourceRecord[]> {
  const queries = await source.plan({ category: 'note taking app', productTitle: title, productUrl: '', terms: [] });
  const out: SourceRecord[] = [];
  for (const q of queries) for await (const r of source.retrieve(q, ctx())) out.push(r);
  return out;
}

runSourceConformance('appstore', () => ({
  source: createAppStoreSource({ fetch: routed(), storefronts: ['us'], pages: 1 }),
  configuredEnv: {},
  planInput: { category: 'note taking app', productTitle: 'Notion', productUrl: 'https://example.com', terms: ['sync'] },
}));

test('the fixtures are real captures', () => {
  const feed = JSON.parse(REVIEWS) as { feed: { entry: unknown[] } };
  assert.equal(feed.feed.entry.length, 50, 'Apple serves 50 reviews a page');
  const search = JSON.parse(SEARCH) as { resultCount: number };
  assert.equal(search.resultCount, 3);
});

/*
 * A star rating is not a vote count, and zero is not a rating. The score kind
 * table marks this source as `stars`, so a fabricated zero would render as
 * "0 of 5 stars", which is the worst review a person can leave.
 */
test('a rating outside one to five is zero rather than a guess', () => {
  assert.equal(reviewRating({ 'im:rating': { label: '2' } }), 2);
  assert.equal(reviewRating({ 'im:rating': { label: '5' } }), 5);
  assert.equal(reviewRating({ 'im:rating': { label: '0' } }), 0);
  assert.equal(reviewRating({ 'im:rating': { label: '7' } }), 0);
  assert.equal(reviewRating({}), 0);
});

test('the title is kept, because it is usually the verdict', () => {
  /* "Great app, just really buggy!" says more than the paragraph under it. */
  const body = reviewText({
    title: { label: 'Great app, just really buggy!' },
    content: { label: 'I love the templates but it crashes when I open a database.' },
  });
  assert.match(body, /^Great app, just really buggy!\. I love the templates/);
});

test('a title already repeated in the body is not said twice', () => {
  const body = reviewText({
    title: { label: 'Buggy' },
    content: { label: 'Buggy since the last update and I cannot sync.' },
  });
  assert.equal(body, 'Buggy since the last update and I cannot sync.');
});

test('a review with no body is not a record', () => {
  assert.equal(reviewText({ title: { label: 'Bad' }, content: { label: '' } }), '');
});

test('the receipt links to Apple when Apple gives a link, and to the app when it does not', () => {
  assert.equal(
    reviewUrl({ link: { attributes: { href: 'https://itunes.apple.com/review?id=1' } } }, 123, 'us'),
    'https://itunes.apple.com/review?id=1',
  );
  assert.match(reviewUrl({}, 123, 'gb'), /^https:\/\/apps\.apple\.com\/gb\/app\/id123/);
});

/*
 * Apple's search returns "To-Do List & Tasks for Notion" when asked for
 * "notion". A wrong app id yields a confident feed of reviews for the wrong
 * product, which is worse than returning nothing.
 */
test('the matched app has to look like what was asked for', async () => {
  const source = createAppStoreSource({ fetch: routed(), storefronts: ['us'], pages: 1 });
  const queries = await source.plan({
    category: 'video editor', productTitle: 'Final Cut Pro', productUrl: '', terms: [],
  });
  assert.deepEqual(queries, [], 'a search result that is not the subject must not be adopted');
});

test('one channel per app per storefront, so concentration is visible', async () => {
  const source = createAppStoreSource({ fetch: routed(), storefronts: ['us', 'gb'], pages: 1 });
  const records = await run(source);
  const channels = new Set(records.map((r) => r.channel));
  assert.deepEqual([...channels].sort(), ['Notion: Notes, Tasks, AI (gb)', 'Notion: Notes, Tasks, AI (us)']);
});

test('records carry stars, real text and a link', async () => {
  const source = createAppStoreSource({ fetch: routed(), storefronts: ['us'], pages: 1 });
  const records = await run(source);

  assert.ok(records.length > 10, `only ${records.length} survived the gate`);
  for (const r of records) {
    assert.equal(r.source, 'appstore');
    assert.equal(r.kind, 'comment');
    assert.ok((r.score ?? 0) >= 1 && (r.score ?? 0) <= 5, `star rating out of range: ${r.score}`);
    assert.ok((r.text ?? '').length >= 40);
    assert.match(r.url ?? '', /^https?:\/\//);
    /*
     * Every entry in the captured feed carries its own `updated` timestamp.
     * This assertion used to demand zero, under a comment claiming the feed
     * had no per review date; the fixture itself disproved that, and the
     * wrong belief survived because the test enforced it. 2026-08-26.
     */
    assert.ok((r.createdUtc ?? 0) >= 1_577_836_800, `review date missing or implausible: ${r.createdUtc}`);
  }
  const distinctDates = new Set(records.map((r) => r.createdUtc));
  assert.ok(distinctDates.size > 1,
    'dates are per review, not the feed level timestamp copied onto every entry');
});

test('a review with a missing or garbage updated label stays honestly undated', () => {
  assert.equal(reviewDate({}), 0);
  assert.equal(reviewDate({ updated: { label: null } }), 0);
  assert.equal(reviewDate({ updated: { label: 'not a date' } }), 0);
  assert.equal(reviewDate({ updated: { label: '2026-08-18T20:34:57-07:00' } }), 1_787_110_497);
});

test('a storefront with no reviews is silent, not an error', async () => {
  const logged: string[] = [];
  const source = createAppStoreSource({ fetch: routed(SEARCH, '', 403), storefronts: ['us'], pages: 1 });
  const queries = await source.plan({ category: 'note taking app', productTitle: 'Notion', productUrl: '', terms: [] });
  const out: SourceRecord[] = [];
  for (const q of queries) for await (const r of source.retrieve(q, ctx({ log: (l) => logged.push(l) }))) out.push(r);

  assert.deepEqual(out, []);
  assert.deepEqual(logged, [], 'a 403 here means no reviews, not a failure');
});

test('a null body degrades rather than crashing', async () => {
  const source = createAppStoreSource({ fetch: routed(SEARCH, 'null'), storefronts: ['us'], pages: 1 });
  assert.deepEqual(await run(source), []);
});

test('it needs no key', () => {
  assert.equal(createAppStoreSource().configured({}), true);
  assert.equal(createAppStoreSource().cost, 'free');
});
