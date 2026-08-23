/*
 * @quorum/sdk-js. The typed client for the hosted API.
 *
 * WRITTEN AGAINST `spec/openapi.yaml`, WHICH IS THE CONTRACT. Every method here
 * is one operationId from that file. A drift check exists precisely so this
 * cannot quietly diverge, and the spec wins when they disagree.
 *
 * TWO DECISIONS THAT MAKE THIS DIFFERENT FROM A GENERATED CLIENT.
 *
 * ERRORS ARE VALUES, NEVER THROWN. The house rule everywhere a vendor can be
 * down, and an SDK IS the place a vendor can be down. A caller gets
 * `{ ok: false, error }` with the server's `type`, `message` and `requestId`
 * rather than a rejected promise, because the interesting failures here are a
 * 429, a 503 with a Retry-After, and a report that is simply not finished, and
 * none of those are exceptional.
 *
 * IT HONOURS RETRY-AFTER. The server sheds under load with a 503 and a
 * Retry-After, and rate limits with a 429. Measured in bench/: a client that
 * gives up on the first refusal reports the service as down when it was busy
 * and told it so. `waitForReport` implements the polling loop correctly once,
 * so every caller does not implement it wrongly.
 *
 * ZERO DEPENDENCIES. `fetch` is built in, and it is injectable so tests run
 * with no network.
 */

/* ------------------------------------------------------------------ */
/* results                                                             */
/* ------------------------------------------------------------------ */

export interface ApiError {
  /* The server's machine readable class: `rate_limited`, `not_found`,
   * `queue_saturated`, `unauthorized`, `bad_request`, `conflict`. */
  type: string;
  message: string;
  /* Echoed on every error. Quote it in a bug report and it can be found. */
  requestId: string | null;
  /* Present on 429 and 503. Seconds. Honour it. */
  retryAfterSeconds: number | null;
  /* The HTTP status, or 0 when the request never got an answer at all. */
  status: number;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

const failure = (
  status: number,
  type: string,
  message: string,
  requestId: string | null = null,
  retryAfterSeconds: number | null = null,
): Result<never> => ({ ok: false, error: { type, message, requestId, retryAfterSeconds, status } });

/* ------------------------------------------------------------------ */
/* the shapes, mirroring spec/openapi.yaml                             */
/* ------------------------------------------------------------------ */

export interface ReportRequest {
  subject: string;
  terms?: string[];
  communities?: string[];
  sources?: string[];
  /* Metered. Every ad call charges the operator's cost meter. */
  includeAds?: boolean;
  /* Answer from the corpus alone: no upstream requests, no cost, and fast. */
  offline?: boolean;
  capUsd?: number;
  deadlineMs?: number;
  webhookUrl?: string;
}

export interface Accepted {
  id: string;
  status: string;
  /* True when an identical subject was already running and you joined it
   * rather than starting a second retrieval. */
  coalesced: boolean;
  category: string;
  /* Terms that arrived after the run had planned its queries, so they were
   * answered from what was already held rather than searched upstream. */
  termsDeferred: string[];
  queuePosition: number | null;
  estimatedSeconds: number | null;
}

export interface Report {
  id: string;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled' | string;
  subject: string;
  category: string;
  createdAt: number;
  completedAt: number | null;
  elapsedMs: number | null;
  coalesced: boolean;
  termsDeferred: string[];
  findings: unknown[];
  weakSignals: unknown[];
  rejected: unknown[];
  [key: string]: unknown;
}

export interface EvidenceRecord {
  receiptId: string;
  source: string;
  channel: string;
  text: string;
  score: number;
  url: string;
  createdUtc: number;
  [key: string]: unknown;
}

export interface Quota { used: number; limit: number; remaining: number; [key: string]: unknown }

export interface Usage {
  /* The display prefix only. The whole key is never returned by the server. */
  keyPrefix: string;
  periodStart: number;
  periodEnd: number;
  reports: Quota;
  lookups: Quota;
  concurrentReports: { running: number; limit: number };
  spendUsd: number;
}

/* One server sent event from a running report. */
export interface ReportEvent {
  id: number;
  type: string;
  data: unknown;
}

/* ------------------------------------------------------------------ */
/* the client                                                          */
/* ------------------------------------------------------------------ */

export interface ClientOptions {
  /*
   * Base URL, supplied by the caller and never hardcoded. That is what makes
   * this a client for YOUR service rather than a vendor client, and
   * check-security asserts it: the no-auth rule exempts this file only while
   * its address remains configuration.
   *
   * With or without a trailing slash. `/v1` is appended. */
  baseUrl: string;
  /* Bearer key. Omit only against an instance running without one, which the
   * server announces as OPEN on boot. */
  apiKey?: string;
  /* Injected so tests run offline, and so a caller can supply their own
   * instrumented fetch. */
  fetch?: typeof globalThis.fetch;
  /* Per request, in milliseconds. Default 30s, which is far longer than any
   * endpoint except a streaming one. */
  timeoutMs?: number;
}

export class QuorumClient {
  readonly #base: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: ClientOptions) {
    this.#base = `${options.baseUrl.replace(/\/+$/, '')}/v1`;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  #headers(body: boolean): Record<string, string> {
    return {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
    };
  }

  async #call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Result<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    /* The caller's signal and our timeout both have to be able to cancel. */
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: this.#headers(body !== undefined),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });

      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* A proxy returning HTML is the common case here, and reporting it as
         * "unexpected token <" would send somebody debugging this client. */
        return failure(res.status, 'bad_response', `the server returned ${res.status} with a body that is not json`);
      }

      if (res.ok) return { ok: true, data: parsed as T };

      const err = (parsed as { error?: Partial<ApiError> } | null)?.error;
      /* The header wins over the body: a proxy may add one the app did not. */
      const header = res.headers.get('retry-after');
      return failure(
        res.status,
        err?.type ?? 'http_error',
        err?.message ?? `the server returned ${res.status}`,
        err?.requestId ?? null,
        header !== null ? Number(header) : err?.retryAfterSeconds ?? null,
      );
    } catch (cause) {
      /* No answer at all: DNS, refused, timed out, aborted. Status 0 says the
       * request never reached a server, which is a different problem from any
       * status code and a caller should be able to tell them apart. */
      const message = cause instanceof Error ? cause.message : String(cause);
      return failure(0, controller.signal.aborted ? 'timeout' : 'network', message);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /* --- reports, the slow path --- */

  createReport(request: ReportRequest, signal?: AbortSignal): Promise<Result<Accepted>> {
    return this.#call('POST', '/reports', request, signal);
  }

  getReport(id: string, signal?: AbortSignal): Promise<Result<Report>> {
    return this.#call('GET', `/reports/${encodeURIComponent(id)}`, undefined, signal);
  }

  cancelReport(id: string, signal?: AbortSignal): Promise<Result<{ id: string; status: string }>> {
    return this.#call('DELETE', `/reports/${encodeURIComponent(id)}`, undefined, signal);
  }

  /* --- evidence, the fast path --- */

  getEvidence(receiptId: string, signal?: AbortSignal): Promise<Result<EvidenceRecord>> {
    return this.#call('GET', `/evidence/${encodeURIComponent(receiptId)}`, undefined, signal);
  }

  getEvidenceBatch(receiptIds: string[], signal?: AbortSignal): Promise<Result<{ records: EvidenceRecord[] }>> {
    return this.#call('POST', '/evidence/batch', { receiptIds }, signal);
  }

  searchEvidence(
    query: { query: string; category?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<Result<{ records: EvidenceRecord[] }>> {
    return this.#call('POST', '/evidence/search', query, signal);
  }

  getAdEvidence(adId: string, signal?: AbortSignal): Promise<Result<unknown>> {
    return this.#call('GET', `/evidence/ads/${encodeURIComponent(adId)}`, undefined, signal);
  }

  getCategory(slug: string, signal?: AbortSignal): Promise<Result<unknown>> {
    return this.#call('GET', `/categories/${encodeURIComponent(slug)}`, undefined, signal);
  }

  /* --- verification and account --- */

  /*
   * Re-resolves every cited id against the corpus. It will check our output or
   * anybody else's, which is the point: a claim citing an id that does not
   * exist is reported rather than quietly passed.
   */
  verifyClaims(
    claims: { term: string; text: string; receiptIds: string[] }[],
    signal?: AbortSignal,
  ): Promise<Result<unknown>> {
    return this.#call('POST', '/verify', { claims }, signal);
  }

  getUsage(signal?: AbortSignal): Promise<Result<Usage>> {
    return this.#call('GET', '/usage', undefined, signal);
  }

  healthz(signal?: AbortSignal): Promise<Result<{ ok: boolean }>> {
    return this.#call('GET', '/healthz', undefined, signal);
  }

  /*
   * POLL A REPORT TO COMPLETION, HONOURING THE SERVER'S OWN PACING.
   *
   * Here so that every caller does not write this loop badly. Three things it
   * gets right that a naive loop does not:
   *
   *   A 503 IS NOT A FAILURE. It is the load shedder, and it comes with a
   *   Retry-After. Treating it as an error reports a busy service as a broken
   *   one, which is the exact distinction the shedder exists to communicate.
   *
   *   THE SERVER SETS THE PACE. Retry-After is used when present, rather than
   *   a fixed interval chosen by the client, because a running report already
   *   tells you roughly how long it needs.
   *
   *   IT GIVES UP HONESTLY. On timeout it returns the last status it saw
   *   rather than pretending the report failed.
   */
  async waitForReport(
    id: string,
    options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal; onPoll?: (report: Report) => void } = {},
  ): Promise<Result<Report>> {
    const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
    const floor = options.pollMs ?? 2_000;
    let last: Report | null = null;

    for (;;) {
      const res = await this.getReport(id, options.signal);

      if (res.ok) {
        last = res.data;
        options.onPoll?.(res.data);
        if (res.data.status !== 'queued' && res.data.status !== 'running') return res;
      } else if (res.error.status !== 503 && res.error.status !== 429) {
        /* A real error. Anything else is the server asking us to wait. */
        return res;
      }

      const suggested = res.ok ? null : res.error.retryAfterSeconds;
      const waitMs = Math.max(floor, (suggested ?? 0) * 1000);

      if (Date.now() + waitMs > deadline) {
        return failure(
          0,
          'timeout',
          last
            ? `gave up after the deadline with the report still ${last.status}`
            : 'gave up after the deadline without reaching the server',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  /*
   * Stream a running report as server sent events.
   *
   * Parsed by hand because the built in `fetch` gives a byte stream and there
   * is no EventSource in Node that accepts an Authorization header. The frame
   * is `id:`, `event:` and `data:` lines terminated by a blank line, and a
   * chunk boundary can fall anywhere, so the buffer is drained on complete
   * frames only.
   */
  async *streamReport(id: string, signal?: AbortSignal): AsyncGenerator<ReportEvent> {
    const res = await this.#fetch(`${this.#base}/reports/${encodeURIComponent(id)}/stream`, {
      headers: { ...this.#headers(false), accept: 'text/event-stream' },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok || !res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const event = parseFrame(frame);
          if (event) yield event;
          split = buffer.indexOf('\n\n');
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function parseFrame(frame: string): ReportEvent | null {
  let id = 0;
  let type = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('id:')) id = Number(line.slice(3).trim()) || 0;
    else if (line.startsWith('event:')) type = line.slice(6).trim();
    /* Multiple data lines in one frame concatenate, per the SSE spec. */
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (!data.length) return null;
  const joined = data.join('\n');
  try {
    return { id, type, data: JSON.parse(joined) };
  } catch {
    return { id, type, data: joined };
  }
}

export const createClient = (options: ClientOptions): QuorumClient => new QuorumClient(options);
