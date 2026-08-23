#!/usr/bin/env node
/*
 * The dev server. The only file in this package that touches the real world.
 *
 *   npm run dev -w packages/server
 *   QUORUM_CORPUS=./quorum.db QUORUM_API_KEYS=key1,key2 PORT=8787
 *
 * With no keys configured it runs open, which is the right default for a self
 * hosted instance on a laptop and the wrong one for anything reachable. It says
 * so on startup rather than leaving that to be discovered.
 *
 * WHY THIS FILE IMPORTS THE CLI, AND WHY THAT IS DEBT RATHER THAN DESIGN.
 *
 * `runResearch` is the pipeline: plan, retrieve, gate, render. By the
 * architecture in CLAUDE.md it belongs in `core`, and the CLI is supposed to be
 * a thin client over it. It currently lives in `packages/cli/src/run.ts`
 * because the CLI was the first caller, and the server needing it is the proof
 * that it is in the wrong package.
 *
 * It is imported here rather than moved today for one reason: the job queue is
 * generic over an injected runner, so the wrong edge is confined to this one
 * wiring file and nothing in the library depends on it. Moving `runResearch`
 * into core is on the todo, and it has to happen before the SDK ships.
 */

import process from 'node:process';
import { openSqliteCorpus } from '@quorum/corpus';
import { isWarm } from '@quorum/corpus/constants';
import { runResearch, type RunResult } from '@quorum/cli';
import { SOURCE_IDS, findProductByName, makeAdSource, makeSource, resolveSubject } from '@quorum/sources';
import { createReceiptsServer, hashKey } from './http.ts';
import { createJobQueue, type ReportRequest, type RunOutcome } from './jobs.ts';
import type { RetrievalResult } from '@quorum/core';
import { computeClaims } from './claims.ts';

const port = Number(process.env['PORT'] ?? 8787);
const corpusPath = process.env['QUORUM_CORPUS'] ?? './quorum.db';

const keys = (process.env['QUORUM_API_KEYS'] ?? '').split(',').map((k) => k.trim()).filter(Boolean);
const keyHashes = new Map(keys.map((k, i) => [hashKey(k), `key-${i + 1}`]));

/*
 * Two, and it is not a performance dial. Every concurrent run is concurrent
 * pressure on the same volunteer archives, and the shared polite client is what
 * keeps us welcome there. Raising it raises their load, not ours.
 */
const concurrency = Number(process.env['QUORUM_CONCURRENCY'] ?? 2);

const corpus = openSqliteCorpus({ path: corpusPath });

/* Measured 2026-08-22: a warm category answers in about 0.1s and a cold run
 * took 39.9s to 75.7s end to end. Rounded rather than averaged, because an
 * estimate that looks precise invites someone to build a timeout on it. */
const WARM_SECONDS = 2;
const COLD_SECONDS = 60;

const queue = createJobQueue({
  concurrency,

  async runReport(request: ReportRequest, ctx): Promise<RunOutcome> {
    /*
     * A FRESH CORPUS HANDLE PER RUN, because `runResearch` closes the corpus it
     * was given in a `finally`. Handing it the long lived one would close the
     * database out from under every other request the moment a report finished.
     */
    const result: RunResult = await runResearch(
      {
        subject: request.subject,
        terms: request.terms,
        communities: request.communities,
        sources: request.sources.length ? request.sources : [...SOURCE_IDS],
        adSources: request.includeAds ? ['meta-ads-apify'] : [],
        corpusPath,
        maxQueriesPerSource: 6,
        maxRecordsTotal: 20_000,
        /*
         * Never from the hosted path. A comparison is one full retrieval per
         * rival, so a request naming five of them is five reports charged as
         * one, and the caller who paid for the subject did not ask for that.
         */
        compare: [],
        deadlineMs: request.deadlineMs ?? 60 * 60_000,
        capUsd: request.capUsd,
        offline: request.offline,
        readImages: false,
        maxImages: 2,
        synthesise: false,
        synthesisModel: undefined,
        format: 'json',
        asOf: undefined,
        json: true,
        quiet: true,
      },
      {
        openCorpus: (path) => openSqliteCorpus({ path }),
        resolveSubject,
        makeSource,
        makeAdSource,
        findProductByName: (name) => findProductByName(name, { timeoutMs: 15_000 }),
        env: process.env,
        signal: ctx.signal,
        onProgress: (line) => ctx.onStage('progress', line),
      },
    );

    for (const degradation of result.retrieval?.degraded ?? []) ctx.onDegraded(degradation);

    return {
      subject: result.subject,
      category: result.category,
      subjectResolved: result.subject.source === 'page' || result.subject.source === 'catalogue',
      retrieval: result.retrieval,
      warmth: result.warmth,
      degraded: result.retrieval?.degraded ?? [],
      cost: result.cost,
      attested: result.attested,
      gaps: result.gaps,
      silence: result.silence,
      formats: result.formats,
      durationBasis: result.durationBasis,
    };
  },

  /*
   * One call per REPORT, not per run. This is what stops a joiner inheriting
   * somebody else's questions, and the outcome goes in whole so that a
   * report's sufficiency block agrees with its own retrieval table.
   */
  claimsFor: (outcome, terms) => computeClaims({
    corpus,
    category: outcome.category,
    terms,
    retrieval: outcome.retrieval as RetrievalResult | null,
    subjectResolved: outcome.subjectResolved,
  }),

  async estimateSeconds(category) {
    const stats = await corpus.categoryStats(category);
    return isWarm(stats.docs, stats.ageDays) ? WARM_SECONDS : COLD_SECONDS;
  },
});

const server = createReceiptsServer({ corpus, keyHashes, requireAuth: keyHashes.size > 0, queue });

server.listen(port, () => {
  process.stderr.write(`quorum api on http://localhost:${port}, corpus ${corpusPath}\n`);
  if (!keyHashes.size) {
    process.stderr.write('no QUORUM_API_KEYS set, so this instance is OPEN. Fine on a laptop, not on a network.\n');
  }
  process.stderr.write(`reports: live, ${concurrency} concurrent runs, coalesced by subject\n`);
  process.stderr.write('live: /v1/reports /v1/reports/:id /v1/reports/:id/stream /v1/healthz /v1/evidence/:id\n');
  process.stderr.write('      /v1/evidence/batch /v1/evidence/search /v1/verify /v1/categories/:slug /v1/evidence/ads/:id\n');
});

const shutdown = (): void => {
  /* Runs are aborted rather than left spending on a process that is going
   * away. Records already retrieved stay in the corpus: a run that dies at
   * minute forty still leaves the archive better than it found it. */
  queue.shutdown();
  server.close(() => { void corpus.close().then(() => process.exit(0)); });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
