/*
 * The job queue.
 *
 * A report is minutes long and about 500 throttled upstream requests when cold.
 * That is not a request, and treating it as one is how a service ends up with
 * a thousand identical runs hammering a volunteer archive.
 *
 * A RUN AND A REPORT ARE DIFFERENT THINGS, AND THE SPEC FORCES IT.
 *
 * `spec/openapi.yaml` says coalescing "shares the retrieval and never shares
 * the claims". Read that carefully and it is two objects, not one:
 *
 *   RUN     one retrieval for a category. Shared, cancellable, and the thing
 *           the concurrency limit counts. Its cost is genuinely shared because
 *           the corpus is global.
 *   REPORT  one caller's questions. Owns its own terms, its own claims and its
 *           own event stream, and attaches to a run rather than being one.
 *
 * Collapsing them into one object would mean the second caller inherits the
 * first caller's questions, which is a different product and a worse one. It
 * would also make DELETE ambiguous: cancelling "the report" would cancel a run
 * somebody else is still waiting on.
 *
 * SO: cancelling a report DETACHES it. The run stops only when the last report
 * attached to it goes away, which is the only reading under which a shared run
 * is safe to join.
 *
 * WHY THE RUNNER IS INJECTED.
 *
 * Everything interesting here is queue behaviour: coalescing, detaching, the
 * event log, idempotency, saturation. None of it involves the network, and all
 * of it is where the bugs are. A queue that could only be tested by doing a
 * real 40 second retrieval would be tested once, by hand, and then never again.
 */

import { randomBytes } from 'node:crypto';

export type ReportStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';

export interface ReportRequest {
  subject: string;
  terms: string[];
  communities: string[];
  sources: string[];
  includeAds: boolean;
  offline: boolean;
  capUsd: number | undefined;
  deadlineMs: number | undefined;
  webhookUrl: string | undefined;
}

/*
 * Events carry a monotonic id per report so `Last-Event-ID` can resume rather
 * than restart. A flaky client must cost nothing upstream, and a client that
 * reconnects into a restarted run would cost everything.
 */
export interface JobEvent {
  id: number;
  type: 'stage' | 'finding' | 'degraded' | 'done' | 'error';
  data: unknown;
}

export interface RunContext {
  /* Aborted when the last attached report detaches, or on shutdown. Checked
   * between queries rather than only at the start, because a cancelled run has
   * to stop SPENDING and on a metered source that is money. */
  signal: AbortSignal;
  /*
   * The key that STARTED this run, which is who pays for any metered work in
   * it. A coalesced run is shared by every caller who joined, and they ride
   * free: that is what coalescing is for, and splitting a bill across joiners
   * who arrived at different times would be arbitrary in a way nobody could
   * predict or check. Whoever caused the spend is charged for it.
   */
  keyLabel: string;
  onStage(name: string, detail?: string): void;
  onDegraded(degradation: unknown): void;
}

/*
 * What a completed retrieval leaves behind. Deliberately not the CLI's
 * RunResult: the queue must not know how a run is performed, and a shape it
 * shares with the CLI is a shape that drifts with the CLI.
 */
export interface RunOutcome {
  subject: unknown;
  category: string;
  /* Whether the subject resolved to a real product page or catalogue entry.
   * Carried explicitly rather than sniffed out of `subject`, because the advice
   * a thin report gives depends on it and "pass the product URL directly" is
   * insulting to a caller who already did. */
  subjectResolved: boolean;
  retrieval: unknown;
  warmth: unknown;
  degraded: unknown[];
  cost: unknown;
  attested?: unknown;
  gaps?: unknown[];
  silence?: unknown;
  formats?: unknown;
  durationBasis?: unknown;
}

export interface ReportClaims {
  findings: unknown[];
  weakSignals: unknown[];
  rejected: unknown[];
  sufficiency: unknown;
  receiptCheck: unknown;
  /* Whether each of THIS caller's questions is getting louder. Per report and
   * not per run, like everything else here: a joiner asked different questions
   * and a trend for somebody else's term is not an answer. */
  trends: unknown[];
  voice: unknown[];
  /* Phrases the corpus keeps returning to that this caller did not ask about.
   * A candidate list carrying its receipts, never a set of findings. */
  themes: unknown[];
}

export interface QueueOptions {
  /* Does the retrieval. One call per RUN, never per report. */
  runReport(request: ReportRequest, ctx: RunContext): Promise<RunOutcome>;
  /*
   * Computes one caller's claims from the corpus as it stands. One call per
   * REPORT, which is what stops a joiner inheriting somebody else's questions.
   *
   * IT TAKES THE WHOLE RUN OUTCOME, NOT JUST THE CATEGORY, and that is a bug
   * fix rather than a convenience. Passing only the category meant sufficiency
   * was computed with no retrieval, so a live report printed "seen 41, gated
   * 19" in its retrieval table and "seen 0, rejected 0, stored 0" three blocks
   * below it. Measured 2026-08-22 on a real run. A report that contradicts its
   * own working is worse than one that says nothing.
   */
  claimsFor(outcome: RunOutcome, terms: readonly string[]): Promise<ReportClaims>;
  /*
   * How many retrievals may run at once, across every caller.
   *
   * Two, and it is not a performance dial. Every concurrent run is concurrent
   * pressure on the same volunteer archives, and the shared polite client is
   * what keeps us welcome there. Raising this raises their load, not ours.
   */
  concurrency?: number;
  /*
   * Beyond this many waiting runs, POST answers 503 rather than accepting work
   * it cannot do. Upstream capacity is about 785 cold reports per day across
   * all callers combined, measured 2026-08-22, so a queue that accepts
   * everything is a queue that lies.
   */
  maxQueued?: number;
  /* Concurrent reports per key. A rate limit does not stop one caller holding
   * every worker, because a job is long and a request is not. */
  maxPerKey?: number;
  idempotencyTtlMs?: number;
  /* Injected so a test can run at a fixed instant. Unix milliseconds. */
  now?: () => number;
  /*
   * Records a completed report's webhook, if it asked for one.
   *
   * INJECTED RATHER THAN CALLED DIRECTLY, because this module reaches neither
   * the corpus nor the network, the same reason `claimsFor` is injected. It
   * writes a row and returns; it does not deliver. Delivery is a separate
   * worker on its own schedule, so a slow receiver can never hold up the queue.
   */
  enqueueWebhook?(delivery: {
    reportId: string;
    /* The tenant that owns the row. The calling key, same as the report. */
    tenantId: string;
    keyLabel: string;
    url: string;
    /* The exact bytes to sign and send, identical to GET /v1/reports/{id}. */
    payload: string;
  }): Promise<void>;
  /* Warm or cold, for `estimatedSeconds`. Optional: a null estimate is honest
   * and a made up one is not. */
  estimateSeconds?(category: string): Promise<number | null>;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_QUEUED = 50;
const DEFAULT_MAX_PER_KEY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export const reportId = (): string => `rep_${randomBytes(8).toString('hex')}`;

/*
 * The coalescing key.
 *
 * The spec keys on the RESOLVED category, and resolving costs a network call
 * with a 12 second timeout. Doing that inside POST would make accepting a job
 * as slow as doing one and would hand anyone a way to make us fetch arbitrary
 * pages synchronously.
 *
 * So the key is derived from what we already have. For a plain text subject
 * that is exact rather than approximate: measured 2026-08-22, a text subject
 * resolves to its own lowercased self as the category, so the key IS the
 * category. For a URL it is the URL, which coalesces two callers sending the
 * same link and misses two callers sending different links to the same
 * product. That miss costs a duplicate run and is stated rather than hidden.
 */
export function coalescingKey(request: ReportRequest): string {
  return request.subject.trim().toLowerCase().replace(/\s+/g, ' ');
}

interface Run {
  key: string;
  /* The key label of the first caller to ask for this. See RunContext. */
  initiator: string;
  status: ReportStatus;
  /* Terms this run planned upstream. A joiner arriving after this is set gets
   * its extra terms back in `termsDeferred` rather than a silent thin answer. */
  plannedTerms: string[];
  planned: boolean;
  controller: AbortController;
  reports: Set<string>;
  outcome: RunOutcome | null;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

interface Report {
  id: string;
  keyLabel: string;
  request: ReportRequest;
  run: Run;
  coalesced: boolean;
  termsDeferred: string[];
  status: ReportStatus;
  createdAt: number;
  completedAt: number | null;
  events: JobEvent[];
  claims: ReportClaims | null;
  error: string | null;
  /* Bumped on every event, so an ETag can change exactly when the report has
   * advanced and a poller can be told 304 the rest of the time. */
  version: number;
  waiters: ((event: JobEvent) => void)[];
}

export interface Accepted {
  id: string;
  status: ReportStatus;
  coalesced: boolean;
  category: string;
  termsDeferred: string[];
  queuePosition: number | null;
  estimatedSeconds: number | null;
}

export type SubmitResult =
  | { ok: true; accepted: Accepted }
  | { ok: false; status: 409 | 503 | 429; message: string };

export interface ReportSnapshot {
  id: string;
  status: ReportStatus;
  subject: unknown;
  category: string;
  createdAt: number;
  completedAt: number | null;
  elapsedMs: number;
  coalesced: boolean;
  termsDeferred: string[];
  findings: unknown[];
  weakSignals: unknown[];
  rejected: unknown[];
  sufficiency: unknown;
  receiptCheck: unknown;
  trends: unknown[];
  voice: unknown[];
  themes: unknown[];
  retrieval: unknown;
  warmth: unknown;
  degraded: unknown[];
  attested: unknown;
  gaps: unknown[];
  silence: unknown;
  formats: unknown;
  durationBasis: unknown;
  cost: unknown;
  error: unknown;
  version: number;
}

export interface JobQueue {
  /*
   * Asynchronous ONLY to fill in `estimatedSeconds`, which needs a corpus read.
   * Every piece of state this touches is mutated before the first await, so two
   * concurrent submits cannot both decide there is no run to join.
   */
  submit(request: ReportRequest, options: { keyLabel: string; idempotencyKey?: string }): Promise<SubmitResult>;
  /* Reports this key has queued or running. The same count the per key cap
   * refuses on, so a usage report and a 429 cannot disagree. */
  runningFor(keyLabel: string): number;
  get(id: string): ReportSnapshot | null;
  /* Detaches this report. The run continues while any other report is still
   * attached to it. Returns null when the id names nothing. */
  cancel(id: string): ReportSnapshot | null;
  /* Events after `afterId`, for a fresh subscriber or a resuming one. */
  eventsSince(id: string, afterId: number): JobEvent[] | null;
  /* Resolves on the next event after `afterId`, or null when the report is
   * already terminal and there will never be another. */
  nextEvent(id: string, afterId: number, signal?: AbortSignal): Promise<JobEvent | null>;
  stats(): { queued: number; running: number; reports: number };
  /* Aborts every run. Used on shutdown, where leaving them is worse. */
  shutdown(): void;
}

export function createJobQueue(options: QueueOptions): JobQueue {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
  const maxPerKey = options.maxPerKey ?? DEFAULT_MAX_PER_KEY;
  const idempotencyTtl = options.idempotencyTtlMs ?? DAY_MS;
  const now = options.now ?? (() => Date.now());

  const reports = new Map<string, Report>();
  const runsByKey = new Map<string, Run>();
  const pending: Run[] = [];
  let running = 0;

  /* (keyLabel, idempotencyKey) to the report it produced, plus a fingerprint of
   * the body so the same key with a different body is a 409 rather than a
   * silently wrong answer. */
  const idempotency = new Map<string, { reportId: string; fingerprint: string; at: number }>();

  const fingerprint = (request: ReportRequest): string => JSON.stringify([
    request.subject.trim().toLowerCase(),
    [...request.terms].sort(),
    [...request.communities].sort(),
    [...request.sources].sort(),
    request.includeAds, request.offline, request.capUsd ?? null, request.deadlineMs ?? null,
    /*
     * THE WEBHOOK URL IS PART OF THE REQUEST, so two submits that differ only
     * in where the answer should be sent are two different requests.
     *
     * It was omitted until 2026-08-23, which meant a caller reusing an
     * Idempotency-Key with a new webhook url got the first submit replayed and
     * their new url silently dropped: no error, no delivery, nothing to see.
     * Included, the second submit is a 409 and says so.
     */
    request.webhookUrl ?? null,
  ]);

  function emit(report: Report, type: JobEvent['type'], data: unknown): void {
    const event: JobEvent = { id: report.events.length + 1, type, data };
    report.events.push(event);
    report.version++;
    /* Copied before draining: a waiter that resubscribes synchronously would
     * otherwise be woken by the event it is already past. */
    const waiters = report.waiters.splice(0, report.waiters.length);
    for (const wake of waiters) wake(event);
  }

  const emitToRun = (run: Run, type: JobEvent['type'], data: unknown): void => {
    for (const id of run.reports) {
      const report = reports.get(id);
      if (report) emit(report, type, data);
    }
  };

  /*
   * The single terminal path for a report, and therefore the one place a
   * webhook is recorded.
   *
   * `cancel` deliberately does not come through here, which is correct: a
   * caller who cancelled does not need to be told their report finished.
   *
   * A WEBHOOK BELONGS TO A REPORT, NEVER TO A RUN. One coalesced run serves
   * many reports, each with its own url and its own terminal moment inside the
   * settle loop. Fanning out from the run would send one caller's report to
   * another caller's endpoint.
   *
   * The enqueue is AWAITED so the row is durable before the report is
   * considered done. The delivery is not: it happens on the worker's schedule.
   * An enqueue that throws must not fail the report, because the report itself
   * succeeded and is readable over the API.
   */
  async function finishReport(report: Report, status: ReportStatus, error: string | null): Promise<void> {
    report.status = status;
    report.completedAt = now();
    report.error = error;
    if (status === 'failed') emit(report, 'error', { message: error });
    else emit(report, 'done', { status });

    const url = report.request.webhookUrl;
    if (!url || !options.enqueueWebhook) return;
    try {
      await options.enqueueWebhook({
        reportId: report.id,
        tenantId: report.keyLabel,
        keyLabel: report.keyLabel,
        url,
        /*
         * Byte identical to what GET /v1/reports/{id} serves, including the two
         * space indentation, because the bytes signed must be the bytes a
         * receiver can compare against the API.
         */
        payload: JSON.stringify(snapshot(report), null, 2),
      });
    } catch { /* a webhook that cannot be queued must not fail a good report */ }
  }

  async function settle(run: Run): Promise<void> {
    /*
     * Claims are computed PER REPORT, from the corpus as it stands, using that
     * report's own terms. This is the line that makes joining somebody else's
     * run safe, so it is a loop over reports and never a single call.
     */
    const outcome = run.outcome;
    for (const id of [...run.reports]) {
      const report = reports.get(id);
      if (!report || report.status === 'cancelled') continue;
      if (!outcome) { await finishReport(report, 'failed', run.error ?? 'the run did not complete'); continue; }
      try {
        report.claims = await options.claimsFor(outcome, report.request.terms);
        for (const finding of report.claims.findings) emit(report, 'finding', finding);
        await finishReport(report, 'complete', null);
      } catch (cause) {
        await finishReport(report, 'failed', cause instanceof Error ? cause.message : String(cause));
      }
    }
  }

  function pump(): void {
    while (running < concurrency && pending.length) {
      const run = pending.shift()!;
      /* Every report attached to it detached while it waited. Nothing to do,
       * and running it would spend upstream budget for nobody. */
      if (!run.reports.size) { runsByKey.delete(run.key); continue; }

      running++;
      run.status = 'running';
      run.startedAt = now();
      /* Planned the moment it starts. A joiner after this point cannot add
       * upstream queries, which is what `termsDeferred` reports. */
      run.planned = true;
      for (const id of run.reports) {
        const report = reports.get(id);
        if (report && report.status === 'queued') report.status = 'running';
      }
      emitToRun(run, 'stage', { stage: 'retrieve', state: 'started' });

      void (async () => {
        try {
          run.outcome = await options.runReport(
            runRequest(run),
            {
              signal: run.controller.signal,
              keyLabel: run.initiator,
              onStage: (stage, detail) => emitToRun(run, 'stage', { stage, ...(detail ? { detail } : {}) }),
              onDegraded: (degradation) => emitToRun(run, 'degraded', degradation),
            },
          );
          run.status = 'complete';
        } catch (cause) {
          run.status = 'failed';
          run.error = cause instanceof Error ? cause.message : String(cause);
        } finally {
          run.completedAt = now();
          running--;
          await settle(run);
          /*
           * Unregistered so the next caller for this subject starts a fresh
           * run. Coalescing onto a finished run would hand somebody a report
           * built from a retrieval that ended before they asked.
           */
          if (runsByKey.get(run.key) === run) runsByKey.delete(run.key);
          pump();
        }
      })();
    }
  }

  /*
   * The request a run executes: the terms of every report attached when it
   * started, so one retrieval serves all of their questions.
   *
   * NOTE WHAT THIS SPREAD CARRIES AND WHAT MUST NEVER READ IT. It copies the
   * FIRST attached report's fields, so `webhookUrl` here is one arbitrary
   * caller's url out of however many joined the run. That is harmless only
   * because delivery is per report and reads `report.request.webhookUrl`
   * instead. Nothing may ever deliver from a run request, and this is not an
   * intent worth inferring from the code.
   */
  function runRequest(run: Run): ReportRequest {
    const first = reports.get([...run.reports][0]!)!;
    return { ...first.request, terms: run.plannedTerms };
  }

  function snapshot(report: Report): ReportSnapshot {
    const outcome = report.run.outcome;
    const claims = report.claims;
    return {
      id: report.id,
      status: report.status,
      subject: outcome?.subject ?? { title: report.request.subject, source: 'text' },
      category: outcome?.category ?? coalescingKey(report.request),
      createdAt: report.createdAt,
      completedAt: report.completedAt,
      elapsedMs: (report.completedAt ?? now()) - report.createdAt,
      coalesced: report.coalesced,
      termsDeferred: report.termsDeferred,
      /* Empty rather than absent while running. A poller showing progress needs
       * the key to exist; the spec promises findings never shrink, and they
       * cannot, because they are only ever written once at completion. */
      findings: claims?.findings ?? [],
      weakSignals: claims?.weakSignals ?? [],
      rejected: claims?.rejected ?? [],
      sufficiency: claims?.sufficiency ?? null,
      receiptCheck: claims?.receiptCheck ?? null,
      trends: claims?.trends ?? [],
      voice: claims?.voice ?? [],
      themes: claims?.themes ?? [],
      retrieval: outcome?.retrieval ?? null,
      warmth: outcome?.warmth ?? null,
      degraded: outcome?.degraded ?? [],
      attested: outcome?.attested ?? null,
      gaps: outcome?.gaps ?? [],
      silence: outcome?.silence ?? null,
      formats: outcome?.formats ?? null,
      durationBasis: outcome?.durationBasis ?? null,
      cost: outcome?.cost ?? null,
      error: report.error ? { type: 'internal', message: report.error } : null,
      version: report.version,
    };
  }

  /*
   * Reports this key currently has queued or running.
   *
   * Shared by the per key cap below and by `GET /v1/usage`, so the number a
   * caller is refused on and the number it is shown are the same number
   * computed once. Two implementations of "in flight" is how a caller gets
   * told it has one running while being refused for having three.
   */
  const inFlightFor = (keyLabel: string): number =>
    [...reports.values()].filter(
      (r) => r.keyLabel === keyLabel && (r.status === 'queued' || r.status === 'running'),
    ).length;

  return {
    runningFor: inFlightFor,

    async submit(request, { keyLabel, idempotencyKey }) {
      /* Swept on use rather than on a timer. A timer in a library is a handle
       * that keeps a process alive and surprises whoever embeds it. */
      const cutoff = now() - idempotencyTtl;
      for (const [k, v] of idempotency) if (v.at < cutoff) idempotency.delete(k);

      if (idempotencyKey) {
        /*
         * NUL joins the two halves because it is the one byte that cannot
         * appear in either, so no pair of key label and idempotency key can
         * collide with another pair by moving the boundary.
         *
         * WRITTEN AS AN ESCAPE, NOT AS THE BYTE. It was a literal NUL in the
         * source until 2026-08-22, which made `file` call this module binary
         * data and made grep skip it in silence: searching this file for
         * `coalescingKey` returned nothing while the function was defined in
         * it. Same string to the runtime, and the file stays greppable.
         */
        const stored = idempotency.get(`${keyLabel}\u0000${idempotencyKey}`);
        if (stored) {
          if (stored.fingerprint !== fingerprint(request)) {
            return { ok: false, status: 409, message: 'this idempotency key was already used with a different body' };
          }
          const previous = reports.get(stored.reportId);
          if (previous) {
            return {
              ok: true,
              accepted: {
                id: previous.id,
                status: previous.status,
                coalesced: previous.coalesced,
                category: snapshot(previous).category,
                termsDeferred: previous.termsDeferred,
                queuePosition: null,
                estimatedSeconds: null,
              },
            };
          }
        }
      }

      const mine = inFlightFor(keyLabel);
      if (mine >= maxPerKey) {
        return { ok: false, status: 429, message: `at most ${maxPerKey} reports may be in flight for one key` };
      }

      const key = coalescingKey(request);
      const existing = runsByKey.get(key);
      const coalesced = existing !== undefined;
      let run = existing;
      let termsDeferred: string[] = [];

      if (run) {
        if (run.planned) {
          /*
           * The run has already planned its queries, so these terms are never
           * searched upstream. Reported rather than silently answered thin,
           * and never by starting a second full run, which would defeat the
           * point of coalescing.
           */
          termsDeferred = request.terms.filter((t) => !run!.plannedTerms.includes(t));
        } else {
          for (const term of request.terms) {
            if (!run.plannedTerms.includes(term)) run.plannedTerms.push(term);
          }
        }
      } else {
        if (pending.length >= maxQueued) {
          return { ok: false, status: 503, message: 'the job queue is full. Check GET /v1/categories/{slug} first: a warm category costs no upstream requests and is not subject to this.' };
        }
        run = {
          key,
          initiator: keyLabel,
          status: 'queued',
          plannedTerms: [...request.terms],
          planned: false,
          controller: new AbortController(),
          reports: new Set(),
          outcome: null,
          error: null,
          startedAt: null,
          completedAt: null,
        };
        runsByKey.set(key, run);
        pending.push(run);
      }

      const id = reportId();
      const report: Report = {
        id,
        keyLabel,
        request,
        run,
        coalesced,
        termsDeferred,
        status: run.status === 'running' ? 'running' : 'queued',
        createdAt: now(),
        completedAt: null,
        events: [],
        claims: null,
        error: null,
        version: 0,
        waiters: [],
      };
      reports.set(id, report);
      run.reports.add(id);

      if (idempotencyKey) {
        idempotency.set(`${keyLabel}\u0000${idempotencyKey}`, {
          reportId: id, fingerprint: fingerprint(request), at: now(),
        });
      }

      const queuePosition = run.status === 'queued' ? pending.indexOf(run) + 1 : null;

      /* Every mutation above is synchronous, so the coalescing decision and the
       * registration cannot be interleaved by another submit. This is the first
       * await and it touches nothing. */
      pump();

      /*
       * AN ESTIMATE THAT CANNOT BE COMPUTED IS NULL, NEVER A REFUSAL. The
       * estimate reads categoryStats, which is a database call, and until
       * 2026-08-23 a failure there took the whole submit down as a 500: the
       * job was registered, the run was pumping, and the caller was told the
       * request could not be completed, all because a COSMETIC number timed
       * out. Found by an end to end run against the real database while it was
       * under load, which is exactly the moment a free tier database produces
       * timeouts. A null estimate is honest and the option doc has always said
       * so; now the code agrees.
       */
      let estimatedSeconds: number | null = null;
      if (options.estimateSeconds) {
        try { estimatedSeconds = await options.estimateSeconds(key); }
        catch { estimatedSeconds = null; }
      }

      return {
        ok: true,
        accepted: { id, status: report.status, coalesced, category: key, termsDeferred, queuePosition, estimatedSeconds },
      };
    },

    get(id) {
      const report = reports.get(id);
      return report ? snapshot(report) : null;
    },

    cancel(id) {
      const report = reports.get(id);
      if (!report) return null;
      if (report.status === 'queued' || report.status === 'running') {
        report.status = 'cancelled';
        report.completedAt = now();
        emit(report, 'done', { status: 'cancelled' });
        report.run.reports.delete(id);
        /*
         * THE RUN STOPS ONLY WHEN THE LAST REPORT DETACHES. Cancelling a
         * coalesced report must not cancel a run somebody else is waiting on,
         * and this is the only reading under which joining a shared run is safe.
         */
        if (!report.run.reports.size) {
          report.run.controller.abort();
          if (runsByKey.get(report.run.key) === report.run) runsByKey.delete(report.run.key);
        }
      }
      return snapshot(report);
    },

    eventsSince(id, afterId) {
      const report = reports.get(id);
      if (!report) return null;
      return report.events.filter((e) => e.id > afterId);
    },

    async nextEvent(id, afterId, signal) {
      const report = reports.get(id);
      if (!report) return null;
      const already = report.events.find((e) => e.id > afterId);
      if (already) return already;
      const terminal = report.status === 'complete' || report.status === 'failed' || report.status === 'cancelled';
      if (terminal) return null;
      return new Promise<JobEvent | null>((resolve) => {
        const wake = (event: JobEvent): void => resolve(event);
        report.waiters.push(wake);
        signal?.addEventListener('abort', () => {
          const at = report.waiters.indexOf(wake);
          if (at !== -1) report.waiters.splice(at, 1);
          resolve(null);
        }, { once: true });
      });
    },

    stats() {
      return { queued: pending.length, running, reports: reports.size };
    },

    shutdown() {
      for (const run of runsByKey.values()) run.controller.abort();
      pending.length = 0;
    },
  };
}

/* Exported so the route layer and the queue cannot disagree about it. */
export { DEFAULT_CONCURRENCY, DEFAULT_MAX_QUEUED, DEFAULT_MAX_PER_KEY };
