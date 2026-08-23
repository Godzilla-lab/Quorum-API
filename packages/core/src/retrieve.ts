/*
 * Retrieval across every configured source.
 *
 * This is the stage that has to survive contact with reality. A real run takes
 * minutes and can take the better part of an hour on a cold category, it talks
 * to half a dozen upstreams that each fail differently, and nobody is watching
 * it. So the design rules are about what happens when things go wrong, not
 * about the happy path.
 *
 *   ONE SOURCE FAILING NEVER FAILS THE RUN. A report missing its ads leg is
 *   still a good report. Silently returning one that LOOKS complete is the
 *   failure worth engineering against, so every degradation is recorded and
 *   reported rather than swallowed.
 *
 *   WRITES ARE INCREMENTAL. A run that dies at minute forty still leaves the
 *   corpus better than it found it, and the next run starts warmer. On a long
 *   run this is the difference between losing an hour and losing nothing.
 *
 *   EVERYTHING IS BOUNDED. A deadline, a per source record cap and a total cap,
 *   because an unbounded loop over a paginating upstream is how a thirty minute
 *   run becomes a six hour one.
 *
 *   CANCELLATION IS CHECKED BETWEEN QUERIES, not just at the start. A cancelled
 *   report has to stop spending, and on a metered source that is money.
 */

import type { CorpusDriver, DocInput } from '@quorum/corpus';
import type { Ctx, PlanInput, Query, Source } from '@quorum/sources';
import { isRelevantRecord, subjectTerms } from '@quorum/sources';

export interface SourceOutcome {
  sourceId: string;
  status: 'ok' | 'skipped' | 'degraded';
  /* Why, in words a caller can show a customer. */
  reason?: string;
  queriesPlanned: number;
  queriesRun: number;
  recordsSeen: number;
  recordsGated: number;
  recordsWritten: number;
  elapsedMs: number;
}

export interface RetrievalResult {
  category: string;
  outcomes: SourceOutcome[];
  totalWritten: number;
  totalSeen: number;
  elapsedMs: number;
  /* Sources that produced nothing usable, for the degraded block in a report. */
  degraded: { source: string; reason: string; impact: string }[];
  stoppedEarly: 'deadline' | 'cancelled' | 'record-cap' | null;
}

export interface RetrieveOptions {
  sources: Source[];
  corpus: CorpusDriver;
  plan: PlanInput;
  ctx: Ctx;

  /* Wall clock budget for the whole retrieval. Default one hour. */
  deadlineMs?: number;
  /* Cap per source, so one chatty upstream cannot crowd out the others. */
  maxRecordsPerSource?: number;
  /* Cap overall, so a run always terminates. */
  maxRecordsTotal?: number;
  /* Cap queries per source, mostly to keep probe runs polite. */
  maxQueriesPerSource?: number;
  /* Records are written in batches of this size as they arrive. */
  batchSize?: number;
  onProgress?: (update: { source: string; seen: number; written: number; query: string }) => void;
}

const DEFAULTS = {
  /* A long research run is a real thing. An unbounded one is a bug. */
  deadlineMs: 60 * 60 * 1000,
  maxRecordsPerSource: 5000,
  maxRecordsTotal: 20_000,
  maxQueriesPerSource: 60,
  batchSize: 100,
};

export async function retrieveAll(options: RetrieveOptions): Promise<RetrievalResult> {
  const {
    sources, corpus, plan, ctx,
    deadlineMs = DEFAULTS.deadlineMs,
    maxRecordsPerSource = DEFAULTS.maxRecordsPerSource,
    maxRecordsTotal = DEFAULTS.maxRecordsTotal,
    maxQueriesPerSource = DEFAULTS.maxQueriesPerSource,
    batchSize = DEFAULTS.batchSize,
    onProgress,
  } = options;

  const startedAt = Date.now();
  const deadline = startedAt + deadlineMs;
  const outcomes: SourceOutcome[] = [];
  const degraded: RetrievalResult['degraded'] = [];

  /*
   * Gate on the subject, search on the questions. Passing the question terms in
   * here is circular and passes everything by construction.
   */
  const subject = subjectTerms([plan.category, plan.productTitle]);
  const subjectPhrases = [plan.category, plan.productTitle].filter((p) => p.trim().length > 0);

  let totalWritten = 0;
  let totalSeen = 0;
  let stoppedEarly: RetrievalResult['stoppedEarly'] = null;

  const outOfTime = (): boolean => Date.now() >= deadline;
  const cancelled = (): boolean => ctx.signal?.aborted === true;

  for (const [index, source] of sources.entries()) {
    if (cancelled()) { stoppedEarly = 'cancelled'; break; }
    if (outOfTime()) { stoppedEarly = 'deadline'; break; }
    if (totalWritten >= maxRecordsTotal) { stoppedEarly = 'record-cap'; break; }

    /*
     * A FAIR SHARE OF THE TOTAL, SO ONE SOURCE CANNOT STARVE THE REST.
     *
     * Measured 2026-08-22: a run with a 300 record total cap had Reddit consume
     * all 300 in its first two queries, and Hacker News never executed. For a
     * product whose entire thesis is composing sources, a cap that silently
     * turns a two source run into a one source run is worse than no cap.
     *
     * Recomputed against the sources still to come rather than fixed up front,
     * so a source that finds little hands its slack to the next one instead of
     * stranding it.
     */
    const remainingSources = sources.length - index;
    const fairShare = Math.max(1, Math.ceil((maxRecordsTotal - totalWritten) / remainingSources));
    const sourceBudget = Math.min(maxRecordsPerSource, fairShare);

    const sourceStart = Date.now();
    const outcome: SourceOutcome = {
      sourceId: source.id,
      status: 'ok',
      queriesPlanned: 0, queriesRun: 0,
      recordsSeen: 0, recordsGated: 0, recordsWritten: 0,
      elapsedMs: 0,
    };

    /*
     * An unconfigured source is skipped, not failed. A missing key degrades a
     * run and never fails it, and someone with no keys at all still gets a
     * report.
     */
    if (!source.configured(ctx.env)) {
      outcome.status = 'skipped';
      outcome.reason = 'not configured';
      outcome.elapsedMs = Date.now() - sourceStart;
      outcomes.push(outcome);
      degraded.push({
        source: source.id,
        reason: 'not_configured',
        impact: `no ${source.id} evidence in this report`,
      });
      continue;
    }

    let queries: Query[] = [];
    try {
      queries = await source.plan(plan);
      outcome.queriesPlanned = queries.length;
    } catch (err) {
      /*
       * Planning talks to the network for some sources, so it fails like
       * anything else. The run continues without this source.
       */
      outcome.status = 'degraded';
      outcome.reason = `planning failed: ${err instanceof Error ? err.message : 'unknown'}`;
      outcome.elapsedMs = Date.now() - sourceStart;
      outcomes.push(outcome);
      degraded.push({ source: source.id, reason: 'plan_failed', impact: `no ${source.id} evidence in this report` });
      continue;
    }

    if (!queries.length) {
      outcome.status = 'degraded';
      outcome.reason = 'planned no queries';
      outcome.elapsedMs = Date.now() - sourceStart;
      outcomes.push(outcome);
      degraded.push({ source: source.id, reason: 'no_queries', impact: `no ${source.id} evidence in this report` });
      continue;
    }

    let batch: DocInput[] = [];
    const flush = async (): Promise<void> => {
      if (!batch.length) return;
      const written = await corpus.addDocs(batch, plan.category);
      outcome.recordsWritten += written;
      totalWritten += written;
      batch = [];
    };

    for (const query of queries.slice(0, maxQueriesPerSource)) {
      /* Checked between queries, not only at the start: a cancelled report has
       * to stop spending, and on a metered source that is money. */
      if (cancelled()) { stoppedEarly = 'cancelled'; break; }
      if (outOfTime()) { stoppedEarly = 'deadline'; break; }
      if (outcome.recordsSeen >= maxRecordsPerSource) break;
      if (outcome.recordsWritten >= sourceBudget) break;
      if (totalWritten >= maxRecordsTotal) { stoppedEarly = 'record-cap'; break; }

      outcome.queriesRun++;

      try {
        for await (const record of source.retrieve(query, ctx)) {
          outcome.recordsSeen++;
          totalSeen++;

          /*
           * The gate. Everything stored is trusted by every later run, so an off
           * topic record is not a bad row, it is permanent corpus poison.
           */
          /*
           * A second gate, after the source's own. Sources that are already
           * scoped (a subreddit is itself a filter) use term mode; a source
           * that searched a general index has already applied phrase mode to
           * itself. This one is the backstop for anything that did neither.
           */
          if (!isRelevantRecord(record.text, record.channel ?? '', subject, {
            phrases: subjectPhrases,
            /*
             * The source declares what its channel is. Without this the gate
             * treats a subreddit name as prose, and a community that prefix
             * matches one subject word vouches for every record in it.
             */
            channelKind: source.channelKind,
          })) {
            outcome.recordsGated++;
            continue;
          }

          batch.push(record);
          if (batch.length >= batchSize) await flush();
          if (outcome.recordsSeen >= maxRecordsPerSource) break;
          if (outcome.recordsWritten + batch.length >= sourceBudget) break;
          /*
           * CHECKED HERE AND NOT ONLY BETWEEN QUERIES.
           *
           * `totalWritten` only moves on a flush, and a flush is every 100
           * records, so a cap tested between queries overshoots by up to a
           * whole batch. Measured live 2026-08-22: --max-records 60 stored 110,
           * which is 83% over a number the help text calls a hard cap. Counting
           * the unflushed batch makes the word true.
           */
          if (totalWritten + batch.length >= maxRecordsTotal) { stoppedEarly = 'record-cap'; break; }
        }
      } catch (err) {
        /*
         * A single query failing is not the source failing. Record it, keep the
         * records already gathered, and move to the next query.
         */
        ctx.log?.(`${source.id}: query "${query.text}" failed: ${err instanceof Error ? err.message : 'unknown'}`);
        outcome.status = 'degraded';
        outcome.reason = 'some queries failed';
      }

      onProgress?.({
        source: source.id,
        seen: outcome.recordsSeen,
        written: outcome.recordsWritten,
        query: query.text,
      });
    }

    await flush();

    /*
     * A source that produced no evidence goes in the degraded block whatever
     * route it took to get there.
     *
     * An earlier version only reported this when the status was still `ok`,
     * which meant a source that failed LOUDLY, by throwing, was left out of the
     * block entirely while a source that quietly returned nothing was included.
     * Exactly backwards, and it produced a report that looked complete while a
     * leg had crashed. Caught by a test on 2026-08-22.
     */
    if (outcome.recordsWritten === 0) {
      if (outcome.status === 'ok') {
        outcome.status = 'degraded';
        outcome.reason = outcome.recordsGated > 0
          ? `every record was off topic (${outcome.recordsGated} gated)`
          : 'returned nothing';
      }
      const reason = outcome.recordsGated > 0 ? 'all_off_topic'
        : outcome.reason?.includes('failed') ? 'retrieve_failed'
          : 'empty';
      degraded.push({
        source: source.id,
        reason,
        impact: `no ${source.id} evidence in this report`,
      });
    }

    outcome.elapsedMs = Date.now() - sourceStart;
    outcomes.push(outcome);
    if (stoppedEarly) break;
  }

  /*
   * The cap announces itself even when every source got its fair share and
   * stopped politely. Without this, a run truncated by the cap looks identical
   * to a run that simply found that much, and a caller cannot tell whether
   * asking for more would return more.
   */
  if (!stoppedEarly && totalWritten >= maxRecordsTotal) stoppedEarly = 'record-cap';

  /*
   * A SOURCE THAT NEVER RAN IS STILL REPORTED.
   *
   * When retrieval stops early, every source after the break used to vanish:
   * absent from `outcomes`, absent from `degraded`, and therefore invisible to
   * a caller who has no way to know it was supposed to run. Measured 2026-08-22
   * on a real run where Hacker News simply was not in the response.
   *
   * That is the failure this file's own header warns about, committed by the
   * file itself: a report that LOOKS complete while a leg is missing. A hole
   * that declares itself is a good report. A hole that does not is a lie.
   */
  if (stoppedEarly) {
    const ran = new Set(outcomes.map((o) => o.sourceId));
    for (const source of sources) {
      if (ran.has(source.id)) continue;
      outcomes.push({
        sourceId: source.id,
        status: 'skipped',
        reason: `never ran, retrieval stopped early: ${stoppedEarly}`,
        queriesPlanned: 0, queriesRun: 0,
        recordsSeen: 0, recordsGated: 0, recordsWritten: 0,
        elapsedMs: 0,
      });
      degraded.push({
        source: source.id,
        reason: 'not_reached',
        impact: `no ${source.id} evidence in this report`,
      });
    }
  }

  return {
    category: plan.category,
    outcomes,
    totalWritten,
    totalSeen,
    elapsedMs: Date.now() - startedAt,
    degraded,
    stoppedEarly,
  };
}
