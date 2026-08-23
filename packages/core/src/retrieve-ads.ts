/*
 * Ad retrieval, and why it is a separate orchestrator rather than a branch
 * inside the record one.
 *
 * Records upsert. Ads append. That is not a storage detail, it is the entire
 * value of the source: observing an ad today and again in thirty days is the
 * only evidence that will ever exist that it ran for thirty days, because Meta
 * destroys inactive commercial ads. Routing ads through the record path is
 * exactly the bug the engine shipped, and it silently discarded every
 * observation after the first.
 *
 * Two things differ from `retrieveAll` and both are deliberate.
 *
 *   NO TEXT GATE. Records are gated on the subject because a source can hand
 *   back anything. Ads are scoped by WHICH ADVERTISER was asked for, because
 *   measurement on 2026-08-22 showed no text threshold separates a real
 *   competitor from a cholesterol supplement whose body copy happens to mention
 *   running and shoes. Scoping lives in the query, and the adapter owns its own
 *   backstop.
 *
 *   EVERY QUERY COSTS MONEY. So the deadline and the caps are not politeness,
 *   they are a spend control, and the meter is checked by the adapter before
 *   each call rather than after.
 */

import type { AdObservationInput, CorpusDriver } from '@receipts/corpus';
import type { AdSource, Ctx, PlanInput } from '@receipts/sources';
import type { SourceOutcome } from './retrieve.ts';
import { resolveAdDuration, type DurationResolvedAd } from './ad-duration.ts';

export interface AdRetrievalResult {
  category: string;
  outcomes: SourceOutcome[];
  totalObserved: number;
  elapsedMs: number;
  degraded: { source: string; reason: string; impact: string }[];
  stoppedEarly: 'deadline' | 'cancelled' | 'record-cap' | null;
}

export interface RetrieveAdsOptions {
  sources: AdSource[];
  corpus: CorpusDriver;
  plan: PlanInput;
  ctx: Ctx;
  deadlineMs?: number;
  maxAdsPerSource?: number;
  maxAdsTotal?: number;
  batchSize?: number;
  onProgress?: (update: { source: string; observed: number; query: string }) => void;
}

const DEFAULTS = {
  /* Shorter than the record deadline. An ads leg that has not answered in ten
   * minutes is not going to, and it is burning credit while it tries. */
  deadlineMs: 10 * 60 * 1000,
  maxAdsPerSource: 500,
  maxAdsTotal: 1000,
  batchSize: 50,
};

export async function retrieveAds(options: RetrieveAdsOptions): Promise<AdRetrievalResult> {
  const {
    sources, corpus, plan, ctx,
    deadlineMs = DEFAULTS.deadlineMs,
    maxAdsPerSource = DEFAULTS.maxAdsPerSource,
    maxAdsTotal = DEFAULTS.maxAdsTotal,
    batchSize = DEFAULTS.batchSize,
    onProgress,
  } = options;

  const startedAt = Date.now();
  const deadline = startedAt + deadlineMs;
  const outcomes: SourceOutcome[] = [];
  const degraded: AdRetrievalResult['degraded'] = [];

  let totalObserved = 0;
  let stoppedEarly: AdRetrievalResult['stoppedEarly'] = null;

  const outOfTime = (): boolean => Date.now() >= deadline;
  const cancelled = (): boolean => ctx.signal?.aborted === true;

  for (const source of sources) {
    if (cancelled()) { stoppedEarly = 'cancelled'; break; }
    if (outOfTime()) { stoppedEarly = 'deadline'; break; }
    if (totalObserved >= maxAdsTotal) { stoppedEarly = 'record-cap'; break; }

    const sourceStart = Date.now();
    const outcome: SourceOutcome = {
      sourceId: source.id,
      status: 'ok',
      queriesPlanned: 0, queriesRun: 0,
      /* Ads are not text gated, so this stays zero. See the header. */
      recordsSeen: 0, recordsGated: 0, recordsWritten: 0,
      elapsedMs: 0,
    };

    const finish = (status: SourceOutcome['status'], reason: string, degradeReason: string): void => {
      outcome.status = status;
      outcome.reason = reason;
      outcome.elapsedMs = Date.now() - sourceStart;
      outcomes.push(outcome);
      degraded.push({ source: source.id, reason: degradeReason, impact: 'no competitor ad evidence in this report' });
    };

    /* A missing key degrades a run and never fails it. Someone with no Apify
     * account still gets a report, and it says the ads leg is missing. */
    if (!source.configured(ctx.env)) {
      finish('skipped', 'not configured', 'not_configured');
      continue;
    }

    let queries;
    try {
      queries = await source.plan(plan);
      outcome.queriesPlanned = queries.length;
    } catch (err) {
      finish('degraded', `planning failed: ${err instanceof Error ? err.message : 'unknown'}`, 'plan_failed');
      continue;
    }

    if (!queries.length) {
      finish('degraded', 'planned no queries', 'no_queries');
      continue;
    }

    let batch: AdObservationInput[] = [];
    const flush = async (): Promise<void> => {
      if (!batch.length) return;
      /*
       * APPEND ONLY. Every call records new observations and nothing is
       * deduplicated away, which is what makes a duration derivable later.
       */
      const written = await corpus.addAdObservations(batch);
      outcome.recordsWritten += written;
      batch = [];
    };

    for (const query of queries) {
      if (cancelled()) { stoppedEarly = 'cancelled'; break; }
      if (outOfTime()) { stoppedEarly = 'deadline'; break; }
      if (outcome.recordsSeen >= maxAdsPerSource) break;
      if (totalObserved >= maxAdsTotal) { stoppedEarly = 'record-cap'; break; }

      outcome.queriesRun++;

      try {
        for await (const ad of source.retrieve(query, ctx)) {
          outcome.recordsSeen++;
          totalObserved++;
          /*
           * The category is attached HERE, not by the adapter, so an ad cannot
           * be filed under a category the run was not about and every ad in a
           * category is comparable by construction.
           */
          batch.push({ ...ad, category: plan.category });
          if (batch.length >= batchSize) await flush();
          if (outcome.recordsSeen >= maxAdsPerSource) break;
        }
      } catch (err) {
        /* A vendor being down degrades a run and never fails it. */
        ctx.log?.(`${source.id}: query "${query.text}" failed: ${err instanceof Error ? err.message : 'unknown'}`);
        outcome.status = 'degraded';
        outcome.reason = 'some queries failed';
      }

      onProgress?.({ source: source.id, observed: outcome.recordsSeen, query: query.text });
    }

    await flush();

    if (outcome.recordsWritten === 0) {
      if (outcome.status === 'ok') {
        outcome.status = 'degraded';
        outcome.reason = 'returned no ads';
      }
      degraded.push({
        source: source.id,
        reason: outcome.reason?.includes('failed') ? 'retrieve_failed' : 'empty',
        impact: 'no competitor ad evidence in this report',
      });
    }

    outcome.elapsedMs = Date.now() - sourceStart;
    outcomes.push(outcome);
    if (stoppedEarly) break;
  }

  return {
    category: plan.category,
    outcomes,
    totalObserved,
    elapsedMs: Date.now() - startedAt,
    degraded,
    stoppedEarly,
  };
}

/*
 * Read the ads back for a category, with each duration derived from the whole
 * observation history rather than from the frozen number on the newest row.
 *
 * One query per ad, which is N+1 and is fine at this scale: a category holds
 * tens of ads, not thousands, and the alternative is a new driver method, which
 * is a corpus interface change for an optimisation nobody has measured a need
 * for. If that stops being true, measure it first and put the number here.
 */
export async function adsForVerdict(
  corpus: CorpusDriver,
  category: string,
  limit = 200,
): Promise<DurationResolvedAd[]> {
  const latest = await corpus.latestAdsByCategory(category, limit);
  const out = [];
  for (const ad of latest) {
    const history = await corpus.adObservations(ad.adId);
    out.push(resolveAdDuration(ad, history));
  }
  return out;
}
