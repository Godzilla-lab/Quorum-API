import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filterRelevant, relevanceScore } from './relevance.ts';

const sub = (name: string, description: string, subscribers = 100_000) =>
  ({ name, subscribers, description });

/*
 * THE REGRESSION THIS GATE EXISTS FOR.
 *
 * A ratio based gate dropped r/Fitness and r/bodybuilding, because a large
 * general community has a long description and one strong match is a small
 * fraction of it. Those are exactly the subreddits worth keeping.
 */
test('large general subreddits survive, which a ratio gate would drop', () => {
  const terms = ['protein powder', 'supplements', 'muscle gain'];
  const candidates = [
    sub('Fitness', 'Discussion of physical fitness goals, exercise, nutrition, protein, cardio, injury, gym etiquette, programs, form checks and everything else related to being in shape', 12_000_000),
    sub('bodybuilding', 'A community for bodybuilders, powerlifters, and anyone interested in building muscle, training splits, nutrition, protein intake, cutting and bulking', 3_000_000),
  ];

  const { kept, dropped } = filterRelevant(candidates, terms);
  assert.equal(dropped.length, 0, 'neither may be dropped');
  assert.equal(kept.length, 2);

  /* Both score low as a FRACTION, which is precisely why the fraction is not
   * the gate. */
  for (const k of kept) {
    assert.ok(k.relevance < 0.6, 'their ratio is low, and it must not matter');
    assert.ok(k.hits >= 1, 'what matters is that they matched at all');
  }
});

/* A genuinely unrelated community is dropped, and one bad subreddit poisons a
 * category's memory permanently, so this is the gate earning its keep. */
test('a subreddit with no topical overlap at all is dropped', () => {
  const { kept, dropped } = filterRelevant(
    [sub('woodworking', 'Hand tools, joinery, finishing and shop builds')],
    ['running shoes', 'sneakers'],
  );
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
});

/*
 * THIS BEHAVIOUR WAS DELIBERATELY REVERSED ON 2026-08-22, AND THE OLD REASONING
 * IS KEPT HERE BECAUSE IT WAS SINCERE AND WRONG.
 *
 * This test used to assert the opposite: that r/Shoestring being kept was fine,
 * because "excluding false friends is the pick step's job" and "tightening it
 * to whole word matching would drop r/shoe and r/shoemaking too".
 *
 * Then a live run on "wool runner" harvested 73 comments about facemasks and
 * Big W returns from r/woolworths, because "wool" is a prefix of "woolworths".
 * A prefix hit on one word of a subject is not evidence that a community is
 * about that subject, and leaving it to a later step meant the corpus was
 * already poisoned by the time anything noticed.
 *
 * The replacement rule is not plain whole word matching, which is what the old
 * comment feared. A community is kept when its NAME carries the subject as a
 * squashed handle, or when any term matched as a real word, or when two terms
 * matched at all. That keeps r/runningshoegeeks and r/running, and drops
 * r/woolworths, r/Wooloo, r/Runner5 and r/Shoestring.
 */
test('a name prefix false friend is now dropped by this gate', () => {
  const { kept, dropped } = filterRelevant(
    [sub('Shoestring', 'Budget travel on a shoestring, cheap flights and hostels')],
    ['running shoes'],
  );
  assert.equal(kept.length, 0, 'shoestring carries no subject word as a real word');
  assert.equal(dropped.length, 1);
});

test('a single matching word is enough, because the gate counts rather than divides', () => {
  const { kept } = filterRelevant([sub('running', 'A community for runners')], ['running shoes']);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.hits, 1);
  assert.equal(kept[0]?.relevance, 0.5, 'half the terms matched, and it is kept anyway');
});

/*
 * The length floor is what makes prefix matching safe. "men" is never a term,
 * so it can never match "mental" or "mention".
 */
test('words of three characters or fewer never become terms', () => {
  /* The haystack contains "mental" and "shirts". If "men" were a term it would
   * match "mental" and inflate the score on a completely unrelated community. */
  const scored = relevanceScore(sub('mentalhealth', 'mental health support, and shirts'), ["men's shirts"]);
  assert.deepEqual(scored.matched, ['shirts'], '"men" must never match "mental"');
  assert.equal(scored.hits, 1);
});

test('a term matches as a prefix of a longer word', () => {
  assert.deepEqual(relevanceScore(sub('shoemaking', 'cobblers'), ['shoe']).matched, ['shoe']);
  assert.deepEqual(relevanceScore(sub('runners', 'people who run'), ['runner']).matched, ['runner']);
});

test('a term cannot match in the middle of an unrelated word', () => {
  assert.equal(relevanceScore(sub('subreddit', 'a place'), ['reddit']).hits, 0, 'no word boundary before "reddit"');
});

test('kept subreddits are ordered by overlap, then by size', () => {
  const { kept } = filterRelevant([
    sub('smalltrail', 'trail running shoes reviews', 5_000),
    sub('running', 'running community', 3_000_000),
    sub('bigtrail', 'trail running shoes and gear', 900_000),
  ], ['trail running shoes']);

  assert.equal(kept[0]?.name, 'bigtrail', 'best overlap first, larger community breaks the tie');
  assert.equal(kept[1]?.name, 'smalltrail');
  assert.equal(kept[2]?.name, 'running');
});



test('a term matches a subreddit that uses only one of its words', () => {
  const scored = relevanceScore(sub('running', 'runners'), ['running shoes']);
  assert.deepEqual(scored.matched, ['running']);
});

test('the same word matching twice counts once', () => {
  const scored = relevanceScore(sub('running', 'running running running'), ['running']);
  assert.equal(scored.hits, 1, 'a repeated word is not extra evidence');
});

test('a duplicated term across two category phrases counts once', () => {
  const scored = relevanceScore(sub('running', 'runners'), ['running shoes', 'running gear']);
  assert.equal(scored.matched.filter((m) => m === 'running').length, 1);
});

test('nothing to match against yields nothing kept and does not divide by zero', () => {
  const { kept, dropped } = filterRelevant([sub('running', 'runners')], []);
  assert.equal(kept.length, 0);
  assert.equal(dropped[0]?.relevance, 0);
});

test('an empty candidate list is not an error', () => {
  const { kept, dropped } = filterRelevant([], ['running shoes']);
  assert.deepEqual(kept, []);
  assert.deepEqual(dropped, []);
});

/*
 * Regression, measured live 2026-08-22 on the subject "wool runner". Prefix
 * matching kept r/woolworths, an Australian supermarket, and 73 comments about
 * facemasks and Big W returns went into the corpus under "wool runner".
 */
test('a community carrying only a prefix of one subject word is not harvested', () => {
  const candidates = [
    { name: 'woolworths', subscribers: 200_000, description: 'Woolworths? The place with insanely high prices' },
    { name: 'Wooloo', subscribers: 40_000, description: 'A community dedicated to the very cute sheep' },
    { name: 'RunnersInChicago', subscribers: 20_000, description: 'A forum for runners of any level in Chicago' },
    { name: 'RunnerHub', subscribers: 30_000, description: 'An online living world roleplaying game' },
  ];
  const { kept, dropped } = filterRelevant(candidates, ['wool runner']);
  assert.deepEqual(kept.map((k) => k.name), [], 'every one of these is a false friend');
  assert.equal(dropped.length, 4);
});

test('a community that names the subject as a real word is kept', () => {
  const { kept } = filterRelevant(
    [{ name: 'Wool', subscribers: 10_000, description: 'A sub-reddit discussing all aspects of wool' }],
    ['wool runner'],
  );
  assert.deepEqual(kept.map((k) => k.name), ['Wool']);
});

test('two prefix hits are enough, since carrying the whole subject is the point', () => {
  const { kept } = filterRelevant(
    [{ name: 'runningshoegeeks', subscribers: 50_000, description: 'Shoe nerds' }],
    ['running shoes'],
  );
  assert.deepEqual(kept.map((k) => k.name), ['runningshoegeeks']);
});
