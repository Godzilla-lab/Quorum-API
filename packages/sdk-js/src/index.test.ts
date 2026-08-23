/*
 * The SDK, against a stub fetch.
 *
 * The interesting behaviour is entirely in what happens when the server says
 * NO: a 429, a 503 with a Retry-After, a body that is not json, a connection
 * that never answers. Those are the paths a happy path test never reaches and
 * the ones a caller actually hits in production, so they are most of this file.
 *
 * A real server is exercised separately by `bench/` and by the server's own
 * tests. Here the point is that this client interprets the answers correctly.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QuorumClient, createClient, type ReportEvent } from './index.ts';

/* A fetch that answers from a script, and records what it was asked. */
function stub(answers: (Response | (() => Response))[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string | null }[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = init ?? {};
    calls.push({
      url: String(input),
      method: req.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((req.headers ?? {}) as Record<string, string>)),
      body: typeof req.body === 'string' ? req.body : null,
    });
    const next = answers[Math.min(i++, answers.length - 1)];
    if (!next) throw new Error('no scripted answer');
    return typeof next === 'function' ? next() : next;
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const client = (fetchImpl: typeof globalThis.fetch, apiKey = 'test-key'): QuorumClient =>
  createClient({ baseUrl: 'https://api.test', apiKey, fetch: fetchImpl });

/* ------------------------------------------------------------------ */
/* the request                                                         */
/* ------------------------------------------------------------------ */

test('the key travels as a bearer token and the path carries /v1', async () => {
  const { fetchImpl, calls } = stub([json(200, { ok: true })]);
  await client(fetchImpl).healthz();
  assert.equal(calls[0]?.url, 'https://api.test/v1/healthz');
  assert.equal(calls[0]?.headers['authorization'], 'Bearer test-key');
});

test('a trailing slash on the base url does not become a double slash', async () => {
  const { fetchImpl, calls } = stub([json(200, { ok: true })]);
  await createClient({ baseUrl: 'https://api.test///', fetch: fetchImpl }).healthz();
  assert.equal(calls[0]?.url, 'https://api.test/v1/healthz');
});

test('no key means no authorization header, rather than an empty one', async () => {
  /* An empty bearer is a 401 with a confusing message. Sending nothing is
   * correct against an instance running open. */
  const { fetchImpl, calls } = stub([json(200, { ok: true })]);
  await createClient({ baseUrl: 'https://api.test', fetch: fetchImpl }).healthz();
  assert.equal('authorization' in (calls[0]?.headers ?? {}), false);
});

test('ids are encoded, so a slug with a space cannot break the path', async () => {
  const { fetchImpl, calls } = stub([json(200, {})]);
  await client(fetchImpl).getCategory('running shoes');
  assert.equal(calls[0]?.url, 'https://api.test/v1/categories/running%20shoes');
});

/* ------------------------------------------------------------------ */
/* errors are values                                                   */
/* ------------------------------------------------------------------ */

test('AN ERROR IS A VALUE, CARRYING THE SERVER TYPE AND REQUEST ID', async () => {
  const { fetchImpl } = stub([json(429, {
    error: { type: 'rate_limited', message: 'too many', requestId: 'req_1', retryAfterSeconds: 30 },
  })]);
  const res = await client(fetchImpl).getEvidence('rc_1');

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.type, 'rate_limited');
  assert.equal(res.error.requestId, 'req_1');
  assert.equal(res.error.retryAfterSeconds, 30);
  assert.equal(res.error.status, 429);
});

test('THE RETRY-AFTER HEADER WINS OVER THE BODY', async () => {
  /* A proxy can add one the application did not, and it is the one that
   * actually describes when this caller will be let through. */
  const { fetchImpl } = stub([json(503, {
    error: { type: 'queue_saturated', message: 'busy', requestId: 'req_2', retryAfterSeconds: 5 },
  }, { 'retry-after': '60' })]);
  const res = await client(fetchImpl).createReport({ subject: 'x' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.retryAfterSeconds, 60);
});

test('a body that is not json is reported as such, not as a parse error', async () => {
  /* A proxy returning an HTML error page is the common case, and "unexpected
   * token <" sends somebody debugging this client instead of their gateway. */
  const { fetchImpl } = stub([new Response('<html>502</html>', { status: 502 })]);
  const res = await client(fetchImpl).healthz();
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.type, 'bad_response');
    assert.match(res.error.message, /502/);
  }
});

test('NO ANSWER AT ALL IS STATUS 0, WHICH IS NOT A STATUS CODE', async () => {
  /* DNS failure, connection refused, TLS rejected. A caller must be able to
   * tell "never reached a server" from any answer a server gave. */
  const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof globalThis.fetch;
  const res = await client(fetchImpl).healthz();
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.status, 0);
    assert.equal(res.error.type, 'network');
  }
});

test('an error with no body still produces a usable error', async () => {
  const { fetchImpl } = stub([new Response('', { status: 500 })]);
  const res = await client(fetchImpl).healthz();
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.status, 500);
});

/* ------------------------------------------------------------------ */
/* waiting for a report                                                */
/* ------------------------------------------------------------------ */

const report = (status: string) => json(200, {
  id: 'rep_1', status, subject: 'x', category: 'x', createdAt: 0, completedAt: null,
  elapsedMs: null, coalesced: false, termsDeferred: [], findings: [], weakSignals: [], rejected: [],
});

test('waitForReport polls until the report leaves the running states', async () => {
  const { fetchImpl, calls } = stub([report('queued'), report('running'), report('complete')]);
  const res = await client(fetchImpl).waitForReport('rep_1', { pollMs: 1 });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.data.status, 'complete');
  assert.equal(calls.length, 3);
});

test('A 503 WHILE POLLING IS THE SHEDDER, NOT A FAILURE', async () => {
  /*
   * This is the distinction the load shedder exists to communicate, and a
   * naive loop reports a busy service as a broken one.
   */
  const { fetchImpl } = stub([
    json(503, { error: { type: 'queue_saturated', message: 'busy', requestId: null, retryAfterSeconds: 0 } }),
    report('complete'),
  ]);
  const res = await client(fetchImpl).waitForReport('rep_1', { pollMs: 1 });
  assert.equal(res.ok, true);
});

test('a real error while polling stops immediately rather than retrying forever', async () => {
  const { fetchImpl, calls } = stub([
    json(404, { error: { type: 'not_found', message: 'no such report', requestId: null, retryAfterSeconds: null } }),
  ]);
  const res = await client(fetchImpl).waitForReport('rep_1', { pollMs: 1 });
  assert.equal(res.ok, false);
  assert.equal(calls.length, 1, 'a 404 is not going to become a 200');
});

test('GIVING UP REPORTS THE LAST STATUS SEEN, NOT A FABRICATED FAILURE', async () => {
  const { fetchImpl } = stub([report('running')]);
  const res = await client(fetchImpl).waitForReport('rep_1', { pollMs: 5, timeoutMs: 1 });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.type, 'timeout');
    assert.match(res.error.message, /still running/);
  }
});

test('onPoll sees every intermediate state, so a caller can show progress', async () => {
  const seen: string[] = [];
  const { fetchImpl } = stub([report('queued'), report('running'), report('complete')]);
  await client(fetchImpl).waitForReport('rep_1', { pollMs: 1, onPoll: (r) => seen.push(r.status) });
  assert.deepEqual(seen, ['queued', 'running', 'complete']);
});

/* ------------------------------------------------------------------ */
/* streaming                                                           */
/* ------------------------------------------------------------------ */

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(client: QuorumClient): Promise<ReportEvent[]> {
  const out: ReportEvent[] = [];
  for await (const event of client.streamReport('rep_1')) out.push(event);
  return out;
}

test('server sent events are parsed into id, type and data', async () => {
  const { fetchImpl } = stub([sseResponse([
    'id: 1\nevent: stage\ndata: {"stage":"retrieve"}\n\n',
    'id: 2\nevent: done\ndata: {"status":"complete"}\n\n',
  ])]);
  const events = await collect(client(fetchImpl));
  assert.deepEqual(events, [
    { id: 1, type: 'stage', data: { stage: 'retrieve' } },
    { id: 2, type: 'done', data: { status: 'complete' } },
  ]);
});

test('A FRAME SPLIT ACROSS CHUNKS IS STILL ONE EVENT', async () => {
  /*
   * A chunk boundary falls wherever TCP decides, and a parser that assumes
   * otherwise works on a laptop and fails across the internet.
   */
  const { fetchImpl } = stub([sseResponse(['id: 1\nev', 'ent: stage\ndata: {"a"', ':1}\n\nid: 2\nevent: x\ndata: 2\n\n'])]);
  const events = await collect(client(fetchImpl));
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { id: 1, type: 'stage', data: { a: 1 } });
});

test('a partial frame at the end is dropped rather than half emitted', async () => {
  const { fetchImpl } = stub([sseResponse(['id: 1\nevent: a\ndata: 1\n\nid: 2\nevent: b\nda'])]);
  const events = await collect(client(fetchImpl));
  assert.equal(events.length, 1);
});

test('data that is not json is passed through as text', async () => {
  const { fetchImpl } = stub([sseResponse(['event: ping\ndata: keepalive\n\n'])]);
  const events = await collect(client(fetchImpl));
  assert.deepEqual(events[0], { id: 0, type: 'ping', data: 'keepalive' });
});

test('a stream that fails to open yields nothing rather than throwing', async () => {
  const { fetchImpl } = stub([json(404, { error: { type: 'not_found', message: 'x', requestId: null } })]);
  assert.deepEqual(await collect(client(fetchImpl)), []);
});
