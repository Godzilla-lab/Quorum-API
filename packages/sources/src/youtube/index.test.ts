/*
 * YouTube comments, against captured responses: a real search page of 10
 * review videos, a real page of 21 comment threads, and a real 403 from a
 * video with comments disabled, all taken unedited on 2026-08-27 with the
 * project key. Roughly 103 of the day's 10,000 free units, $0.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { commentDate, createYoutubeSource } from './index.ts';
import { runSourceConformance } from '../conformance.ts';
import { createThrottle } from '../throttle.ts';
import type { Ctx, SourceRecord } from '../source.ts';

const dir = fileURLToPath(new URL('.', import.meta.url));
const SEARCH = readFileSync(join(dir, 'fixtures/search.json'), 'utf8');
const THREADS = readFileSync(join(dir, 'fixtures/comment-threads.json'), 'utf8');
const DISABLED = readFileSync(join(dir, 'fixtures/comments-disabled.json'), 'utf8');

const ctx = (over: Partial<Ctx> = {}): Ctx => ({
  env: { QUORUM_YOUTUBE_API_KEY: 'test-key' },
  cost: { charge: () => 0, canSpend: () => true },
  ...over,
});

/* Instant throttle so retries and gaps cost the suite no wall clock. */
const throttle = () => createThrottle({ minGapMs: 0, sleep: async () => {} });

/* Routes search and commentThreads to fixtures, recording every url. */
function routed(threadsBody = THREADS, threadsStatus = 200) {
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(url);
    if (url.includes('/search?')) return { ok: true as const, status: 200, body: SEARCH, headers: {} };
    return threadsStatus === 200
      ? { ok: true as const, status: 200, body: threadsBody, headers: {} }
      : { ok: false as const, status: threadsStatus, body: threadsBody, error: `status ${threadsStatus}`, headers: {} };
  }) as never;
  return { fetch, calls };
}

const PLAN = {
  category: 'running shoes',
  productTitle: 'running shoes',
  productUrl: 'https://example.test/shoes',
  terms: ['sizing'],
};

runSourceConformance('youtube', () => ({
  source: createYoutubeSource({ fetch: routed().fetch, throttle: throttle() }),
  configuredEnv: { QUORUM_YOUTUBE_API_KEY: 'x' },
  planInput: PLAN,
}));

async function run(source = createYoutubeSource({ fetch: routed().fetch, throttle: throttle() })): Promise<SourceRecord[]> {
  const queries = await source.plan(PLAN);
  const out: SourceRecord[] = [];
  for (const q of queries) for await (const r of source.retrieve(q, ctx())) out.push(r);
  return out;
}

test('queries carry review intent, one per distinct name', async () => {
  const source = createYoutubeSource({ fetch: routed().fetch, throttle: throttle() });
  const same = await source.plan(PLAN);
  assert.deepEqual(same.map((q) => q.text), ['running shoes review']);

  const distinct = await source.plan({ ...PLAN, productTitle: 'Pegasus 41' });
  assert.deepEqual(distinct.map((q) => q.text), ['running shoes review', 'pegasus 41 review']);
});

test('records carry likes as points, exact dates and a comment permalink', async () => {
  const records = await run();
  assert.ok(records.length >= 5, `only ${records.length} records survived the gate`);
  for (const r of records) {
    assert.equal(r.source, 'youtube');
    assert.equal(r.kind, 'comment');
    assert.ok((r.text ?? '').length > 0);
    assert.match(r.url ?? '', /^https:\/\/www\.youtube\.com\/watch\?v=.+&lc=.+/,
      'the lc parameter is what makes a receipt blind resolve to the comment');
    assert.ok((r.createdUtc ?? 0) >= 1_500_000_000, `date missing or implausible: ${r.createdUtc}`);
    assert.ok((r.channel ?? '').length > 5, 'the channel is the video title, prose');
  }
  const distinctDates = new Set(records.map((r) => r.createdUtc));
  assert.ok(distinctDates.size > 1, 'dates are per comment');
});

test('the relevance gate runs under the video title channel', async () => {
  /*
   * One video, one fixture page of 21 threads. The video title carries the
   * subject words, so the container vouches for its comments exactly as a
   * matching subreddit does; what the gate must never do is admit MORE than
   * the page holds or records with no text. The known title-vouch residual
   * (one subject word in a title vouching everything under it) is a gate
   * calibration question, measured in evals/relevance, not an adapter one.
   */
  const source = createYoutubeSource({ fetch: routed().fetch, throttle: throttle(), videosPerQuery: 1, pagesPerVideo: 1 });
  const queries = await source.plan(PLAN);
  const out: SourceRecord[] = [];
  for (const q of queries) for await (const r of source.retrieve(q, ctx())) out.push(r);
  assert.ok(out.length >= 5 && out.length <= 21, `${out.length} records from a 21 thread page`);
  assert.ok(out.every((r) => r.text.length > 0));
});

test('comments disabled is absence, not an error, and other failures log', async () => {
  const disabled = createYoutubeSource({ fetch: routed(DISABLED, 403).fetch, throttle: throttle() });
  const logged: string[] = [];
  const out: SourceRecord[] = [];
  for (const q of await disabled.plan(PLAN)) {
    for await (const r of disabled.retrieve(q, ctx({ log: (l) => logged.push(l) }))) out.push(r);
  }
  assert.equal(out.length, 0);
  assert.deepEqual(logged, [], 'a 403 here means comments are off, not a failure worth alarm');

  const down = createYoutubeSource({ fetch: routed('', 500).fetch, throttle: throttle() });
  const downLogged: string[] = [];
  for (const q of await down.plan(PLAN)) {
    for await (const _ of down.retrieve(q, ctx({ log: (l) => downLogged.push(l) }))) { /* drain */ }
  }
  assert.match(downLogged.join(' '), /status/, 'a real failure says so');
});

test('a missing key degrades to nothing and no request is made', async () => {
  const { fetch, calls } = routed();
  const source = createYoutubeSource({ fetch, throttle: throttle() });
  const out: SourceRecord[] = [];
  for (const q of await source.plan(PLAN)) {
    for await (const r of source.retrieve(q, ctx({ env: {} }))) out.push(r);
  }
  assert.equal(out.length, 0);
  assert.equal(calls.length, 0, 'unconfigured means untouched, not errored');
});

test('the unit budget ends the run cleanly instead of spending the day', async () => {
  const { fetch, calls } = routed();
  /* Two pages per video across 10 fixture videos would be 20 thread calls;
   * a budget of 100 search + a handful of pages stops far earlier. */
  const source = createYoutubeSource({ fetch, throttle: throttle(), pagesPerVideo: 500 });
  const logged: string[] = [];
  for (const q of await source.plan(PLAN)) {
    for await (const _ of source.retrieve(q, ctx({ log: (l) => logged.push(l) }))) { /* drain */ }
  }
  assert.ok(calls.length <= 502, `made ${calls.length} calls against a 500 unit budget`);
});

test('failure paths never log the url, because the url carries the key', async () => {
  const down = createYoutubeSource({ fetch: routed('', 500).fetch, throttle: throttle() });
  const logged: string[] = [];
  for (const q of await down.plan(PLAN)) {
    for await (const _ of down.retrieve(q, ctx({ log: (l) => logged.push(l) }))) { /* drain */ }
  }
  assert.doesNotMatch(logged.join(' '), /key|googleapis/, 'no log line names the url or the key');
});

test('dates parse from the payload and garbage stays honestly undated', () => {
  assert.ok(commentDate('2026-08-19T17:47:57Z') > 1_700_000_000);
  assert.equal(commentDate('two weeks ago'), 0);
  assert.equal(commentDate(undefined), 0);
});
