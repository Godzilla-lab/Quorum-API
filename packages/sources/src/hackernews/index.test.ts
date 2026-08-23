import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runSourceConformance, makeCtx } from '../conformance.ts';
import { createHackerNewsSource, decodeEntities, itemUrl } from './index.ts';
import { createThrottle } from '../throttle.ts';
import type { SafeFetchResult } from '../http/safe-fetch.ts';

const FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures/search-comments.json'), 'utf8');

const instantThrottle = () => createThrottle({ sleep: async () => {}, random: () => 0 });

const respond = (body: string, status = 200): typeof import('../http/safe-fetch.ts').safeFetch =>
  async (url) => ({ ok: status >= 200 && status < 300, status, headers: {}, body, url } as SafeFetchResult);

runSourceConformance('hackernews', () => ({
  source: createHackerNewsSource({ throttle: instantThrottle(), fetch: respond(FIXTURE) }),
  configuredEnv: {},
  planInput: { category: 'mechanical keyboards', productTitle: 'Keeb', productUrl: 'https://example.com', terms: ['sizing', 'switches'] },
}));

test('hackernews needs no key at all', () => {
  const s = createHackerNewsSource();
  assert.equal(s.configured({}), true, 'a fresh clone with no keys must still get this source');
  assert.equal(s.cost, 'free');
});

/*
 * Every query carries the category. Measured live 2026-08-22: the bare term
 * "sizing" returned 13,801 hits about CSS and fonts, while "running shoes
 * sizing" returned 12 that were actually about running. Hacker News is a
 * general forum, so an unscoped question term means whatever it means to
 * programmers.
 */
test('every query is scoped to the category, never a bare term', async () => {
  const s = createHackerNewsSource();
  const queries = await s.plan({
    category: 'mechanical keyboards', productTitle: 'Keeb', productUrl: 'https://x.com',
    terms: ['switches', 'keycaps', 'sound'],
  });
  assert.deepEqual(queries.map((q) => q.text), [
    'mechanical keyboards switches',
    'mechanical keyboards keycaps',
    'mechanical keyboards sound',
  ]);
});

test('a product with no terms still plans against its category', async () => {
  const s = createHackerNewsSource();
  const queries = await s.plan({ category: 'standing desks', productTitle: 'D', productUrl: 'https://x.com', terms: [] });
  assert.deepEqual(queries.map((q) => q.text), ['standing desks standing desks']);
});

/*
 * THE REGRESSION, from a live run. A running shoes report stored 95 Hacker News
 * threads about Internet Explorer, RISC versus CISC and grid stylesheets, and
 * the corroboration line reported them as independent corroborating channels.
 * That is a fabricated number in front of a customer with real receipts under
 * it that lead to people discussing something else.
 */
test('off topic threads are refused even when the search returns them', async () => {
  const body = JSON.stringify({ hits: [
    { objectID: '1', created_at_i: 1700000000, story_title: 'RISC vs. CISC: Whats the Difference?',
      comment_text: 'Instruction sizing tradeoffs matter more than people think for cache pressure' },
    { objectID: '2', created_at_i: 1700000000, story_title: 'Grid Style Sheets',
      comment_text: 'Font sizing in responsive layouts is still an unsolved mess after all these years' },
    { objectID: '3', created_at_i: 1700000000, story_title: 'The Great Barefoot Running Hysteria',
      comment_text: 'I switched to minimal running shoes and had to size up a full size, worth knowing' },
  ] });

  const s = createHackerNewsSource({ throttle: instantThrottle(), fetch: respond(body) });
  const queries = await s.plan({
    category: 'running shoes', productTitle: 'Trail X', productUrl: 'https://x.com', terms: ['sizing'],
  });

  const out = [];
  for await (const r of s.retrieve(queries[0]!, makeCtx())) out.push(r);

  assert.equal(out.length, 1, 'two of three were about programming, not shoes');
  assert.match(out[0]!.channel ?? '', /Barefoot Running/);
});

test('the gate is only armed after planning has seen the subject', async () => {
  /* Retrieving without planning first must not silently store everything. */
  const body = JSON.stringify({ hits: [
    { objectID: '1', created_at_i: 1700000000, story_title: 'Grid Style Sheets',
      comment_text: 'Font sizing in responsive layouts is still an unsolved mess after all these years' },
  ] });
  const s = createHackerNewsSource({ throttle: instantThrottle(), fetch: respond(body) });

  const out = [];
  for await (const r of s.retrieve({ text: 'sizing' }, makeCtx())) out.push(r);
  assert.equal(out.length, 1, 'with no subject known the gate cannot judge, and says so by passing');
});

test('records are parsed from a real captured response', async () => {
  const s = createHackerNewsSource({ throttle: instantThrottle(), fetch: respond(FIXTURE) });
  const out = [];
  for await (const r of s.retrieve({ text: 'switches' }, makeCtx())) out.push(r);

  assert.ok(out.length >= 2, 'the fixture holds several usable comments');
  const first = out[0];
  assert.ok(first);
  assert.equal(first.source, 'hackernews');
  assert.equal(first.kind, 'comment');
  assert.equal(first.origin, 'Hacker News');
  assert.match(first.url ?? '', /news\.ycombinator\.com\/item\?id=/);
  assert.equal(first.score, 0, 'HN comments carry no score, and inventing one would be fabrication');
  assert.ok((first.createdUtc ?? 0) > 0, 'a receipt without a date cannot be dated to a reader');
});

/*
 * Algolia returns HTML entities inside comment text. Left alone a quote reads
 * as "it&#x27;s too small", which looks like a bug in our product rather than
 * in theirs.
 */
test('html entities and tags are decoded before a quote reaches a reader', () => {
  assert.equal(decodeEntities('it&#x27;s too small'), "it's too small");
  assert.equal(decodeEntities('&quot;quoted&quot;'), '"quoted"');
  assert.equal(decodeEntities('a &lt;tag&gt; here'), 'a <tag> here');
  assert.equal(decodeEntities('<p>para</p><p>two</p>'), 'para two');
  assert.equal(decodeEntities('a&nbsp;b'), 'a b');
  assert.equal(decodeEntities('one   two\n\nthree'), 'one two three');
});

/* Ampersand decodes last, or a double encoded entity decodes twice. */
test('a double encoded entity is not decoded twice', () => {
  assert.equal(decodeEntities('&amp;#x27;'), "&#x27;", 'the inner entity must survive as literal text');
});

test('short fragments are dropped rather than spending prompt tokens', async () => {
  const body = JSON.stringify({ hits: [
    { objectID: '1', comment_text: 'yes', created_at_i: 1700000000, story_title: 'T' },
    { objectID: '2', comment_text: 'x'.repeat(60), created_at_i: 1700000000, story_title: 'T' },
  ] });
  const s = createHackerNewsSource({ throttle: instantThrottle(), fetch: respond(body) });
  const out = [];
  for await (const r of s.retrieve({ text: 'anything' }, makeCtx())) out.push(r);
  assert.equal(out.length, 1, 'a three character comment carries no market signal');
});

test('a source that is down degrades the run instead of failing it', async () => {
  const s = createHackerNewsSource({ throttle: instantThrottle(), fetch: respond('', 503) });
  const logs: string[] = [];
  const out = [];
  for await (const r of s.retrieve({ text: 'x' }, makeCtx({ log: (m) => logs.push(m) }))) out.push(r);

  assert.deepEqual(out, [], 'no records, and no exception');
  assert.equal(logs.length, 1, 'but it says so rather than being silently empty');
});

test('a non json response is survived', async () => {
  const s = createHackerNewsSource({ throttle: instantThrottle(), fetch: respond('<html>cloudflare</html>') });
  const out = [];
  for await (const r of s.retrieve({ text: 'x' }, makeCtx())) out.push(r);
  assert.deepEqual(out, []);
});

test('an empty result set is not an error', async () => {
  const s = createHackerNewsSource({ throttle: instantThrottle(), fetch: respond('{"hits":[]}') });
  const out = [];
  for await (const r of s.retrieve({ text: 'x' }, makeCtx())) out.push(r);
  assert.deepEqual(out, []);
});

test('records yield incrementally rather than after the whole page', async () => {
  const s = createHackerNewsSource({ throttle: instantThrottle(), fetch: respond(FIXTURE) });
  const iterator = s.retrieve({ text: 'switches' }, makeCtx())[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false, 'the corpus can start writing before retrieval finishes');
});

test('a citation names the source and the thread but claims no score', () => {
  const s = createHackerNewsSource();
  const c = s.cite({
    source: 'hackernews', kind: 'comment', externalId: '42',
    text: 'the switches are too loud', origin: 'Hacker News', channel: 'Show HN: a keyboard',
    score: 0, url: 'https://news.ycombinator.com/item?id=42', createdUtc: 1_700_000_000,
  });
  assert.match(c.label, /Hacker News/);
  assert.match(c.label, /Show HN: a keyboard/);
  assert.doesNotMatch(c.label, /points/, '"0 points" reads as "nobody agreed", which is a fabricated signal');
  assert.equal(c.postedAt, 1_700_000_000);
});

/*
 * REGRESSION, found by a live probe 2026-08-22.
 *
 * The adapter sent numericFilters=points>=2 against tags=comment. Comments have
 * no points field, so that matched ZERO of 6,903 available rows: the adapter
 * would have returned nothing in production, forever. It passed fifteen tests
 * because the fixture was hand written and invented the field.
 */
test('the query never filters on points, which comments do not have', async () => {
  const urls: string[] = [];
  const capture = (async (url: string) => {
    urls.push(url);
    return { ok: true, status: 200, headers: {}, body: FIXTURE, url } as SafeFetchResult;
  }) as unknown as typeof import('../http/safe-fetch.ts').safeFetch;

  const s = createHackerNewsSource({ throttle: instantThrottle(), fetch: capture });
  for await (const _ of s.retrieve({ text: 'keyboard', withinDays: 30 }, makeCtx())) { /* drain */ }

  const url = urls[0] ?? '';
  assert.doesNotMatch(url, /points/, 'filtering on points matches nothing at all');
  assert.match(url, /created_at_i/, 'created_at_i is the only numeric field a comment has');
});

test('the captured fixture really has no points field', () => {
  const parsed = JSON.parse(FIXTURE) as { hits: Record<string, unknown>[] };
  assert.ok(parsed.hits.length > 0);
  for (const hit of parsed.hits) {
    assert.equal('points' in hit, false, 'this fixture is captured from the live API, not authored');
  }
});

test('item urls point at the comment, not the story', () => {
  assert.equal(itemUrl({ objectID: '12345' }), 'https://news.ycombinator.com/item?id=12345');
});
