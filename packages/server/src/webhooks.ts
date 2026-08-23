/*
 * Webhook delivery: signing, address safety, and the retry policy.
 *
 * WHY THIS FILE EXISTS AT ALL, STATED PLAINLY. `spec/openapi.yaml` has promised
 * since M1 that a webhook url is "validated against the same rules as every
 * other URL this service touches: scheme allowlist, DNS resolved and checked
 * against private and reserved space before connecting, the resolved address
 * pinned for the connection, and every redirect hop revalidated". What the code
 * did was `typeof webhookUrl !== 'string'`, and then it dropped the value on the
 * floor. Nothing was exploitable because nothing was delivered, but the document
 * a customer reads was false, and adding delivery naively would have turned that
 * false claim into a live SSRF into cloud metadata.
 *
 * DELIVERY GOES THROUGH `safeFetch` AND NOTHING ELSE, because safeFetch already
 * implements every clause of that sentence and has the tests to prove it. This
 * module adds no address logic of its own. Writing a second one would mean two
 * implementations of the rule the legal and security posture rests on.
 *
 * SIGNED TO THE STANDARD WEBHOOKS SPEC (standardwebhooks.com) rather than to a
 * scheme invented here, so a receiver can verify with an off the shelf library.
 * A bespoke signature would work exactly as well and would oblige every customer
 * to write crypto, which is where webhook verification actually goes wrong.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { checkAddress, checkScheme, safeFetch, type Refusal, type SafeFetchOptions } from '@quorum/sources';
import type { CorpusDriver, WebhookDelivery, WebhookDeliveryStatus } from '@quorum/corpus';

/*
 * Standard Webhooks: `{id}.{timestamp}.{payload}`, signed with HMAC-SHA256,
 * presented as `v1,{base64}`. The header carries a SPACE DELIMITED LIST so a
 * secret can be rotated by signing with both for a window.
 */
const SIGNATURE_VERSION = 'v1';
const SECRET_PREFIX = 'whsec_';

/* Replay window for `verify`. Five minutes, which is the common default. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/*
 * A receiver's body is not interesting and must not become a way to make us
 * hold memory or a socket. Far tighter than safeFetch's own 30s and 8MB, which
 * are calibrated for fetching an actual document.
 */
const DELIVERY_TIMEOUT_MS = 10_000;
const DELIVERY_MAX_BYTES = 64 * 1024;

/*
 * THE RETRY SCHEDULE, TAKEN FROM THE SPEC RATHER THAN INVENTED.
 *
 * Seconds to wait after attempt N before attempting N+1. Attempt 1 is
 * immediate, so the first entry is the wait after it fails.
 *
 * WHAT THIS REPLACED, AND WHY IT MATTERED. The first version was
 * `min(15 minutes, 2s * 2^(n-1))` over 5 attempts. Worked out on 2026-08-23,
 * that is 2s, 4s, 8s, 16s, 32s: a SIXTY TWO SECOND total horizon, and the 15
 * minute ceiling was unreachable dead code because reaching it needs 10
 * attempts. A durable queue whose whole justification is surviving an instance
 * that sleeps is pointless if it gives up before the instance wakes up.
 *
 * These nine waits sum to 75 hours 35 minutes, which is the schedule in the
 * Standard Webhooks spec, matched deliberately so a receiver's expectations and
 * ours are the same document.
 */
const SCHEDULE_SECONDS = [5, 300, 1_800, 7_200, 18_000, 36_000, 50_400, 72_000, 86_400] as const;

export const MAX_ATTEMPTS = SCHEDULE_SECONDS.length + 1;

/*
 * Jitter, as a fraction of the interval rather than a flat amount, because the
 * spec asks for it and because a flat second means nothing against a 24 hour
 * wait. Prevents a fleet of deliveries queued during one outage from all
 * arriving in the same instant when the receiver comes back.
 */
const JITTER_FRACTION = 0.1;

/*
 * Per key secrets, derived rather than stored.
 *
 * HMAC of the key label under one instance secret gives every caller a distinct,
 * stable secret that can be shown to that caller and to nobody else, with no
 * table and no migration. Deriving also means the instance secret never leaves
 * this process: what a customer is told is already one HMAC away from it.
 */
export function deriveSecret(instanceSecret: string, keyLabel: string): string {
  const derived = createHmac('sha256', instanceSecret).update(`webhook:${keyLabel}`).digest();
  return `${SECRET_PREFIX}${derived.toString('base64')}`;
}

/*
 * The exact bytes the spec says to sign.
 *
 * The spec requires the id and timestamp contain no `.`, or the delimiter
 * becomes ambiguous and two different messages can produce one signed string.
 * Report ids are `rep_[0-9a-f]{16}` and the timestamp is an integer, so both
 * hold, and this asserts it rather than trusting it: the day an id format
 * changes, this should fail loudly rather than sign something forgeable.
 */
export function signedContent(id: string, timestampSeconds: number, payload: string): string {
  if (id.includes('.')) throw new Error('a webhook id may not contain a dot, it is the signing delimiter');
  if (!Number.isInteger(timestampSeconds)) throw new Error('a webhook timestamp must be whole seconds');
  return `${id}.${timestampSeconds}.${payload}`;
}

export function sign(secret: string, id: string, timestampSeconds: number, payload: string): string {
  /* The base64 body of the secret is the key, not the `whsec_` label. */
  const key = Buffer.from(secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret, 'base64');
  const mac = createHmac('sha256', key).update(signedContent(id, timestampSeconds, payload)).digest();
  return `${SIGNATURE_VERSION},${mac.toString('base64')}`;
}

export interface VerifyOptions {
  /*
   * How far out of date a timestamp may be, in seconds, in either direction.
   * Five minutes is the common default and is what Svix ships.
   */
  toleranceSeconds?: number;
  /* Unix seconds. Injected by tests. */
  now?: () => number;
}

/*
 * Verification, exported so our own tests and anybody reading this can check a
 * delivery. Constant time, and length guarded because `timingSafeEqual` throws
 * on a length mismatch, which is the same idiom `keyMatches` in http.ts uses.
 *
 * THE TIMESTAMP IS CHECKED, NOT MERELY SIGNED, and that is not optional. A
 * signature alone is replayable forever: an attacker who captures one valid
 * delivery can post it again next year and it verifies. The spec says a
 * verifier must bound the age, and this function is the example a customer
 * copies, so shipping one under the name `verify` that skipped the check would
 * be worse than shipping none.
 */
export function verify(
  secret: string,
  id: string,
  timestampSeconds: number,
  payload: string,
  header: string,
  options: VerifyOptions = {},
): boolean {
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.now ? options.now() : Math.floor(Date.now() / 1000);

  /*
   * MALFORMED INPUT IS A FAILED VERIFICATION, NEVER AN EXCEPTION. The id and
   * timestamp arrive from whoever is POSTing at the receiver, which means an
   * attacker chooses them. `sign` throws on a dotted id and a fractional
   * timestamp, correctly, because WE must never produce one. A VERIFIER that
   * does the same hands the attacker an unhandled exception in the receiver's
   * process for the price of one crafted header. Proved 2026-08-23:
   * `webhook-timestamp: 1731705121.5` threw straight through verify.
   */
  if (!Number.isInteger(timestampSeconds)) return false;
  if (id.includes('.')) return false;
  if (Math.abs(now - timestampSeconds) > tolerance) return false;

  const expected = sign(secret, id, timestampSeconds, payload);
  const [, expectedMac = ''] = expected.split(',');
  /* A space delimited list, so a rotated secret can be accepted during a window.
   * Any one matching signature is enough. */
  for (const candidate of header.split(' ')) {
    const [version, mac] = candidate.split(',');
    if (version !== SIGNATURE_VERSION || !mac) continue;
    const a = Buffer.from(mac, 'base64');
    const b = Buffer.from(expectedMac, 'base64');
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* the url, checked twice and for different reasons                    */
/* ------------------------------------------------------------------ */

export interface UrlVerdict { ok: boolean; reason: string }

/*
 * SUBMIT TIME. Cheap, synchronous, and its job is a fast 400 on an obviously
 * wrong url rather than security: everything decided here can change before the
 * delivery happens.
 *
 * DNS IS DELIBERATELY NOT RESOLVED HERE. A submit time address check reads like
 * diligence and is theatre, because the attacker controls the DNS answer and can
 * change it between this moment and the connection. The address check that
 * counts is the one safeFetch does at connect time, against the address it then
 * pins. Doing it here as well would only invite somebody to conclude the real
 * one is redundant.
 */
export function checkWebhookUrl(raw: string): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'webhookUrl must be an absolute url' };
  }

  /* https only. OWASP is explicit, and a plaintext webhook publishes the whole
   * report to anybody on the path. safeFetch permits http because a public
   * archive may only offer it; a customer endpoint has no such excuse. */
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'webhookUrl must be https' };
  }
  const scheme = checkScheme(url.protocol);
  if (!scheme.allowed) return { ok: false, reason: `webhookUrl scheme refused: ${scheme.reason ?? 'not allowed'}` };

  /* Credentials in the url would be signed into nothing and logged into
   * everything, and no legitimate receiver needs them. */
  if (url.username || url.password) {
    return { ok: false, reason: 'webhookUrl must not contain credentials' };
  }

  /*
   * AN IP LITERAL IS CHECKED HERE, AND A HOSTNAME IS NOT. The distinction is
   * the whole point and it is easy to get backwards.
   *
   * Resolving a NAME at submit time is theatre: the caller owns the DNS answer
   * and can change it between this moment and the connection, so a check here
   * proves nothing about what we will connect to. That check belongs at
   * delivery, against the address that then gets pinned.
   *
   * A LITERAL HAS NO SUCH GAP. The address is right there in the url, nothing
   * resolves it, and it cannot change. Refusing it now is free and it is the
   * difference between a caller getting an immediate 400 that names the problem
   * and a caller getting a 202 followed by a webhook that silently never
   * arrives. safeFetch still refuses it at delivery either way, which is why
   * this was a usability defect rather than a hole.
   *
   * The url parser has already normalised the obfuscated forms by this point:
   * 0177.0.0.1, 0x7f000001 and 2130706433 all read as 127.0.0.1 here.
   */
  const literal = /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':');
  if (literal) {
    const verdict = checkAddress(url.hostname);
    if (!verdict.allowed) {
      return { ok: false, reason: `webhookUrl address refused: ${verdict.reason ?? 'not allowed'}` };
    }
  }

  return { ok: true, reason: 'ok' };
}

/* ------------------------------------------------------------------ */
/* delivery                                                            */
/* ------------------------------------------------------------------ */

export interface DeliveryRequest {
  /* The webhook id, which is also the id the receiver deduplicates on. */
  id: string;
  url: string;
  secret: string;
  /* Already serialised, because the bytes SIGNED must be the bytes SENT. Signing
   * an object and serialising it again invites a different key order. */
  payload: string;
  timestampSeconds: number;
}

export interface DeliveryResult {
  delivered: boolean;
  status: number;
  /* Whether trying again could plausibly work. */
  retryable: boolean;
  detail: string;
}

export interface DeliveryDeps {
  fetch?: typeof safeFetch;
  signal?: AbortSignal;
}

/*
 * One attempt. Errors are values, as everywhere a vendor can be down, and here
 * the "vendor" is a customer endpoint we know nothing about.
 */
export async function deliver(request: DeliveryRequest, deps: DeliveryDeps = {}): Promise<DeliveryResult> {
  const send = deps.fetch ?? safeFetch;

  /* Re-checked at delivery, not only at submit: a report can be enqueued for
   * minutes and the row may have been written by an older build. */
  const verdict = checkWebhookUrl(request.url);
  if (!verdict.ok) {
    return { delivered: false, status: 0, retryable: false, detail: verdict.reason };
  }

  const options: SafeFetchOptions = {
    method: 'POST',
    body: request.payload,
    headers: {
      'content-type': 'application/json',
      'webhook-id': request.id,
      'webhook-timestamp': String(request.timestampSeconds),
      'webhook-signature': sign(request.secret, request.id, request.timestampSeconds, request.payload),
    },
    timeoutMs: DELIVERY_TIMEOUT_MS,
    maxBytes: DELIVERY_MAX_BYTES,
    ...(deps.signal ? { signal: deps.signal } : {}),
  };

  const result = await send(request.url, options);

  /*
   * safeFetch reports a refusal as status 0 plus a `refusal` tag, which covers
   * a blocked address, a refused scheme, a redirect into private space and a
   * transport failure. A refused ADDRESS must never be retried: the answer will
   * not improve, and retrying is how a blocked target becomes a slow scan.
   *
   * THIS USED TO PATTERN MATCH THE ERROR SENTENCE and got it badly wrong.
   * Checked on 2026-08-23 against every reason the address guard can produce,
   * the regex classified 13 of the 19 blocked ranges as RETRYABLE, because
   * "private" and "loopback" were in it and "carrier grade nat", "multicast",
   * "unique local", "nat64" and "broadcast" were not. The tag exists so that
   * this decision is made from a fact rather than from prose that nobody is
   * stopping anyone from rewording.
   */
  if (result.status === 0) {
    const detail = result.error ?? 'no response';
    return {
      delivered: false,
      status: 0,
      retryable: isRetryableRefusal(result.refusal),
      detail,
    };
  }

  if (result.status >= 200 && result.status < 300) {
    return { delivered: true, status: result.status, retryable: false, detail: 'delivered' };
  }

  /*
   * A 4xx is the receiver saying it does not want this body. Sending the same
   * bytes again cannot change that, and retrying somebody's 401 for an hour is
   * how a webhook sender becomes an attacker. 429 is the exception: it is an
   * explicit "later", not a refusal.
   */
  const retryable = result.status >= 500 || result.status === 429;
  return { delivered: false, status: result.status, retryable, detail: `receiver returned ${result.status}` };
}

/*
 * Which refusals could ever succeed on a retry.
 *
 * Four of the seven are rules and can never change their answer. Three are
 * conditions and might. An unknown tag is treated as permanent, because the
 * safe default when this module does not recognise a refusal is to stop rather
 * than to keep knocking.
 */
export function isRetryableRefusal(refusal: Refusal | undefined): boolean {
  return refusal === 'dns' || refusal === 'transport' || refusal === 'timeout';
}

/*
 * How long to wait after `attempt` attempts before making the next one, in
 * seconds. Returns null when the schedule is spent, which is the signal to mark
 * the delivery exhausted rather than to keep going.
 */
export function nextAttemptDelaySeconds(
  attempt: number,
  random: () => number = Math.random,
): number | null {
  const base = SCHEDULE_SECONDS[attempt - 1];
  if (base === undefined) return null;
  return Math.round(base * (1 + random() * JITTER_FRACTION));
}

/* ------------------------------------------------------------------ */
/* the worker                                                          */
/* ------------------------------------------------------------------ */

/* Only the four queue methods, so a test can supply a fake without building a
 * whole corpus. */
type QueueDriver = Pick<
  CorpusDriver,
  'enqueueDelivery' | 'dueDeliveries' | 'recordDeliveryAttempt' | 'pruneDeliveries'
>;

/*
 * The instance secret every per key secret is derived from.
 *
 * 24 bytes is the floor the Standard Webhooks spec gives for a signing secret,
 * and it is checked rather than assumed because the failure mode of a short one
 * is silence: everything signs, everything verifies, and the signature is
 * simply easier to forge than anyone believes.
 */
const MIN_SECRET_BYTES = 24;

export function checkInstanceSecret(secret: string): UrlVerdict {
  if (secret.length < MIN_SECRET_BYTES) {
    return {
      ok: false,
      reason: `QUORUM_WEBHOOK_SECRET must be at least ${MIN_SECRET_BYTES} characters, this one is ${secret.length}`,
    };
  }
  return { ok: true, reason: 'ok' };
}

/*
 * A url with the query string removed, for the one place a url reaches a log.
 *
 * Receivers routinely carry a bearer token in the query string, which makes a
 * webhook url closer to a credential than to an address. The host and path are
 * enough for an operator to know which delivery is failing.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}${url.search ? '?...' : ''}`;
  } catch {
    return '<unparseable url>';
  }
}

export interface EnqueueRequest {
  /* The report id, which is also the webhook-id the receiver deduplicates on. */
  reportId: string;
  tenantId?: string | null;
  keyLabel: string;
  url: string;
  payload: string;
}

export interface WebhookWorkerOptions {
  corpus: QueueDriver;
  instanceSecret: string;
  /* Unix seconds. Injected by tests. */
  now?: () => number;
  random?: () => number;
  fetch?: typeof safeFetch;
  /* Deliveries attempted per tick. Also the cap on concurrent outbound POSTs. */
  maxInFlight?: number;
  tickMs?: number;
  /* Settled rows older than this are pruned. Comfortably past the schedule. */
  retainSeconds?: number;
  log?: (message: string) => void;
}

export interface WebhookWorker {
  enqueue(request: EnqueueRequest): Promise<void>;
  /* One drain pass. Returns how many deliveries were attempted. */
  tick(): Promise<number>;
  start(): void;
  stop(): void;
}

const DEFAULT_MAX_IN_FLIGHT = 4;
const DEFAULT_TICK_MS = 5_000;
/* Seven days, well past the 75 hour schedule. */
const DEFAULT_RETAIN_SECONDS = 7 * 86_400;

/*
 * The delivery worker.
 *
 * WHY THERE IS NO DRAIN ON SHUTDOWN, WHICH LOOKS LIKE AN OMISSION.
 *
 * A row is marked only AFTER its attempt finishes, so a process killed mid
 * flight leaves the delivery `pending` and the next boot picks it up. Draining
 * would only convert a clean restart into a slow one, and a hung receiver into
 * a process that will not exit.
 *
 * The cost is that a delivery can be sent twice: once by the process that died
 * after the receiver accepted it but before the row was written, and again on
 * the next boot. That is at least once delivery, it is what the `webhook-id`
 * header is for, and every Standard Webhooks receiver is already expected to
 * deduplicate on it. Choosing at most once instead would mean marking the row
 * before the attempt, which loses deliveries outright.
 */
export function createWebhookWorker(options: WebhookWorkerOptions): WebhookWorker {
  const {
    corpus,
    instanceSecret,
    now = (): number => Math.floor(Date.now() / 1000),
    random = Math.random,
    fetch: send = safeFetch,
    maxInFlight = DEFAULT_MAX_IN_FLIGHT,
    tickMs = DEFAULT_TICK_MS,
    retainSeconds = DEFAULT_RETAIN_SECONDS,
    log = (): void => {},
  } = options;

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  /* What one attempt's outcome means for the row. */
  function settle(delivery: WebhookDelivery, result: DeliveryResult): {
    status: WebhookDeliveryStatus;
    attempts: number;
    nextAttemptAt: number;
    lastStatus: number | null;
    lastError: string | null;
    deliveredAt: number | null;
  } {
    const attempts = delivery.attempts + 1;
    const at = now();

    if (result.delivered) {
      return {
        status: 'delivered', attempts, nextAttemptAt: at,
        lastStatus: result.status, lastError: null, deliveredAt: at,
      };
    }

    /*
     * A permanent refusal stops here. Retrying a blocked address is how a
     * refused target becomes a slow scan, and retrying a receiver's 400 for
     * three days is how a webhook sender becomes an attacker.
     */
    if (!result.retryable) {
      return {
        status: 'refused', attempts, nextAttemptAt: at,
        lastStatus: result.status, lastError: result.detail, deliveredAt: null,
      };
    }

    const delay = nextAttemptDelaySeconds(attempts, random);
    if (delay === null) {
      /*
       * The schedule is spent. The spec also asks a provider to tell the
       * consumer by another channel and disable the endpoint; there is no
       * endpoint registry and no mail path here, so this is logged and the row
       * is left as evidence. Named rather than pretended away.
       */
      log(`webhook: giving up on ${delivery.reportId} after ${attempts} attempts to ${redactUrl(delivery.url)}`);
      return {
        status: 'exhausted', attempts, nextAttemptAt: at,
        lastStatus: result.status, lastError: result.detail, deliveredAt: null,
      };
    }

    return {
      status: 'pending', attempts, nextAttemptAt: at + delay,
      lastStatus: result.status, lastError: result.detail, deliveredAt: null,
    };
  }

  async function attempt(delivery: WebhookDelivery): Promise<void> {
    /*
     * SIGNED AFRESH ON EVERY ATTEMPT, with the timestamp of THIS send.
     *
     * The schedule runs out to 75 hours. Reusing the timestamp the delivery was
     * enqueued with would mean a retry arrives carrying a three day old
     * timestamp, and any receiver enforcing the spec's replay tolerance rejects
     * it. Re-signing costs one HMAC.
     */
    const result = await deliver({
      id: delivery.reportId,
      url: delivery.url,
      secret: deriveSecret(instanceSecret, delivery.keyLabel),
      payload: delivery.payload,
      timestampSeconds: now(),
    }, { fetch: send });

    await corpus.recordDeliveryAttempt(delivery.reportId, settle(delivery, result));
  }

  return {
    async enqueue(request: EnqueueRequest): Promise<void> {
      await corpus.enqueueDelivery({
        reportId: request.reportId,
        tenantId: request.tenantId ?? null,
        keyLabel: request.keyLabel,
        url: request.url,
        payload: request.payload,
        /* Attempt one is immediate: the first entry of the schedule is the wait
         * AFTER it fails. */
        nextAttemptAt: now(),
      });
    },

    async tick(): Promise<number> {
      /* One pass at a time. A slow receiver must not let ticks pile up and
       * deliver the same row twice concurrently. */
      if (running) return 0;
      running = true;
      try {
        const due = await corpus.dueDeliveries(now(), maxInFlight);

        /*
         * AT MOST ONE IN FLIGHT PER HOST. A caller can submit many reports all
         * pointing at one victim, and without this the worker would aim its
         * whole concurrency at that host. Whatever is skipped is still due and
         * is picked up on the next tick.
         */
        const seen = new Set<string>();
        const batch = due.filter((d) => {
          let host: string;
          try { host = new URL(d.url).host; } catch { return true; }
          if (seen.has(host)) return false;
          seen.add(host);
          return true;
        });

        await Promise.all(batch.map((d) => attempt(d)));
        await corpus.pruneDeliveries(now() - retainSeconds);
        return batch.length;
      } catch (cause) {
        /*
         * ERRORS ARE VALUES HERE TOO, and this catch is load bearing rather
         * than tidy. `start()` fires ticks as `void this.tick()` from an
         * interval, so a rejection from this method is an UNHANDLED REJECTION,
         * and node's default for that is to kill the process. Without this
         * catch, a transient database error during any background tick took
         * the whole API server down with it. Proved 2026-08-23 by pointing the
         * worker at a corpus whose dueDeliveries throws: the rejection reached
         * the process. A free tier database that sleeps makes that a routine
         * event, not a rarity.
         *
         * The row state is safe either way: nothing is marked until an attempt
         * finishes, so whatever this pass failed to do is still pending and
         * the next tick simply finds it again.
         */
        log(`webhook: tick failed, will retry next tick: ${cause instanceof Error ? cause.message : String(cause)}`);
        return 0;
      } finally {
        running = false;
      }
    },

    start(): void {
      if (timer) return;
      timer = setInterval(() => { void this.tick(); }, tickMs);
      /* Never the reason a process stays alive, the same rule the lag sampler
       * in http.ts follows. */
      timer.unref();
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
