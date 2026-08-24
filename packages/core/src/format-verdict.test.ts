import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatVerdict, type VerdictAd } from './format-verdict.ts';

const ad = (over: Partial<VerdictAd> = {}): VerdictAd => ({
  creative: 'video', daysRunning: 120, durationConfidence: 'reported', ...over,
});
const many = (n: number, over: Partial<VerdictAd> = {}) => Array.from({ length: n }, () => ad(over));

test('below the minimum sample there is no verdict, and it says why', () => {
  const v = formatVerdict(many(9));
  assert.equal(v.verdict, null, 'a number derived from nine ads is worse than no number');
  assert.equal(v.confidence, null);
  assert.match(v.reason, /not enough competitor evidence/);
  assert.match(v.reason, /need 20/);
});

test('enough typed ads but too few long runners is still no verdict', () => {
  const v = formatVerdict([...many(25, { daysRunning: 10 })]);
  assert.equal(v.verdict, null);
  assert.match(v.reason, /running past 60 days/);
});

/* The load bearing exclusion. An unreadable ad leaves the sample entirely. */
test('untyped ads are excluded from every ratio, never bucketed', () => {
  const ads = [...many(20, { creative: 'video' }), ...many(30, { creative: null })];
  const v = formatVerdict(ads);
  assert.equal(v.sample.ads, 50);
  assert.equal(v.sample.typed, 20);
  assert.equal(v.sample.untyped, 30);
  assert.equal(v.raw.total, 20, 'the ratio is computed over 20, not 50');
  assert.equal(v.raw.videoShare, 1);
});

/* A duration that was inferred is not evidence, so it leaves the duration cuts. */
test('undated ads count in the raw split but not in any duration cut', () => {
  const ads = [
    ...many(20, { creative: 'video', durationConfidence: 'none', daysRunning: null }),
    ...many(10, { creative: 'static', daysRunning: 120 }),
  ];
  const v = formatVerdict(ads);
  assert.equal(v.raw.total, 30, 'they are still typed');
  assert.equal(v.sample.dated, 10, 'but only the dated ones can support a duration claim');
  assert.equal(v.longRunners.video, 0);
});

/*
 * The whole point. The raw split says static, the winners say video, and the
 * verdict follows the winners because duration is the proof of what an
 * advertiser keeps paying for.
 */
test('the verdict follows the long runners, not the raw split', () => {
  const ads = [
    ...many(40, { creative: 'static', daysRunning: 3 }),   // lots of static, none of it sticking
    ...many(16, { creative: 'video', daysRunning: 150 }),  // fewer videos, all sustained
  ];
  const v = formatVerdict(ads);

  assert.ok((v.raw.videoShare ?? 0) < 0.35, 'raw says static');
  assert.equal(v.longRunners.videoShare, 1, 'the winners are all video');
  assert.equal(v.verdict, 'video');
});

test('a static category is called static', () => {
  const ads = [...many(30, { creative: 'static', daysRunning: 200 }), ...many(10, { creative: 'video', daysRunning: 2 })];
  const v = formatVerdict(ads);
  assert.equal(v.verdict, 'static');
});

/* The dead band is a real answer, not a failure to decide. */
test('an evenly split category returns both rather than forcing a call', () => {
  const ads = [...many(15, { creative: 'video', daysRunning: 120 }), ...many(15, { creative: 'static', daysRunning: 120 })];
  const v = formatVerdict(ads);
  assert.equal(v.verdict, 'both');
  assert.equal(v.longRunners.videoShare, 0.5);
});

test('the 90 day cohort is preferred, and 60 is the fallback when 90 is thin', () => {
  const deep = formatVerdict([...many(25, { daysRunning: 120 })]);
  assert.equal(deep.longRunners.cohortDays, 90);

  const shallow = formatVerdict([...many(25, { daysRunning: 70 })]);
  assert.equal(shallow.longRunners.cohortDays, 60, 'nothing reached 90, so read the 60 day cohort');
});

test('duration weighting counts a 200 day ad as 200 times a one day ad', () => {
  const ads = [...many(20, { creative: 'static', daysRunning: 1 }), ...many(10, { creative: 'video', daysRunning: 200 })];
  const v = formatVerdict(ads);
  assert.equal(v.durationWeighted.staticDays, 20);
  assert.equal(v.durationWeighted.videoDays, 2000);
  assert.equal(v.durationWeighted.videoShare, 2000 / 2020);
});

/*
 * One company's media buy is not a market pattern. Thirty long lived video
 * ads from a single advertiser used to print "video, strong".
 */
test('a single advertiser cohort caps at thin, however loud it is', () => {
  const v = formatVerdict([
    ...many(45, { creative: 'video', daysRunning: 150, advertiser: 'MegaCorp' }),
    ...many(5, { creative: 'static', daysRunning: 150, advertiser: 'MegaCorp' }),
  ]);
  assert.equal(v.verdict, 'video', 'the arithmetic is what it is');
  assert.equal(v.confidence, 'thin', 'but one company cannot state it strongly');
  assert.equal(v.sample.advertisers, 1);
});

test('breadth of advertisers restores the confidence the arithmetic earns', () => {
  const v = formatVerdict([
    ...many(15, { creative: 'video', daysRunning: 150, advertiser: 'Alpha' }),
    ...many(15, { creative: 'video', daysRunning: 150, advertiser: 'Beta' }),
    ...many(15, { creative: 'video', daysRunning: 150, advertiser: 'Gamma' }),
    ...many(5, { creative: 'static', daysRunning: 150, advertiser: 'Delta' }),
  ]);
  assert.equal(v.confidence, 'strong');
  assert.equal(v.sample.advertisers, 4);
});

/*
 * Observation span durations accrue only when WE re-run a category, on ads
 * the network keeps only while they run. A cohort mostly made of them partly
 * measures our own polling cadence, and that must not read as strong.
 */
test('a cohort of mostly self observed durations cannot be strong', () => {
  const v = formatVerdict([
    ...many(35, { creative: 'video', daysRunning: 150, durationConfidence: 'observed' }),
    ...many(10, { creative: 'video', daysRunning: 150, durationConfidence: 'reported' }),
    ...many(5, { creative: 'static', daysRunning: 150 }),
  ]);
  assert.equal(v.verdict, 'video');
  assert.notEqual(v.confidence, 'strong');
  assert.equal(v.sample.basis.observed, 35);
});

test('a mostly untypeable pool refuses a verdict and says why', () => {
  const v = formatVerdict([
    ...many(30, { creative: 'video', daysRunning: 150 }),
    ...many(25, { creative: null, durationConfidence: 'none', daysRunning: null }),
  ]);
  assert.equal(v.verdict, null);
  assert.match(v.reason, /no readable creative type/);
});

test('confidence reflects how hard the evidence leans and how much there is', () => {
  const strong = formatVerdict([...many(45, { creative: 'video', daysRunning: 150 }), ...many(5, { creative: 'static', daysRunning: 150 })]);
  assert.equal(strong.confidence, 'strong');

  const thin = formatVerdict([...many(12, { creative: 'video', daysRunning: 120 }), ...many(10, { creative: 'static', daysRunning: 120 })]);
  assert.equal(thin.verdict, 'both');
  assert.equal(thin.confidence, 'thin', 'a near even split with a small sample is not a finding');
});

/*
 * Scoped to one network deliberately. A video native library mixed in would
 * manufacture a video verdict out of nothing but where we looked.
 */
test('other networks are excluded rather than pooled', () => {
  const ads = [
    ...many(25, { network: 'meta', creative: 'static', daysRunning: 120 }),
    ...many(50, { network: 'tiktok', creative: 'video', daysRunning: 120 }),
  ];
  const v = formatVerdict(ads, { network: 'meta' });
  assert.equal(v.sample.ads, 25, 'a video native library must not decide the Meta verdict');
  assert.equal(v.verdict, 'static');
});

test('an ad with no network is treated as meta, matching the engine', () => {
  assert.equal(formatVerdict(many(25, { daysRunning: 120 })).sample.ads, 25);
});

test('platform split is reported as a second weaker cut', () => {
  const ads = [
    ...many(20, { creative: 'video', daysRunning: 120, platforms: ['instagram'] }),
    ...many(10, { creative: 'static', daysRunning: 120, platforms: ['facebook'] }),
  ];
  const v = formatVerdict(ads);
  assert.equal(v.byPlatform['instagram']?.videoShare, 1);
  assert.equal(v.byPlatform['facebook']?.videoShare, 0);
});

test('an empty pool returns a shaped result rather than throwing', () => {
  const v = formatVerdict([]);
  assert.equal(v.verdict, null);
  assert.equal(v.raw.videoShare, null);
  assert.equal(v.durationWeighted.videoShare, null);
  assert.equal(v.sample.ads, 0);
});

test('the reason quotes the real counts, so a reader can check the arithmetic', () => {
  const ads = [...many(20, { creative: 'video', daysRunning: 120 }), ...many(5, { creative: 'static', daysRunning: 120 })];
  const v = formatVerdict(ads);
  assert.match(v.reason, /20 are video and 5 are static/);
  assert.match(v.reason, /80% video/);
});

/*
 * NO RECEIPT, NO CLAIM, AND THAT INCLUDES THE FORMAT VERDICT.
 *
 * Found by auditing our own output on 2026-08-22. "Video wins, strong
 * confidence" shipped as a bare verdict with sample counts and nothing a caller
 * could fetch. It was one of only two places in the response stating a
 * conclusion about a market with no resolvable evidence behind it.
 */
test('the verdict names the ads it rests on', () => {
  const ads = Array.from({ length: 30 }, (_, i) => ({
    adId: `ad_${i}`,
    creative: (i % 4 === 0 ? 'static' : 'video') as 'static' | 'video',
    daysRunning: 100 + i,
    durationConfidence: 'reported' as const,
    platforms: ['facebook'],
  }));

  const v = formatVerdict(ads);

  assert.ok(v.cohortAdIds.length > 0, 'a verdict with no fetchable evidence is an assertion');
  assert.equal(v.cohortAdIds.length, v.longRunners.total,
    'the ids must be exactly the cohort the verdict was computed from, not a sample of it');
  for (const id of v.cohortAdIds) assert.match(id, /^ad_\d+$/);
});

test('an untyped ad contributes no id, because it contributed no verdict', () => {
  const ads = [
    ...Array.from({ length: 25 }, (_, i) => ({
      adId: `typed_${i}`, creative: 'video' as const, daysRunning: 120,
      durationConfidence: 'reported' as const,
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      adId: `untyped_${i}`, creative: null, daysRunning: 120,
      durationConfidence: 'reported' as const,
    })),
  ];

  const v = formatVerdict(ads);
  assert.ok(!v.cohortAdIds.some((id) => id.startsWith('untyped_')),
    'an ad we could not type must not appear as evidence for a format verdict');
});
