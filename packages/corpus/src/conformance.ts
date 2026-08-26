/*
 * The corpus conformance suite.
 *
 * Written once and run against every driver, because "identical query results
 * from both drivers" is the M1 acceptance criterion and a hand comparison would
 * not survive the first schema change.
 *
 * Note what this deliberately does NOT do: diff against the existing engine's
 * corpus.db byte for byte. Rows now carry a receipt_id that the old file does
 * not have, so byte equality is impossible by construction. Conformance is
 * defined on the query surface instead, which is the thing callers actually
 * depend on.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CorpusDriver } from './driver.ts';
import { MIN_RECEIPTS, WARM_MIN_DOCS } from './constants.ts';
import { receiptId } from './receipt-id.ts';
import type { AdObservationInput, DocInput, WebhookDeliveryInput } from './types.ts';

const doc = (over: Partial<DocInput> = {}): DocInput => ({
  source: 'reddit',
  kind: 'comment',
  externalId: 't1_default',
  channel: 'running',
  text: 'these shoes run small and I had to size up half a size',
  score: 12,
  url: 'https://reddit.com/r/running/comments/x/',
  createdUtc: 1_700_000_000,
  ...over,
});

const ad = (over: Partial<AdObservationInput> = {}): AdObservationInput => ({
  adId: 'ad_1',
  advertiser: 'Acme',
  category: 'running shoes',
  body: 'The shoe that fits',
  cta: 'Shop now',
  url: 'https://facebook.com/ads/library/?id=ad_1',
  creative: 'video',
  platforms: ['facebook', 'instagram'],
  startDate: 1_700_000_000,
  endDate: null,
  isActive: true,
  daysRunning: 30,
  durationConfidence: 'observed',
  ...over,
});

/*
 * A controllable clock. Tests that care about time move it explicitly rather
 * than sleeping, which keeps the suite fast and deterministic.
 */
export interface TestClock {
  now: () => number;
  advanceDays: (days: number) => void;
  advanceSeconds: (seconds: number) => void;
}

function makeClock(startUnixSeconds = 1_700_000_000): TestClock {
  let t = startUnixSeconds;
  return {
    now: () => t,
    advanceDays: (days) => { t += Math.round(days * 86400); },
    advanceSeconds: (seconds) => { t += seconds; },
  };
}

/*
 * `open` is a factory rather than an instance so each test gets a clean corpus.
 * A shared one would let write order leak between tests, and the ad append
 * behaviour is exactly the property that would hide behind that.
 *
 * The factory takes a clock so a driver can be tested against controlled time.
 */
export function runConformanceSuite(
  driverName: string,
  open: (now?: () => number) => Promise<CorpusDriver>,
): void {
  const withCorpus = async (fn: (c: CorpusDriver) => Promise<void>): Promise<void> => {
    const corpus = await open();
    try { await fn(corpus); } finally { await corpus.close(); }
  };

  const withClock = async (fn: (c: CorpusDriver, clock: TestClock) => Promise<void>): Promise<void> => {
    const clock = makeClock();
    const corpus = await open(clock.now);
    try { await fn(corpus, clock); } finally { await corpus.close(); }
  };

  test(`${driverName}: an empty corpus reports empty rather than throwing`, async () => {
    await withCorpus(async (c) => {
      assert.deepEqual(await c.totals(), { docs: 0, categories: 0, reports: 0, adObservations: 0 });
      assert.deepEqual(await c.search('anything'), []);
      assert.deepEqual(await c.byCategory('nothing'), []);
      assert.deepEqual(await c.getByReceiptIds(['rc_0000000000000000']), []);

      const stats = await c.categoryStats('never seen');
      assert.equal(stats.docs, 0);
      assert.equal(stats.ageDays, null);
      assert.equal(stats.warm, false, 'a category with no history is never warm');
    });
  });

  test(`${driverName}: addDocs counts only genuinely new rows`, async () => {
    await withCorpus(async (c) => {
      const first = await c.addDocs([doc({ externalId: 'a' }), doc({ externalId: 'b' })], 'running shoes');
      assert.equal(first, 2);

      const again = await c.addDocs([doc({ externalId: 'a' }), doc({ externalId: 'b' })], 'running shoes');
      assert.equal(again, 0, 're-harvesting the same records adds nothing, which is how we know a category was already warm');

      const third = await c.addDocs([doc({ externalId: 'c' })], 'running shoes');
      assert.equal(third, 1);
    });
  });

  /*
   * One call may carry the same record twice: a source that pages overlapping
   * windows hands the orchestrator overlapping batches. The duplicate counts
   * once and the FIRST occurrence is the one stored, matching the
   * first-write-wins rule the table enforces across calls.
   */
  test(`${driverName}: duplicates inside one addDocs call count once, first occurrence wins`, async () => {
    await withCorpus(async (c) => {
      const added = await c.addDocs([
        doc({ externalId: 'dup', text: 'the first sighting' }),
        doc({ externalId: 'solo' }),
        doc({ externalId: 'dup', text: 'the second sighting' }),
      ], 'running shoes');
      assert.equal(added, 2);
      assert.equal((await c.totals()).docs, 2);

      const stored = await c.getByReceiptIds([receiptId('reddit', 'dup')]);
      assert.equal(stored[0]?.text, 'the first sighting');
    });
  });

  test(`${driverName}: records without text or an external id are skipped, not stored`, async () => {
    await withCorpus(async (c) => {
      const added = await c.addDocs(
        [doc({ externalId: 'ok' }), doc({ externalId: '', text: 'orphan' }), doc({ externalId: 'x', text: '' })],
        'running shoes',
      );
      assert.equal(added, 1);
      assert.equal((await c.totals()).docs, 1);
    });
  });

  test(`${driverName}: receipt ids are assigned and resolve back to the record`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([doc({ externalId: 't1_real', text: 'the toe box is too narrow' })], 'running shoes');

      const expected = receiptId('reddit', 't1_real');
      const [found] = await c.getByReceiptIds([expected]);

      assert.ok(found, 'the id minted at write time must resolve at read time');
      assert.equal(found.receiptId, expected);
      assert.equal(found.text, 'the toe box is too narrow');
      assert.equal(found.channel, 'running');
    });
  });

  test(`${driverName}: an invented receipt id resolves to nothing`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([doc({ externalId: 'real' })], 'running shoes');
      const found = await c.getByReceiptIds(['rc_deadbeefdeadbeef']);
      assert.deepEqual(found, [], 'this is what makes a fabricated citation impossible rather than unlikely');
    });
  });

  /*
   * The load bearing one for corroboration counting. The same comment harvested
   * while researching two categories is two rows, and it must resolve to ONE
   * record, or a claim supported by one person can be reported as two.
   */
  test(`${driverName}: one utterance in two categories resolves to one receipt`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([doc({ externalId: 'shared' })], 'running shoes');
      await c.addDocs([doc({ externalId: 'shared' })], 'trail shoes');
      assert.equal((await c.totals()).docs, 2, 'two rows, because category is part of row identity');

      const resolved = await c.getByReceiptIds([receiptId('reddit', 'shared')]);
      assert.equal(resolved.length, 1, 'but one receipt, or corroboration counts this person twice');
    });
  });

  test(`${driverName}: full text search finds records and respects filters`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([
        doc({ externalId: '1', text: 'the sizing runs small on these', score: 50 }),
        doc({ externalId: '2', text: 'battery life is excellent', score: 5 }),
        doc({ externalId: '3', source: 'youtube', text: 'sizing was my only complaint', score: 30 }),
      ], 'running shoes');

      const hits = await c.search('sizing');
      assert.equal(hits.length, 2, 'both sizing records match, the battery one does not');

      const redditOnly = await c.search('sizing', { source: 'reddit' });
      assert.equal(redditOnly.length, 1);
      assert.equal(redditOnly[0]?.source, 'reddit');

      const highScore = await c.search('sizing', { minScore: 40 });
      assert.equal(highScore.length, 1);
      assert.equal(highScore[0]?.externalId, '1');

      const otherCategory = await c.search('sizing', { category: 'headphones' });
      assert.deepEqual(otherCategory, []);
    });
  });

  /*
   * Include and exclude lists over sources. The single `source` filter could
   * not express the request every live evaluation session actually made,
   * "drop sec-edgar and cpsc from this consumer question", 2026-08-26.
   */
  test(`${driverName}: source include and exclude lists filter, and exclusion wins`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([
        doc({ externalId: 'r1', source: 'reddit', text: 'the sizing runs small for r1' }),
        doc({ externalId: 'h1', source: 'hackernews', text: 'the sizing runs small for h1' }),
        doc({ externalId: 's1', source: 'sec-edgar', text: 'the sizing runs small for s1' }),
      ], 'running shoes');

      const included = await c.search('sizing', { sources: ['reddit', 'hackernews'] });
      assert.deepEqual(included.map((h) => h.externalId).sort(), ['h1', 'r1']);

      const excluded = await c.search('sizing', { excludeSources: ['sec-edgar', 'cpsc'] });
      assert.deepEqual(excluded.map((h) => h.externalId).sort(), ['h1', 'r1']);

      const both = await c.search('sizing', { sources: ['reddit', 'sec-edgar'], excludeSources: ['sec-edgar'] });
      assert.deepEqual(both.map((h) => h.externalId), ['r1'],
        'a source both included and excluded stays out');

      const empty = await c.search('sizing', { sources: [] });
      assert.equal(empty.length, 3, 'an empty include list means unfiltered, not nothing');
    });
  });

  /*
   * AND first, OR as the fallback. "battery life" used to OR its words and
   * count every record that merely said "life"; when records carrying every
   * word exist, they are the answer, and when none do the measured recall
   * behaviour is unchanged. See terms.ts.
   */
  test(`${driverName}: a multi word query prefers records carrying every word`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([
        doc({ externalId: 'both', text: 'the battery life on these is dreadful, four hours at best' }),
        doc({ externalId: 'battery-only', text: 'the battery swelled after a month' }),
        doc({ externalId: 'life-only', text: 'life is too short for uncomfortable shoes' }),
      ], 'running shoes');

      const hits = await c.search('battery life', { category: 'running shoes' });
      assert.deepEqual(hits.map((h) => h.externalId), ['both'],
        'records with every word exist, so only they answer');
      assert.ok(hits.every((h) => h.matchedAll), 'the strict pass answered, and the hits say so');
    });
  });

  test(`${driverName}: when no record carries every word, the query falls back to any word`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([
        doc({ externalId: 'battery-only', text: 'the battery swelled after a month' }),
        doc({ externalId: 'life-only', text: 'life is too short for uncomfortable shoes' }),
      ], 'running shoes');

      const hits = await c.search('battery life', { category: 'running shoes' });
      assert.equal(hits.length, 2, 'recall is what a corroboration count needs when precision is unavailable');
      /* The fallback must confess. A count over any-word matches presented as
       * corroboration of the phrase is how a nonsense query printed a finding
       * on 143 real records, measured live 2026-08-25. */
      assert.ok(hits.every((h) => h.matchedAll === false), 'a fallback hit says it is one');

      const oneWord = await c.search('battery', { category: 'running shoes' });
      assert.ok(oneWord.every((h) => h.matchedAll), 'a one word query has no fallback to fall into');
    });
  });

  /*
   * Ranking is not a length contest. Measured live 2026-08-26 by an outside
   * evaluation: on the hosted driver a long project update ranked top five
   * for three unrelated queries and two SEC filings outranked every real
   * customer, because ts_rank was called with no normalisation argument and
   * so never penalised length, while sqlite's bm25 did. This test is the
   * cross driver ordering guarantee an earlier comment claimed conformance
   * provided; nothing asserted it until now.
   */
  test(`${driverName}: the concise on topic record outranks the long rambler sharing its words`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([
        doc({ externalId: 'concise', text: 'the battery life on these is dreadful, four hours at best' }),
        doc({
          externalId: 'rambler',
          text: 'Quarterly progress notes for the workshop, longer than usual because a lot happened. '
            + 'The new enclosure design finally cleared thermal testing, the battery supplier changed '
            + 'their packaging so the intake jig needed rework, and the firmware team spent most of the '
            + 'month chasing a sleep mode regression that drained the battery overnight on some units. '
            + 'Community life continues as always: the forum meetup photos are posted, the classifieds '
            + 'thread got a cleanup, and the wiki migration is half done. Shipping wise the third batch '
            + 'left the warehouse on Tuesday and the fourth is being packed now, with customs forms '
            + 'pre-filled this time after the last delay. Real life kept several contributors busy this '
            + 'quarter so the documentation sprint moved to next month, and the test rig got a second '
            + 'power channel so endurance runs no longer block the bench. More notes when the next '
            + 'batch lands, and thanks as ever to everyone who filed reports.',
        }),
      ], 'running shoes');

      const hits = await c.search('battery life', { category: 'running shoes' });
      assert.equal(hits.length, 2, 'both records carry both words, so both answer the strict pass');
      assert.equal(hits[0]?.externalId, 'concise',
        'the record that is about the query must outrank the record that merely contains it');
    });
  });

  /*
   * Phrase mode: the words, in order, as one phrase, with no any-word
   * fallback. Fixture words are content words on purpose: the two engines
   * disagree about stop words (porter indexes them, the english tsquery
   * config drops them), and conformance pins the behaviour they share.
   */
  test(`${driverName}: phrase mode matches the exact sequence and never falls back`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([
        doc({ externalId: 'exact', text: 'honestly the battery life is short on these' }),
        doc({ externalId: 'scattered', text: 'battery packs gave my life some grief this winter' }),
      ], 'running shoes');

      const hits = await c.search('battery life', { mode: 'phrase' });
      assert.deepEqual(hits.map((h) => h.externalId), ['exact'],
        'the words out of order or apart are not the phrase');
      assert.ok(hits.every((h) => h.matchedAll), 'a phrase hit matched everything it was asked for');

      const reordered = await c.search('life battery', { mode: 'phrase' });
      assert.deepEqual(reordered, [], 'phrase order is the query, so reversing it finds nothing');
    });
  });

  test(`${driverName}: a query of only short words returns nothing rather than everything`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([doc({ externalId: '1' })], 'running shoes');
      assert.deepEqual(await c.search('a to的'), [], 'tokens of two characters or fewer are dropped');
      assert.deepEqual(await c.search('   '), []);
    });
  });

  test(`${driverName}: punctuation in a query cannot break the FTS parser`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([doc({ externalId: '1', text: 'sizing complaints here' })], 'running shoes');
      /* Each of these would be a syntax error if passed to MATCH unescaped. */
      for (const q of ['sizing"', 'sizing*', '(sizing)', 'sizing^2', 'sizing:foo', '"""']) {
        await assert.doesNotReject(() => c.search(q), `query ${q} must not throw`);
      }
    });
  });

  test(`${driverName}: warmth needs both volume and recency`, async () => {
    await withCorpus(async (c) => {
      const many: DocInput[] = [];
      for (let i = 0; i < WARM_MIN_DOCS; i++) many.push(doc({ externalId: `bulk_${i}` }));

      await c.addDocs(many.slice(0, WARM_MIN_DOCS - 1), 'running shoes');
      assert.equal((await c.categoryStats('running shoes')).warm, false, 'one below the floor is cold');

      await c.addDocs([doc({ externalId: 'one_more' })], 'running shoes');
      const stats = await c.categoryStats('running shoes');
      assert.equal(stats.docs, WARM_MIN_DOCS);
      assert.equal(stats.warm, true, 'freshly harvested and at the floor is warm');
      assert.ok(stats.ageDays !== null && stats.ageDays < 1);
    });
  });

  test(`${driverName}: category stats count comments and distinct channels`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([
        doc({ externalId: '1', kind: 'post', channel: 'running' }),
        doc({ externalId: '2', kind: 'comment', channel: 'running' }),
        doc({ externalId: '3', kind: 'comment', channel: 'trailrunning' }),
      ], 'running shoes');

      const stats = await c.categoryStats('running shoes');
      assert.equal(stats.docs, 3);
      assert.equal(stats.comments, 2);
      assert.equal(stats.channels, 2);
    });
  });

  test(`${driverName}: the category listing is the discovery path, most records first`, async () => {
    await withCorpus(async (c) => {
      assert.deepEqual(await c.listCategories(), [], 'an empty corpus lists nothing rather than erroring');

      await c.addDocs([
        doc({ externalId: 'a1', channel: 'running' }),
        doc({ externalId: 'a2', channel: 'trailrunning' }),
      ], 'running shoes');
      await c.addDocs([doc({ externalId: 'b1', channel: 'espresso' })], 'espresso machines');

      const listed = await c.listCategories();
      assert.deepEqual(listed.map((l) => l.category), ['running shoes', 'espresso machines']);
      const shoes = listed[0]!;
      assert.equal(shoes.docs, 2);
      assert.equal(shoes.channels, 2);
      assert.ok(shoes.lastHarvested > 0);
      assert.equal(typeof shoes.warm, 'boolean');
    });
  });

  /*
   * Measured live 2026-08-24 by an outside tester: "Running Shoes" answered
   * with the cold run message while "running shoes" held 2,452 records,
   * because category identity was the raw string. One spelling everywhere,
   * write path and read path, both drivers.
   */
  test(`${driverName}: CATEGORY CASE AND WHITESPACE ARE NOT IDENTITY`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([doc({ externalId: 'n1' })], '  Running   Shoes ');

      assert.equal((await c.categoryStats('running shoes')).docs, 1,
        'a write under a shouty spelling lands in the one true category');
      assert.equal((await c.categoryStats('RUNNING SHOES')).docs, 1,
        'a read under a shouty spelling finds it');
      assert.equal((await c.byCategory('Running Shoes')).length, 1);
      const hits = await c.search('shoes', { category: 'Running Shoes' });
      assert.equal(hits.length, 1, 'the search category filter folds the same way');
      assert.deepEqual((await c.listCategories()).map((l) => l.category), ['running shoes'],
        'the listing never shows a second, invisible spelling');
    });
  });

  /*
   * MARCH 2024 and APRIL 2024, chosen because they are far from any boundary a
   * timezone could push a record across. A histogram test dated to the first of
   * a month would pass or fail depending on where the test runs.
   */
  const MAR_2024 = 1_710_000_000;
  const APR_2024 = 1_712_600_000;

  test(`${driverName}: the date histogram buckets by the author's month, not ours`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([
        doc({ externalId: '1', createdUtc: MAR_2024, text: 'these run small in the toe box' }),
        doc({ externalId: '2', createdUtc: MAR_2024, text: 'sizing is strange on these' }),
        doc({ externalId: '3', createdUtc: APR_2024, text: 'the sole wore through fast' }),
      ], 'running shoes');

      const all = await c.dateHistogram({ category: 'running shoes' });
      assert.deepEqual(all.buckets, [
        { period: '2024-03', records: 2 },
        { period: '2024-04', records: 1 },
      ]);
      assert.equal(all.undated, 0);

      /* The numerator, from the same call shape. A share needs both. */
      const sized = await c.dateHistogram({ category: 'running shoes', query: 'sizing' });
      assert.deepEqual(sized.buckets, [{ period: '2024-03', records: 1 }]);
    });
  });

  test(`${driverName}: a corrupt date is counted as undated rather than inventing a month`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([
        doc({ externalId: '1', createdUtc: MAR_2024 }),
        /* Milliseconds where seconds were expected. Lands in the year 56000 and
         * would otherwise invent a period in which nobody said anything. */
        doc({ externalId: '2', createdUtc: MAR_2024 * 1000 }),
        doc({ externalId: '3', createdUtc: 0 }),
      ], 'running shoes');

      const histogram = await c.dateHistogram({ category: 'running shoes' });
      assert.deepEqual(histogram.buckets, [{ period: '2024-03', records: 1 }]);
      assert.equal(histogram.undated, 2, 'reported, never silently dropped');
    });
  });

  test(`${driverName}: the histogram is scoped to its category and counts the whole of it`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([doc({ externalId: '1', createdUtc: MAR_2024 })], 'running shoes');
      await c.addDocs([doc({ externalId: '2', createdUtc: MAR_2024 })], 'trail shoes');

      const shoes = await c.dateHistogram({ category: 'running shoes' });
      assert.deepEqual(shoes.buckets, [{ period: '2024-03', records: 1 }]);

      /* An unknown category is empty rather than an error, because that is what
       * every category looks like before its first run. */
      assert.deepEqual(await c.dateHistogram({ category: 'nothing here' }), { buckets: [], undated: 0 });
    });
  });

  test(`${driverName}: the histogram counts past any row cap, because a share needs the whole denominator`, async () => {
    await withCorpus(async (c) => {
      /*
       * MEASURED 2026-08-22 on a real 1,181 record category. Computing the
       * denominator from `byCategory` instead, which caps its rows, printed the
       * share of `sizing` as 8.70% when it is 7.37%. The overstatement grows
       * with the corpus: the cap is fixed and the category is not, so on a
       * 10,000 record category the row path is out by nearly ten times.
       *
       * 450 records, which is past the 400 row default `byCategory` returns.
       */
      const many = Array.from({ length: 450 }, (_, i) => doc({
        externalId: `bulk-${i}`,
        createdUtc: MAR_2024,
        text: i < 90 ? 'the sizing on these is strange' : 'a comment about something else entirely',
      }));
      await c.addDocs(many, 'running shoes');

      const all = await c.dateHistogram({ category: 'running shoes' });
      const total = all.buckets.reduce((n, b) => n + b.records, 0) + all.undated;
      assert.equal(total, 450, 'the histogram counts every record, not a page of them');

      const rows = await c.byCategory('running shoes');
      assert.ok(rows.length < total, 'while the row path is capped, which is the point');

      const sized = await c.dateHistogram({ category: 'running shoes', query: 'sizing' });
      const matched = sized.buckets.reduce((n, b) => n + b.records, 0);
      assert.equal(matched, 90);
      assert.equal((100 * matched) / total, 20, 'a share computed on the real denominator');
    });
  });

  test(`${driverName}: a query that reduces to nothing matches nothing, not everything`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([doc({ externalId: '1', createdUtc: MAR_2024 })], 'running shoes');
      /* The denominator and a dead query must not be the same answer, or a
       * share of conversation comes out as 100%. */
      const dead = await c.dateHistogram({ category: 'running shoes', query: 'a of' });
      assert.deepEqual(dead, { buckets: [], undated: 0 });
    });
  });

  test(`${driverName}: an as-of window filters on the author's date, not ours`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([
        doc({ externalId: 'old', createdUtc: MAR_2024, text: 'the sizing was strange back then' }),
        doc({ externalId: 'new', createdUtc: APR_2024, text: 'the sizing is strange now' }),
      ], 'running shoes');

      /* Everything up to the end of March. `harvestedAt` for both rows is now,
       * so a window that filtered on OUR date would return both or neither. */
      const asOfMarch = await c.search('sizing', { category: 'running shoes', until: MAR_2024 + 86_400 });
      assert.deepEqual(asOfMarch.map((d) => d.externalId), ['old']);

      const sinceApril = await c.search('sizing', { category: 'running shoes', from: APR_2024 });
      assert.deepEqual(sinceApril.map((d) => d.externalId), ['new']);

      /* And with no window, both. */
      assert.equal((await c.search('sizing', { category: 'running shoes' })).length, 2);
    });
  });

  test(`${driverName}: byCategory takes the same window, so a denominator can match`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([
        doc({ externalId: 'old', createdUtc: MAR_2024 }),
        doc({ externalId: 'new', createdUtc: APR_2024 }),
      ], 'running shoes');

      const held = await c.byCategory('running shoes', { until: MAR_2024 + 86_400 });
      assert.deepEqual(held.map((d) => d.externalId), ['old']);
    });
  });

  test(`${driverName}: AN UNDATED RECORD IS EXCLUDED FROM A WINDOW, NEVER ASSUMED RECENT`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([
        doc({ externalId: 'dated', createdUtc: MAR_2024, text: 'sizing is strange' }),
        doc({ externalId: 'undated', createdUtc: 0, text: 'sizing is strange too' }),
      ], 'running shoes');

      /* Assuming would place undated evidence inside every window it was never
       * shown to belong to, which is a fabricated date with a claim on top. */
      const windowed = await c.search('sizing', { category: 'running shoes', until: APR_2024 });
      assert.deepEqual(windowed.map((d) => d.externalId), ['dated']);

      /* Unwindowed it is still real evidence and still comes back. */
      assert.equal((await c.search('sizing', { category: 'running shoes' })).length, 2);
    });
  });

  test(`${driverName}: a remembered plan survives a round trip`, async () => {
    await withCorpus(async (c) => {
      await c.rememberCategory('running shoes', {
        subreddits: ['running', 'trailrunning'],
        queries: ['sizing', 'durability'],
      });
      const stats = await c.categoryStats('running shoes');
      assert.deepEqual(stats.subreddits, ['running', 'trailrunning']);
      assert.deepEqual(stats.queries, ['sizing', 'durability']);
    });
  });

  /*
   * THE REGRESSION TEST FOR THE DEFECT THIS TABLE EXISTS TO FIX.
   *
   * The engine wrote ads into the shared docs table, unique on
   * (source, external_id, category) with INSERT OR IGNORE, so the second
   * sighting of an ad was silently dropped and its day count froze at first
   * sight. It also cost money: a re-run re-paid the vendor per ad for
   * observations that were then discarded.
   */
  test(`${driverName}: observing the same ad twice records two observations`, async () => {
    await withClock(async (c, clock) => {
      assert.equal(await c.addAdObservations([ad({ daysRunning: 30 })]), 1);

      clock.advanceDays(30);
      assert.equal(await c.addAdObservations([ad({ daysRunning: 60 })]), 1, 'the second sighting is evidence, not a duplicate');

      const history = await c.adObservations('ad_1');
      assert.equal(history.length, 2, 'this is the assertion the old schema could not satisfy');
      assert.equal(history[0]?.daysRunning, 30);
      assert.equal(history[1]?.daysRunning, 60, 'and the day count moves rather than freezing at first sight');

      const span = (history[1]?.observedAt ?? 0) - (history[0]?.observedAt ?? 0);
      assert.equal(span, 30 * 86400, 'the gap between sightings is the evidence a duration is built from');
      assert.equal((await c.totals()).adObservations, 2);
    });
  });

  test(`${driverName}: an untypeable creative stays null and is not bucketed`, async () => {
    await withCorpus(async (c) => {
      await c.addAdObservations([ad({ adId: 'ad_untyped', creative: null })]);
      const [obs] = await c.adObservations('ad_untyped');
      assert.equal(obs?.creative, null, 'a ratio computed over guesses is worse than no ratio');
    });
  });

  test(`${driverName}: duration provenance survives storage`, async () => {
    await withCorpus(async (c) => {
      await c.addAdObservations([
        ad({ adId: 'r', durationConfidence: 'reported', daysRunning: 94, isActive: false, endDate: 1_700_100_000 }),
        ad({ adId: 'o', durationConfidence: 'observed', daysRunning: 12, isActive: true, endDate: null }),
        ad({ adId: 'n', durationConfidence: 'none', daysRunning: null, startDate: null }),
      ]);

      assert.equal((await c.adObservations('r'))[0]?.durationConfidence, 'reported');
      assert.equal((await c.adObservations('o'))[0]?.durationConfidence, 'observed');

      const none = (await c.adObservations('n'))[0];
      assert.equal(none?.durationConfidence, 'none');
      assert.equal(none?.daysRunning, null, 'no evidenced date means no duration at all, never a guess');
    });
  });

  test(`${driverName}: latest ads by category returns one row per ad`, async () => {
    await withCorpus(async (c) => {
      await c.addAdObservations([ad({ adId: 'x', daysRunning: 10 }), ad({ adId: 'y', daysRunning: 5 })]);
      await c.addAdObservations([ad({ adId: 'x', daysRunning: 40 })]);
      /* Deliberately written in the same second, because production does that
       * too and the query must still pick the later row. */

      const latest = await c.latestAdsByCategory('running shoes');
      assert.equal(latest.length, 2, 'two ads, not three observations');
      assert.equal(latest[0]?.adId, 'x', 'ordered by how long they have been running');
      assert.equal(latest[0]?.daysRunning, 40, 'and it is the most recent sighting, not the first');
    });
  });

  test(`${driverName}: reports round trip and are readable by category`, async () => {
    await withCorpus(async (c) => {
      await c.saveReport({
        productUrl: 'https://example.com/shoe',
        productTitle: 'Trail Shoe',
        category: 'running shoes',
        markdown: '# report',
        findings: { themes: ['sizing'] },
        costUsd: 0.0143,
      });
      const prior = await c.priorReports('running shoes');
      assert.equal(prior.length, 1);
      assert.equal(prior[0]?.productTitle, 'Trail Shoe');
      assert.deepEqual(prior[0]?.findings, { themes: ['sizing'] });
    });
  });

  /*
   * Report snapshots. The property that matters is byte identity: the payload
   * a caller fetches after a restart must be the bytes the report actually
   * said, which is why the driver stores a string and never an object.
   */
  test(`${driverName}: a report snapshot round trips byte for byte`, async () => {
    await withCorpus(async (c) => {
      const payload = JSON.stringify({ id: 'rep_0123456789abcdef', findings: [{ term: 'price' }] }, null, 2);
      await c.saveReportSnapshot({
        reportId: 'rep_0123456789abcdef',
        tenantId: 'tenant-a',
        category: 'running shoes',
        status: 'complete',
        payload,
      });

      const stored = await c.getReportSnapshot('rep_0123456789abcdef');
      assert.equal(stored?.payload, payload, 'the exact bytes, two space indentation included');
      assert.equal(stored?.status, 'complete');
      assert.equal(stored?.tenantId, 'tenant-a');
      assert.equal(stored?.category, 'running shoes');

      assert.equal(await c.getReportSnapshot('rep_ffffffffffffffff'), null, 'an unknown id is null, not an error');
    });
  });

  /*
   * Monitors. The tenancy rules mirror priorReports exactly: exact match,
   * undefined means the NULL tenant, forgetting fails closed. The due scan is
   * the one operator-scope read, because the scheduler serves every tenant.
   */
  test(`${driverName}: a monitor is tenant owned in every direction`, async () => {
    await withCorpus(async (c) => {
      await c.createMonitor({
        monitorId: 'mon_aaaaaaaaaaaaaaaa', tenantId: 'key-1', keyLabel: 'key-1',
        subject: 'running shoes', terms: ['sizing', 'price'],
        webhookUrl: 'https://example.test/hook', intervalSeconds: 86_400,
      });

      const mine = await c.listMonitors('key-1');
      assert.equal(mine.length, 1);
      assert.equal(mine[0]?.subject, 'running shoes');
      assert.deepEqual(mine[0]?.terms, ['sizing', 'price'], 'terms round trip through storage');
      assert.equal(mine[0]?.lastFiredAt, 0, 'a fresh monitor is immediately due');

      assert.deepEqual(await c.listMonitors('key-2'), [], 'another tenant sees nothing');
      assert.deepEqual(await c.listMonitors(), [], 'the NULL tenant is its own tenant, not a wildcard');

      assert.equal(await c.deleteMonitor('mon_aaaaaaaaaaaaaaaa', 'key-2'), 0,
        'another tenant cannot delete it either');
      assert.equal(await c.deleteMonitor('mon_aaaaaaaaaaaaaaaa', 'key-1'), 1);
      assert.deepEqual(await c.listMonitors('key-1'), []);
    });
  });

  test(`${driverName}: due monitors follow the clock, across every tenant`, async () => {
    await withClock(async (c, clock) => {
      await c.createMonitor({
        monitorId: 'mon_bbbbbbbbbbbbbbbb', tenantId: 'key-1', keyLabel: 'key-1',
        subject: 'standing desks', terms: [], webhookUrl: 'https://example.test/a',
        intervalSeconds: 3_600,
      });
      await c.createMonitor({
        monitorId: 'mon_cccccccccccccccc', tenantId: 'key-2', keyLabel: 'key-2',
        subject: 'air purifiers', terms: [], webhookUrl: 'https://example.test/b',
        intervalSeconds: 3_600,
      });

      const due = await c.dueMonitors(clock.now());
      assert.deepEqual(due.map((m) => m.monitorId).sort(),
        ['mon_bbbbbbbbbbbbbbbb', 'mon_cccccccccccccccc'],
        'the scheduler sees every tenant, which is its job');

      await c.markMonitorFired('mon_bbbbbbbbbbbbbbbb', clock.now(), 'rep_1234567812345678');
      assert.deepEqual((await c.dueMonitors(clock.now())).map((m) => m.monitorId),
        ['mon_cccccccccccccccc'], 'a fired monitor is not due again yet');

      clock.advanceSeconds(3_601);
      const later = await c.dueMonitors(clock.now());
      assert.equal(later.length, 2, 'the interval elapsed and it is due again');
      const fired = later.find((m) => m.monitorId === 'mon_bbbbbbbbbbbbbbbb');
      assert.equal(fired?.lastResult, 'rep_1234567812345678', 'the last outcome travels with it');
    });
  });

  test(`${driverName}: a snapshot write is idempotent and the first write wins`, async () => {
    await withCorpus(async (c) => {
      await c.saveReportSnapshot({
        reportId: 'rep_aaaaaaaaaaaaaaaa', category: 'running shoes',
        status: 'complete', payload: 'first',
      });
      await c.saveReportSnapshot({
        reportId: 'rep_aaaaaaaaaaaaaaaa', category: 'running shoes',
        status: 'failed', payload: 'second',
      });
      const stored = await c.getReportSnapshot('rep_aaaaaaaaaaaaaaaa');
      assert.equal(stored?.payload, 'first', 'a terminal state happens once; a replay must not rewrite what a caller may have fetched');
      assert.equal(stored?.tenantId, null, 'an absent tenant is the null tenant');
    });
  });

  test(`${driverName}: report counts since a cutoff, per tenant, for the quota replay`, async () => {
    await withClock(async (c, clock) => {
      await c.saveReportSnapshot({
        reportId: 'rep_0000000000000001', tenantId: 'key-1', category: 'shoes',
        status: 'complete', payload: '{}',
      });
      clock.advanceSeconds(4000);
      await c.saveReportSnapshot({
        reportId: 'rep_0000000000000002', tenantId: 'key-1', category: 'shoes',
        status: 'complete', payload: '{}',
      });
      await c.saveReportSnapshot({
        reportId: 'rep_0000000000000003', tenantId: 'key-2', category: 'desks',
        status: 'failed', payload: '{}',
      });
      await c.saveReportSnapshot({
        reportId: 'rep_0000000000000004', category: 'desks',
        status: 'complete', payload: '{}',
      });

      /* An hour back from now: the first snapshot is 4000s old and outside. */
      const counts = await c.reportCountsSince(clock.now() - 3600);
      const byTenant = new Map(counts.map((r) => [r.tenantId, r.count]));
      assert.equal(byTenant.get('key-1'), 1, 'the old report fell out of the window');
      assert.equal(byTenant.get('key-2'), 1, 'a failed report still consumed its quota slot');
      assert.equal(byTenant.get(null), 1, 'the null tenant is a tenant like any other');
    });
  });

  test(`${driverName}: snapshots prune by age and nothing else`, async () => {
    await withClock(async (c, clock) => {
      await c.saveReportSnapshot({
        reportId: 'rep_1111111111111111', category: 'running shoes',
        status: 'complete', payload: 'old',
      });
      clock.advanceDays(31);
      await c.saveReportSnapshot({
        reportId: 'rep_2222222222222222', category: 'running shoes',
        status: 'failed', payload: 'young',
      });

      const removed = await c.pruneReportSnapshots(clock.now() - 30 * 86400);
      assert.equal(removed, 1, 'only the row past the cutoff');
      assert.equal(await c.getReportSnapshot('rep_1111111111111111'), null);
      assert.equal((await c.getReportSnapshot('rep_2222222222222222'))?.payload, 'young', 'a failed report is still a report someone may fetch');
    });
  });

  /*
   * The spend ledger. What matters is the window sum, because that is what
   * seeds the in memory budget on boot: get it wrong and a restart either
   * refills a spent budget or double charges an innocent key.
   */
  test(`${driverName}: spend appends, sums per key inside the window, and prunes by age`, async () => {
    await withClock(async (c, clock) => {
      await c.recordSpend('key-1', 0.25);
      await c.recordSpend('key-1', 0.05);
      await c.recordSpend('key-2', 0.10);
      clock.advanceDays(2);
      await c.recordSpend('key-1', 0.40);

      const window = await c.spendSince(clock.now() - 86_400);
      const key1 = window.find((s) => s.keyLabel === 'key-1');
      assert.ok(Math.abs((key1?.totalUsd ?? 0) - 0.40) < 1e-9, 'only the charge inside the window counts');
      assert.equal(window.find((s) => s.keyLabel === 'key-2'), undefined, 'key-2 spent nothing recently');

      const removed = await c.pruneSpend(clock.now() - 86_400);
      assert.equal(removed, 3, 'the three old rows go, the recent one stays');
      const after = await c.spendSince(0);
      assert.equal(after.length, 1);
      assert.ok(Math.abs((after[0]?.totalUsd ?? 0) - 0.40) < 1e-9);
    });
  });

  test(`${driverName}: a zero or negative charge is refused at the ledger, not recorded`, async () => {
    await withCorpus(async (c) => {
      await c.recordSpend('key-1', 0);
      await c.recordSpend('key-1', -5);
      await c.recordSpend('key-1', Number.NaN);
      assert.deepEqual(await c.spendSince(0), [], 'nothing credit shaped may enter an append only money log');
    });
  });

  test(`${driverName}: the product cache expires rather than serving stale facts`, async () => {
    await withClock(async (c, clock) => {
      await c.cacheProduct({ url: 'https://example.com/shoe', title: 'Shoe', source: 'shopify' }, 'running shoes');

      assert.equal((await c.getProduct('https://example.com/shoe'))?.title, 'Shoe');

      clock.advanceDays(29);
      assert.equal((await c.getProduct('https://example.com/shoe'))?.title, 'Shoe', 'inside the default 30 day budget');

      clock.advanceDays(2);
      assert.equal(await c.getProduct('https://example.com/shoe'), null, 'past it, the cache must not serve stale facts');

      assert.equal(await c.getProduct('https://example.com/never-seen'), null);
    });
  });

  /*
   * The takedown path. A record removed at source has to be removable here, and
   * the full text index has to forget it too, or a deleted comment keeps
   * surfacing in search while resolving to nothing.
   */
  test(`${driverName}: deleting a record removes it from search as well as storage`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([doc({ externalId: 'takedown', text: 'a distinctive phrase worth removing' })], 'running shoes');
      assert.equal((await c.search('distinctive')).length, 1);

      const removed = await c.deleteByExternalId('reddit', 'takedown');
      assert.equal(removed, 1);

      assert.deepEqual(await c.search('distinctive'), [], 'the FTS index must forget it too');
      assert.deepEqual(await c.getByReceiptIds([receiptId('reddit', 'takedown')]), []);
      assert.equal((await c.totals()).docs, 0);
    });
  });

  test(`${driverName}: deleting removes the record from every category it was harvested into`, async () => {
    await withCorpus(async (c) => {
      await c.addDocs([doc({ externalId: 'shared' })], 'running shoes');
      await c.addDocs([doc({ externalId: 'shared' })], 'trail shoes');
      assert.equal(await c.deleteByExternalId('reddit', 'shared'), 2, 'a takedown is not per category');
      assert.equal((await c.totals()).docs, 0);
    });
  });


  test(`${driverName}: A NUL IN A RECORD DOES NOT DISCARD THE BATCH AROUND IT`, async () => {
    /*
     * MEASURED 2026-08-22. A NUL in a doc's text threw on write, and because a
     * batch is one transaction that rolls back, ONE poisoned record discarded
     * every good record beside it. Postgres refuses a NUL in a text column
     * outright, so neither driver survived it.
     *
     * It arrives from upstream rather than from a caller: JSON encodes a NUL as
     * an escape perfectly legally, so any source parsing JSON can hand us one.
     * A harvest we cannot store is a harvest that has to be paid for twice.
     */
    const NUL = String.fromCharCode(0);
    await withCorpus(async (c) => {
      const added = await c.addDocs([
        doc({ externalId: 'clean_1', text: 'the sole separated after a month' }),
        doc({ externalId: 'nul_1', text: `sizing${NUL}runs small` }),
        doc({ externalId: 'clean_2', text: 'the arch support is excellent' }),
      ], 'running shoes');

      assert.equal(added, 3, 'the good records must survive the bad one');

      /* The record is stored, and BOTH halves of it are searchable. A NUL that
       * was deleted rather than replaced would weld the words either side into
       * one that nobody wrote. */
      const [stored] = await c.getByReceiptIds([receiptId('reddit', 'nul_1')]);
      assert.ok(stored, 'the record itself is kept, not dropped');
      assert.equal(stored.text.includes(NUL), false);
      assert.equal(stored.text, 'sizing runs small');

      const hits = await c.search('sizing', { category: 'running shoes' });
      assert.equal(hits.length, 1);
    });
  });

  test(`${driverName}: a newline inside a record is content and survives storage`, async () => {
    /* The query path collapses whitespace because a query is not evidence.
     * This path must not: a forum comment has paragraphs, and this is the only
     * copy of it that will exist. */
    await withCorpus(async (c) => {
      const text = 'first para about sizing\n\nsecond para about durability';
      await c.addDocs([doc({ externalId: 'multi', text })], 'running shoes');
      const [stored] = await c.getByReceiptIds([receiptId('reddit', 'multi')]);
      assert.equal(stored?.text, text);
    });
  });

  test(`${driverName}: a NUL in an ad body does not discard the batch either`, async () => {
    const NUL = String.fromCharCode(0);
    await withCorpus(async (c) => {
      const written = await c.addAdObservations([
        ad({ adId: 'ad_clean' }),
        ad({ adId: 'ad_nul', body: `buy${NUL}now` }),
      ]);
      assert.equal(written, 2);
      const [obs] = await c.adObservations('ad_nul');
      assert.equal(obs?.body, 'buy now');
    });
  });

  /* ---------------------------------------------------------------- */
  /* the tenant boundary on reports                                    */
  /* ---------------------------------------------------------------- */

  /*
   * WHY THESE ARE IN THE SHARED SUITE AND NOT ONLY IN THE RLS TEST.
   *
   * `reports` has carried an RLS policy since 002_rls.sql, and measured
   * 2026-08-23 that policy is INERT in production: the server connects as the
   * table owner, and Postgres exempts an owner from RLS unless FORCE ROW LEVEL
   * SECURITY is set, which it is not. SQLite has no equivalent at all. So the
   * boundary has to hold in the driver, on both drivers, or it does not hold.
   */
  test(`${driverName}: a tenant sees only its own prior reports`, async () => {
    await withCorpus(async (c) => {
      await c.saveReport({ tenantId: 'tenant-a', productUrl: 'https://a.example', productTitle: 'A', category: 'running shoes', markdown: '', findings: { owner: 'a' } });
      await c.saveReport({ tenantId: 'tenant-b', productUrl: 'https://b.example', productTitle: 'B', category: 'running shoes', markdown: '', findings: { owner: 'b' } });

      const a = await c.priorReports('running shoes', 10, 'tenant-a');
      assert.equal(a.length, 1, 'tenant a must not see tenant b');
      assert.deepEqual(a[0]?.findings, { owner: 'a' });

      const b = await c.priorReports('running shoes', 10, 'tenant-b');
      assert.equal(b.length, 1, 'tenant b must not see tenant a');
      assert.deepEqual(b[0]?.findings, { owner: 'b' });
    });
  });

  /*
   * THE FAIL CLOSED CASE, which is the one that matters. Forgetting to pass a
   * tenant must show the single user rows, never everybody's. If undefined
   * meant "no filter" then every future call site that forgot would leak, and
   * they would all look correct in review.
   */
  test(`${driverName}: omitting the tenant sees the null tenant, not every tenant`, async () => {
    await withCorpus(async (c) => {
      await c.saveReport({ tenantId: 'tenant-a', productUrl: 'https://a.example', category: 'running shoes', markdown: '', findings: { owner: 'a' } });
      await c.saveReport({ productUrl: 'https://cli.example', category: 'running shoes', markdown: '', findings: { owner: 'cli' } });

      const unscoped = await c.priorReports('running shoes', 10);
      assert.equal(unscoped.length, 1, 'an omitted tenant must not return another tenant rows');
      assert.deepEqual(unscoped[0]?.findings, { owner: 'cli' });

      /* And explicitly asking for the null tenant is the same thing. */
      assert.deepEqual(await c.priorReports('running shoes', 10, null), unscoped);
    });
  });

  /* The CLI writes no tenant at all, and must keep working exactly as before. */
  test(`${driverName}: a single user corpus is unaffected by the tenant scope`, async () => {
    await withCorpus(async (c) => {
      await c.saveReport({ productUrl: 'https://one.example', productTitle: 'One', category: 'running shoes', markdown: '', findings: { n: 1 } });
      await c.saveReport({ productUrl: 'https://two.example', productTitle: 'Two', category: 'running shoes', markdown: '', findings: { n: 2 } });
      const prior = await c.priorReports('running shoes', 10);
      assert.equal(prior.length, 2);
    });
  });

  /* ---------------------------------------------------------------- */
  /* the webhook delivery queue                                        */
  /* ---------------------------------------------------------------- */

  /*
   * A delivery to enqueue. `nextAttemptAt` defaults to the clock's start so a
   * test that does not care about scheduling gets a row that is immediately
   * due.
   */
  const delivery = (over: Partial<WebhookDeliveryInput> = {}): WebhookDeliveryInput => ({
    reportId: 'rep_0000000000000001',
    tenantId: 'tenant-a',
    keyLabel: 'key-1',
    url: 'https://receiver.example/hook',
    payload: '{"id":"rep_0000000000000001"}',
    nextAttemptAt: 1_700_000_000,
    ...over,
  });

  test(`${driverName}: a delivery round trips with every field intact`, async () => {
    await withClock(async (c, clock) => {
      await c.enqueueDelivery(delivery());
      const [due] = await c.dueDeliveries(clock.now());
      assert.equal(due?.reportId, 'rep_0000000000000001');
      assert.equal(due?.tenantId, 'tenant-a');
      assert.equal(due?.keyLabel, 'key-1');
      assert.equal(due?.url, 'https://receiver.example/hook');
      assert.equal(due?.payload, '{"id":"rep_0000000000000001"}');
      assert.equal(due?.attempts, 0);
      assert.equal(due?.status, 'pending');
      assert.equal(due?.lastStatus, null);
      assert.equal(due?.lastError, null);
      assert.equal(due?.deliveredAt, null);
      assert.equal(due?.createdAt, clock.now());
    });
  });

  /*
   * The property that makes the queue safe to call from a terminal path: a
   * report that somehow finishes twice must not deliver twice, because the
   * second delivery is a duplicate POST to a customer.
   */
  test(`${driverName}: enqueueing the same report twice yields one delivery`, async () => {
    await withClock(async (c, clock) => {
      await c.enqueueDelivery(delivery());
      await c.enqueueDelivery(delivery({ url: 'https://elsewhere.example/hook' }));
      const due = await c.dueDeliveries(clock.now());
      assert.equal(due.length, 1);
      assert.equal(due[0]?.url, 'https://receiver.example/hook', 'the first enqueue wins, the second is ignored');
    });
  });

  /* A row that is not due yet must not be handed out early, or the schedule
   * this table exists to hold is not a schedule. */
  test(`${driverName}: a delivery is invisible until its next attempt falls due`, async () => {
    await withClock(async (c, clock) => {
      await c.enqueueDelivery(delivery({ nextAttemptAt: clock.now() + 300 }));
      assert.equal((await c.dueDeliveries(clock.now())).length, 0);
      clock.advanceSeconds(299);
      assert.equal((await c.dueDeliveries(clock.now())).length, 0);
      clock.advanceSeconds(1);
      assert.equal((await c.dueDeliveries(clock.now())).length, 1, 'due at exactly the appointed second');
    });
  });

  test(`${driverName}: due deliveries come back oldest first and respect the limit`, async () => {
    await withClock(async (c, clock) => {
      await c.enqueueDelivery(delivery({ reportId: 'rep_000000000000000c', nextAttemptAt: clock.now() + 20 }));
      await c.enqueueDelivery(delivery({ reportId: 'rep_000000000000000a', nextAttemptAt: clock.now() }));
      await c.enqueueDelivery(delivery({ reportId: 'rep_000000000000000b', nextAttemptAt: clock.now() + 10 }));
      clock.advanceSeconds(60);

      const all = await c.dueDeliveries(clock.now());
      assert.deepEqual(all.map((d) => d.reportId), [
        'rep_000000000000000a', 'rep_000000000000000b', 'rep_000000000000000c',
      ]);
      assert.equal((await c.dueDeliveries(clock.now(), 2)).length, 2);
    });
  });

  /* A failed attempt goes back in the queue at its new time, carrying what
   * happened, and does not come back before then. */
  test(`${driverName}: a failed attempt is rescheduled and its outcome recorded`, async () => {
    await withClock(async (c, clock) => {
      await c.enqueueDelivery(delivery());
      await c.recordDeliveryAttempt('rep_0000000000000001', {
        status: 'pending',
        attempts: 1,
        nextAttemptAt: clock.now() + 5,
        lastStatus: 500,
        lastError: 'receiver returned 500',
      });

      assert.equal((await c.dueDeliveries(clock.now())).length, 0, 'not due again yet');
      clock.advanceSeconds(5);
      const [retry] = await c.dueDeliveries(clock.now());
      assert.equal(retry?.attempts, 1);
      assert.equal(retry?.status, 'pending');
      assert.equal(retry?.lastStatus, 500);
      assert.equal(retry?.lastError, 'receiver returned 500');
      assert.equal(retry?.deliveredAt, null);
    });
  });

  /* THE ONE THAT MATTERS. A delivered row must never be handed out again,
   * whatever the clock does, because that is a duplicate POST to a customer. */
  test(`${driverName}: a delivered delivery never becomes due again`, async () => {
    await withClock(async (c, clock) => {
      await c.enqueueDelivery(delivery());
      await c.recordDeliveryAttempt('rep_0000000000000001', {
        status: 'delivered',
        attempts: 1,
        nextAttemptAt: clock.now(),
        lastStatus: 200,
        deliveredAt: clock.now(),
      });
      clock.advanceDays(30);
      assert.deepEqual(await c.dueDeliveries(clock.now()), []);
    });
  });

  test(`${driverName}: an exhausted delivery never becomes due again either`, async () => {
    await withClock(async (c, clock) => {
      await c.enqueueDelivery(delivery());
      await c.recordDeliveryAttempt('rep_0000000000000001', {
        status: 'exhausted',
        attempts: 10,
        nextAttemptAt: clock.now(),
        lastError: 'gave up after 10 attempts',
      });
      clock.advanceDays(30);
      assert.deepEqual(await c.dueDeliveries(clock.now()), []);
    });
  });

  /*
   * Pruning keeps the table bounded, and the rule it must not break is that a
   * pending row is never dropped however old. The schedule runs to roughly 75
   * hours, so an instance that slept through most of it must still find its
   * work when it wakes.
   */
  test(`${driverName}: pruning removes settled rows and never a pending one`, async () => {
    await withClock(async (c, clock) => {
      await c.enqueueDelivery(delivery({ reportId: 'rep_00000000000000d1' }));
      await c.enqueueDelivery(delivery({ reportId: 'rep_00000000000000d2' }));
      await c.enqueueDelivery(delivery({ reportId: 'rep_00000000000000p1' }));
      await c.recordDeliveryAttempt('rep_00000000000000d1', {
        status: 'delivered', attempts: 1, nextAttemptAt: clock.now(), deliveredAt: clock.now(),
      });
      await c.recordDeliveryAttempt('rep_00000000000000d2', {
        status: 'exhausted', attempts: 10, nextAttemptAt: clock.now(),
      });

      clock.advanceDays(30);
      const removed = await c.pruneDeliveries(clock.now());
      assert.equal(removed, 2, 'both settled rows go');

      const stillPending = await c.dueDeliveries(clock.now());
      assert.equal(stillPending.length, 1);
      assert.equal(stillPending[0]?.reportId, 'rep_00000000000000p1', 'a pending row survives any age');
    });
  });

  test(`${driverName}: pruning leaves a settled row that is newer than the cutoff`, async () => {
    await withClock(async (c, clock) => {
      await c.enqueueDelivery(delivery());
      await c.recordDeliveryAttempt('rep_0000000000000001', {
        status: 'delivered', attempts: 1, nextAttemptAt: clock.now(), deliveredAt: clock.now(),
      });
      assert.equal(await c.pruneDeliveries(clock.now() - 1), 0);
    });
  });

  test(`${driverName}: an empty queue is empty rather than throwing`, async () => {
    await withCorpus(async (c) => {
      assert.deepEqual(await c.dueDeliveries(2_000_000_000), []);
      assert.equal(await c.pruneDeliveries(2_000_000_000), 0);
      /* Recording against a row that is not there is a no op, not a crash. */
      await c.recordDeliveryAttempt('rep_00000000000000ff', {
        status: 'delivered', attempts: 1, nextAttemptAt: 0,
      });
    });
  });

  test(`${driverName}: the corroboration threshold is a shared constant, not a local guess`, () => {
    assert.equal(MIN_RECEIPTS, 3);
  });
}
