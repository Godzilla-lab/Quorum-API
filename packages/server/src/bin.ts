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
import { readFileSync } from 'node:fs';
import { createQuotas, DEFAULT_LIMITS } from './quotas.ts';
import { openPostgres } from './postgres.ts';
import { createJobQueue, type ReportRequest, type RunOutcome } from './jobs.ts';
import { checkInstanceSecret, createWebhookWorker } from './webhooks.ts';
import { runCorpusOpener } from './run-corpus.ts';
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

/*
 * THREE CEILINGS ON METERED WORK, AND EACH ONE STOPS A DIFFERENT DISASTER.
 *
 *   per report    one runaway report cannot drain the budget by itself
 *   per key       one caller cannot drain it either
 *   per instance  ALL callers together cannot, which is the only one that
 *                 holds when the metered leg is open to everyone. Without it
 *                 the real ceiling is the per key figure times however many
 *                 keys exist, which is not a ceiling.
 *
 * ALL DEFAULT TO ZERO, WHICH LEAVES ADS OFF. An operator who has not set a
 * budget has not agreed to a bill, so forgetting produces a report without ads
 * rather than an invoice.
 */
const maxCapUsd = Number(process.env['QUORUM_MAX_CAP_USD'] ?? 0);
const spendPerKeyUsd = Number(process.env['QUORUM_SPEND_PER_KEY_USD'] ?? 0);
const spendTotalUsd = Number(process.env['QUORUM_SPEND_TOTAL_USD'] ?? 0);

/*
 * WEBHOOKS ARE OFF UNTIL A SECRET IS SET, the same shape as the budget above.
 *
 * Every per key signing secret is derived from this one, so without it there is
 * nothing to sign with and a delivery would be unverifiable. Off is the honest
 * default: `webhookUrl` is still validated and still rejected if it points
 * somewhere it should not, it is simply never called, and the banner says so.
 *
 * A SHORT SECRET IS REFUSED RATHER THAN ACCEPTED, because its failure mode is
 * silence. Everything signs, everything verifies, and the signature is merely
 * easier to forge than anybody believes.
 */
const webhookSecret = process.env['QUORUM_WEBHOOK_SECRET'] ?? '';
const webhookVerdict = webhookSecret ? checkInstanceSecret(webhookSecret) : null;
if (webhookVerdict && !webhookVerdict.ok) {
  process.stderr.write(`webhooks: refusing to start. ${webhookVerdict.reason}\n`);
  process.exit(1);
}
const webhooksOn = webhookSecret.length > 0;

/*
 * POSTGRES WHEN A URL IS SET, SQLITE OTHERWISE.
 *
 * Not a preference. Measured 2026-08-22: `node:sqlite` is synchronous, so
 * every corpus read blocks the event loop, and evidence search topped out at
 * 124 requests a second while an indexed read managed 7,477. The same property
 * is why identical reports never coalesce under load, because a second request
 * cannot even be RECEIVED while the first report is running.
 *
 * It is also why a hosted deployment cannot be SQLite at all on a platform
 * with no persistent disk: the file would vanish on every restart and take the
 * corpus with it, and the corpus is the asset.
 *
 * SQLite stays the default because it is right for a laptop, and every test in
 * this repo runs against it with no service to start.
 */
const pgUrl = process.env['QUORUM_PG_URL'] ?? process.env['DATABASE_URL'];
/*
 * THE CA, AS A PATH OR AS THE PEM ITSELF.
 *
 * A path is what you want on a machine you control. A hosting platform hands
 * you environment variables and not files, so `QUORUM_PG_CA` alone meant the
 * certificate could not be verified anywhere it matters most: on the public
 * internet, which is exactly where the database is reachable from.
 */
const pgCaPem = process.env['QUORUM_PG_CA_PEM'];
const pgCaPath = process.env['QUORUM_PG_CA'];
const caCert = pgCaPem?.trim()
  ? pgCaPem
  : pgCaPath ? readFileSync(pgCaPath, 'utf8') : undefined;

const postgres = pgUrl
  ? openPostgres({ url: pgUrl, ...(caCert ? { caCert } : {}) })
  : null;

const corpus = postgres ? postgres.driver : openSqliteCorpus({ path: corpusPath });

/* Measured 2026-08-22: a warm category answers in about 0.1s and a cold run
 * took 39.9s to 75.7s end to end. Rounded rather than averaged, because an
 * estimate that looks precise invites someone to build a timeout on it. */
const WARM_SECONDS = 2;
const COLD_SECONDS = 60;

/*
 * Deliveries are durable because the hosted tier sleeps. A queue held in this
 * process would lose every pending delivery on the next redeploy, which makes
 * the 75 hour retry schedule a decoration. Outstanding rows are picked up on
 * boot simply by being due.
 */
const webhookWorker = webhooksOn
  ? createWebhookWorker({
    corpus,
    instanceSecret: webhookSecret,
    log: (message) => process.stderr.write(`${message}\n`),
  })
  : null;
webhookWorker?.start();

/*
 * Report snapshots prune by age, the way webhook deliveries do, or the table
 * inherits the unbounded growth the in memory map used to have. Thirty days
 * is far past any caller's polling horizon, and the timer is unref'd so it
 * cannot hold the process open on shutdown. On boot as well, because a free
 * tier that sleeps may never see a timer fire.
 */
const SNAPSHOT_RETAIN_SECONDS = 30 * 86_400;
const pruneSnapshots = (): void => {
  void corpus.pruneReportSnapshots(Math.floor(Date.now() / 1000) - SNAPSHOT_RETAIN_SECONDS)
    .catch((err: unknown) => {
      process.stderr.write(`snapshots: prune failed, next attempt in a day: ${err instanceof Error ? err.message : 'unknown'}\n`);
    });
};
pruneSnapshots();
setInterval(pruneSnapshots, 24 * 60 * 60_000).unref();

const queue = createJobQueue({
  concurrency,

  async runReport(request: ReportRequest, ctx): Promise<RunOutcome> {
    /*
     * METERED SOURCES, ASKED FOR AND PAID FOR.
     *
     * The caller asks with `includeAds`, and the budget decides. Checked here,
     * before the run, because a charge that lands after the money is gone is
     * an audit trail rather than a limit.
     *
     * A refusal is NOT an error. The report still runs and still answers, it
     * just answers without the metered leg, and the degradation list says so.
     * Failing the whole report because a budget ran out would throw away
     * minutes of free retrieval over an optional extra.
     */
    const spend = request.includeAds ? quotas.canSpend(ctx.keyLabel) : null;
    const adsAllowed = spend?.allowed === true;
    if (request.includeAds && !adsAllowed && spend) {
      ctx.onDegraded({
        source: 'meta-ads-apify',
        reason: spend.reason,
        impact: 'the report has no competitor ad evidence in it',
      });
    }

    /*
     * THE RUN RETRIEVES INTO THE SAME CORPUS THE CLAIMS READ. On Postgres that
     * is the shared driver, whose `close()` is a no op by design; on SQLite it
     * is a fresh handle per run, because `runResearch` closes the corpus it
     * was given in a `finally` and the long lived handle must survive the
     * report finishing. The split lives in `run-corpus.ts` with the incident
     * that made it load bearing.
     */
    const result: RunResult = await runResearch(
      {
        /*
         * The calling key IS the tenant here, and this is the line that keeps
         * one customer's prior report out of another customer's diff.
         */
        tenantId: ctx.keyLabel,
        subject: request.subject,
        terms: request.terms,
        communities: request.communities,
        sources: request.sources.length ? request.sources : [...SOURCE_IDS],
        /*
         * NEVER FROM THE HOSTED PATH, and `includeAds` is accepted and ignored.
         *
         * This read `request.includeAds ? ['meta-ads-apify'] : []` until
         * 2026-08-23, which meant any caller holding a key could post
         * `{"includeAds": true}` and run metered Apify calls on the operator's
         * account, as fast as the queue would take them. `synthesise` and
         * `readImages` were already hardcoded false below for exactly this
         * reason and the ads leg was the one that got missed.
         *
         * The flag stays in the request schema rather than becoming a 400,
         * because rejecting it would break callers who send it harmlessly, and
         * because a spend decision belongs to whoever pays the bill. When the
         * hosted tier meters ads per tenant this becomes a quota rather than a
         * constant.
         */
        adSources: adsAllowed ? ['meta-ads-apify'] : [],
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
        /*
         * THE CALLER'S CAP IS A CEILING REQUEST, NOT A GRANT. It can only ever
         * lower the operator's own limit, never raise it, and an absent one
         * gets the operator's rather than no cap at all, which is what
         * `undefined` used to mean here.
         */
        /*
         * THE TIGHTEST OF FOUR NUMBERS. The caller's own request, the per
         * report ceiling, and whatever is left of both the key's allowance and
         * the instance budget. A caller's capUsd can only ever lower this.
         */
        capUsd: Math.min(
          request.capUsd ?? Number.POSITIVE_INFINITY,
          maxCapUsd,
          spend?.keyRemainingUsd ?? maxCapUsd,
          spend?.instanceRemainingUsd ?? maxCapUsd,
        ),
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
        openCorpus: runCorpusOpener(postgres),
        resolveSubject,
        makeSource,
        makeAdSource,
        findProductByName: (name) => findProductByName(name, { timeoutMs: 15_000 }),
        env: process.env,
        signal: ctx.signal,
        onProgress: (line) => ctx.onStage('progress', line),
      },
    );

    /*
     * CHARGED FROM WHAT THE RUN ACTUALLY SPENT, not from an estimate and not
     * from what was authorised. The cost meter is the only thing that knows,
     * and it is charged whether the run succeeded or degraded, because a
     * vendor bills for a call that returned nothing useful just the same.
     */
    if (result.cost.totalUsd > 0) quotas.charge(ctx.keyLabel, result.cost.totalUsd);

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

  /*
   * The exact GET bytes, durably, so a finished report survives the restart
   * this tier is guaranteed to take. The queue evicts terminal reports after
   * an hour and the GET handler falls back to this row.
   */
  persistSnapshot: (snap) => corpus.saveReportSnapshot(snap),

  /*
   * Recording only. The queue writes a row and returns; the worker below
   * delivers on its own schedule, so a receiver taking ten seconds can never
   * hold up the next report.
   */
  ...(webhookWorker ? { enqueueWebhook: (d) => webhookWorker.enqueue(d) } : {}),
});

/*
 * Limits are ALWAYS ON, including on an open instance. An instance without
 * keys has one caller by definition, so the allowance is shared rather than
 * absent, and the one thing a limit must survive is somebody forgetting to
 * configure it.
 */
const limits = {
  ...DEFAULT_LIMITS,
  reportsPerWindow: Number(process.env['QUORUM_REPORTS_PER_MINUTE'] ?? DEFAULT_LIMITS.reportsPerWindow),
  lookupsPerWindow: Number(process.env['QUORUM_LOOKUPS_PER_MINUTE'] ?? DEFAULT_LIMITS.lookupsPerWindow),
  spendPerKeyUsd,
  spendTotalUsd,
};
const quotas = createQuotas(limits);

/* Doubles as the key request address on the root signpost, so setting it for
 * the SEC also answers the question a stranger has at the front door. */
const contactEmail = process.env['QUORUM_CONTACT_EMAIL']?.trim();

const server = createReceiptsServer({
  corpus, keyHashes, requireAuth: keyHashes.size > 0, queue, quotas,
  /* So GET /v1/usage can hand each key its own webhook signing secret. */
  ...(webhooksOn ? { webhookSecret } : {}),
  ...(contactEmail ? { contactEmail } : {}),
});

server.listen(port, () => {
  process.stderr.write(
    `quorum api on http://localhost:${port}, corpus ${postgres ? postgres.describe() : `sqlite ${corpusPath}`}\n`,
  );
  if (!keyHashes.size) {
    process.stderr.write('no QUORUM_API_KEYS set, so this instance is OPEN. Fine on a laptop, not on a network.\n');
  }
  process.stderr.write(`reports: live, ${concurrency} concurrent runs, coalesced by subject\n`);
  /* The CONFIGURED numbers, not the defaults. This printed the defaults until
   * 2026-08-23 and cheerfully announced 600 while enforcing 10, which is worse
   * than printing nothing: it is a log that has to be distrusted. */
  process.stderr.write(
    `limits: ${limits.reportsPerWindow} reports and ${limits.lookupsPerWindow} lookups `
    + `per key per minute\n`,
  );
  process.stderr.write(
    spendTotalUsd > 0 && spendPerKeyUsd > 0
      ? `budget: metered sources ON. $${spendPerKeyUsd} per key and $${spendTotalUsd} per instance `
        + `per day, at most $${maxCapUsd} in any one report\n`
      : 'budget: metered sources OFF, so ads are skipped. Set QUORUM_SPEND_PER_KEY_USD, '
        + 'QUORUM_SPEND_TOTAL_USD and QUORUM_MAX_CAP_USD to enable them.\n',
  );
  /* Configured, not default, for the reason given above the limits line. */
  process.stderr.write(
    webhooksOn
      ? 'webhooks: ON. Completed reports POST to their webhookUrl, signed to the '
        + 'Standard Webhooks spec, retried for about 75 hours.\n'
      : 'webhooks: OFF, so webhookUrl is validated and accepted but never called. '
        + 'Set QUORUM_WEBHOOK_SECRET to enable delivery.\n',
  );
  process.stderr.write('live: /v1/reports /v1/reports/:id /v1/reports/:id/stream /v1/healthz /v1/evidence/:id\n');
  process.stderr.write('      /v1/evidence/batch /v1/evidence/search /v1/verify /v1/categories/:slug\n');
  process.stderr.write('      /v1/evidence/ads/:id /v1/usage\n');
});

const shutdown = (): void => {
  /* Runs are aborted rather than left spending on a process that is going
   * away. Records already retrieved stay in the corpus: a run that dies at
   * minute forty still leaves the archive better than it found it. */
  queue.shutdown();
  /*
   * The timer is stopped, and nothing is drained. A row is marked only after
   * its attempt finishes, so a delivery interrupted here is still pending and
   * the next boot picks it up. Draining would turn a hung receiver into a
   * process that will not exit, and the webhook-id header is what lets a
   * receiver deduplicate the one delivery this can send twice.
   */
  webhookWorker?.stop();
  /*
   * The pool is drained AFTER the server stops accepting, so a request already
   * in flight still has a connection to finish on. Closing it first would fail
   * the very requests a graceful shutdown exists to protect.
   */
  server.close(() => {
    void corpus.close()
      .then(() => (postgres ? postgres.end() : undefined))
      /*
       * A close that fails must not turn a shutdown into a crash. Without this
       * catch, a pool already broken by the database going away rejected the
       * chain, node treated it as an unhandled rejection, and every unclean
       * shutdown exited 1 with a stack trace, which a host reads as a failed
       * restart. The server has already stopped accepting by this line, so
       * there is nothing left to protect: report it and leave normally.
       */
      .catch((cause) => process.stderr.write(
        `shutdown: closing the corpus failed, exiting anyway: ${cause instanceof Error ? cause.message : String(cause)}
`,
      ))
      .then(() => process.exit(0));
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
