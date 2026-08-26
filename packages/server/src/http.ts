/*
 * The hosted API, on node:http and nothing else.
 *
 * TWO KINDS OF ROUTE, AND THEY ARE NOT THE SAME SHAPE OF PROBLEM.
 *
 * Six are synchronous reads: resolve a receipt, resolve many, search the
 * corpus, category warmth, ad history, and verify somebody's claims. Each is a
 * single indexed lookup and answers inside a request.
 *
 * The other three are reports, which are minutes long and about 500 throttled
 * upstream requests when cold. That is not a request, so they go through the
 * job queue in `jobs.ts`, which coalesces, cancels and streams.
 *
 * WITHOUT A QUEUE CONFIGURED THEY ANSWER 501 rather than a fake. A corpus only
 * deployment is a real configuration, and an endpoint that pretends to accept
 * work it will never do is worse than one that says it is not built.
 *
 * THE ONE THAT MATTERS MOST IS `/v1/verify`.
 *
 * It takes claims this API did not produce and answers whether the ids resolve,
 * whether the quotes are real, and whether each claim still clears the bar once
 * the invented ids are removed. That check has existed inside the pipeline for
 * a while and has been reachable by nobody, which is a strange place to keep
 * the only capability nobody else has.
 *
 * ZERO DEPENDENCIES, deliberately. A framework would be four lines shorter and
 * would put a supply chain into the one process that holds the corpus.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { meterFor, type Quotas } from './quotas.ts';
import type { CorpusDriver, SourceId } from '@quorum/corpus';
import { isReceiptId } from '@quorum/corpus';
import { SOURCE_TIER, scoreKindOf, tierOf, type EvidenceTier } from '@quorum/corpus/tiers';
import { resolveCitations, fabricationReport, type ModelClaim } from '@quorum/core';
import type { JobQueue, ReportRequest, ReportSnapshot } from './jobs.ts';
import { checkWebhookUrl, deriveSecret } from './webhooks.ts';
import { createTools, handleMessage } from '@quorum/mcp';

export interface ServerOptions {
  corpus: CorpusDriver;
  /*
   * sha256 of each accepted key, mapped to a label for logs. Hashes, never the
   * keys: a leaked log line or a heap dump must not be a leaked key.
   */
  keyHashes?: Map<string, string>;
  /* Open when no keys are configured, which is the self hosted default. */
  requireAuth?: boolean;
  /*
   * Per key rate limits. Absent means unlimited, which is right for a laptop
   * and wrong for anything with a public hostname, so `bin.ts` always supplies
   * one.
   */
  quotas?: Quotas;
  /*
   * The webhook instance secret, when webhooks are enabled. Used for exactly
   * one thing here: deriving the CALLING key's signing secret so GET /v1/usage
   * can hand a customer the one secret that is theirs. The instance secret
   * itself is never returned; what a caller sees is already one HMAC away
   * from it.
   */
  webhookSecret?: string;
  /*
   * Where a stranger asks for a key, shown on the root signpost. Operator
   * configured rather than hardcoded, so publishing an address is a deployment
   * decision and not a code change.
   */
  contactEmail?: string;
  maxBodyBytes?: number;
  /*
   * Event loop lag, in milliseconds, above which the server SHEDS LOAD.
   *
   * MEASURED 2026-08-22 on a 100,000 record corpus, 3,000 requests at 300
   * concurrent:
   *
   *   /v1/healthz        7,365 req/s, 0 failures      no database
   *   /v1/evidence/:id   7,477 req/s, 0 failures      one indexed read
   *   /v1/evidence/search  123 req/s, 313 FAILURES    one FTS read at 8.5ms
   *
   * `node:sqlite` is SYNCHRONOUS, so every corpus read blocks the event loop.
   * Past about 120 searches a second the backlog grows until clients give up,
   * and those 313 were DROPPED CONNECTIONS rather than refusals. A caller who
   * gets a transport error cannot tell a busy server from a broken one, and
   * cannot know whether it is safe to retry. So the excess is refused with a
   * status and a Retry-After instead.
   *
   * LAG IS THE MEASURE, AND THE TWO OBVIOUS ALTERNATIVES BOTH FAILED.
   *
   * Counting handlers in flight reported 1, always: a synchronous handler has
   * no yield point between arriving and responding, so the counter cannot rise
   * however deep the backlog is. Measured during a run with 241 open sockets
   * and 521ms of loop lag, that counter sat at 1 and shed nothing.
   *
   * Counting open sockets was worse, and it took a realistic test to see it.
   * Keep alive means a client pool of 100 holds 100 sockets open whether or not
   * it is doing anything, so shedding above 64 refused ONE HUNDRED PERCENT of a
   * 10,000 request mixed workload. It punished clients for pooling, which is
   * the thing every good client does.
   *
   * Loop lag measures the only thing that matters: whether we are behind. It is
   * unaffected by how many sockets a client keeps or how the handler is
   * written, and it goes to zero the moment the server catches up.
   *
   * VERIFIED 2026-08-22 against a 10,000 request mixed workload, 3,000 requests
   * per level, one process, one 100,000 record corpus:
   *
   *   concurrent   offered/s   served/s   shed   p95     dropped
   *            5         275        275     0%    76ms         0
   *           20         283        283     0%   178ms         0
   *           40         319        314     1%   246ms         0
   *           80         612        279    54%   385ms         0
   *          300         882        271    69%   853ms         0
   *
   * SERVED THROUGHPUT IS FLAT AND NOTHING IS EVER DROPPED. Real capacity for
   * this mix is about 290 requests a second, the knee sits between 20 and 40
   * concurrent, and past it the shedder refuses exactly the surplus rather than
   * letting the queue swallow it. A caller offering three times capacity still
   * gets 290 a second served and a Retry-After on the rest, which is the whole
   * point: below the knee it never fires, and above it nobody is left guessing
   * whether the server is busy or broken.
   */
  maxLagMs?: number;
  /*
   * Absent means the three report routes answer 501. That is deliberate: an
   * endpoint that pretends to accept minutes long work it will never do is
   * worse than one that says it is not built, and a corpus only deployment is
   * a real configuration rather than a broken one.
   */
  queue?: JobQueue;
}

/* 1MB. A verify request with 100 claims is a few kilobytes; anything near this
 * is a mistake or an attack, and either way it is refused before parsing. */
const MAX_BODY = 1024 * 1024;

/*
 * See `maxLagMs`. A single search blocks the loop for about 8.5ms, so a healthy
 * server shows lag in the low tens. 250ms means roughly thirty queries are
 * already queued ahead of this one, which is past useful and heading for a
 * client timeout.
 */
const MAX_LAG_MS = 250;
/* How often lag is sampled. Cheap: one timer, no work in the callback. */
const LAG_SAMPLE_MS = 20;

/*
 * THE RATE LIMIT HEADER NAMES, IN ONE PLACE AND EXPORTED.
 *
 * They were written as three string literals here while spec/openapi.yaml
 * declared `RateLimit-Limit` without the prefix and the README documented a
 * third spelling. Three documents, two behaviours, and nothing that could
 * notice. Exported so check-spec.mjs asserts the spec quotes these exact names
 * rather than a plausible looking guess.
 *
 * `x-` prefixed rather than the IETF draft spelling, because that is what has
 * shipped and what callers are already reading. Changing the wire names is a
 * breaking change and belongs to a version bump, not to a tidy up.
 */
export const RATE_LIMIT_HEADERS = {
  limit: 'x-ratelimit-limit',
  remaining: 'x-ratelimit-remaining',
  reset: 'x-ratelimit-reset',
} as const;

export const hashKey = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex');

/*
 * Constant time, so the number of correct leading characters cannot be learned
 * from how long the comparison took.
 */
function keyMatches(presented: string, accepted: ReadonlyMap<string, string>): string | null {
  const given = Buffer.from(hashKey(presented), 'hex');
  for (const [hash, label] of accepted) {
    const expected = Buffer.from(hash, 'hex');
    if (expected.length === given.length && timingSafeEqual(expected, given)) return label;
  }
  return null;
}

interface Ctx {
  requestId: string;
  url: URL;
  body: unknown;
  /* Which key is asking. Quotas, the per key job cap and idempotency are all
   * scoped to this, so it is never optional: with auth off every caller is the
   * same self hosted operator and shares one allowance, which is correct. */
  keyLabel: string;
  headers: Record<string, string | string[] | undefined>;
}

type Handler = (ctx: Ctx) => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>;

/* A route that writes its own response, for the one endpoint that is not a
 * single JSON body. Kept as a separate field so an ordinary handler cannot
 * accidentally take over the socket. */
type Streamer = (ctx: Ctx, req: IncomingMessage, res: ServerResponse) => Promise<void>;

const error = (status: number, type: string, message: string, requestId: string) => ({
  status,
  body: { error: { type, message, requestId, retryAfterSeconds: null } },
});

export function createReceiptsServer(options: ServerOptions): Server {
  const { corpus, keyHashes, maxBodyBytes = MAX_BODY, maxLagMs = MAX_LAG_MS } = options;

  /*
   * One timer, and the callback does nothing but subtract. If the loop is
   * healthy this fires on schedule and lag is near zero; if something is
   * blocking it, the delay IS the lag.
   */
  let lagMs = 0;
  let lastTick = Date.now();
  const lagTimer = setInterval(() => {
    const now = Date.now();
    lagMs = Math.max(0, now - lastTick - LAG_SAMPLE_MS);
    lastTick = now;
  }, LAG_SAMPLE_MS);
  /* Never the reason a process stays alive. A metric must not outrank the
   * thing it measures. */
  lagTimer.unref();
  const requireAuth = options.requireAuth ?? Boolean(keyHashes?.size);

  /* Records come out of the corpus without a tier or a score meaning, because
   * both are properties of the source rather than of the row. */
  const toEvidence = (doc: {
    receiptId: string; source: SourceId; kind: string; externalId: string; category: string;
    channel: string; text: string; score: number; url: string; createdUtc: number; harvestedAt: number;
  }) => ({
    ...doc,
    tier: tierOf(doc.source),
    scoreKind: scoreKindOf(doc.source),
  });

  const queue = options.queue;
  const quotas = options.quotas;

  /*
   * THE REMOTE MCP ENDPOINT: the same four read only tools the stdio server
   * speaks, at POST /mcp, so a hosted instance has a URL that MCP clients and
   * connector forms can take. Streamable HTTP in its stateless form: one JSON
   * response per POST, no sessions, no server initiated stream. The research
   * tool is deliberately absent, exactly as the stdio server's read only
   * default: an agent must not start minutes of retrieval by accident.
   */
  const mcpTools = createTools({ corpus });
  const MCP_INFO = {
    name: 'quorum',
    version: '0.1.0',
    instructions: 'Market evidence with receipts. Search what buyers actually said, resolve any '
      + 'receipt id back to the real record behind it, and check a category\'s warmth before '
      + 'asking for a report. Every claim these tools return can be independently verified: '
      + 'an id that does not resolve was never real.',
  };

  /*
   * How long to wait before polling again. Honoured or not, it has to be said:
   * past a few hundred concurrent callers tight polling is a denial of service
   * we inflicted on ourselves. Queued is longer than running because a queued
   * report cannot advance until a worker frees up, and there are two workers.
   */
  const retryAfterFor = (status: string): number | null =>
    status === 'queued' ? 10 : status === 'running' ? 3 : null;

  const reportBody = (snapshot: ReportSnapshot) => snapshot;

  /* Parses and bounds the request body. Every limit here is in the spec, and a
   * limit the server does not enforce is a limit that does not exist. */
  function parseReportRequest(raw: unknown): ReportRequest | string {
    const body = raw as Record<string, unknown> | null;
    const subject = typeof body?.['subject'] === 'string' ? body['subject'].trim() : '';
    if (subject.length < 2) return 'subject is required and must be at least 2 characters';
    if (subject.length > 500) return 'subject must be at most 500 characters';

    const list = (value: unknown, max: number, name: string): string[] | string => {
      if (value === undefined) return [];
      if (!Array.isArray(value)) return `${name} must be an array of strings`;
      const items = value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
      if (items.length > max) return `${name} takes at most ${max} entries`;
      return items;
    };

    const terms = list(body?.['terms'], 20, 'terms');
    if (typeof terms === 'string') return terms;
    const communities = list(body?.['communities'], 20, 'communities');
    if (typeof communities === 'string') return communities;
    const sources = list(body?.['sources'], 40, 'sources');
    if (typeof sources === 'string') return sources;

    const capUsd = body?.['capUsd'];
    if (capUsd !== undefined && (typeof capUsd !== 'number' || !Number.isFinite(capUsd) || capUsd < 0)) {
      return 'capUsd must be a number of dollars, zero or more';
    }
    const deadlineMs = body?.['deadlineMs'];
    if (deadlineMs !== undefined && (typeof deadlineMs !== 'number' || deadlineMs < 1000)) {
      return 'deadlineMs must be at least 1000';
    }
    /*
     * THE URL IS CHECKED HERE, AND CHECKED AGAIN AT DELIVERY, FOR DIFFERENT
     * REASONS.
     *
     * This check is cheap, synchronous, and its job is a fast 400 on an
     * obviously wrong url. It is NOT the security boundary: everything decided
     * here can change before the delivery happens.
     *
     * DNS IS DELIBERATELY NOT RESOLVED AT THIS POINT. A submit time address
     * check reads like diligence and is theatre, because the attacker owns the
     * DNS answer and can change it between this moment and the connection. The
     * check that counts is the one safeFetch makes at connect time against the
     * address it then pins. Doing it here as well would only invite somebody
     * later to conclude the real one is redundant.
     *
     * Until 2026-08-23 this line was `typeof webhookUrl !== 'string'`, while
     * spec/openapi.yaml promised a scheme allowlist, a resolved and checked
     * address, a pinned connection and revalidated redirects. Nothing was
     * exploitable because nothing was delivered, but the document a customer
     * read was false.
     */
    const webhookUrl = body?.['webhookUrl'];
    if (webhookUrl !== undefined) {
      if (typeof webhookUrl !== 'string') return 'webhookUrl must be a url';
      const verdict = checkWebhookUrl(webhookUrl);
      if (!verdict.ok) return verdict.reason;
    }

    return {
      subject,
      terms: terms.length ? terms : ['quality', 'price', 'problems'],
      communities,
      sources,
      includeAds: body?.['includeAds'] === true,
      offline: body?.['offline'] === true,
      capUsd: typeof capUsd === 'number' ? capUsd : undefined,
      deadlineMs: typeof deadlineMs === 'number' ? deadlineMs : undefined,
      webhookUrl: typeof webhookUrl === 'string' ? webhookUrl : undefined,
    };
  }

  const REPORT_ID = /^\/v1\/reports\/(rep_[0-9a-f]{16})$/;
  const REPORT_STREAM = /^\/v1\/reports\/(rep_[0-9a-f]{16})\/stream$/;

  const routes: { method: string; pattern: RegExp; handler?: Handler; stream?: Streamer }[] = [
    {
      method: 'GET',
      pattern: /^\/$/,
      handler: async () => ({
        status: 200,
        body: {
          name: 'quorum',
          description: 'Market evidence with receipts. Every claim resolves to a real stored record.',
          spec: 'https://github.com/Godzilla-lab/Quorum-API/blob/main/spec/openapi.yaml',
          source: 'https://github.com/Godzilla-lab/Quorum-API',
          health: '/v1/healthz',
          /*
           * The question every keyed api forgets to answer on its front door,
           * answered for whichever mode this instance is actually in. An open
           * door saying "send your key" is as useless as a locked one saying
           * nothing.
           */
          ...(requireAuth
            ? {
              authenticate: 'send your key as a Bearer token in the Authorization header, on every /v1 path',
              getAKey: options.contactEmail
                ? `keys are issued by hand while the api is early. Email ${options.contactEmail} to request one.`
                : 'keys are issued by hand while the api is early. Ask through the source repository.',
            }
            : {
              authenticate: 'no key is needed. This instance is open and free, and the rate limits are shared by everyone, so be gentle.',
              tryIt: '/v1/categories/running%20shoes',
            }),
        },
      }),
    },
    {
      method: 'GET',
      pattern: /^\/v1\/healthz$/,
      handler: async () => ({ status: 200, body: { ok: true } }),
    },

    /*
     * MCP over Streamable HTTP, in its stateless form: every POST carries one
     * JSON-RPC message (or a 2025-03-26 batch) and gets one JSON reply, no
     * session id, no server initiated stream. The protocol logic is the same
     * `handleMessage` the stdio server runs, so the two transports cannot
     * drift. See the auth block for why this path is open on a keyed
     * instance, and `createTools` for why the research tool is absent.
     */
    {
      method: 'POST',
      pattern: /^\/mcp$/,
      handler: async (ctx) => {
        const batched = Array.isArray(ctx.body);
        const messages = batched ? ctx.body as unknown[] : [ctx.body];
        const replies: Record<string, unknown>[] = [];
        for (const message of messages) {
          const reply = await handleMessage(message, mcpTools, MCP_INFO);
          if (reply) replies.push(reply);
        }
        /* Notifications only. The spec wants a bodiless 202, and an undefined
         * body serialises to exactly that. */
        if (!replies.length) return { status: 202, body: undefined };
        return { status: 200, body: batched ? replies : replies[0] };
      },
    },

    {
      method: 'GET',
      pattern: /^\/mcp$/,
      handler: async (ctx) => ({
        status: 405,
        body: {
          error: {
            type: 'invalid_request',
            message: 'this MCP endpoint is POST only and opens no server initiated stream',
            requestId: ctx.requestId,
            retryAfterSeconds: null,
          },
        },
        headers: { allow: 'POST' },
      }),
    },

    /*
     * MONITORS: standing watches. A monitor re-runs its subject on a schedule
     * through the same queue, quota and coalescing a hand submitted report
     * goes through, under the owning key, and the finished payload, diff
     * included, goes to the monitor's webhook. The webhook url is REQUIRED,
     * because a monitor nobody hears from is a scheduled bill with no
     * customer. Tenant owned end to end: list and delete see only the calling
     * key's monitors, enforced in SQL by the driver.
     */
    {
      method: 'POST',
      pattern: /^\/v1\/monitors$/,
      handler: async (ctx) => {
        const body = ctx.body as {
          subject?: unknown; terms?: unknown; intervalHours?: unknown; webhookUrl?: unknown;
        } | undefined;

        const subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
        if (!subject) return error(400, 'invalid_request', 'subject is required', ctx.requestId);

        const rawTerms = body?.terms ?? [];
        if (!Array.isArray(rawTerms) || rawTerms.some((t) => typeof t !== 'string')) {
          return error(400, 'invalid_request', 'terms must be an array of strings', ctx.requestId);
        }
        const terms = (rawTerms as string[]).map((t) => t.trim()).filter(Boolean).slice(0, 12);

        const webhookUrl = body?.webhookUrl;
        if (typeof webhookUrl !== 'string') {
          return error(400, 'invalid_request', 'webhookUrl is required: a monitor nobody hears from is a scheduled bill with no customer', ctx.requestId);
        }
        const verdict = checkWebhookUrl(webhookUrl);
        if (!verdict.ok) return error(400, 'invalid_request', verdict.reason, ctx.requestId);

        /*
         * Six hours is the floor because every fire is a real retrieval
         * against volunteer archives, and a warm rerun still re-asks the
         * upstreams. Anyone needing minutes-fresh data is asking for a
         * different product than public archive research.
         */
        const intervalHours = body?.intervalHours === undefined ? 24 : Number(body.intervalHours);
        if (!Number.isFinite(intervalHours) || intervalHours < 6 || intervalHours > 24 * 30) {
          return error(400, 'invalid_request', 'intervalHours must be between 6 and 720', ctx.requestId);
        }

        /* A cap, not a quota: monitors are standing spend, and five per key is
         * generous for a human and stops a loop. */
        const existing = await corpus.listMonitors(ctx.keyLabel);
        if (existing.length >= 5) {
          return error(400, 'invalid_request', 'at most 5 monitors per key. Delete one first: GET /v1/monitors lists yours.', ctx.requestId);
        }

        const id = `mon_${randomBytes(8).toString('hex')}`;
        await corpus.createMonitor({
          monitorId: id, tenantId: ctx.keyLabel, keyLabel: ctx.keyLabel,
          subject, terms, webhookUrl, intervalSeconds: Math.round(intervalHours * 3600),
        });
        return {
          status: 201,
          body: { id, subject, terms, intervalHours, webhookUrl, enabled: true },
        };
      },
    },

    {
      method: 'GET',
      pattern: /^\/v1\/monitors$/,
      handler: async (ctx) => {
        const monitors = await corpus.listMonitors(ctx.keyLabel);
        return {
          status: 200,
          body: {
            monitors: monitors.map((m) => ({
              id: m.monitorId,
              subject: m.subject,
              terms: m.terms,
              intervalHours: m.intervalSeconds / 3600,
              webhookUrl: m.webhookUrl,
              enabled: m.enabled,
              createdAt: m.createdAt,
              /* Null before the first fire rather than a fake epoch date. */
              lastFiredAt: m.lastFiredAt || null,
              lastResult: m.lastResult,
            })),
          },
        };
      },
    },

    {
      method: 'DELETE',
      pattern: /^\/v1\/monitors\/(mon_[0-9a-f]{16})$/,
      handler: async (ctx) => {
        const id = /^\/v1\/monitors\/(mon_[0-9a-f]{16})$/.exec(ctx.url.pathname)![1]!;
        const removed = await corpus.deleteMonitor(id, ctx.keyLabel);
        if (!removed) return error(404, 'not_found', 'no monitor carries this id', ctx.requestId);
        return { status: 200, body: { deleted: id } };
      },
    },

    /*
     * What this key has used and what it is allowed. Specified in
     * `spec/openapi.yaml` long before it was built, and the spec's reasoning
     * is why there are two quotas rather than one.
     */
    {
      method: 'GET',
      pattern: /^\/v1\/usage$/,
      handler: async (ctx) => {
        /*
         * THE ONE PLACE A CUSTOMER GETS THEIR WEBHOOK SIGNING SECRET. Usage is
         * already scoped to the calling key, which makes it the natural
         * self-serve channel: each caller sees exactly their own secret and
         * nobody's else. Null when webhooks are off, because a secret that
         * signs nothing is not worth inventing. Before this field existed the
         * secret was derivable only by the operator, by hand, out of band,
         * which meant every onboarding included a step nobody had written
         * down.
         */
        const webhookSecret = options.webhookSecret
          ? deriveSecret(options.webhookSecret, ctx.keyLabel)
          : null;

        if (!quotas) {
          return {
            status: 200,
            body: {
              keyPrefix: ctx.keyLabel,
              periodStart: 0,
              periodEnd: 0,
              reports: { used: 0, limit: 0, remaining: 0 },
              lookups: { used: 0, limit: 0, remaining: 0 },
              concurrentReports: { running: 0, limit: 0 },
              spendUsd: 0,
              webhookSecret,
              note: 'this instance runs without quotas, so nothing is counted',
            },
          };
        }
        /* No queue means reports are not served here at all, so nothing of this
         * key's can be in flight. Zero is the true answer, not a fallback. */
        const running = queue ? queue.runningFor(ctx.keyLabel) : 0;
        return { status: 200, body: { ...quotas.snapshot(ctx.keyLabel, running), webhookSecret } };
      },
    },

    {
      method: 'POST',
      pattern: /^\/v1\/evidence\/batch$/,
      handler: async (ctx) => {
        const body = ctx.body as { receiptIds?: unknown };
        const ids = Array.isArray(body?.receiptIds) ? body.receiptIds.filter((i): i is string => typeof i === 'string') : [];
        if (!ids.length) return error(400, 'invalid_request', 'receiptIds must be a non empty array', ctx.requestId);
        if (ids.length > 200) return error(400, 'invalid_request', 'at most 200 ids per request', ctx.requestId);

        const found = await corpus.getByReceiptIds(ids.filter(isReceiptId));
        const seen = new Set(found.map((d) => d.receiptId));
        return {
          status: 200,
          body: {
            records: found.map(toEvidence),
            /* Named rather than counted. Non empty against a report's own
             * citations means something fabricated them. */
            unresolved: ids.filter((id) => !seen.has(id)),
            tombstoned: [],
          },
        };
      },
    },

    {
      method: 'POST',
      pattern: /^\/v1\/evidence\/search$/,
      handler: async (ctx) => {
        const body = ctx.body as {
          query?: unknown; category?: unknown; source?: unknown; limit?: unknown;
          minScore?: unknown; from?: unknown; until?: unknown;
          sources?: unknown; excludeSources?: unknown; sourceClasses?: unknown;
        };
        const query = typeof body?.query === 'string' ? body.query.trim() : '';
        if (!query) return error(400, 'invalid_request', 'query is required', ctx.requestId);

        /*
         * A source name nobody stores used to be cast straight through, so a
         * typo returned an empty 200 indistinguishable from "we hold
         * nothing", the exact ambiguity the categories route was added to
         * kill. Validation is against SOURCE_TIER because that table is
         * exhaustive over every storable source, while the retrieval
         * registry only knows the sources that can harvest today.
         */
        const knownSource = (s: string): s is SourceId => s in SOURCE_TIER;
        const sourceList = (value: unknown, field: string): SourceId[] | { message: string } => {
          if (value == null) return [];
          if (!Array.isArray(value) || value.some((s) => typeof s !== 'string')) {
            return { message: `${field} must be an array of source ids` };
          }
          const unknown = (value as string[]).find((s) => !knownSource(s));
          if (unknown !== undefined) {
            return { message: `${field} names an unknown source ${JSON.stringify(unknown)}; GET /v1/categories shows what is held, and the spec's SourceId enum lists every storable source` };
          }
          return value as SourceId[];
        };

        const single = body?.source;
        if (single != null && (typeof single !== 'string' || !knownSource(single))) {
          return error(400, 'invalid_request', `source names an unknown source ${JSON.stringify(single)}`, ctx.requestId);
        }
        const sources = sourceList(body?.sources, 'sources');
        if (!Array.isArray(sources)) return error(400, 'invalid_request', sources.message, ctx.requestId);
        const excludeSources = sourceList(body?.excludeSources, 'excludeSources');
        if (!Array.isArray(excludeSources)) return error(400, 'invalid_request', excludeSources.message, ctx.requestId);

        /*
         * Source classes are the caller facing names for the evidence tiers,
         * expanded to source lists HERE so the corpus never learns the class
         * vocabulary. consumer_voice is tier C, practitioner is B,
         * institutional is A; tier D is context and is not a class anyone
         * asks for by name.
         */
        const CLASS_TIER: Record<string, EvidenceTier> = {
          consumer_voice: 'C', practitioner: 'B', institutional: 'A',
        };
        let classSources: SourceId[] = [];
        if (body?.sourceClasses != null) {
          const classes = body.sourceClasses;
          if (!Array.isArray(classes) || classes.some((c) => typeof c !== 'string')) {
            return error(400, 'invalid_request', 'sourceClasses must be an array of class names', ctx.requestId);
          }
          const bad = (classes as string[]).find((c) => !(c in CLASS_TIER));
          if (bad !== undefined) {
            return error(400, 'invalid_request',
              `sourceClasses names an unknown class ${JSON.stringify(bad)}; the classes are consumer_voice, practitioner and institutional`,
              ctx.requestId);
          }
          const wanted = new Set((classes as string[]).map((c) => CLASS_TIER[c]!));
          classSources = (Object.keys(SOURCE_TIER) as SourceId[]).filter((s) => wanted.has(SOURCE_TIER[s]));
        }
        /* Explicit sources and class expansions union: both are inclusion. */
        const includeSources = [...new Set([...sources, ...classSources])];

        const numberOrBad = (value: unknown, field: string): number | null | { message: string } => {
          if (value == null) return null;
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            return { message: `${field} must be a number` };
          }
          return value;
        };
        const minScore = numberOrBad(body?.minScore, 'minScore');
        if (minScore !== null && typeof minScore !== 'number') return error(400, 'invalid_request', minScore.message, ctx.requestId);
        const from = numberOrBad(body?.from, 'from');
        if (from !== null && typeof from !== 'number') return error(400, 'invalid_request', from.message, ctx.requestId);
        const until = numberOrBad(body?.until, 'until');
        if (until !== null && typeof until !== 'number') return error(400, 'invalid_request', until.message, ctx.requestId);

        const limit = Math.min(Number(body?.limit) || 50, 500);
        const rows = await corpus.search(query, {
          limit,
          ...(typeof body?.category === 'string' ? { category: body.category } : {}),
          ...(typeof single === 'string' ? { source: single as SourceId } : {}),
          ...(includeSources.length ? { sources: includeSources } : {}),
          ...(excludeSources.length ? { excludeSources } : {}),
          ...(minScore !== null ? { minScore } : {}),
          ...(from !== null ? { from } : {}),
          ...(until !== null ? { until } : {}),
        });
        return {
          status: 200,
          body: {
            records: rows.map((r) => ({ ...toEvidence(r), rank: r.rank })),
            /* Whether every record matched ALL the query words, or the
             * any-word fallback answered. A caller counting these rows as
             * corroboration needs to know which question the rows answer. */
            matchedAllWords: rows.length ? rows[0]!.matchedAll : true,
            /* Always bounded. An unbounded response is a denial of service
             * vector aimed at ourselves. */
            nextCursor: null,
          },
        };
      },
    },

    /*
     * The discovery path, declared BEFORE the slug route so the bare
     * collection URL cannot be read as a slug. Until 2026-08-24 a caller had
     * to already know a slug: an outside tester guessed five categories, four
     * answered with nothing, and nothing is indistinguishable from the
     * service being broken.
     */
    {
      method: 'GET',
      pattern: /^\/v1\/categories$/,
      handler: async (ctx) => {
        const all = await corpus.listCategories();
        const limit = Math.min(Number(ctx.url.searchParams.get('limit')) || 100, 500);
        const offset = Math.max(Number(ctx.url.searchParams.get('offset')) || 0, 0);
        const page = all.slice(offset, offset + limit);
        return {
          status: 200,
          headers: { 'cache-control': 'public, max-age=60' },
          body: {
            categories: page,
            total: all.length,
            /* Same bounded-response rule as evidence search. */
            nextOffset: offset + page.length < all.length ? offset + page.length : null,
          },
        };
      },
    },

    {
      method: 'GET',
      pattern: /^\/v1\/categories\/(.+)$/,
      handler: async (ctx) => {
        const slug = decodeURIComponent(/^\/v1\/categories\/(.+)$/.exec(ctx.url.pathname)![1]!);
        const stats = await corpus.categoryStats(slug);
        return { status: 200, headers: { 'cache-control': 'public, max-age=60' }, body: stats };
      },
    },

    {
      method: 'GET',
      pattern: /^\/v1\/evidence\/ads\/(.+)$/,
      handler: async (ctx) => {
        const adId = decodeURIComponent(/^\/v1\/evidence\/ads\/(.+)$/.exec(ctx.url.pathname)![1]!);
        const observations = await corpus.adObservations(adId);
        if (!observations.length) return error(404, 'not_found', 'no observations recorded for this ad', ctx.requestId);
        return { status: 200, body: { adId, observations } };
      },
    },

    /*
     * The resolver. Declared AFTER the more specific evidence routes, because
     * the pattern has to be loose enough that a MALFORMED id reaches this
     * handler and gets a 400. A pattern that only matched hex meant `rc_nope`
     * matched no route at all and returned 404, which says "this evidence does
     * not exist" about something that was never a valid question.
     */
    {
      method: 'GET',
      pattern: /^\/v1\/evidence\/([^/]+)$/,
      handler: async (ctx) => {
        const id = decodeURIComponent(/^\/v1\/evidence\/([^/]+)$/.exec(ctx.url.pathname)![1]!);
        if (!isReceiptId(id)) {
          /* Malformed and unknown are different answers: one says you asked
           * wrongly, the other says this evidence does not exist. */
          return error(400, 'invalid_request', 'that is not a well formed receipt id', ctx.requestId);
        }
        const [doc] = await corpus.getByReceiptIds([id]);
        /* A well formed id that names nothing returns 404 and never a nearest
         * match. That answer is the entire product. */
        if (!doc) return error(404, 'not_found', 'no record carries this id', ctx.requestId);
        return {
          status: 200,
          /* A receipt id is derived from the record's content, so the record
           * behind it can never change and this is safe to cache for a year. */
          headers: { 'cache-control': 'public, max-age=31536000, immutable', etag: `"${id}"` },
          body: toEvidence(doc),
        };
      },
    },

    /*
     * The endpoint that takes output this API did not produce.
     */
    {
      method: 'POST',
      pattern: /^\/v1\/verify$/,
      handler: async (ctx) => {
        const body = ctx.body as { claims?: unknown };
        if (!Array.isArray(body?.claims) || !body.claims.length) {
          return error(400, 'invalid_request', 'claims must be a non empty array', ctx.requestId);
        }
        if (body.claims.length > 100) {
          return error(400, 'invalid_request', 'at most 100 claims per request', ctx.requestId);
        }

        const claims: ModelClaim[] = (body.claims as Record<string, unknown>[]).map((c) => ({
          term: typeof c['term'] === 'string' ? c['term'] : 'unnamed',
          text: typeof c['text'] === 'string' ? c['text'] : '',
          receiptIds: Array.isArray(c['receiptIds'])
            ? (c['receiptIds'] as unknown[]).filter((i): i is string => typeof i === 'string')
            : [],
        }));

        const resolved = await resolveCitations(claims, corpus);
        return {
          status: 200,
          body: {
            claims: resolved.map((r, i) => ({
              term: r.term,
              text: r.text,
              cited: new Set(claims[i]?.receiptIds ?? []).size,
              resolved: r.receipts.length,
              fabricated: r.fabricated,
              unsupportedQuotes: r.unsupportedQuotes,
              verdict: r.verdict,
              /* Recomputed over the survivors, never inherited from the caller. */
              records: r.corroboration.records,
              demoted: r.fabricated.length > 0 && r.verdict !== 'finding',
            })),
            fabrication: fabricationReport(resolved),
            clean: fabricationReport(resolved).clean,
          },
        };
      },
    },

    /*
     * REPORTS. All three answer 501 without a queue rather than pretending.
     */
    {
      method: 'POST',
      pattern: /^\/v1\/reports$/,
      handler: async (ctx) => {
        if (!queue) return error(501, 'internal', 'this build has no job queue, so reports cannot be started. The evidence and verify endpoints are live.', ctx.requestId);

        const parsed = parseReportRequest(ctx.body);
        if (typeof parsed === 'string') return error(400, 'invalid_request', parsed, ctx.requestId);

        const raw = ctx.headers['idempotency-key'];
        const idempotencyKey = typeof raw === 'string' ? raw.trim() : '';
        if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 255)) {
          return error(400, 'invalid_request', 'Idempotency-Key must be between 8 and 255 characters', ctx.requestId);
        }

        const result = await queue.submit(parsed, {
          keyLabel: ctx.keyLabel,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });

        if (!result.ok) {
          const type = result.status === 409 ? 'conflict' : result.status === 429 ? 'rate_limited' : 'queue_saturated';
          const e = error(result.status, type, result.message, ctx.requestId);
          /* A 503 and a 429 are both "come back later", and a caller that is
           * not told how long guesses, which means immediately. */
          if (result.status !== 409) {
            (e.body as { error: { retryAfterSeconds: number | null } }).error.retryAfterSeconds = 30;
            return { ...e, headers: { 'retry-after': '30' } };
          }
          return e;
        }

        return {
          status: 202,
          headers: { location: `/v1/reports/${result.accepted.id}` },
          body: result.accepted,
        };
      },
    },

    {
      method: 'GET',
      pattern: REPORT_ID,
      handler: async (ctx) => {
        if (!queue) return error(501, 'internal', 'this build has no job queue', ctx.requestId);
        const id = REPORT_ID.exec(ctx.url.pathname)![1]!;
        const snapshot = queue.get(id);
        if (!snapshot) {
          /*
           * THE QUEUE FORGETS, THE CORPUS DOES NOT. The queue is in memory, so
           * a finished report used to 404 after every restart and every sleep,
           * which reads to a caller as their report never having existed. The
           * persisted snapshot is the exact bytes this handler served while
           * the report was live: parse and re-serve, and the serializer
           * reproduces them byte for byte because parse preserves key order.
           * A terminal report never advances, so the ETag is stable and there
           * is no Retry-After to send.
           */
          const stored = await corpus.getReportSnapshot(id);
          if (!stored) return error(404, 'not_found', 'no report carries this id', ctx.requestId);
          const etag = `"${id}-final"`;
          if (ctx.headers['if-none-match'] === etag) {
            return { status: 304, body: null, headers: { etag } };
          }
          return { status: 200, headers: { etag }, body: JSON.parse(stored.payload) };
        }

        /*
         * The version changes exactly when the report advances, so a poller
         * that has not missed anything gets a 304 and reads nothing. Without
         * this, honouring Retry-After still costs a full report body per poll.
         */
        const etag = `"${id}-${snapshot.version}"`;
        if (ctx.headers['if-none-match'] === etag) {
          return { status: 304, body: null, headers: { etag } };
        }

        const retryAfter = retryAfterFor(snapshot.status);
        return {
          status: 200,
          headers: {
            etag,
            ...(retryAfter === null ? {} : { 'retry-after': String(retryAfter) }),
          },
          body: reportBody(snapshot),
        };
      },
    },

    {
      method: 'DELETE',
      pattern: REPORT_ID,
      handler: async (ctx) => {
        if (!queue) return error(501, 'internal', 'this build has no job queue', ctx.requestId);
        const id = REPORT_ID.exec(ctx.url.pathname)![1]!;
        const snapshot = queue.cancel(id);
        if (!snapshot) return error(404, 'not_found', 'no report carries this id', ctx.requestId);
        /* 200 whether it was cancelled or had already finished. A caller
         * racing the end of a job should not have to handle a special case for
         * winning that race. */
        return { status: 200, body: reportBody(snapshot) };
      },
    },

    /*
     * SERVER SENT EVENTS.
     *
     * Writes its own response, because it is the only endpoint here that is not
     * one JSON body. Measured on the engine, a warm run is 82s of which 68s is
     * a single synthesis call, so streaming makes time to first insight a few
     * seconds while time to complete stays what it is.
     */
    {
      method: 'GET',
      pattern: REPORT_STREAM,
      stream: async (ctx, req, res) => {
        const id = REPORT_STREAM.exec(ctx.url.pathname)![1]!;
        if (!queue || !queue.get(id)) {
          const e = queue
            ? error(404, 'not_found', 'no report carries this id', ctx.requestId)
            : error(501, 'internal', 'this build has no job queue', ctx.requestId);
          res.writeHead(e.status, { 'content-type': 'application/json; charset=utf-8', 'x-request-id': ctx.requestId });
          res.end(JSON.stringify(e.body, null, 2));
          return;
        }

        /*
         * `Last-Event-ID` REPLAYS RATHER THAN RESTARTS. A flaky client must
         * cost nothing upstream, and a reconnect that restarted the report
         * would cost everything.
         */
        const resumeHeader = req.headers['last-event-id'];
        const resumeFrom = Number(Array.isArray(resumeHeader) ? resumeHeader[0] : resumeHeader ?? 0) || 0;

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-request-id': ctx.requestId,
        });

        const controller = new AbortController();
        /* The client hanging up must stop us waiting on an event nobody will
         * read, or an abandoned tab holds a waiter for the life of the run. */
        req.on('close', () => controller.abort());

        const write = (event: { id: number; type: string; data: unknown }): void => {
          res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
        };

        /*
         * A HEARTBEAT, BECAUSE THE QUIET STRETCH IS THE NORMAL CASE. A cold
         * run spends most of a minute retrieving with nothing to say, and an
         * idle proxy or load balancer with a 60 second timeout kills the
         * socket mid run; the client then reconnects and, without the replay
         * above, would have restarted the report. A comment frame is the SSE
         * mechanism for exactly this: every parser discards it, and 25
         * seconds sits under every common idle timeout. Unref'd so a
         * heartbeat cannot hold the process open on shutdown.
         */
        const heartbeat = setInterval(() => { res.write(': keep-alive\n\n'); }, 25_000);
        heartbeat.unref();

        try {
          for (const event of queue.eventsSince(id, resumeFrom) ?? []) write(event);

          let cursor = queue.eventsSince(id, 0)?.at(-1)?.id ?? resumeFrom;
          while (!controller.signal.aborted) {
            const event = await queue.nextEvent(id, cursor, controller.signal);
            if (!event) break;
            cursor = event.id;
            write(event);
            /* `done` and `error` are terminal by definition, and a stream that
             * stayed open after them is a connection nobody will ever close. */
            if (event.type === 'done' || event.type === 'error') break;
          }
        } finally {
          clearInterval(heartbeat);
        }
        res.end();
      },
    },
  ];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = randomUUID();

    /*
     * Filled in by the quota check once the key is known, and MERGED INTO
     * EVERY RESPONSE BY send ITSELF, which is the part that was missing.
     *
     * These headers were built on every request and then passed to send in
     * exactly one place: the 429. So the documented promise, that a caller can
     * read its remaining allowance and pace itself BEFORE being refused, was
     * impossible: the first time anyone saw a rate limit header was the
     * refusal. The spec, the README and the bench docs all said otherwise, and
     * nothing could notice because a header nobody sends looks identical to
     * one nobody reads. Found 2026-08-23 by curling the live instance and
     * counting the headers that came back.
     *
     * Empty until the quota block runs, so a shed 503 and an unauthenticated
     * 401 carry none, correctly: there is no key yet to report an allowance
     * for.
     */
    let quotaHeaders: Record<string, string> = {};

    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      const payload = JSON.stringify(body, null, 2);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        /* On every response, not only on errors. Support is impossible without
         * something a caller can quote back. */
        'x-request-id': requestId,
        ...quotaHeaders,
        ...headers,
      });
      res.end(payload);
    };

    /*
     * SHED BEFORE READING ANYTHING. A refusal has to be cheaper than the work
     * it is refusing, or the shedder becomes the bottleneck it exists to
     * prevent. Health checks are never shed: a monitor concluding the process
     * is dead because it is busy is how a busy server gets restarted.
     */
    if (lagMs > maxLagMs && req.url !== '/v1/healthz') {
      send(503, {
        error: {
          type: 'overloaded',
          message: 'too many requests in flight. This is a deliberate refusal rather than a dropped connection, so it is safe to retry.',
          requestId,
          retryAfterSeconds: 1,
        },
      }, { 'retry-after': '1' });
      req.resume();
      return;
    }

    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

        /*
         * With auth off every caller is the same self hosted operator, so they
         * share one allowance. That is the correct reading rather than a
         * fallback: an open instance has one user, and giving each anonymous
         * request its own quota would mean there is no quota.
         */
        let keyLabel = 'self-hosted';
        /*
         * The root is a signpost, not a surface: static json naming the
         * project, the spec and how to authenticate. It exists because the
         * first thing anyone does with an api host is open it in a browser,
         * and a bare 401 teaches them nothing. Exempt from auth and from the
         * meters for the same reason healthz is: it reads nothing.
         */
        /*
         * /mcp IS OPEN ON A KEYED INSTANCE, AND THAT IS A DOCUMENTED STANCE,
         * not an oversight. The keyed door exists to protect spend: synthesis,
         * ads, retrieval. The MCP tools are read only projections of public
         * data the corpus already holds, they can spend nothing, and connector
         * forms offer no field to put a key in. Anonymous MCP callers share
         * one rate bucket below, so they cannot crowd out keyed customers; a
         * caller who does present a valid key gets their own allowance.
         */
        const openPath = url.pathname === '/v1/healthz' || url.pathname === '/' || url.pathname === '/mcp';
        if (requireAuth && !openPath) {
          const header = req.headers.authorization ?? '';
          const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
          const label = presented && keyHashes ? keyMatches(presented, keyHashes) : null;
          if (!label) {
            const e = error(401, 'unauthorized', 'a bearer key is required', requestId);
            send(e.status, e.body);
            return;
          }
          keyLabel = label;
        } else if (requireAuth && url.pathname === '/mcp') {
          const header = req.headers.authorization ?? '';
          const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
          const label = presented && keyHashes ? keyMatches(presented, keyHashes) : null;
          keyLabel = label ?? 'mcp-public';
        }

        /*
         * QUOTAS AFTER AUTH AND BEFORE ROUTING.
         *
         * After auth because a limit is per key and an unauthenticated request
         * has no key to charge. Before routing because the cheapest possible
         * refusal is the point: a 429 that first did the work it was refusing
         * protects nothing.
         */
        if (quotas) {
          const meter = meterFor(req.method ?? 'GET', url.pathname);
          const decision = quotas.check(keyLabel, meter);
          if (meter !== 'exempt') {
            quotaHeaders = {
              'x-ratelimit-limit': String(decision.state.limit),
              'x-ratelimit-remaining': String(decision.state.remaining),
              'x-ratelimit-reset': String(decision.retryAfterSeconds),
            };
          }
          if (!decision.allowed) {
            const e = error(429, 'rate_limited',
              `too many ${meter} for this key. ${decision.state.used} used of ${decision.state.limit}. `
              + `Retry in ${decision.retryAfterSeconds}s, or check GET /v1/usage.`,
              requestId);
            (e.body as { error: { retryAfterSeconds: number | null } }).error.retryAfterSeconds = decision.retryAfterSeconds;
            send(e.status, e.body, { ...quotaHeaders, 'retry-after': String(decision.retryAfterSeconds) });
            return;
          }
        }

        const route = routes.find((r) => r.method === (req.method ?? 'GET') && r.pattern.test(url.pathname));
        if (!route) {
          const e = error(404, 'not_found', `no route for ${req.method} ${url.pathname}`, requestId);
          send(e.status, e.body);
          return;
        }

        let body: unknown;
        if (req.method === 'POST') {
          /*
           * DECLARED LENGTH FIRST, before a byte is read.
           *
           * Aborting midway through a body the client is still writing leaves
           * the connection in a state `fetch` waits on forever: breaking out of
           * `for await` closes the stream, so a drain afterwards is a no op and
           * the response that was already sent never arrives. Refusing up front
           * on the header the client itself supplied avoids the race entirely,
           * and it is what every real server does.
           */
          const declared = Number(req.headers['content-length'] ?? 0);
          if (declared > maxBodyBytes) {
            const e = error(413, 'invalid_request', 'request body too large', requestId);
            send(e.status, e.body);
            /*
             * Drained, and the connection deliberately left open. Closing it
             * here cuts the socket while the client is still uploading, and the
             * client reports a transport failure instead of the 413 that was
             * already written. Responding early to an upload in progress is
             * legal HTTP; hanging up on it is what breaks clients.
             */
            req.resume();
            return;
          }

          const chunks: Buffer[] = [];
          let size = 0;
          let overflowed = false;
          for await (const chunk of req) {
            size += (chunk as Buffer).length;
            /* A chunked body declares no length, so the guard still has to
             * exist. It stops accumulating and keeps reading, so the request
             * completes and the response is delivered. */
            if (size > maxBodyBytes) { overflowed = true; continue; }
            chunks.push(chunk as Buffer);
          }
          if (overflowed) {
            const e = error(413, 'invalid_request', 'request body too large', requestId);
            send(e.status, e.body);
            return;
          }
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw.trim()) {
            try { body = JSON.parse(raw); } catch {
              const e = error(400, 'invalid_request', 'the body is not json', requestId);
              send(e.status, e.body);
              return;
            }
          }
        }

        const ctx: Ctx = { requestId, url, body, keyLabel, headers: req.headers };

        if (route.stream) {
          await route.stream(ctx, req, res);
          return;
        }

        const result = await route.handler!(ctx);
        /* A 304 carries no body by definition, and sending one makes a
         * conditional GET more expensive than the unconditional one it was
         * meant to replace. */
        if (result.status === 304) {
          res.writeHead(304, { 'x-request-id': requestId, ...result.headers });
          res.end();
          return;
        }
        send(result.status, result.body, result.headers ?? {});
      } catch (err) {
        /*
         * The message is not echoed. An internal error string carries stack
         * paths and sometimes key material, and both end up in a customer's
         * logs. The request id is how it gets traced instead.
         */
        send(500, { error: { type: 'internal', message: 'the request could not be completed', requestId, retryAfterSeconds: null } });
        process.stderr.write(`[${requestId}] ${err instanceof Error ? err.stack : String(err)}\n`);
      }
    })();
  });

  server.on('close', () => clearInterval(lagTimer));

  return server;
}
