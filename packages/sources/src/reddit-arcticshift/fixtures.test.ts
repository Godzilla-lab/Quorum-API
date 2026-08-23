import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createArcticShiftSource, isUsableComment } from './index.ts';
import { filterRelevant } from './relevance.ts';
import { makeCtx } from '../conformance.ts';
import type { ArcticShiftClient } from './client.ts';

/*
 * THE FIELD CONTRACT.
 *
 * These fixtures are CAPTURED from the live archive, not authored. That
 * distinction is the whole point of this file.
 *
 * A hand written Hacker News fixture once invented a `points` field on a
 * comment. The real API returns no such field, so the adapter filtered on
 * points, matched zero of 6,903 available rows, and would have returned nothing
 * in production forever. It passed fifteen tests, because the tests were run
 * against the invention.
 *
 * So every field the adapter reads is asserted present here against real data.
 * If the archive changes shape, this fails before anybody ships.
 *
 * Recapture with: node scripts/probes/capture-arcticshift.mjs
 */

const load = (name: string): { data: Record<string, unknown>[] } =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as { data: Record<string, unknown>[] };

const SUBREDDITS = load('subreddits-search.json');
const POSTS = load('posts-search.json');
const COMMENTS = load('comments-search.json');

test('captured subreddit rows carry every field discovery reads', () => {
  assert.ok(SUBREDDITS.data.length > 0, 'an empty fixture proves nothing');
  for (const row of SUBREDDITS.data) {
    assert.equal(typeof row['display_name'], 'string');
    assert.equal(typeof row['subscribers'], 'number');
    assert.equal(typeof row['over18'], 'boolean');
    assert.ok('public_description' in row);
  }
});

test('captured post rows carry every field retrieval reads', () => {
  assert.ok(POSTS.data.length > 0);
  for (const row of POSTS.data) {
    assert.equal(typeof row['id'], 'string');
    assert.equal(typeof row['title'], 'string');
    assert.equal(typeof row['subreddit'], 'string');
    assert.equal(typeof row['score'], 'number');
    assert.equal(typeof row['num_comments'], 'number');
    assert.equal(typeof row['created_utc'], 'number', 'a receipt without a date cannot be dated to a reader');
  }
});

/*
 * Reddit comments DO carry a score, unlike Hacker News comments. That asymmetry
 * is exactly the kind of thing worth asserting rather than assuming, since the
 * two adapters look similar and the difference is invisible in the code.
 */
test('captured comment rows carry a real score, unlike Hacker News', () => {
  assert.ok(COMMENTS.data.length > 0);
  for (const row of COMMENTS.data) {
    assert.equal(typeof row['body'], 'string');
    assert.equal(typeof row['score'], 'number', 'reddit comments are scored, HN comments are not');
    assert.ok('author' in row);
  }
});

test('the relevance gate keeps real subreddits from a real prefix search', () => {
  const candidates = SUBREDDITS.data
    .filter((s) => (s['subscribers'] as number) >= 5000 && s['over18'] !== true)
    .map((s) => ({
      name: String(s['display_name']),
      subscribers: Number(s['subscribers']),
      description: String(s['public_description'] ?? ''),
    }));

  const { kept } = filterRelevant(candidates, ['running shoes']);
  assert.ok(kept.length > 0, 'a real prefix search must survive the gate, or no report is possible');
  assert.ok(kept.some((k) => k.name.toLowerCase().includes('running')));
});

test('the adapter parses real captured responses end to end', async () => {
  const client: ArcticShiftClient = {
    async get<T>(path: string): Promise<T[]> {
      if (path === 'subreddits/search') return SUBREDDITS.data as T[];
      if (path === 'posts/search') return POSTS.data as T[];
      return COMMENTS.data as T[];
    },
    throttleState: () => ({ gapMs: 220, throttled: false }),
  };

  const source = createArcticShiftSource({ client });
  const queries = await source.plan({
    category: 'running shoes', productTitle: 'Trail X', productUrl: 'https://example.com',
    terms: ['sizing'], subredditTerms: ['running'],
  });
  assert.ok(queries.length > 0, 'real data must produce real work');

  const out = [];
  for await (const r of source.retrieve(queries[0]!, makeCtx())) out.push(r);
  assert.ok(out.length > 0, 'and real work must produce real records');

  for (const r of out) {
    assert.equal(r.source, 'reddit');
    assert.ok(r.externalId.length > 0);
    assert.ok(r.text.length > 0);
    assert.match(r.url ?? '', /^https:\/\/reddit\.com\/r\//);
    assert.ok((r.createdUtc ?? 0) > 0);
  }
});

/*
 * Automod is usually the first and pinned comment on a thread, so a ranked
 * sample gets it every time. This asserts against whatever the live capture
 * actually contained rather than against an idea of what it might contain.
 */
test('any automod boilerplate in the real capture is filtered', () => {
  const bodies = COMMENTS.data.map((c) => String(c['body']));
  const bot = bodies.filter((b) => /welcome to r\/|i am a bot|automatically/i.test(b));
  for (const b of bot) {
    assert.equal(isUsableComment(b), false, `real automod text got through: ${b.slice(0, 60)}`);
  }
});
