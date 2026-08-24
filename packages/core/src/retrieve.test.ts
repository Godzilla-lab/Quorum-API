import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openSqliteCorpus } from '@quorum/corpus';
import type { Ctx, PlanInput, Query, Source, SourceRecord } from '@quorum/sources';
import { retrieveAll } from './retrieve.ts';

const PLAN: PlanInput = {
  category: 'running shoes',
  productTitle: 'Trail X',
  productUrl: 'https://example.com/x',
  terms: ['sizing', 'comfort'],
};

const record = (i: number, over: Partial<SourceRecord> = {}): SourceRecord => ({
  source: 'reddit', kind: 'comment', externalId: `r${i}`,
  channel: 'running', text: `these running shoes felt narrow after a week, record ${i}`,
  score: 5, url: `https://example.com/${i}`, createdUtc: 1_700_000_000, origin: 'r/running',
  ...over,
});

/* A source built from a script, so each failure mode is one line to express. */
function makeSource(id: string, opts: {
  configured?: boolean;
  queries?: Query[];
  planThrows?: boolean;
  retrieveThrows?: boolean;
  records?: (q: Query) => SourceRecord[];
  onRetrieve?: () => void;
} = {}): Source {
  return {
    id,
    cost: 'free',
    channelKind: 'handle',
    configured: () => opts.configured ?? true,
    async plan() {
      if (opts.planThrows) throw new Error('upstream refused the plan');
      return opts.queries ?? [{ text: 'sizing' }, { text: 'comfort' }];
    },
    async *retrieve(q) {
      opts.onRetrieve?.();
      if (opts.retrieveThrows) throw new Error('connection reset');
      for (const r of opts.records?.(q) ?? [record(1), record(2)]) yield r;
    },
    cite: (r) => ({ label: id, url: r.url ?? '', score: r.score ?? 0, postedAt: r.createdUtc ?? 0 }),
  };
}

const freshCorpus = () => openSqliteCorpus({ path: ':memory:' });
const makeCtx = (over: Partial<Ctx> = {}): Ctx =>
  ({ env: {}, cost: { charge: () => 0, canSpend: () => true }, ...over });

test('records from every source land in the corpus', async () => {
  const corpus = freshCorpus();
  const result = await retrieveAll({
    sources: [makeSource('a'), makeSource('b')],
    corpus, plan: PLAN, ctx: makeCtx(),
  });

  assert.equal(result.outcomes.length, 2);
  assert.ok(result.totalWritten > 0);
  assert.equal((await corpus.totals()).docs, result.totalWritten);
  await corpus.close();
});

/*
 * The live counter and the summary table must agree. Seen live 2026-08-23: a
 * source yielding 99 records never filled the 100 record batch, so every
 * progress line said "0 stored" while the flush after the query loop wrote 89.
 * The last progress line for a source now carries what the corpus holds.
 */
test('a progress line never reports fewer stored than the corpus was given', async () => {
  const corpus = freshCorpus();
  const updates: { source: string; seen: number; written: number }[] = [];
  await retrieveAll({
    sources: [makeSource('small', {
      queries: [{ text: 'sizing' }],
      records: () => [record(1), record(2), record(3)],
    })],
    corpus, plan: PLAN, ctx: makeCtx(),
    onProgress: (u) => updates.push(u),
  });

  const last = updates.at(-1)!;
  assert.equal(last.seen, 3);
  assert.equal(last.written, 3, 'three records well under one batch, reported after the flush');
  assert.equal((await corpus.totals()).docs, 3);
  await corpus.close();
});

/*
 * Counted, never gated on: a record stored on its container's word alone is
 * tallied so a report can say what share of its evidence never names the
 * subject itself. PLAN.category is "running shoes", so the vouching channel
 * here is the handle "running".
 */
test('records that never name the subject are counted as channel vouched', async () => {
  const corpus = freshCorpus();
  const result = await retrieveAll({
    sources: [makeSource('scoped', {
      queries: [{ text: 'sizing' }],
      records: () => [
        record(1, { text: 'Same, had to size up half a size', channel: 'runningshoegeeks' }),
        record(2, { text: 'these running shoes felt narrow after a week', channel: 'runningshoegeeks' }),
      ],
    })],
    corpus, plan: PLAN, ctx: makeCtx(),
  });

  const scoped = result.outcomes.find((o) => o.sourceId === 'scoped')!;
  assert.equal(scoped.recordsWritten, 2, 'both stored: the community vouches for the elliptical one');
  assert.equal(scoped.recordsChannelVouched, 1, 'and exactly one of them never names the subject');
  await corpus.close();
});

/*
 * THE LOAD BEARING RULE. A report missing one leg is still a good report.
 * Silently returning one that LOOKS complete is the failure worth engineering
 * against.
 */
test('one source failing never fails the run, and is reported', async () => {
  const corpus = freshCorpus();
  const result = await retrieveAll({
    sources: [makeSource('broken', { retrieveThrows: true }), makeSource('working')],
    corpus, plan: PLAN, ctx: makeCtx(),
  });

  assert.ok(result.totalWritten > 0, 'the working source still produced evidence');
  const broken = result.outcomes.find((o) => o.sourceId === 'broken');
  assert.equal(broken?.status, 'degraded');
  assert.ok(result.degraded.some((d) => d.source === 'broken'), 'and the report can say so');
  await corpus.close();
});

test('a source whose planning fails does not stop the ones after it', async () => {
  const corpus = freshCorpus();
  const result = await retrieveAll({
    sources: [makeSource('planless', { planThrows: true }), makeSource('working')],
    corpus, plan: PLAN, ctx: makeCtx(),
  });

  assert.equal(result.outcomes.find((o) => o.sourceId === 'planless')?.status, 'degraded');
  assert.ok(result.outcomes.find((o) => o.sourceId === 'working')!.recordsWritten > 0);
  assert.equal(result.degraded[0]?.reason, 'plan_failed');
  await corpus.close();
});

/* A missing key degrades a run and never fails it. */
test('an unconfigured source is skipped, not failed', async () => {
  const corpus = freshCorpus();
  const result = await retrieveAll({
    sources: [makeSource('paid', { configured: false }), makeSource('free')],
    corpus, plan: PLAN, ctx: makeCtx(),
  });

  const paid = result.outcomes.find((o) => o.sourceId === 'paid');
  assert.equal(paid?.status, 'skipped');
  assert.equal(paid?.reason, 'not configured');
  assert.equal(result.degraded[0]?.reason, 'not_configured');
  assert.ok(result.totalWritten > 0, 'someone with no keys at all still gets a report');
  await corpus.close();
});

test('every source failing still returns a result rather than throwing', async () => {
  const corpus = freshCorpus();
  const result = await retrieveAll({
    sources: [makeSource('a', { retrieveThrows: true }), makeSource('b', { planThrows: true })],
    corpus, plan: PLAN, ctx: makeCtx(),
  });

  assert.equal(result.totalWritten, 0);
  assert.equal(result.degraded.length, 2, 'an empty report that explains itself beats an exception');
  await corpus.close();
});

/*
 * On a run that can take the better part of an hour, this is the difference
 * between losing everything and losing nothing.
 */
test('records are written incrementally, so a run that dies keeps what it found', async () => {
  const corpus = freshCorpus();
  let queriesStarted = 0;

  const source = makeSource('flaky', {
    queries: [{ text: 'q1' }, { text: 'q2' }, { text: 'q3' }],
    onRetrieve: () => {
      queriesStarted++;
      if (queriesStarted === 3) throw new Error('died on the third query');
    },
    records: () => [record(queriesStarted * 10), record(queriesStarted * 10 + 1)],
  });

  const result = await retrieveAll({ sources: [source], corpus, plan: PLAN, ctx: makeCtx(), batchSize: 1 });

  assert.ok(result.totalWritten >= 4, 'the first two queries are safely on disk');
  assert.equal((await corpus.totals()).docs, result.totalWritten);
  await corpus.close();
});

/* An off topic record is not a bad row, it is permanent corpus poison. */
test('off topic records are gated out before they reach the corpus', async () => {
  const corpus = freshCorpus();
  const source = makeSource('noisy', {
    queries: [{ text: 'sizing' }],
    records: () => [
      record(1, { text: 'these running shoes run narrow and I sized up', channel: 'r/running' }),
      record(2, { text: 'font sizing in responsive layouts is a mess', channel: 'Grid Style Sheets' }),
      record(3, { text: 'RISC vs CISC instruction sizing tradeoffs', channel: 'RISC vs CISC' }),
    ],
  });

  const result = await retrieveAll({ sources: [source], corpus, plan: PLAN, ctx: makeCtx() });

  assert.equal(result.outcomes[0]?.recordsSeen, 3);
  assert.equal(result.outcomes[0]?.recordsGated, 2);
  assert.equal(result.totalWritten, 1);
  await corpus.close();
});

/*
 * The vouched record check, at the backstop. On a one word subject a record
 * whose text never names the subject passes on its container's word, and with
 * planner vocabulary on the plan it must also use one of those words. See
 * vouchedRecordSpeaksForItself in relevance.ts for the measured scoping.
 */
test('plan context terms reach the backstop gate and reject empty vouched records', async () => {
  const weakPlan: PlanInput = {
    category: 'love', productTitle: 'love', productUrl: '', terms: ['dating'],
  };
  const vouched = () => [
    record(1, { text: 'Met my partner through a climbing club', channel: 'lovewins' }),
    record(2, { text: 'The producers clearly scripted that whole fight', channel: 'lovewins' }),
  ];

  const corpus = freshCorpus();
  const bare = await retrieveAll({
    sources: [makeSource('a', { queries: [{ text: 'dating' }], records: vouched })],
    corpus, plan: weakPlan, ctx: makeCtx(),
  });
  assert.equal(bare.totalWritten, 2, 'without vocabulary the container vouches for both');

  const second = freshCorpus();
  const informed = await retrieveAll({
    sources: [makeSource('a', { queries: [{ text: 'dating' }], records: vouched })],
    corpus: second,
    plan: { ...weakPlan, contextTerms: ['partner', 'dating'] },
    ctx: makeCtx(),
  });
  assert.equal(informed.outcomes[0]?.recordsGated, 1, 'the reality TV chatter is out');
  assert.equal(informed.totalWritten, 1, 'the record speaking the buyer vocabulary survives');
  await corpus.close();
  await second.close();
});

test('a source whose records are all off topic is reported as degraded', async () => {
  const corpus = freshCorpus();
  const source = makeSource('offtopic', {
    queries: [{ text: 'sizing' }],
    records: () => [record(1, { text: 'font sizing in css', channel: 'Grid Style Sheets' })],
  });

  const result = await retrieveAll({ sources: [source], corpus, plan: PLAN, ctx: makeCtx() });
  assert.equal(result.outcomes[0]?.status, 'degraded');
  assert.match(result.outcomes[0]?.reason ?? '', /off topic/);
  assert.equal(result.degraded[0]?.reason, 'all_off_topic');
  await corpus.close();
});

/* A cancelled report has to stop spending, and on a metered source that is money. */
test('cancellation is honoured between queries, not only at the start', async () => {
  const corpus = freshCorpus();
  const controller = new AbortController();
  let queriesRun = 0;

  const source = makeSource('slow', {
    queries: [{ text: 'q1' }, { text: 'q2' }, { text: 'q3' }, { text: 'q4' }],
    onRetrieve: () => { queriesRun++; if (queriesRun === 2) controller.abort(); },
  });

  const result = await retrieveAll({
    sources: [source], corpus, plan: PLAN, ctx: makeCtx({ signal: controller.signal }),
  });

  assert.equal(result.stoppedEarly, 'cancelled');
  assert.ok(queriesRun < 4, 'it stopped rather than running to the end');
  assert.ok(result.totalWritten > 0, 'and it kept what it had already gathered');
  await corpus.close();
});

/* An unbounded loop over a paginating upstream turns 30 minutes into 6 hours. */
test('a deadline stops a long run', async () => {
  const corpus = freshCorpus();
  const result = await retrieveAll({
    sources: [makeSource('a'), makeSource('b')],
    corpus, plan: PLAN, ctx: makeCtx(),
    deadlineMs: -1,
  });

  assert.equal(result.stoppedEarly, 'deadline');
  /*
   * It starts no work it cannot finish, AND it says so. Until 2026-08-22 a
   * source that never ran was simply absent from the response, so a caller had
   * no way to know a leg was missing. A hole that declares itself is a good
   * report; a hole that does not is a lie.
   */
  assert.equal(result.outcomes.every((o) => o.status === 'skipped'), true);
  assert.equal(result.outcomes.every((o) => o.recordsWritten === 0), true);
  assert.deepEqual(result.degraded.map((d) => d.reason), ['not_reached', 'not_reached']);
  await corpus.close();
});

test('a per source cap stops one chatty upstream crowding out the others', async () => {
  const corpus = freshCorpus();
  const source = makeSource('chatty', {
    queries: [{ text: 'q1' }, { text: 'q2' }],
    records: () => Array.from({ length: 50 }, (_, i) => record(i)),
  });

  const result = await retrieveAll({
    sources: [source], corpus, plan: PLAN, ctx: makeCtx(), maxRecordsPerSource: 10,
  });

  assert.ok((result.outcomes[0]?.recordsSeen ?? 0) <= 50);
  assert.ok((result.outcomes[0]?.recordsSeen ?? 0) >= 10);
  await corpus.close();
});

test('a total cap always terminates the run', async () => {
  const corpus = freshCorpus();
  const sources = Array.from({ length: 5 }, (_, i) => makeSource(`s${i}`, {
    queries: [{ text: 'q' }],
    records: () => Array.from({ length: 20 }, (_, n) => record(i * 100 + n)),
  }));

  const result = await retrieveAll({
    sources, corpus, plan: PLAN, ctx: makeCtx(), maxRecordsTotal: 25,
  });

  assert.equal(result.stoppedEarly, 'record-cap');
  assert.ok(result.totalWritten <= 25, `the cap was 25 and ${result.totalWritten} rows were written`);

  /*
   * THE CAP IS SHARED, NOT RACED FOR.
   *
   * This assertion used to read `outcomes.length < 5`, which encoded the old
   * behaviour as if it were desirable: the first source took the whole budget
   * and the rest never ran. Measured on a real run 2026-08-22, that turned a
   * two source report into a one source report and did not say so.
   *
   * Composing sources is the entire thesis of this product, so a cap that
   * silently removes sources is worse than no cap. Every source now gets a
   * share of what is left, and a source that uses little hands the slack on.
   */
  assert.equal(result.outcomes.length, 5, 'every source got a share of the budget');
  assert.ok(
    result.outcomes.every((o) => o.recordsWritten > 0),
    'a capped run must still hear from every source, not just the first',
  );
  await corpus.close();
});

test('progress is reported per query so a long run is not a silent spinner', async () => {
  const corpus = freshCorpus();
  const seen: string[] = [];

  await retrieveAll({
    sources: [makeSource('a', { queries: [{ text: 'q1' }, { text: 'q2' }] })],
    corpus, plan: PLAN, ctx: makeCtx(),
    onProgress: (u) => seen.push(`${u.source}:${u.query}`),
  });

  assert.deepEqual(seen, ['a:q1', 'a:q2']);
  await corpus.close();
});

test('a source planning no queries is degraded rather than silently empty', async () => {
  const corpus = freshCorpus();
  const result = await retrieveAll({
    sources: [makeSource('empty', { queries: [] })],
    corpus, plan: PLAN, ctx: makeCtx(),
  });

  assert.equal(result.outcomes[0]?.status, 'degraded');
  assert.equal(result.degraded[0]?.reason, 'no_queries');
  await corpus.close();
});

test('re-running the same retrieval writes nothing new, which is how warmth is measured', async () => {
  const corpus = freshCorpus();
  const opts = { sources: [makeSource('a')], corpus, plan: PLAN, ctx: makeCtx() };

  const first = await retrieveAll(opts);
  const second = await retrieveAll(opts);

  assert.ok(first.totalWritten > 0);
  assert.equal(second.totalWritten, 0, 'a run that adds nothing has told you the category was already warm');
  assert.ok(second.totalSeen > 0, 'and it still saw the records, it just had them already');
  await corpus.close();
});

test('the total record cap is hard, not a suggestion', async () => {
  /*
   * MEASURED LIVE 2026-08-22, and this test exists because of it: a run with
   * --max-records 60 stored 110. `totalWritten` only advances on a flush, and a
   * flush is every batchSize records, so a cap tested only between queries
   * overshoots by up to a whole batch. The help text calls this a hard cap, so
   * it has to be one.
   */
  const corpus = freshCorpus();
  const result = await retrieveAll({
    sources: [makeSource('a', { records: () => Array.from({ length: 500 }, (_, i) => record(i)) })],
    corpus,
    plan: PLAN,
    ctx: makeCtx(),
    maxRecordsTotal: 60,
  });

  assert.ok(
    result.totalWritten <= 60,
    `the cap was 60 and ${result.totalWritten} rows were written`,
  );
  assert.equal(result.stoppedEarly, 'record-cap');
  await corpus.close();
});

test('the cap counts across sources, not per source', async () => {
  const corpus = freshCorpus();
  const many = (prefix: string) => () =>
    Array.from({ length: 200 }, (_, i) => record(i, { externalId: `${prefix}${i}` }));

  const result = await retrieveAll({
    sources: [makeSource('a', { records: many('a') }), makeSource('b', { records: many('b') })],
    corpus,
    plan: PLAN,
    ctx: makeCtx(),
    maxRecordsTotal: 50,
  });

  assert.ok(result.totalWritten <= 50, `${result.totalWritten} rows written against a cap of 50`);
  await corpus.close();
});
