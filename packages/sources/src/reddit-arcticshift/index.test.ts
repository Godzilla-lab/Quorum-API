import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runSourceConformance, makeCtx } from '../conformance.ts';
import { createArcticShiftSource, isBotBoilerplate, isUsableComment } from './index.ts';
import { permalink } from './client.ts';
import type { ArcticShiftClient } from './client.ts';

/*
 * A recording fake. Arctic Shift retrieval is three stages, and the assertions
 * that matter are about which calls are made and with what, so the fake records
 * every request.
 */
function fakeClient(responses: Record<string, unknown[]> = {}) {
  const calls: { path: string; params: Record<string, string | number> }[] = [];
  const client: ArcticShiftClient = {
    async get<T>(path: string, params: Record<string, string | number>): Promise<T[]> {
      calls.push({ path, params });
      return (responses[path] ?? []) as T[];
    },
    throttleState: () => ({ gapMs: 220, throttled: false }),
  };
  return { client, calls };
}

const subreddit = (display_name: string, subscribers: number, public_description: string, over18 = false) =>
  ({ display_name, subscribers, public_description, over18 });

const post = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: 'These shoes run small, size up', selftext: '', score: 120,
  num_comments: 40, subreddit: 'running', created_utc: 1_700_000_000, ...over,
});

const DEFAULT = {
  'subreddits/search': [subreddit('running', 3_000_000, 'A community for runners and running shoes')],
  'posts/search': [post('abc123')],
  'comments/search': [
    { body: 'I went half a size up and they fit perfectly now, wish the site said so', score: 45, author: 'a' },
    { body: 'Same experience, the toe box is narrow and it took two returns to work out', score: 22, author: 'b' },
  ],
};

runSourceConformance('reddit-arcticshift', () => ({
  source: createArcticShiftSource({ client: fakeClient(DEFAULT).client }),
  configuredEnv: {},
  planInput: { category: 'running shoes', productTitle: 'Trail X', productUrl: 'https://example.com', terms: ['sizing', 'comfort'] },
}));

test('a public archive needs no key', () => {
  const s = createArcticShiftSource({ client: fakeClient().client });
  assert.equal(s.configured({}), true);
  assert.equal(s.cost, 'free');
});

test('planning produces the cross product of subreddits and single concept terms', async () => {
  const f = fakeClient({
    'subreddits/search': [
      subreddit('running', 3_000_000, 'running and running shoes'),
      subreddit('trailrunning', 400_000, 'trail running shoes and gear'),
    ],
  });
  const s = createArcticShiftSource({ client: f.client });

  const queries = await s.plan({
    category: 'running shoes', productTitle: 'X', productUrl: 'https://x.com',
    terms: ['sizing', 'durability'],
  });

  assert.equal(queries.length, 4, 'two subreddits times two terms');
  assert.deepEqual(new Set(queries.map((q) => q.scope)), new Set(['running', 'trailrunning']));
  assert.deepEqual(new Set(queries.map((q) => q.text)), new Set(['sizing', 'durability']));
});

/*
 * The gate runs BEFORE anything is harvested. Every run writes to the corpus,
 * so one bad subreddit poisons a category's memory permanently. Measured: a
 * "men shoes" probe returned r/mentalhealth, which contributed French language
 * domestic violence threads to a footwear report.
 */
test('an off topic subreddit is dropped before anything is harvested from it', async () => {
  const f = fakeClient({
    'subreddits/search': [
      subreddit('running', 3_000_000, 'running and running shoes'),
      subreddit('mentalhealth', 2_000_000, 'Support for anxiety, depression and wellbeing'),
    ],
  });
  const s = createArcticShiftSource({ client: f.client });

  const queries = await s.plan({
    category: 'running shoes', productTitle: 'X', productUrl: 'https://x.com', terms: ['sizing'],
  });

  assert.deepEqual(queries.map((q) => q.scope), ['running']);
  assert.equal(queries.some((q) => q.scope === 'mentalhealth'), false);
});

test('tiny and adult subreddits never become candidates', async () => {
  const f = fakeClient({
    'subreddits/search': [
      subreddit('running', 3_000_000, 'running shoes'),
      subreddit('runningtiny', 40, 'running shoes'),
      subreddit('runningnsfw', 900_000, 'running shoes', true),
    ],
  });
  const s = createArcticShiftSource({ client: f.client });
  const queries = await s.plan({
    category: 'running shoes', productTitle: 'X', productUrl: 'https://x.com', terms: ['sizing'],
  });
  assert.deepEqual(queries.map((q) => q.scope), ['running'], 'too quiet to be a signal, or not a market');
});

test('the archive refuses an unscoped query, so one is never sent', async () => {
  const f = fakeClient(DEFAULT);
  const s = createArcticShiftSource({ client: f.client });
  const logs: string[] = [];

  const out = [];
  for await (const r of s.retrieve({ text: 'sizing' }, makeCtx({ log: (m) => logs.push(m) }))) out.push(r);

  assert.deepEqual(out, []);
  assert.equal(f.calls.length, 0, 'not worth a round trip to rediscover a known refusal');
  assert.equal(logs.length, 1);
});

test('retrieval yields the post title and its comments', async () => {
  const f = fakeClient(DEFAULT);
  const s = createArcticShiftSource({ client: f.client });

  const out = [];
  for await (const r of s.retrieve({ text: 'sizing', scope: 'running' }, makeCtx())) out.push(r);

  assert.equal(out.length, 3, 'one post plus two comments');
  assert.equal(out[0]?.kind, 'post');
  assert.equal(out[0]?.text, 'These shoes run small, size up');
  assert.equal(out[1]?.kind, 'comment');
  for (const r of out) {
    assert.equal(r.source, 'reddit');
    assert.equal(r.origin, 'r/running');
    assert.equal(r.url, 'https://reddit.com/r/running/comments/abc123/');
  }
});

/*
 * link_id needs the t3_ prefix. Without it the archive returns nothing and
 * reports no error, so the failure is a silent empty rather than something that
 * shows up in a log.
 */
test('comments are pulled by link_id with the t3_ prefix', async () => {
  const f = fakeClient(DEFAULT);
  const s = createArcticShiftSource({ client: f.client });
  for await (const _ of s.retrieve({ text: 'sizing', scope: 'running' }, makeCtx())) { /* drain */ }

  const commentCall = f.calls.find((c) => c.path === 'comments/search');
  assert.ok(commentCall);
  assert.equal(commentCall.params['link_id'], 't3_abc123', 'without t3_ the archive silently returns nothing');
});

test('a post nobody replied to has no voice of customer in it', async () => {
  const f = fakeClient({ ...DEFAULT, 'posts/search': [post('quiet', { num_comments: 1 })] });
  const s = createArcticShiftSource({ client: f.client });

  const out = [];
  for await (const r of s.retrieve({ text: 'sizing', scope: 'running' }, makeCtx())) out.push(r);

  assert.deepEqual(out, []);
  assert.equal(f.calls.some((c) => c.path === 'comments/search'), false, 'and its comments are never fetched');
});

test('automod boilerplate, removed comments and one liners are all dropped', async () => {
  const f = fakeClient({
    ...DEFAULT,
    'comments/search': [
      { body: '[removed]', score: 5 },
      { body: '[deleted]', score: 5 },
      { body: 'same', score: 30 },
      { body: 'I am a bot, and this action was performed automatically. Please contact the moderators', score: 1 },
      { body: 'Your post was automatically removed because your account is too new to post here', score: 1 },
      { body: 'The sizing really is off, I ordered my usual and had to send them back twice', score: 12 },
    ],
  });
  const s = createArcticShiftSource({ client: f.client });

  const comments = [];
  for await (const r of s.retrieve({ text: 'sizing', scope: 'running' }, makeCtx())) {
    if (r.kind === 'comment') comments.push(r);
  }
  assert.equal(comments.length, 1, 'only the one that actually says something');
});

test('the usable comment rule is explicit', () => {
  assert.equal(isUsableComment('same'), false);
  assert.equal(isUsableComment('[removed]'), false);
  assert.equal(isUsableComment('[deleted]'), false);
  assert.equal(isUsableComment('I am a bot and this was automatic'), false);
  assert.equal(isUsableComment('x'.repeat(39)), false, 'shorter than forty characters is a plus one');
  assert.equal(isUsableComment('x'.repeat(40)), true);
});

test('comment ids are stable within a thread so the corpus can deduplicate', async () => {
  const f = fakeClient(DEFAULT);
  const s = createArcticShiftSource({ client: f.client });

  const ids = [];
  for await (const r of s.retrieve({ text: 'sizing', scope: 'running' }, makeCtx())) {
    if (r.kind === 'comment') ids.push(r.externalId);
  }
  assert.deepEqual(ids, ['abc123_c0', 'abc123_c1']);
});

test('a recency window is passed as an after timestamp', async () => {
  const f = fakeClient(DEFAULT);
  const s = createArcticShiftSource({ client: f.client });
  for await (const _ of s.retrieve({ text: 'sizing', scope: 'running', withinDays: 30 }, makeCtx())) { /* drain */ }

  const postCall = f.calls.find((c) => c.path === 'posts/search');
  assert.ok(postCall);
  const after = Number(postCall.params['after']);
  const expected = Math.floor(Date.now() / 1000) - 30 * 86400;
  assert.ok(Math.abs(after - expected) < 5);
});

test('an archive that returns nothing degrades the run rather than failing it', async () => {
  const s = createArcticShiftSource({ client: fakeClient({}).client });
  const out = [];
  for await (const r of s.retrieve({ text: 'sizing', scope: 'running' }, makeCtx())) out.push(r);
  assert.deepEqual(out, []);
});

test('permalinks are constructed, because the archive does not return them', () => {
  assert.equal(permalink('running', 'abc123'), 'https://reddit.com/r/running/comments/abc123/');
});

test('a citation names the subreddit and the score', () => {
  const s = createArcticShiftSource({ client: fakeClient().client });
  const c = s.cite({
    source: 'reddit', kind: 'comment', externalId: 'x', text: 'runs small',
    channel: 'running', origin: 'r/running', score: 45,
    url: 'https://reddit.com/r/running/comments/abc123/', createdUtc: 1_700_000_000,
  });
  assert.equal(c.label, 'r/running, 45 points');
  assert.equal(c.score, 45);
});

/*
 * REGRESSION, measured live 2026-08-22. The first comment the archive returned
 * on a real thread was an automod welcome message, which the original three
 * boilerplate patterns did not catch. Automod posts first and is usually pinned,
 * so a ranked sample gets it every single time: one bot post per thread going
 * into the corpus and then into a prompt as though a customer had said it.
 */
test('automod welcome and rules boilerplate is filtered', () => {
  const live = 'Welcome to r/Running! We have set up a ["New to the sub"](https://www.reddit.com/r/running/comments/) wiki page with everything you need';
  assert.equal(isUsableComment(live), false, 'this is the exact comment the live probe returned first');

  for (const b of [
    'Welcome to r/skincareaddiction! Please read the rules before posting anything at all here',
    'Your post was removed because it did not meet the community guidelines for this subreddit',
    'Please read the wiki before asking a question that has been answered many times already',
    'This action was performed automatically. Please contact the moderators of this subreddit',
  ]) {
    assert.equal(isUsableComment(b), false, `boilerplate not caught: ${b.slice(0, 40)}`);
  }
});

test('a real customer comment that merely mentions rules is not filtered', () => {
  assert.equal(
    isUsableComment('The sizing rules on their site are wrong, I read them twice and still ordered the wrong size'),
    true,
    'filtering must not eat genuine complaints that happen to use the word rules',
  );
  assert.equal(
    isUsableComment('I welcome the redesign but the toe box is still far too narrow for wide feet'),
    true,
    'anchored patterns must not match mid sentence',
  );
});

/*
 * REGRESSION, found by a live end to end run 2026-08-22.
 *
 * Discovery is a NAME prefix search. An earlier version fed it the question
 * terms, so a product with terms ["sizing"] searched for a community literally
 * called "sizing", found none, and planned ZERO queries. Nothing threw and
 * nothing logged: the source just silently produced no work.
 */
test('subreddit discovery searches for community names, not question concepts', async () => {
  const f = fakeClient({ 'subreddits/search': [subreddit('running', 3_000_000, 'runners')] });
  const s = createArcticShiftSource({ client: f.client });

  await s.plan({
    category: 'running shoes', productTitle: 'X', productUrl: 'https://x.com',
    terms: ['sizing', 'durability'],
  });

  const prefixes = f.calls.filter((c) => c.path === 'subreddits/search').map((c) => c.params['subreddit_prefix']);
  assert.deepEqual(prefixes.sort(), ['running', 'shoes'], 'the category words, not "sizing"');
  assert.equal(prefixes.includes('sizing'), false, 'no community is called sizing');
});

test('explicit subreddit name hints are used when supplied', async () => {
  const f = fakeClient({ 'subreddits/search': [subreddit('running', 3_000_000, 'runners')] });
  const s = createArcticShiftSource({ client: f.client });

  await s.plan({
    category: 'running shoes', productTitle: 'X', productUrl: 'https://x.com',
    terms: ['sizing'], subredditTerms: ['running', 'marathon'],
  });

  const prefixes = f.calls.filter((c) => c.path === 'subreddits/search').map((c) => c.params['subreddit_prefix']);
  assert.deepEqual(prefixes.sort(), ['marathon', 'running']);
});

test('the questions asked are still the terms, not the name hints', async () => {
  const f = fakeClient({ 'subreddits/search': [subreddit('running', 3_000_000, 'runners and running shoes')] });
  const s = createArcticShiftSource({ client: f.client });

  const queries = await s.plan({
    category: 'running shoes', productTitle: 'X', productUrl: 'https://x.com',
    terms: ['sizing', 'durability'], subredditTerms: ['running'],
  });

  assert.deepEqual(queries.map((q) => q.text).sort(), ['durability', 'sizing']);
  assert.deepEqual(new Set(queries.map((q) => q.scope)), new Set(['running']));
});

/*
 * The archive returns newest first and rejects min_num_comments and min_score
 * as unknown parameters, measured 2026-08-22, so the time window is the only
 * quality lever available. A post from this week has no discussion yet no
 * matter how good it is, and the discussion is the whole point.
 *
 * Measured on r/running for "shoes", 25 posts: 19 of 25 usable without the
 * settle cutoff, 23 of 25 with it.
 */
test('the freshest month is excluded so threads have time to accumulate discussion', async () => {
  const f = fakeClient(DEFAULT);
  const s = createArcticShiftSource({ client: f.client });
  for await (const _ of s.retrieve({ text: 'sizing', scope: 'running', withinDays: 540 }, makeCtx())) { /* drain */ }

  const call = f.calls.find((c) => c.path === 'posts/search');
  assert.ok(call);

  const now = Math.floor(Date.now() / 1000);
  const before = Number(call.params['before']);
  const after = Number(call.params['after']);

  assert.ok(Math.abs(before - (now - 30 * 86400)) < 5, 'a 30 day settle cutoff');
  assert.ok(Math.abs(after - (now - 540 * 86400)) < 5, 'and the usual recency floor');
  assert.ok(after < before, 'the window has to be the right way round');
});

test('the settle cutoff applies even when no recency window is asked for', async () => {
  const f = fakeClient(DEFAULT);
  const s = createArcticShiftSource({ client: f.client });
  for await (const _ of s.retrieve({ text: 'sizing', scope: 'running' }, makeCtx())) { /* drain */ }

  const call = f.calls.find((c) => c.path === 'posts/search');
  assert.ok(call);
  assert.ok(call.params['before'], 'unsettled posts are useless regardless of how far back we look');
  assert.equal(call.params['after'], undefined);
});

/*
 * Regression, 2026-08-22. The gate used to fall open when it rejected
 * everything, harvesting the very candidates it had just refused.
 */
test('a gate that rejects every community harvests none of them', async () => {
  const source = createArcticShiftSource({
    client: {
      get: (async (path: string) => {
        if (path.includes('subreddits')) {
          return [
            { display_name: 'woolworths', subscribers: 200_000, public_description: 'Australian supermarket' },
            { display_name: 'Wooloo', subscribers: 40_000, public_description: 'A community for the cute sheep' },
          ];
        }
        return [];
      }) as ArcticShiftClient['get'],
      throttleState: () => ({ gapMs: 220, throttled: false }),
    },
  });

  const queries = await source.plan({
    category: 'wool runner', productTitle: 'wool runner', productUrl: '',
    terms: ['sizing'], subredditTerms: ['wool'],
  });
  assert.deepEqual(queries, [], 'no community is about this, and that is a real answer');
});

/*
 * The circularity. `terms` are the words used to FIND these communities, so
 * scoring candidates against them passes whatever the search returned.
 */
test('communities are gated on the subject, never on the terms that found them', async () => {
  const source = createArcticShiftSource({
    client: {
      get: (async (path: string) => {
        if (path.includes('subreddits')) {
          return [{ display_name: 'runninglifestyle', subscribers: 90_000, public_description: 'Running and lifestyle chat' }];
        }
        return [];
      }) as ArcticShiftClient['get'],
      throttleState: () => ({ gapMs: 220, throttled: false }),
    },
  });

  /* A model hinted "running shoes" for a subject that is a wool shoe. */
  const queries = await source.plan({
    category: 'wool runner', productTitle: 'wool runner', productUrl: '',
    terms: ['sizing'], subredditTerms: ['running', 'shoes'],
  });
  assert.deepEqual(queries, [],
    'the hint may widen the search and must never widen what counts as on topic');
});

/*
 * THE MODERATOR REMOVAL NOTICE, WHICH SLIPPED PAST FOR AS LONG AS THIS FILTER
 * HAS EXISTED.
 *
 * The pattern for "your post was removed" was here from the start and caught
 * nothing, because the real message puts a markdown link between the two words
 * it needed adjacent. MEASURED 2026-08-22 on a corpus harvested before the fix:
 * 27 of these were sitting in a 1,181 record category, counted as voices, loud
 * enough to become the entire discovered topic list.
 *
 * The text below is copied from real records, usernames and all.
 */
const REAL_REMOVAL_NOTICES = [
  'Dear Kaedamanoods, Your [post](/r/RunningShoeGeeks/comments/1u0u50y/spotted_a_red_hare/) on r/RunningShoeGeeks was removed by the Read The Rules app because it did not follow the community rules. Click here to refresh yourself on the rules.',
  'Dear plumpyplummy, Your [post](/r/running/comments/1mhlot1/can_someone_tell_me/) on r/running was removed by the Read The Rules app. Use the main menu to check the guidance.',
  'Dear SuperbBody, Your [post](/r/running/comments/1m9w5na/running_with_bad_air/) on r/running was removed by the Read The Rules app because of rule 3.',
];

test('a removal notice with a markdown link in it is not a voice', () => {
  for (const body of REAL_REMOVAL_NOTICES) {
    assert.equal(isUsableComment(body), false, `got through: ${body.slice(0, 70)}`);
    assert.equal(isBotBoilerplate(body), true);
  }
});

test('flattening the link is what does it, and the old pattern proves it', () => {
  /* Without flattening, "Your" and "post" are not adjacent, which is exactly
   * why this shipped broken. The assertion is on the mechanism, so a future
   * refactor that drops the flattening fails here rather than in production. */
  const withLink = REAL_REMOVAL_NOTICES[0]!;
  const withoutLink = withLink.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  assert.notEqual(withLink, withoutLink, 'the fixture must actually contain a link');
  assert.equal(isBotBoilerplate(withoutLink), true);
  assert.equal(isBotBoilerplate(withLink), true, 'and the link must not change the answer');
});

test('a person writing about a removed post is still a voice', () => {
  /* The filter must not eat a real complaint that happens to use the words.
   * "My post got removed" is somebody talking about moderation, which is a
   * genuine thing people discuss when a product community is strict. */
  assert.equal(isUsableComment('I bought these last month and the toe box is far too narrow for my feet'), true);
  assert.equal(
    isUsableComment('These shoes are great but the sizing chart on their site is completely wrong'),
    true,
  );
});
