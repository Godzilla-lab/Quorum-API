/*
 * The whole run, offline.
 *
 * Every dependency is injected, so this exercises the real orchestrator, the
 * real corroboration rule and the real sqlite driver with no network and no
 * keys. That is the point of the injection: the interesting failures here are
 * a source going down, a claim landing under the threshold and a citation not
 * resolving, and none of them need the internet to reproduce.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openSqliteCorpus, type CorpusDriver, type Doc } from '@quorum/corpus';
import type { PlanInput, Source, SourceRecord, Subject } from '@quorum/sources';
import type { CliOptions } from './args.ts';
import { RATES, isCallRate, type AskModel } from '@quorum/core';
import { runResearch, runWithComparison, type ImageReading, type RunDeps } from './run.ts';

/* Derived, never hardcoded: a vendor repricing must not break a meter test. */
const AD_KEY = 'apify.fb-ads-item';
const AD_RATE = (() => {
  const rate = RATES[AD_KEY];
  if (!rate || !isCallRate(rate)) throw new Error(`${AD_KEY} is not a per call rate`);
  return rate.perCall;
})();
/* Accumulated in micros, exactly as the meter does, so the expectation cannot
 * drift where the meter does not. */
const adMicros = (n: number): number => Math.round(AD_RATE * n * 1_000_000);

const scratch = mkdtempSync(join(tmpdir(), 'quorum-cli-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let dbCount = 0;
const freshDb = (): string => join(scratch, `corpus-${dbCount++}.db`);

const SUBJECT: Subject = {
  category: 'running shoes',
  title: 'running shoes',
  source: 'text',
  images: [],
  reviews: [],
};

function options(over: Partial<CliOptions> = {}): CliOptions {
  return {
    subject: 'running shoes',
    terms: ['quality', 'price', 'problems'],
    communities: ['running'],
    sources: ['reddit'],
    adSources: [],
    corpusPath: freshDb(),
    maxQueriesPerSource: 1,
    maxRecordsTotal: 1000,
    deadlineMs: 60_000,
    capUsd: undefined,
    compare: [],
    offline: false,
    synthesise: false,
    synthesisModel: undefined,
    readImages: false,
    maxImages: 2,
    format: 'text',
    asOf: undefined,
    json: false,
    quiet: true,
    ...over,
  };
}

function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    openCorpus: (path) => openSqliteCorpus({ path }),
    resolveSubject: async () => SUBJECT,
    makeSource: () => { throw new Error('no source registered in this test'); },
    ...over,
  };
}

const record = (n: number, text: string, channel = 'r/running'): SourceRecord => ({
  source: 'reddit',
  kind: 'comment',
  externalId: `c${n}`,
  channel,
  text,
  score: 5,
  url: `https://example.test/${n}`,
  createdUtc: 1_700_000_000,
  origin: channel,
});

function sourceYielding(id: string, records: SourceRecord[], over: Partial<Source> = {}): Source {
  return {
    id,
    cost: 'free',
    channelKind: 'handle',
    configured: () => true,
    plan: async () => [{ text: 'shoes' }],
    async *retrieve() { yield* records; },
    cite: (r) => ({ label: r.origin, url: r.url ?? '', score: r.score ?? 0, postedAt: r.createdUtc ?? 0 }),
    ...over,
  };
}

/* Three mention quality, two mention problems, none mention price. That maps
 * onto one finding, one weak signal and one empty term. */
const CORPUS_RECORDS = [
  record(1, 'these running shoes have great quality stitching'),
  record(2, 'quality of the running shoes held up for a year', 'r/runningshoegeeks'),
  record(3, 'build quality on my running shoes is excellent', 'r/trailrunning'),
  record(4, 'running shoes gave me problems on long runs'),
  record(5, 'sizing problems with these running shoes', 'r/runningshoegeeks'),
];

test('a run stores evidence, and a corroborated term becomes a finding', async () => {
  const result = await runResearch(options(), deps({
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS),
  }));

  assert.equal(result.retrieval?.totalWritten, 5);
  assert.equal(result.warmth.docs, 5);

  const quality = result.claims.find((c) => c.term === 'quality');
  assert.equal(quality?.records, 3);
  assert.equal(quality?.channels, 3);
  assert.equal(quality?.verdict, 'finding');
});

/*
 * The one hint the gate consumes. Normalised through the gate's own tokeniser
 * and stripped of subject words, so the vouched record check runs on real
 * buyer vocabulary rather than on whatever casing the model chose.
 */
test('planner vocabulary reaches the retrieval plan, normalised and without subject words', async () => {
  let seen: PlanInput | undefined;
  await runResearch(options(), deps({
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS, {
      plan: async (input) => { seen = input; return [{ text: 'shoes' }]; },
    }),
    expandSubject: async () => ({
      brands: [], category: null, aliases: [],
      context: ['Cushioning', 'shoes', 'fit', 'sizing', 'cushioning'],
      model: 'some/model:free',
    }),
  }));

  assert.deepEqual(seen?.contextTerms, ['cushioning', 'sizing'],
    'lowercased and deduped; "fit" is under the term floor and "shoes" is the subject vouching for itself');
});

test('a term with two receipts is a weak signal and is never cited as a finding', async () => {
  const result = await runResearch(options(), deps({
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS),
  }));

  const problems = result.claims.find((c) => c.term === 'problems');
  assert.equal(problems?.records, 2);
  assert.equal(problems?.verdict, 'weak-signal');

  /* Its receipts exist and are listed, so it can be chased. */
  assert.equal(problems?.receiptIds.length, 2);

  /*
   * The rule that matters is not "a weak signal has no receipts", it is that a
   * weak signal is never PROMOTED to a finding. Its quotes are printed on
   * purpose, so its ids are shown and therefore have to resolve like any other.
   */
  const promoted = new Set(
    result.claims.filter((c) => c.verdict === 'finding').flatMap((c) => c.receiptIds),
  );
  for (const id of problems?.receiptIds ?? []) assert.equal(promoted.has(id), false);

  /* Every id the report shows is checked, which now includes the samples
   * printed under a weak signal. Anything shown and unresolvable is the one
   * failure this product cannot have. */
  assert.ok(result.receiptCheck.cited >= 3);
  assert.equal(result.receiptCheck.resolved, result.receiptCheck.cited);
  assert.deepEqual(result.receiptCheck.unresolved, []);
});

test('a term with no evidence is an empty weak signal, not an omission', async () => {
  const result = await runResearch(options(), deps({
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS),
  }));
  const price = result.claims.find((c) => c.term === 'price');
  assert.equal(price?.records, 0);
  assert.equal(price?.verdict, 'weak-signal');
});

/*
 * The anti fabrication check, in the production path. Today the ids come from
 * corpus rows so this passes by construction; it is here so that when synthesis
 * supplies them there is already a wall to hit.
 */
test('every cited receipt resolves back to a real record', async () => {
  const result = await runResearch(options(), deps({
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS),
  }));
  /* Every id the report shows, not only the ones under a finding: the samples
   * printed beside a weak signal carry ids too, and an id that is shown and
   * does not resolve is a fabricated citation whatever heading it sat under. */
  assert.ok(result.receiptCheck.cited >= 3, `cited ${result.receiptCheck.cited}`);
  assert.equal(result.receiptCheck.resolved, result.receiptCheck.cited);
  assert.deepEqual(result.receiptCheck.unresolved, []);
});

test('a citation that does not resolve is reported rather than printed', async () => {
  /* A driver that loses a row between counting and resolving. Contrived here,
   * and exactly what a model inventing an id will look like later. */
  const lossy = (path: string): CorpusDriver => {
    const real = openSqliteCorpus({ path });
    return {
      ...real,
      async getByReceiptIds(ids: string[]): Promise<Doc[]> {
        const rows = await real.getByReceiptIds(ids);
        return rows.slice(1);
      },
    };
  };

  const result = await runResearch(options(), deps({
    openCorpus: lossy,
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS),
  }));

  /*
   * The count moves with how many ids the report shows, and what must hold is
   * the relationship: one fewer resolves than was cited, and the missing one is
   * named rather than quietly dropped.
   */
  assert.ok(result.receiptCheck.cited > 0);
  assert.equal(result.receiptCheck.resolved, result.receiptCheck.cited - 1);
  assert.equal(result.receiptCheck.unresolved.length, 1);
});

test('an unconfigured source degrades the run and never fails it', async () => {
  const result = await runResearch(options(), deps({
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS, { configured: () => false }),
  }));

  assert.equal(result.retrieval?.outcomes[0]?.status, 'skipped');
  assert.equal(result.retrieval?.degraded[0]?.reason, 'not_configured');
  assert.equal(result.claims.length, 3, 'the report is still produced');
});

test('a source that throws mid retrieval degrades the run and keeps what it got', async () => {
  const exploding = sourceYielding('reddit', [], {
    async *retrieve() {
      yield CORPUS_RECORDS[0]!;
      throw new Error('upstream 503');
    },
  });

  const result = await runResearch(options(), deps({ makeSource: () => exploding }));

  assert.equal(result.retrieval?.outcomes[0]?.status, 'degraded');
  assert.equal(result.retrieval?.totalWritten, 1, 'the record gathered before the failure is kept');
});

test('offline never constructs a source and never retrieves', async () => {
  const result = await runResearch(options({ offline: true }), deps());
  assert.equal(result.retrieval, null);
  assert.equal(result.offline, true);
  assert.equal(result.cost.totalUsd, 0);
});

test('offline answers from what an earlier run stored, at zero cost', async () => {
  const corpusPath = freshDb();

  const cold = await runResearch(options({ corpusPath }), deps({
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS),
  }));
  assert.equal(cold.retrieval?.totalWritten, 5);

  const warm = await runResearch(options({ corpusPath, offline: true }), deps());
  assert.equal(warm.retrieval, null);
  assert.equal(warm.warmth.docs, 5);
  assert.equal(warm.claims.find((c) => c.term === 'quality')?.verdict, 'finding');
  assert.deepEqual(
    warm.claims.find((c) => c.term === 'quality')?.receiptIds.sort(),
    cold.claims.find((c) => c.term === 'quality')?.receiptIds.sort(),
    'the same evidence answers the same question, with no network',
  );
});

/*
 * A plan is only remembered when it was actually executed. Recording one an
 * offline run never ran would make the next run believe a route had been proven.
 */
test('the working plan is remembered after a real run and not after an offline one', async () => {
  const withNetwork = freshDb();
  await runResearch(options({ corpusPath: withNetwork }), deps({
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS),
  }));
  const reopened = openSqliteCorpus({ path: withNetwork });
  const stats = await reopened.categoryStats('running shoes');
  await reopened.close();
  assert.deepEqual(stats.subreddits, ['running']);
  assert.deepEqual(stats.queries, ['quality', 'price', 'problems']);

  const offlineOnly = freshDb();
  await runResearch(options({ corpusPath: offlineOnly, offline: true }), deps());
  const cold = openSqliteCorpus({ path: offlineOnly });
  const coldStats = await cold.categoryStats('running shoes');
  await cold.close();
  assert.deepEqual(coldStats.queries, []);
});

test('a paid call charges the meter and the spend cap is enforced there', async () => {
  const spender = sourceYielding('reddit', [], {
    async *retrieve(_query, ctx) {
      for (let i = 0; i < 10; i++) ctx.cost.charge(AD_KEY);
      yield* CORPUS_RECORDS;
    },
  });

  /* Capped at exactly what ten ads cost, so the boundary is the assertion. */
  const tenAds = (adMicros(1) * 10) / 1_000_000;
  const result = await runResearch(options({ capUsd: tenAds }), deps({ makeSource: () => spender }));

  assert.equal(result.cost.totalUsd, tenAds);
  assert.equal(result.cost.overCap, true, 'floating point drift must not let the cap slip past');
  assert.equal(result.cost.lines[0]?.calls, 10);
});

test('the subject note survives onto the result, because a blocked page is information', async () => {
  const result = await runResearch(options({ offline: true }), deps({
    resolveSubject: async () => ({
      ...SUBJECT,
      source: 'url-fallback',
      url: 'https://rei.com/product/193434',
      note: 'page could not be read: page returned 403',
    }),
  }));
  assert.equal(result.subject.note, 'page could not be read: page returned 403');
  assert.equal(result.subject.source, 'url-fallback');
});

/*
 * The product cache. Without it a repeat run of the same URL re-fetches a page
 * that may cost money to unblock, and four of four real stores block a plain
 * server side fetch, so the expensive path is the normal one.
 */
const PAGE_SUBJECT: Subject = {
  category: 'wool runner',
  title: 'Mens Wool Runners',
  source: 'page',
  url: 'https://allbirds.test/products/mens-wool-runners',
  brand: 'Allbirds',
  price: 110,
  images: ['https://cdn.allbirds.test/wool-runner.jpg'],
  reviews: [],
};

const URL_INPUT = 'https://allbirds.test/products/mens-wool-runners';

test('a page that resolved once is not fetched again on the next run', async () => {
  const corpusPath = freshDb();
  let resolves = 0;
  const counting = (): RunDeps => deps({
    resolveSubject: async () => { resolves++; return PAGE_SUBJECT; },
    makeSource: () => sourceYielding('reddit', []),
  });

  const first = await runResearch(options({ subject: URL_INPUT, corpusPath }), counting());
  assert.equal(resolves, 1);
  assert.equal(first.subjectCached, false);

  const second = await runResearch(options({ subject: URL_INPUT, corpusPath }), counting());
  /* Cumulative across both runs: still 1 means the second run resolved nothing. */
  assert.equal(resolves, 1, 'the second run must not fetch the page again');
  assert.equal(second.subjectCached, true);
  assert.equal(second.subject.brand, 'Allbirds');
  assert.equal(second.subject.price, 110);
  assert.deepEqual(second.subject.images, PAGE_SUBJECT.images);
});

test('a plain text subject never consults the cache, because it costs nothing to resolve', async () => {
  const corpusPath = freshDb();
  let resolves = 0;
  const counting = (): RunDeps => deps({
    resolveSubject: async () => { resolves++; return SUBJECT; },
    makeSource: () => sourceYielding('reddit', []),
  });

  await runResearch(options({ corpusPath }), counting());
  const second = await runResearch(options({ corpusPath }), counting());
  assert.equal(resolves, 2);
  assert.equal(second.subjectCached, false);
});

/*
 * A url-fallback subject was derived from the URL string with no network, so
 * caching it would save nothing and would stop us ever retrying a store that
 * came back up.
 */
test('a blocked page is not cached, so the store gets retried', async () => {
  const corpusPath = freshDb();
  let resolves = 0;
  const counting = (): RunDeps => deps({
    resolveSubject: async () => {
      resolves++;
      return { ...PAGE_SUBJECT, source: 'url-fallback' as const, note: 'page returned 403' };
    },
    makeSource: () => sourceYielding('reddit', []),
  });

  await runResearch(options({ subject: URL_INPUT, corpusPath }), counting());
  const second = await runResearch(options({ subject: URL_INPUT, corpusPath }), counting());
  assert.equal(resolves, 2, 'a store that blocked us once must be tried again');
  assert.equal(second.subjectCached, false);
});

test('an unusable cache row degrades to a re-fetch rather than a subject with holes in it', async () => {
  const corpusPath = freshDb();
  const seeded = openSqliteCorpus({ path: corpusPath });
  /* A row written by an older version, or by hand. Corpus rows are data. */
  await seeded.cacheProduct({ url: URL_INPUT, title: 'stale' } as never, 'wool runner');
  await seeded.close();

  let resolves = 0;
  const result = await runResearch(options({ subject: URL_INPUT, corpusPath }), deps({
    resolveSubject: async () => { resolves++; return PAGE_SUBJECT; },
    makeSource: () => sourceYielding('reddit', []),
  }));

  assert.equal(resolves, 1);
  assert.equal(result.subjectCached, false);
  assert.equal(result.category, 'wool runner');
});

/*
 * The ads leg. Ads do not travel the record path: they append to their own
 * table, because two sightings of one ad thirty days apart are the only
 * evidence that will ever exist that it ran for thirty days.
 */
const DAY = 86_400;

function adSourceYielding(records: import('@quorum/sources').AdRecord[], over: Partial<import('@quorum/sources').AdSource> = {}): import('@quorum/sources').AdSource {
  return {
    id: 'meta-ads-apify',
    cost: 'metered',
    configured: () => true,
    plan: async () => [{ text: 'running shoes' }],
    async *retrieve() { yield* records; },
    cite: (r) => ({ label: r.advertiser, url: r.url ?? '' }),
    ...over,
  };
}

const ad = (adId: string, over: Partial<import('@quorum/sources').AdRecord> = {}): import('@quorum/sources').AdRecord => ({
  adId,
  advertiser: 'HOKA',
  body: 'the new clifton is here',
  creative: 'video',
  platforms: ['facebook', 'instagram'],
  startDate: null,
  endDate: null,
  isActive: true,
  daysRunning: null,
  durationConfidence: 'none',
  ...over,
});

test('ads are appended, never upserted, so a second sighting is kept', async () => {
  const corpusPath = freshDb();
  const base = { ...deps({ makeSource: () => sourceYielding('reddit', []) }), makeAdSource: () => adSourceYielding([ad('ad_1')]) };

  await runResearch(options({ corpusPath, adSources: ['meta-ads-apify'] }), base);
  await runResearch(options({ corpusPath, adSources: ['meta-ads-apify'] }), base);

  const corpus = openSqliteCorpus({ path: corpusPath });
  const seen = await corpus.adObservations('ad_1');
  await corpus.close();
  assert.equal(seen.length, 2, 'the engine collapsed these into one and lost the duration signal');
});

test('the run attaches the category, so an adapter cannot misfile an ad', async () => {
  const corpusPath = freshDb();
  await runResearch(options({ corpusPath, adSources: ['meta-ads-apify'] }), {
    ...deps({ makeSource: () => sourceYielding('reddit', []) }),
    makeAdSource: () => adSourceYielding([ad('ad_1')]),
  });
  const corpus = openSqliteCorpus({ path: corpusPath });
  const rows = await corpus.latestAdsByCategory('running shoes');
  await corpus.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.category, 'running shoes');
});

test('an unconfigured ads leg degrades the run and spends nothing', async () => {
  const result = await runResearch(options({ adSources: ['meta-ads-apify'] }), {
    ...deps({ makeSource: () => sourceYielding('reddit', CORPUS_RECORDS) }),
    makeAdSource: () => adSourceYielding([ad('ad_1')], { configured: () => false }),
  });
  assert.equal(result.adRetrieval?.outcomes[0]?.status, 'skipped');
  assert.equal(result.adRetrieval?.degraded[0]?.reason, 'not_configured');
  assert.equal(result.cost.totalUsd, 0);
  assert.equal(result.claims.length, 3, 'the rest of the report is unaffected');
});

test('--no-ads means the leg never runs at all', async () => {
  const result = await runResearch(options({ adSources: [] }), {
    ...deps({ makeSource: () => sourceYielding('reddit', []) }),
    makeAdSource: () => { throw new Error('must not be constructed'); },
  });
  assert.equal(result.adRetrieval, null);
  assert.equal(result.formats, null);
});

test('offline never runs the metered leg, whatever was asked for', async () => {
  const result = await runResearch(options({ offline: true, adSources: ['meta-ads-apify'] }), {
    ...deps(),
    makeAdSource: () => { throw new Error('must not be constructed'); },
  });
  assert.equal(result.adRetrieval, null);
});

/*
 * The payoff. Two runs thirty days apart on an ad that reports no dates, and
 * the duration comes out of our own recording. Meta deletes this ad when it
 * stops, so nothing else in the world can produce that number.
 */
test('a duration is derived from repeat sightings when the ad reports nothing', async () => {
  const corpusPath = freshDb();
  const t0 = 1_787_000_000_000;
  const build = (nowMs: number) => ({
    ...deps({ makeSource: () => sourceYielding('reddit', []) }),
    makeAdSource: () => adSourceYielding([ad('ad_1')]),
    now: () => nowMs,
  });

  const first = await runResearch(options({ corpusPath, adSources: ['meta-ads-apify'] }), build(t0));
  assert.equal(first.durationBasis.none, 1, 'one sighting proves no duration');

  const later = await runResearch(options({ corpusPath, adSources: ['meta-ads-apify'] }), build(t0 + 30 * DAY * 1000));
  assert.equal(later.durationBasis.observationSpan, 1);
  assert.equal(later.durationBasis.none, 0);
});

test('the format verdict is read back from the corpus, so a warm category needs no network', async () => {
  const corpusPath = freshDb();
  await runResearch(options({ corpusPath, adSources: ['meta-ads-apify'] }), {
    ...deps({ makeSource: () => sourceYielding('reddit', []) }),
    makeAdSource: () => adSourceYielding([ad('ad_1'), ad('ad_2', { creative: 'static' })]),
  });

  const warm = await runResearch(options({ corpusPath, offline: true }), deps());
  assert.equal(warm.adRetrieval, null, 'nothing was retrieved');
  assert.ok(warm.formats, 'but a verdict is still produced from what we hold');
  assert.equal(warm.formats?.sample.ads, 2);
  assert.equal(warm.formats?.verdict, null, 'two ads is nowhere near enough to call a format');
  assert.match(warm.formats?.reason ?? '', /not enough competitor evidence/);
});

/*
 * IMAGE READING: THE OPT IN, AND THE WALL AROUND IT.
 *
 * These four tests exist because this is the one feature in the pipeline whose
 * output looks like evidence and is not. A transcription of an ad reads exactly
 * like a quote from a person, and the difference is the whole product.
 */

const IMAGE_SUBJECT: Subject = {
  category: 'running shoes',
  title: 'wool runner',
  source: 'page',
  url: 'https://example.test/p',
  images: ['https://cdn.example.test/1.jpg', 'https://cdn.example.test/2.jpg', 'https://cdn.example.test/3.jpg'],
  reviews: [],
};

const reading = (url: string): ImageReading => ({
  imageUrl: url,
  kind: 'transcription',
  text: 'BUILT FOR THE LONG RUN. Free returns.',
  model: 'test/vision',
  readAt: 1_700_000_000,
  derived: true,
});

test('images are not read unless --read-images is passed', async () => {
  let calls = 0;
  const result = await runResearch(options(), deps({
    resolveSubject: async () => IMAGE_SUBJECT,
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS),
    readImage: async (url) => { calls++; return reading(url); },
  }));

  assert.equal(calls, 0, 'a run must never read images without being asked');
  assert.deepEqual(result.readings, []);
});

test('--read-images reads up to --max-images and no further', async () => {
  const seen: string[] = [];
  const result = await runResearch(options({ readImages: true, maxImages: 2 }), deps({
    resolveSubject: async () => IMAGE_SUBJECT,
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS),
    readImage: async (url) => { seen.push(url); return reading(url); },
  }));

  /* Three images available, two read. The cap is the point: measured live, a
   * single image cost 151s. */
  assert.equal(seen.length, 2);
  assert.equal(result.readings.length, 2);
  assert.equal(result.readings[0]?.derived, true);
});

test('a reading never enters the corpus and never joins a claim', async () => {
  /* Held rather than rebuilt, because `options()` mints a fresh database every
   * call and reopening a new one would inspect an empty file and pass. */
  const opts = options({ readImages: true, maxImages: 2 });
  const result = await runResearch(opts, deps({
    resolveSubject: async () => IMAGE_SUBJECT,
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS),
    readImage: async (url) => ({ ...reading(url), text: 'SIZING RUNS SMALL, ORDER A SIZE UP' }),
  }));

  /* Five records went in. Two images were read. The corpus still holds five. */
  assert.equal(result.warmth.docs, 5);

  /*
   * The reading says something a claim would love to have. It reaches none of
   * them, because a reading is not a record and cannot be counted.
   */
  const everyReceipt = new Set(result.claims.flatMap((c) => c.receiptIds));
  const corpus = openSqliteCorpus({ path: opts.corpusPath });
  try {
    for (const id of everyReceipt) {
      const [row] = await corpus.getByReceiptIds([id]);
      assert.ok(row, 'every cited receipt resolves to a real stored record');
      assert.ok(!row.text.includes('SIZING RUNS SMALL'), 'a model reading was stored as a record');
    }
  } finally {
    await corpus.close();
  }

  const sizing = result.claims.find((c) => c.term === 'problems');
  assert.equal(sizing?.records, 2, 'a reading must not raise a corroboration count');
});

test('a vision provider that is down degrades the run rather than failing it', async () => {
  const result = await runResearch(options({ readImages: true, maxImages: 2 }), deps({
    resolveSubject: async () => IMAGE_SUBJECT,
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS),
    readImage: async () => null,
  }));

  assert.deepEqual(result.readings, []);
  /* The evidence is untouched. A missing image reading is not a missing report. */
  assert.equal(result.warmth.docs, 5);
  assert.equal(result.claims.find((c) => c.term === 'quality')?.verdict, 'finding');
});

/* ------------------------------------------------------------------ */
/* synthesis in the run                                                */
/* ------------------------------------------------------------------ */

/*
 * A model that answers with whatever it was told to, and records the prompt it
 * was handed. Injected exactly as the real one is, so these tests exercise the
 * production path with no key and no network.
 */
function modelSaying(
  claims: { term: string; claim: string; evidence_ids: string[] }[],
  over: { fromOrdinals?: boolean } = {},
) {
  const seen: { system: string; prompt: string }[] = [];
  const askModel: AskModel = async (request) => {
    seen.push({ system: request.system, prompt: request.prompt });
    /*
     * Real models cite ordinals, so by default the test does too: it reads the
     * ordinals out of the prompt it was given rather than being handed ids the
     * run never showed it, which is the only way the ordinal translation is
     * genuinely under test.
     */
    const ordinals = [...request.prompt.matchAll(/^([cp]\d+) \[/gm)].map((m) => m[1]!);
    const resolved = claims.map((c) => ({
      ...c,
      evidence_ids: over.fromOrdinals === false
        ? c.evidence_ids
        : c.evidence_ids.map((id) => {
          const index = Number(id.replace(/^take/, ''));
          return Number.isNaN(index) ? id : ordinals[index] ?? id;
        }),
    }));
    return {
      ok: true,
      model: 'test/model:free',
      json: { claims: resolved },
      usage: { inputTokens: 400, outputTokens: 900 },
    };
  };
  return { askModel, seen };
}

test('synthesis is off unless asked for, and absent is not a degraded run', async () => {
  const { askModel, seen } = modelSaying([]);
  const result = await runResearch(options(), deps({
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS),
    askModel,
  }));

  assert.equal(result.synthesis, null);
  assert.equal(seen.length, 0, 'the model was never called');
  /* And the report is complete without it. */
  assert.equal(result.claims.find((c) => c.term === 'quality')?.verdict, 'finding');
});

test('--offline never calls a model, because offline means zero network', async () => {
  const { askModel, seen } = modelSaying([{ term: 'quality', claim: 'Good.', evidence_ids: ['take0'] }]);
  const result = await runResearch(options({ offline: true, synthesise: true }), deps({ askModel }));
  assert.equal(result.synthesis, null);
  assert.equal(seen.length, 0);
});

test('a synthesised claim citing real ordinals becomes a finding with resolvable receipts', async () => {
  const { askModel, seen } = modelSaying([
    { term: 'quality', claim: 'Buyers say the build holds up.', evidence_ids: ['take0', 'take1', 'take2'] },
  ]);
  const result = await runResearch(options({ synthesise: true }), deps({
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS),
    askModel,
  }));

  const syn = result.synthesis;
  assert.ok(syn);
  assert.equal(syn.model, 'test/model:free');
  assert.equal(syn.claims.length, 1);
  assert.equal(syn.claims[0]?.verdict, 'finding');
  assert.equal(syn.claims[0]?.receipts.length, 3, 'the ordinals translated back into real records');
  assert.equal(syn.fabrication.clean, true);

  /* THE MODEL WAS NEVER SHOWN AN ID IT COULD HAVE COPIED. */
  assert.equal(/rc_[0-9a-f]/.test(seen[0]!.prompt), false);
  assert.equal(/rc_[0-9a-f]/.test(seen[0]!.system), false);
});

test('A SYNTHESISED CLAIM CITING INVENTED IDS REACHES NOTHING AND IS REPORTED', async () => {
  const { askModel } = modelSaying(
    [{ term: 'quality', claim: 'Buyers agree.', evidence_ids: ['c98', 'c99', 'rc_deadbeefdeadbeef'] }],
    { fromOrdinals: false },
  );
  const result = await runResearch(options({ synthesise: true }), deps({
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS),
    askModel,
  }));

  const syn = result.synthesis!;
  assert.equal(syn.claims[0]?.receipts.length, 0);
  assert.deepEqual(syn.claims[0]?.fabricated, ['c98', 'c99', 'rc_deadbeefdeadbeef']);
  assert.equal(syn.claims[0]?.verdict, 'weak-signal');
  assert.equal(syn.fabrication.clean, false);
  assert.equal(syn.fabrication.idsFabricated, 3);

  /*
   * The run wide receipt check must still pass. An invented id is not a cited
   * receipt that failed to resolve, it is one that never became a citation,
   * and conflating the two would make the exit code fire on a working gate.
   */
  assert.deepEqual(result.receiptCheck.unresolved, []);
});

test('a synthesised claim quoting words nobody wrote is rejected outright', async () => {
  const { askModel } = modelSaying([{
    term: 'quality',
    claim: 'One buyer said "these fell apart within a single week of wearing them".',
    evidence_ids: ['take0', 'take1', 'take2'],
  }]);
  const result = await runResearch(options({ synthesise: true }), deps({
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS),
    askModel,
  }));

  const syn = result.synthesis!;
  assert.equal(syn.claims[0]?.receipts.length, 3, 'all three citations are real');
  assert.equal(syn.claims[0]?.corroboration.verdict, 'finding', 'corroboration alone would have passed it');
  assert.equal(syn.claims[0]?.verdict, 'rejected');
  assert.equal(syn.fabrication.quotesUnsupported, 1);
});

test('a provider being down degrades the prose and nothing else', async () => {
  const askModel: AskModel = async () => ({ ok: false, error: 'every model returned 429' });
  const result = await runResearch(options({ synthesise: true }), deps({
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS),
    askModel,
  }));

  assert.equal(result.synthesis?.error, 'every model returned 429');
  assert.deepEqual(result.synthesis?.claims, []);
  /* Every deterministic number is untouched. */
  assert.equal(result.claims.find((c) => c.term === 'quality')?.verdict, 'finding');
  assert.equal(result.receiptCheck.unresolved.length, 0);
});

test('a model that throws degrades loudly instead of failing the run', async () => {
  /*
   * THIS TEST USED TO ASSERT THE OPPOSITE: that a throwing transport was our
   * own defect and should reject the whole run rather than be swallowed. The
   * first production synthesis attempt settled the argument on 2026-08-24. A
   * platform env var with a trailing newline made node throw at request build
   * time, the throw propagated exactly as the old contract demanded, and a
   * customer's completed retrieval was thrown away over whitespace. The half
   * of the old rule worth keeping is loudness, so the error must be ON the
   * result where a reader can see it, never a silent null.
   */
  const askModel: AskModel = async () => { throw new Error('transport defect'); };
  const result = await runResearch(options({ synthesise: true }), deps({
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS),
    askModel,
  }));

  assert.equal(result.synthesis?.error, 'transport defect', 'the defect is reported, not swallowed');
  assert.deepEqual(result.synthesis?.claims, []);
  /* Every deterministic number is untouched, same as a provider being down. */
  assert.equal(result.claims.find((c) => c.term === 'quality')?.verdict, 'finding');
  assert.equal(result.receiptCheck.unresolved.length, 0);
});

test('the model reasons over exactly the rows the counts came from', async () => {
  const { askModel, seen } = modelSaying([]);
  const result = await runResearch(options({ synthesise: true }), deps({
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS),
    askModel,
  }));

  /*
   * Five records were stored, and only the ones a term search matched are in
   * the book. A fresh query here would let the model cite a record no count
   * ever saw, and the two halves of the report would describe different
   * corpora.
   */
  const shown = [...seen[0]!.prompt.matchAll(/^[cp]\d+ \[/gm)].length;
  const counted = new Set(result.claims.flatMap((c) => c.receiptIds)).size;
  assert.equal(shown, counted);
  assert.ok(shown > 0);
});

test('synthesis charges the meter from reported tokens, and free is a verified zero', async () => {
  const { askModel } = modelSaying([
    { term: 'quality', claim: 'Buyers say the build holds up.', evidence_ids: ['take0'] },
  ]);
  const result = await runResearch(options({ synthesise: true }), deps({
    makeSource: () => sourceYielding('reddit', CORPUS_RECORDS),
    askModel,
  }));

  const line = result.cost.lines.find((l) => l.key === 'test/model:free');
  assert.ok(line, 'the call is on the bill even when it cost nothing');
  assert.equal(line.kind, 'llm');
  assert.equal(line.inputTokens, 400);
  assert.equal(line.outputTokens, 900);
});

/* ------------------------------------------------------------------ */
/* as-of                                                               */
/* ------------------------------------------------------------------ */

const MARCH_2026 = Math.floor(Date.UTC(2026, 2, 15) / 1000);
const JULY_2026 = Math.floor(Date.UTC(2026, 6, 15) / 1000);

const dated = (n: number, text: string, when: number, channel = 'r/running'): SourceRecord => ({
  source: 'reddit', kind: 'comment', externalId: `d${n}`, channel, text,
  score: 5, url: `https://example.test/${n}`, createdUtc: when, origin: channel,
});

const ACROSS_TIME = [
  dated(1, 'quality of these running shoes was fine back in march', MARCH_2026, 'r/a'),
  dated(2, 'running shoes quality held up in march too', MARCH_2026, 'r/b'),
  dated(3, 'running shoes quality complaints started in july', JULY_2026, 'r/a'),
  dated(4, 'running shoes quality dropped in july', JULY_2026, 'r/b'),
  dated(5, 'quality of my running shoes is bad now, july', JULY_2026, 'r/c'),
];

test('AS OF ANSWERS AS THE MARKET STOOD, NOT AS IT STANDS', async () => {
  const opts = options({ asOf: '2026-03', terms: ['quality'] });
  const path = opts.corpusPath;
  await runResearch(opts, deps({ makeSource: () => sourceYielding('reddit', ACROSS_TIME) }));

  const march = await runResearch(
    options({ asOf: '2026-03', terms: ['quality'], corpusPath: path, offline: true }),
    deps(),
  );
  const now = await runResearch(
    options({ terms: ['quality'], corpusPath: path, offline: true }),
    deps(),
  );

  assert.equal(march.claims[0]?.records, 2, 'only what had been written by the end of March');
  assert.equal(march.claims[0]?.verdict, 'weak-signal', 'and it had not cleared the bar yet');
  assert.equal(now.claims[0]?.records, 5);
  assert.equal(now.claims[0]?.verdict, 'finding');
  assert.equal(march.asOf, '2026-03');
  assert.equal(now.asOf, null);
});

test('the denominator is windowed too, or a share is against the wrong total', async () => {
  /* The bug the trend module exists to avoid, in a second place: a windowed
   * numerator over a whole corpus denominator understates every share. */
  const opts = options({ asOf: '2026-03', terms: ['quality'] });
  const path = opts.corpusPath;
  await runResearch(opts, deps({ makeSource: () => sourceYielding('reddit', ACROSS_TIME) }));

  const march = await runResearch(
    options({ asOf: '2026-03', terms: ['quality'], corpusPath: path, offline: true }),
    deps(),
  );
  /* Two of the two records that existed in March, not two of five. */
  assert.equal(march.voice[0]?.categoryRecords, 2);
  assert.equal(march.voice[0]?.sharePct, 100);
});

test('A HISTORICAL RUN NEVER BECOMES THE BASELINE THE NEXT DIFF USES', async () => {
  /*
   * Recording one would make tomorrow's report announce that several months of
   * evidence had just arrived, which is a real event reported on a false date.
   */
  const opts = options({ terms: ['quality'] });
  const path = opts.corpusPath;
  await runResearch(opts, deps({ makeSource: () => sourceYielding('reddit', ACROSS_TIME) }));

  const corpus = openSqliteCorpus({ path });
  const before = (await corpus.priorReports('running shoes', 5)).length;
  await corpus.close();

  await runResearch(
    options({ asOf: '2026-03', terms: ['quality'], corpusPath: path }),
    deps({ makeSource: () => sourceYielding('reddit', []) }),
  );

  const after = openSqliteCorpus({ path });
  assert.equal((await after.priorReports('running shoes', 5)).length, before, 'no new baseline');
  await after.close();
});

test('the month boundary is the last second of the month, in every month', async () => {
  /* Built from the first of the NEXT month minus one second, so February in a
   * leap year and the December to January roll need no special case. */
  const cases: [string, number, string][] = [
    ['2024-02', Date.UTC(2024, 1, 29, 23, 59, 59), 'a leap February'],
    ['2026-02', Date.UTC(2026, 1, 28, 23, 59, 59), 'a common February'],
    ['2026-12', Date.UTC(2026, 11, 31, 23, 59, 59), 'the year end'],
  ];
  for (const [asOf, boundaryMs, why] of cases) {
    const inside = Math.floor(boundaryMs / 1000);
    const outside = inside + 1;
    const opts = options({ asOf, terms: ['quality'] });
    const path = opts.corpusPath;
    await runResearch(opts, deps({
      makeSource: () => sourceYielding('reddit', [
        dated(90, 'running shoes quality inside the window', inside, 'r/a'),
        dated(91, 'running shoes quality outside the window', outside, 'r/b'),
      ]),
    }));
    const result = await runResearch(
      options({ asOf, terms: ['quality'], corpusPath: path, offline: true }),
      deps(),
    );
    assert.equal(result.claims[0]?.records, 1, `${why} (${asOf})`);
    assert.equal(result.claims[0]?.evidence[0]?.excerpt, 'running shoes quality inside the window', why);
  }
});

test('a record with no usable date is in no window, and is still evidence without one', async () => {
  const opts = options({ terms: ['quality'] });
  const path = opts.corpusPath;
  await runResearch(opts, deps({
    makeSource: () => sourceYielding('reddit', [
      dated(80, 'running shoes quality is fine', MARCH_2026, 'r/a'),
      dated(81, 'running shoes quality undated', 0, 'r/b'),
    ]),
  }));

  const windowed = await runResearch(
    options({ asOf: '2026-03', terms: ['quality'], corpusPath: path, offline: true }),
    deps(),
  );
  const unwindowed = await runResearch(
    options({ terms: ['quality'], corpusPath: path, offline: true }),
    deps(),
  );
  assert.equal(windowed.claims[0]?.records, 1, 'assuming a date would fabricate one');
  assert.equal(unwindowed.claims[0]?.records, 2, 'and it is still real evidence');
});

/* ------------------------------------------------------------------ */
/* comparison, where each rival is a run of its own                    */
/* ------------------------------------------------------------------ */

/*
 * A side's records have to carry that side's name, because the relevance gate
 * requires the subject as a PHRASE. That is not a test convenience: it is why a
 * rival needs its own retrieval at all, since records about one product do not
 * pass the gate for another.
 */
function sideRecords(name: string, sizing: number, filler: number): SourceRecord[] {
  const rows: SourceRecord[] = [];
  let n = 0;
  for (let i = 0; i < sizing; i++) {
    rows.push(record(n++, `the ${name} sizing runs small, had to size up`, `r/side${i}`));
  }
  for (let i = 0; i < filler; i++) {
    rows.push(record(n++, `bought the ${name} last month and they are fine`, `r/other${i}`));
  }
  /* Ids are per side, or the second run would upsert the first run's records. */
  return rows.map((r) => ({ ...r, externalId: `${name.replace(/\s+/g, '')}-${r.externalId}` }));
}

/*
 * Deps whose subject resolution echoes whatever it was handed, so each side
 * lands in a category of its own, and whose source yields the records for
 * whichever side is currently running. `makeSource` runs after
 * `resolveSubject`, which is what makes the handoff work.
 */
function comparingDeps(rows: Record<string, SourceRecord[]>): RunDeps {
  let active = '';
  return deps({
    resolveSubject: async (input) => {
      active = input;
      return { ...SUBJECT, category: input, title: input };
    },
    makeSource: () => sourceYielding('reddit', rows[active] ?? []),
  });
}

test('WITHOUT --compare THERE IS NO COMPARISON, AND NO SECOND RUN IS PAID FOR', async () => {
  let runs = 0;
  const result = await runWithComparison(options({ offline: true }), deps({
    resolveSubject: async () => { runs++; return SUBJECT; },
  }));
  assert.equal(result.comparison, null);
  assert.equal(runs, 1);
});

test('EACH RIVAL IS RETRIEVED AS A CORPUS OF ITS OWN, AND SHARES ARE COMPARED', async () => {
  /*
   * The whole reason this is a retrieval feature. `alpha shoes` holds 45 of 90
   * records about sizing and `beta shoes` holds 4 of 60, and NEITHER corpus
   * contains a record about the other product. There is no co-occurrence
   * anywhere in this test, which is the point.
   */
  const corpusPath = freshDb();
  const result = await runWithComparison(
    options({ corpusPath, subject: 'alpha shoes', terms: ['sizing'], compare: ['beta shoes'] }),
    comparingDeps({
      'alpha shoes': sideRecords('alpha shoes', 45, 45),
      'beta shoes': sideRecords('beta shoes', 4, 56),
    }),
  );

  const c = result.comparison!;
  assert.equal(c.baseline, 'alpha shoes');
  const sizing = c.terms[0]!;
  assert.equal(sizing.sides.length, 2);
  assert.equal(sizing.louder, 'alpha shoes');
  assert.equal(sizing.sides[0]?.records, 45);
  assert.equal(sizing.sides[1]?.records, 4);
  /* Each side's count is against its OWN corpus, never the subject's. */
  assert.equal(sizing.sides[0]?.corpusRecords, 90);
  assert.equal(sizing.sides[1]?.corpusRecords, 60);
  assert.ok(sizing.deltaPp > sizing.noisePp);

  /* And every side names receipts that fetch back out of the real corpus. */
  const corpus = openSqliteCorpus({ path: corpusPath });
  for (const side of sizing.sides) {
    const found = await corpus.getByReceiptIds(side.sampleReceiptIds);
    assert.equal(found.length, side.sampleReceiptIds.length, `${side.subject} cited an id that does not resolve`);
  }
  await corpus.close();
});

test('THE COUNT WINS AND THE SHARE LOSES, AND THE SHARE IS WHAT IS REPORTED', async () => {
  /*
   * `alpha shoes` has more sizing records in absolute terms and a corpus four
   * times the size, so sizing is a smaller part of what is said about it. A
   * comparison on counts reports the wrong product.
   */
  const result = await runWithComparison(
    options({ corpusPath: freshDb(), subject: 'alpha shoes', terms: ['sizing'], compare: ['beta shoes'] }),
    comparingDeps({
      'alpha shoes': sideRecords('alpha shoes', 14, 186),
      'beta shoes': sideRecords('beta shoes', 12, 38),
    }),
  );

  const sizing = result.comparison!.terms[0]!;
  assert.equal(sizing.sides[0]?.subject, 'beta shoes', 'ranked by share');
  assert.ok(sizing.sides[0]!.records < sizing.sides[1]!.records, 'and it holds fewer records');
  assert.equal(sizing.louder, 'beta shoes');
});

test('A RIVAL THAT CANNOT BE RETRIEVED IS NAMED, AND THE REPORT STILL SHIPS', async () => {
  /* A side missing in silence looks exactly like a side with nothing to say. */
  const result = await runWithComparison(
    options({ corpusPath: freshDb(), subject: 'alpha shoes', terms: ['sizing'], compare: ['beta shoes'] }),
    deps({
      resolveSubject: async (input) => {
        if (input === 'beta shoes') throw new Error('resolver timed out');
        return { ...SUBJECT, category: input, title: input };
      },
      makeSource: () => sourceYielding('reddit', sideRecords('alpha shoes', 45, 45)),
    }),
  );

  assert.deepEqual(result.comparison?.unavailable, [{ subject: 'beta shoes', reason: 'resolver timed out' }]);
  /* The subject was still retrieved, so its own findings are intact. */
  assert.equal(result.claims[0]?.verdict, 'finding');
  assert.equal(result.comparison?.terms[0]?.louder, null, 'one side is not a comparison');
});

test('THE COST OF EVERY SIDE IS ON THE ONE REPORT', async () => {
  /*
   * A comparison that printed the subject's cost alone would understate what
   * the caller just spent by however many rivals they named.
   */
  const spender = sourceYielding('reddit', [], {
    async *retrieve(_query, ctx) {
      for (let i = 0; i < 4; i++) ctx.cost.charge(AD_KEY);
      yield* sideRecords('alpha shoes', 3, 3);
    },
  });
  const result = await runWithComparison(
    options({ corpusPath: freshDb(), subject: 'alpha shoes', terms: ['sizing'], compare: ['beta shoes'] }),
    deps({
      resolveSubject: async (input) => ({ ...SUBJECT, category: input, title: input }),
      makeSource: () => spender,
    }),
  );

  /* Two runs, four charges each. */
  assert.equal(result.cost.totalUsd, (adMicros(1) * 8) / 1_000_000);
  assert.equal(result.cost.lines.reduce((n, l) => n + l.calls, 0), 8);
});

test('a rival never pays for a vision model or a synthesis model', async () => {
  /* Nothing a rival run produces beyond its counts is printed, so anything
   * else it bought would go straight in the bin. */
  const asked: string[] = [];
  await runWithComparison(
    options({
      corpusPath: freshDb(), subject: 'alpha shoes', terms: ['sizing'],
      compare: ['beta shoes'], readImages: true, synthesise: true,
    }),
    deps({
      resolveSubject: async (input) => ({
        ...SUBJECT, category: input, title: input, images: ['https://img.test/1.jpg'],
      }),
      makeSource: () => sourceYielding('reddit', sideRecords('alpha shoes', 3, 3)),
      readImage: async (url) => { asked.push(url); return null; },
      askModel: async () => { asked.push('model'); return { ok: false as const, error: 'no' }; },
    }),
  );

  assert.equal(asked.filter((a) => a === 'model').length, 1, 'the subject only');
  assert.equal(asked.filter((a) => a !== 'model').length, 1, 'the subject only');
});
