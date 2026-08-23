/*
 * Theme discovery.
 *
 * Every fixture here is shaped like the real failure it stands for, because
 * each one was found by running this against a 1,181 record corpus rather than
 * by imagining what could go wrong. The automoderator case is the important
 * one: it is what the first working version returned, in its entirety.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { receiptId, type Doc } from '@receipts/corpus';
import { discoverThemes, notableThemes, words } from './themes.ts';

let counter = 0;
function doc(text: string, channel = 'r/running'): Doc {
  const externalId = `t${counter++}`;
  return {
    receiptId: receiptId('reddit', externalId),
    source: 'reddit',
    kind: 'comment',
    externalId,
    category: 'running shoes',
    channel,
    text,
    score: 1,
    url: `https://reddit.test/${externalId}`,
    createdUtc: 1_700_000_000,
    harvestedAt: 1_700_000_000,
  };
}

/* One phrase, spread across `channels` different places. */
const spread = (text: string, channels: number): Doc[] =>
  Array.from({ length: channels }, (_, i) => doc(text, `r/place${i}`));

/* ------------------------------------------------------------------ */
/* the measurement that made it work                                   */
/* ------------------------------------------------------------------ */

test('AUTOMOD BOILERPLATE CANNOT BECOME A THEME, HOWEVER OFTEN IT REPEATS', () => {
  /*
   * The first working version returned exactly this and nothing else: "rules
   * app", "bot message", "wiki faq", "readtherulesapp comments". One
   * subreddit's automoderator, twenty five times, ranked above every real
   * phrase in the corpus. All of it sat in ONE channel.
   */
  const records = [
    ...Array.from({ length: 25 }, () => doc('please read the wiki faq before posting, this bot message is automated')),
    ...spread('the toe box is narrow on these', 3),
  ];

  const themes = discoverThemes(records, { exclude: [] });
  const phrases = themes.map((t) => t.phrase);
  for (const boilerplate of ['wiki faq', 'bot message', 'read the', 'please read']) {
    assert.equal(phrases.includes(boilerplate), false, `${boilerplate} became a theme`);
  }
  assert.equal(themes[0]?.phrase, 'toe box', 'and the real phrase leads');
  assert.equal(themes[0]?.channels, 3);
  /* And no phrase nobody wrote: `is` sits between `box` and `narrow`. */
  assert.equal(phrases.includes('box narrow'), false);
});

test('spread beats volume, which is what corroboration has always believed', () => {
  const records = [
    ...Array.from({ length: 40 }, () => doc('carbon plate carbon plate', 'r/oneplace')),
    ...spread('arch support matters', 4),
  ];
  const themes = discoverThemes(records, { exclude: [] });
  assert.equal(themes[0]?.phrase, 'arch support', 'four channels beats forty records in one');
});

test('A PHRASE OUTRANKS ANY SINGLE WORD, BECAUSE THEY ARE NOT COMPARABLE', () => {
  /*
   * Measured 2026-08-22: ranked together by channel spread, every single word
   * won, because a common word appears in more channels than any specific
   * phrase containing it BY CONSTRUCTION. The first real run returned "pair",
   * "high" and "theyre" as the themes of a running shoe corpus while "toe box"
   * ranked below them. No stop list fixes that.
   */
  const records = [
    ...spread('cushioning', 9),
    ...spread('the toe box is narrow', 3),
  ];
  const themes = discoverThemes(records, { exclude: [] });
  assert.equal(themes[0]?.phrase, 'toe box', 'three channels of a phrase beats nine of a word');
  assert.equal(themes[1]?.phrase, 'cushioning', 'and the word is still reported, below it');
});

/* ------------------------------------------------------------------ */
/* the defect it exists to fix                                         */
/* ------------------------------------------------------------------ */

test('THE CORPUS CAN ANSWER A QUESTION NOBODY ASKED', () => {
  /*
   * The knee brace case. Twelve real FDA reports about a sterile barrier, a
   * caller who typed "defects", and a report that said "no evidence" to every
   * question while holding the strongest evidence it had.
   */
  const records = spread('the sterile barrier was compromised during shipping', 4);
  const themes = discoverThemes(records, { exclude: ['defects', 'quality', 'price'] });
  assert.ok(themes.some((t) => t.phrase === 'sterile barrier'), themes.map((t) => t.phrase).join(', '));
});

test('a term the caller already asked about is not offered back to them', () => {
  const records = [...spread('the sizing runs small here', 4), ...spread('the toe box is narrow', 4)];
  const asked = discoverThemes(records, { exclude: ['sizing'] });
  assert.equal(asked.some((t) => t.phrase.includes('sizing')), false);
  assert.ok(asked.some((t) => t.phrase === 'toe box'), 'and the rest still comes through');
});

test('exclusion tolerates plurals and gerunds, because a caller types one of them', () => {
  const records = spread('the sizing is strange', 4);
  for (const term of ['sizing', 'size', 'sizes', 'sized']) {
    const themes = discoverThemes(records, { exclude: [term] });
    assert.equal(themes.some((t) => t.phrase.includes('siz')), false, `${term} did not exclude`);
  }
});

test('the subject own words are not a discovery about the subject', () => {
  const records = spread('these running shoes are fine', 4);
  const themes = discoverThemes(records, { exclude: ['running shoes'] });
  assert.equal(themes.some((t) => t.phrase.includes('running')), false);
});

/* ------------------------------------------------------------------ */
/* counting                                                            */
/* ------------------------------------------------------------------ */

test('one person repeating a phrase is one voice, not a crowd', () => {
  const records = [
    doc('toe box toe box toe box toe box toe box', 'r/a'),
    doc('the toe box again', 'r/b'),
    doc('toe box', 'r/c'),
  ];
  const themes = discoverThemes(records, { exclude: [] });
  assert.equal(themes[0]?.records, 3, 'three records, not the eight mentions in them');
});

test('EVERY THEME CARRIES ITS RECEIPTS, BECAUSE A WORD COUNTER IS STILL MAKING A CLAIM', () => {
  const records = spread('the toe box is narrow', 4);
  const [theme] = discoverThemes(records, { exclude: [] });

  assert.equal(theme?.receiptIds.length, 4);
  assert.deepEqual([...theme!.receiptIds].sort(), records.map((r) => r.receiptId).sort());
  /* Gated by the same rule as everything else, so there is exactly one
   * definition of "enough" in this codebase. */
  assert.equal(theme?.corroboration.verdict, 'finding');
  assert.deepEqual([...theme!.corroboration.receiptIds].sort(), [...theme!.receiptIds].sort());
});

test('one spelling per theme, merged on the stem and counted over the union', () => {
  const records = [
    ...spread('the long runs hurt', 3),
    ...spread('a long run hurts', 4),
  ];
  const themes = discoverThemes(records, { exclude: [], minChannels: 2 });
  const runs = themes.filter((t) => t.phrase.startsWith('long run'));
  assert.equal(runs.length, 1, 'one entry, not two spellings of one theme');
  assert.equal(runs[0]?.records, 7, 'counted over the union, never added');
});

test('a merged theme never double counts a record carrying both spellings', () => {
  const records = [
    doc('a long run and some long runs', 'r/a'),
    doc('long run', 'r/b'),
    doc('long runs', 'r/c'),
  ];
  const themes = discoverThemes(records, { exclude: [], minChannels: 2, minRecords: 2 });
  const merged = themes.find((t) => t.phrase.startsWith('long run'));
  assert.equal(merged?.records, 3, 'three records, and the first is one voice');
});

/* ------------------------------------------------------------------ */
/* the thresholds                                                      */
/* ------------------------------------------------------------------ */

test('one channel is never enough, however many records back it', () => {
  const records = Array.from({ length: 50 }, () => doc('the toe box is narrow', 'r/onlyplace'));
  assert.deepEqual(discoverThemes(records, { exclude: [] }), []);
});

test('below the corroboration threshold nothing is offered', () => {
  const records = spread('the toe box is narrow', 2);
  assert.deepEqual(discoverThemes(records, { exclude: [] }), []);
  assert.equal(discoverThemes(records, { exclude: [], minRecords: 2 }).length > 0, true);
});

test('the result is bounded, because a list of forty themes is not a finding', () => {
  const records = Array.from({ length: 30 }, (_, i) =>
    spread(`topic${i} matter${i} discussion`, 3)).flat();
  assert.equal(discoverThemes(records, { exclude: [] }).length, 8);
  assert.equal(discoverThemes(records, { exclude: [], limit: 3 }).length, 3);
});

test('an empty corpus discovers nothing rather than throwing', () => {
  assert.deepEqual(discoverThemes([], { exclude: [] }), []);
  assert.deepEqual(notableThemes([]), []);
});

/* ------------------------------------------------------------------ */
/* tokenising                                                          */
/* ------------------------------------------------------------------ */

test('a contraction stays one word, which is a fix for output we shipped', () => {
  /* Splitting on the apostrophe turned "don't" into "don" plus a dropped
   * letter, so a real corpus offered "don run" and "don mind" as themes. */
  assert.deepEqual(words("don't run"), ['dont', 'run']);
  assert.deepEqual(words('it’s the toe box'), ['its', 'the', 'toe', 'box']);
  const records = spread("don't run in these", 4);
  assert.equal(discoverThemes(records, { exclude: [] }).some((t) => t.phrase.startsWith('don ')), false);
});

test('a url contributes no themes, because its query string is not a market', () => {
  /* "utm source", "utm medium" and "wiki faq" all outranked real phrases. */
  assert.deepEqual(words('see https://reddit.com/r/x/wiki/faq?utm_source=share now'), ['see', 'now']);
  const records = spread('https://reddit.com/r/running/wiki/faq?utm_source=reddit&utm_medium=usertext', 5);
  assert.deepEqual(discoverThemes(records, { exclude: [] }), []);
});

test('bare numbers are not themes', () => {
  assert.deepEqual(words('i ran 100 miles in 2026'), ['ran', 'miles']);
});

test('only corroborated themes are notable, using the shared gate', () => {
  const records = [...spread('the toe box', 4), ...spread('a carbon plate', 2)];
  const themes = discoverThemes(records, { exclude: [], minRecords: 2, minChannels: 2, limit: 100 });
  const phrases = themes.filter((t) => t.phrase.includes(' '));
  assert.deepEqual(phrases.map((t) => t.phrase), ['toe box', 'carbon plate']);
  /* Two records is real evidence and not a market pattern, so it is reported
   * and never promoted. The shared gate decides, not this module. */
  assert.deepEqual(notableThemes(phrases).map((t) => t.phrase), ['toe box']);
});

test('ONE IDEA IS ONE ENTRY, NOT THE PHRASE PLUS EACH OF ITS WORDS', () => {
  /*
   * A live diff announced "new topics: toe box, box, toe" after this rule was
   * lost in a refactor. Ranking phrases above words hides the problem when
   * there are plenty of phrases and exposes it the moment there are few.
   */
  const records = spread('the toe box is narrow', 3);
  const phrases = discoverThemes(records, { exclude: [] }).map((t) => t.phrase);

  assert.ok(phrases.includes('toe box'));
  assert.equal(phrases.includes('toe'), false, 'a fragment of the phrase above it');
  assert.equal(phrases.includes('box'), false, 'likewise');
  /* `narrow` stays, and that is correct: `is` separates it from `box`, so no
   * phrase carries it and it is a topic in its own right rather than a piece
   * of one. */
  assert.ok(phrases.includes('narrow'));
});

test('a word wider than any phrase carrying it survives on its own', () => {
  /* `cushioning` appears in more places than "carbon plate" does, so it is not
   * a fragment of it and dropping it would lose a real topic. */
  const records = [...spread('cushioning', 6), ...spread('a carbon plate', 3)];
  const themes = discoverThemes(records, { exclude: [] });
  assert.deepEqual(themes.map((t) => t.phrase), ['carbon plate', 'cushioning']);
});
