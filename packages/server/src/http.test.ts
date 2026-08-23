/*
 * The hosted API, against a real corpus over real HTTP.
 *
 * No mocked transport: the server is started, listened on an ephemeral port and
 * called with fetch, because the routing, the body reading and the status codes
 * are exactly the parts a mocked request would not exercise.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { openSqliteCorpus, type CorpusDriver } from '@quorum/corpus';
import { createReceiptsServer, hashKey } from './http.ts';
import { createQuotas } from './quotas.ts';
import { deriveSecret } from './webhooks.ts';
import { createJobQueue, type JobQueue, type RunContext, type RunOutcome } from './jobs.ts';

const scratch = mkdtempSync(join(tmpdir(), 'receipts-server-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

interface Live { base: string; ids: string[]; queue?: JobQueue; finish?: (over?: Partial<RunOutcome>) => void; close: () => Promise<void> }

async function live(over: { requireAuth?: boolean; keys?: string[]; withQueue?: boolean; webhookSecret?: string } = {}): Promise<Live> {
  const corpus: CorpusDriver = openSqliteCorpus({ path: join(scratch, `c-${Math.floor(performance.now() * 1e6)}.db`) });
  await corpus.addDocs([
    { source: 'reddit', kind: 'comment', externalId: 'a', channel: 'r/running', text: 'these run small and I sized up half a size', score: 7, url: 'https://e.test/a', createdUtc: 1 },
    { source: 'cpsc', kind: 'post', externalId: 'r1', channel: 'Acme Corp', text: 'Acme recalls the widget because the strap can fail under load', score: 0, url: 'https://e.test/r1', createdUtc: 2 },
  ], 'shoes');
  const rows = await corpus.byCategory('shoes');

  const keyHashes = new Map((over.keys ?? []).map((k, i) => [hashKey(k), `key-${i}`]));

  /* The runner is a promise the test resolves, because every report route
   * property worth testing is about what the API says WHILE a run is in
   * flight. A runner that finished on its own would make all of them races. */
  let release: ((outcome: RunOutcome) => void) | null = null;
  const queue = over.withQueue
    ? createJobQueue({
      runReport: async (_request, _ctx: RunContext) => new Promise<RunOutcome>((resolve) => { release = resolve; }),
      claimsFor: async (_outcome, terms) => ({
        findings: terms.map((t) => ({ term: t, verdict: 'finding' })),
        weakSignals: [], rejected: [],
        sufficiency: { verdict: 'sufficient' },
        receiptCheck: { cited: 0, resolved: 0, unresolved: [] },
        trends: [], voice: [], themes: [],
      }),
    })
    : undefined;

  const server = createReceiptsServer({
    /* A real quotas instance, as bin.ts wires one. Without it the whole quota
     * block is skipped, which is exactly why no test here could ever notice
     * that the rate limit headers never reached a successful response. */
    corpus, keyHashes, quotas: createQuotas(),
    ...(over.webhookSecret ? { webhookSecret: over.webhookSecret } : {}),
    ...(queue ? { queue } : {}),
    ...(over.requireAuth === undefined ? {} : { requireAuth: over.requireAuth }),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    ids: rows.map((r) => r.receiptId),
    ...(queue ? { queue } : {}),
    finish: (outcome: Partial<RunOutcome> = {}) => release?.({
      subject: { title: 'wool runner' },
      category: 'shoes',
      subjectResolved: false,
      retrieval: { totalWritten: 2 },
      warmth: { docs: 2 },
      degraded: [],
      cost: { totalUsd: 0 },
      ...outcome,
    }),
    close: async () => {
      queue?.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await corpus.close();
    },
  };
}

test('a real receipt resolves, with its tier and what its score means', async () => {
  const s = await live();
  try {
    const res = await fetch(`${s.base}/v1/evidence/${s.ids[0]}`);
    assert.equal(res.status, 200);
    const body = await res.json() as { tier: string; scoreKind: string; text: string };
    assert.ok(['A', 'B', 'C', 'D'].includes(body.tier));
    assert.ok(['points', 'stars', 'none'].includes(body.scoreKind));
    assert.ok(body.text.length > 0);
    /* Content addressed, so the record behind it can never change. */
    assert.match(res.headers.get('cache-control') ?? '', /immutable/);
  } finally { await s.close(); }
});

/*
 * These two are different answers and collapsing them would be a lie in the one
 * place this product cannot afford one.
 */
test('a malformed id is 400 and a well formed unknown id is 404', async () => {
  const s = await live();
  try {
    assert.equal((await fetch(`${s.base}/v1/evidence/rc_nope`)).status, 400);
    assert.equal((await fetch(`${s.base}/v1/evidence/rc_deadbeefdeadbeef`)).status, 404);
  } finally { await s.close(); }
});

test('the specific evidence routes are not swallowed by the resolver', async () => {
  /* The resolver pattern is loose so malformed ids reach it, which means route
   * ORDER is load bearing rather than incidental. */
  const s = await live();
  try {
    const batch = await fetch(`${s.base}/v1/evidence/batch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receiptIds: s.ids }),
    });
    assert.equal(batch.status, 200);
    const body = await batch.json() as { records: unknown[]; unresolved: string[] };
    assert.equal(body.records.length, 2);
    assert.deepEqual(body.unresolved, []);
  } finally { await s.close(); }
});

test('an invented id comes back named, not counted', async () => {
  const s = await live();
  try {
    const res = await fetch(`${s.base}/v1/evidence/batch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receiptIds: [s.ids[0], 'rc_deadbeefdeadbeef'] }),
    });
    const body = await res.json() as { records: unknown[]; unresolved: string[] };
    assert.equal(body.records.length, 1);
    assert.deepEqual(body.unresolved, ['rc_deadbeefdeadbeef']);
  } finally { await s.close(); }
});

/*
 * The endpoint that takes output this API did not produce.
 */
test('verify catches an invented id and refuses to let it count', async () => {
  const s = await live();
  try {
    const res = await fetch(`${s.base}/v1/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        claims: [{ term: 'sizing', text: 'Sizing runs small.', receiptIds: [s.ids[0], 'rc_deadbeefdeadbeef'] }],
      }),
    });
    assert.equal(res.status, 200, 'finding a fabrication is a successful request');

    const body = await res.json() as { clean: boolean; claims: { records: number; fabricated: string[]; demoted: boolean }[] };
    assert.equal(body.clean, false);
    assert.deepEqual(body.claims[0]?.fabricated, ['rc_deadbeefdeadbeef']);
    /* Two ids cited, one real. The count is one. */
    assert.equal(body.claims[0]?.records, 1);
    assert.equal(body.claims[0]?.demoted, true);
  } finally { await s.close(); }
});

test('verify rejects a claim that quotes something nobody said', async () => {
  const s = await live();
  try {
    const res = await fetch(`${s.base}/v1/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        claims: [{ term: 'sizing', text: 'A buyer said "these disintegrated after one week".', receiptIds: s.ids }],
      }),
    });
    const body = await res.json() as { claims: { verdict: string; unsupportedQuotes: string[] }[] };
    assert.equal(body.claims[0]?.verdict, 'rejected');
    assert.equal(body.claims[0]?.unsupportedQuotes.length, 1);
  } finally { await s.close(); }
});

test('every response carries a request id, because support needs one', async () => {
  const s = await live();
  try {
    const res = await fetch(`${s.base}/v1/healthz`);
    assert.match(res.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  } finally { await s.close(); }
});

test('a bad body is a 400 with an actionable message, not a stack trace', async () => {
  const s = await live();
  try {
    const res = await fetch(`${s.base}/v1/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: { type: string; message: string; requestId: string } };
    assert.equal(body.error.type, 'invalid_request');
    assert.match(body.error.message, /not json/);
    assert.ok(body.error.requestId);
    /* No stack paths and no key material, because this ends up in a customer's
     * logs. */
    assert.doesNotMatch(body.error.message, /\/Users\/|node_modules|at Object/);
  } finally { await s.close(); }
});

test('a key is required when one is configured, and compared as a hash', async () => {
  const s = await live({ keys: ['rk_secret'], requireAuth: true });
  try {
    assert.equal((await fetch(`${s.base}/v1/evidence/${s.ids[0]}`)).status, 401);
    assert.equal((await fetch(`${s.base}/v1/evidence/${s.ids[0]}`, {
      headers: { authorization: 'Bearer wrong' },
    })).status, 401);
    assert.equal((await fetch(`${s.base}/v1/evidence/${s.ids[0]}`, {
      headers: { authorization: 'Bearer rk_secret' },
    })).status, 200);
    /* Health stays open, or a load balancer cannot tell live from broken. */
    assert.equal((await fetch(`${s.base}/v1/healthz`)).status, 200);
  } finally { await s.close(); }
});

test('reports say they are not built rather than accepting work never done', async () => {
  const s = await live();
  try {
    const res = await fetch(`${s.base}/v1/reports`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'running shoes' }),
    });
    assert.equal(res.status, 501);
  } finally { await s.close(); }
});

test('an oversized body is refused before it is parsed', async () => {
  const s = await live();
  try {
    const res = await fetch(`${s.base}/v1/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claims: [{ term: 'x', text: 'y'.repeat(2 * 1024 * 1024), receiptIds: [] }] }),
    });
    assert.equal(res.status, 413);
  } finally { await s.close(); }
});

/* ------------------------------------------------------------------ */
/* reports, over real HTTP                                             */
/* ------------------------------------------------------------------ */

const start = (base: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('a build with no queue says so rather than accepting work it will never do', async () => {
  const s = await live();
  try {
    const res = await start(s.base, { subject: 'wool runner' });
    assert.equal(res.status, 501);
    const body = await res.json() as { error: { message: string } };
    assert.match(body.error.message, /evidence and verify endpoints are live/);
  } finally { await s.close(); }
});

test('POST accepts, returns 202 with a Location, and the id is pollable', async () => {
  const s = await live({ withQueue: true });
  try {
    const res = await start(s.base, { subject: 'wool runner', terms: ['sizing'] });
    assert.equal(res.status, 202);
    const accepted = await res.json() as { id: string; status: string; coalesced: boolean; category: string };
    assert.match(accepted.id, /^rep_[0-9a-f]{16}$/);
    assert.equal(accepted.status, 'running');
    assert.equal(accepted.coalesced, false);
    assert.equal(res.headers.get('location'), `/v1/reports/${accepted.id}`);

    const poll = await fetch(`${s.base}${res.headers.get('location')}`);
    assert.equal(poll.status, 200);
    const report = await poll.json() as { status: string; findings: unknown[] };
    assert.equal(report.status, 'running');
    assert.deepEqual(report.findings, [], 'running, so nothing has landed yet');
    /* A poller must be told how long to wait, or it guesses, which means now. */
    assert.equal(poll.headers.get('retry-after'), '3');
  } finally { await s.close(); }
});

test('a completed report carries this caller findings and stops sending Retry-After', async () => {
  const s = await live({ withQueue: true });
  try {
    const accepted = await (await start(s.base, { subject: 'wool runner', terms: ['sizing'] })).json() as { id: string };
    s.finish!();
    await new Promise((r) => setTimeout(r, 20));

    const res = await fetch(`${s.base}/v1/reports/${accepted.id}`);
    const report = await res.json() as { status: string; findings: { term: string }[]; category: string };
    assert.equal(report.status, 'complete');
    assert.deepEqual(report.findings.map((f) => f.term), ['sizing']);
    assert.equal(res.headers.get('retry-after'), null, 'nothing left to wait for');
  } finally { await s.close(); }
});

test('AN UNCHANGED REPORT IS A 304, SO POLLING COSTS NOTHING', async () => {
  const s = await live({ withQueue: true });
  try {
    const accepted = await (await start(s.base, { subject: 'wool runner' })).json() as { id: string };
    const first = await fetch(`${s.base}/v1/reports/${accepted.id}`);
    const etag = first.headers.get('etag')!;
    assert.match(etag, /^"rep_[0-9a-f]{16}-\d+"$/);

    const again = await fetch(`${s.base}/v1/reports/${accepted.id}`, { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), '', 'a 304 carries no body, or it costs more than the request it replaced');

    /* And the moment it advances, the tag changes. */
    s.finish!();
    await new Promise((r) => setTimeout(r, 20));
    const advanced = await fetch(`${s.base}/v1/reports/${accepted.id}`, { headers: { 'if-none-match': etag } });
    assert.equal(advanced.status, 200);
  } finally { await s.close(); }
});

test('COALESCING IS VISIBLE TO THE SECOND CALLER, AND SO IS WHAT IT COST THEM', async () => {
  const s = await live({ withQueue: true });
  try {
    await start(s.base, { subject: 'wool runner', terms: ['sizing'] });
    const second = await start(s.base, { subject: 'Wool Runner', terms: ['sizing', 'durability'] });
    const accepted = await second.json() as { coalesced: boolean; termsDeferred: string[] };

    assert.equal(accepted.coalesced, true);
    /* Not hidden. The run had already planned its queries, so `durability` is
     * answered from the corpus as it stands and the caller is told. */
    assert.deepEqual(accepted.termsDeferred, ['durability']);
  } finally { await s.close(); }
});

test('a replayed Idempotency-Key returns the same report', async () => {
  const s = await live({ withQueue: true });
  try {
    const headers = { 'idempotency-key': 'a-retry-key-long-enough' };
    const first = await (await start(s.base, { subject: 'wool runner' }, headers)).json() as { id: string };
    const again = await start(s.base, { subject: 'wool runner' }, headers);
    assert.equal(again.status, 202);
    assert.equal((await again.json() as { id: string }).id, first.id);
  } finally { await s.close(); }
});

test('the same key with a different body is a 409, never a silently wrong answer', async () => {
  const s = await live({ withQueue: true });
  try {
    const headers = { 'idempotency-key': 'a-retry-key-long-enough' };
    await start(s.base, { subject: 'wool runner', terms: ['sizing'] }, headers);
    const conflict = await start(s.base, { subject: 'wool runner', terms: ['price'] }, headers);
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { error: { type: string } }).error.type, 'conflict');
  } finally { await s.close(); }
});

test('a too short idempotency key is a usage error rather than being ignored', async () => {
  const s = await live({ withQueue: true });
  try {
    const res = await start(s.base, { subject: 'wool runner' }, { 'idempotency-key': 'short' });
    assert.equal(res.status, 400);
  } finally { await s.close(); }
});

test('the request body is validated, and each refusal says which field', async () => {
  const s = await live({ withQueue: true });
  try {
    for (const [body, expected] of [
      [{}, /subject is required/],
      [{ subject: 'x' }, /at least 2 characters/],
      [{ subject: 'a'.repeat(501) }, /at most 500/],
      [{ subject: 'wool runner', terms: 'sizing' }, /terms must be an array/],
      [{ subject: 'wool runner', terms: Array.from({ length: 21 }, (_, i) => `t${i}`) }, /at most 20/],
      [{ subject: 'wool runner', capUsd: -1 }, /capUsd/],
      [{ subject: 'wool runner', deadlineMs: 10 }, /deadlineMs/],
    ] as [Record<string, unknown>, RegExp][]) {
      const res = await start(s.base, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match((await res.json() as { error: { message: string } }).error.message, expected);
    }
  } finally { await s.close(); }
});

test('DELETE cancels and returns the report, and an unknown id is a 404', async () => {
  const s = await live({ withQueue: true });
  try {
    const accepted = await (await start(s.base, { subject: 'wool runner' })).json() as { id: string };
    const res = await fetch(`${s.base}/v1/reports/${accepted.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { status: string }).status, 'cancelled');

    const missing = await fetch(`${s.base}/v1/reports/rep_0000000000000000`, { method: 'DELETE' });
    assert.equal(missing.status, 404);
  } finally { await s.close(); }
});

test('a malformed report id is a 404 for the route, not a crash', async () => {
  const s = await live({ withQueue: true });
  try {
    const res = await fetch(`${s.base}/v1/reports/not-an-id`);
    assert.equal(res.status, 404);
  } finally { await s.close(); }
});

test('THE STREAM REPLAYS FROM Last-Event-ID RATHER THAN RESTARTING', async () => {
  const s = await live({ withQueue: true });
  try {
    const accepted = await (await start(s.base, { subject: 'wool runner', terms: ['sizing'] })).json() as { id: string };
    s.finish!();
    await new Promise((r) => setTimeout(r, 20));

    const res = await fetch(`${s.base}/v1/reports/${accepted.id}/stream`, { headers: { 'last-event-id': '1' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const text = await res.text();

    /* Event 1 was the retrieve stage, and it is not replayed. */
    assert.doesNotMatch(text, /"state":"started"/);
    assert.match(text, /^id: 2$/m);
    assert.match(text, /^event: finding$/m);
    assert.match(text, /^event: done$/m);
    /* Terminal, so the stream closed rather than being held open forever. */
    assert.equal(text.trim().endsWith('}'), true);
  } finally { await s.close(); }
});

test('a live stream delivers events as they happen and closes on done', async () => {
  const s = await live({ withQueue: true });
  try {
    const accepted = await (await start(s.base, { subject: 'wool runner', terms: ['sizing'] })).json() as { id: string };
    const streaming = fetch(`${s.base}/v1/reports/${accepted.id}/stream`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 20));
    s.finish!();

    const text = await streaming;
    assert.match(text, /event: stage/);
    assert.match(text, /event: finding/);
    assert.match(text, /event: done/);
  } finally { await s.close(); }
});

test('streaming an unknown report is a 404 rather than an empty stream held open', async () => {
  const s = await live({ withQueue: true });
  try {
    const res = await fetch(`${s.base}/v1/reports/rep_0000000000000000/stream`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  } finally { await s.close(); }
});

test('every report route needs a key when auth is on', async () => {
  const s = await live({ withQueue: true, keys: ['secret-key'], requireAuth: true });
  try {
    assert.equal((await start(s.base, { subject: 'wool runner' })).status, 401);
    assert.equal((await fetch(`${s.base}/v1/reports/rep_0000000000000000`)).status, 401);
    assert.equal((await fetch(`${s.base}/v1/reports/rep_0000000000000000/stream`)).status, 401);

    const ok = await start(s.base, { subject: 'wool runner' }, { authorization: 'Bearer secret-key' });
    assert.equal(ok.status, 202);
  } finally { await s.close(); }
});

test('two keys do not share an idempotency namespace', async () => {
  const s = await live({ withQueue: true, keys: ['key-one', 'key-two'], requireAuth: true });
  try {
    const headers = (key: string) => ({ authorization: `Bearer ${key}`, 'idempotency-key': 'the-same-string' });
    const mine = await (await start(s.base, { subject: 'wool runner' }, headers('key-one'))).json() as { id: string };
    const theirs = await (await start(s.base, { subject: 'wool runner' }, headers('key-two'))).json() as { id: string };
    assert.notEqual(mine.id, theirs.id);
  } finally { await s.close(); }
});

/* ------------------------------------------------------------------ */
/* the webhook url, refused at the door                                */
/* ------------------------------------------------------------------ */

/*
 * The end to end negative case. spec/openapi.yaml has always promised that a
 * webhook url is validated against the same rules as every other url this
 * service touches; until 2026-08-23 the code behind that sentence was
 * `typeof webhookUrl !== 'string'`. These assert the promise over real HTTP,
 * because that is the surface a customer actually meets.
 */
test('a webhook url pointing into private space is refused at submit', async () => {
  const s = await live({ withQueue: true });
  try {
    for (const webhookUrl of [
      'https://169.254.169.254/',          /* cloud metadata */
      'https://127.0.0.1/hook',            /* loopback */
      'https://10.0.0.1/hook',             /* RFC1918 */
      'http://receiver.example/hook',      /* plaintext publishes the report on the path */
      'https://user:pass@receiver.example/hook',
      'not-a-url',
    ]) {
      const res = await start(s.base, { subject: 'wool runner', webhookUrl });
      assert.equal(res.status, 400, `${webhookUrl} must be refused`);
      const body = await res.json() as { error: { type: string; message: string } };
      assert.equal(body.error.type, 'invalid_request');
      assert.match(body.error.message, /webhookUrl/);
    }
  } finally { await s.close(); }
});

test('a well formed https webhook url is accepted', async () => {
  const s = await live({ withQueue: true });
  try {
    const res = await start(s.base, { subject: 'wool runner', webhookUrl: 'https://receiver.example/hook' });
    assert.equal(res.status, 202);
  } finally { await s.close(); }
});

test('a webhookUrl that is not a string is still refused', async () => {
  const s = await live({ withQueue: true });
  try {
    const res = await start(s.base, { subject: 'wool runner', webhookUrl: 42 });
    assert.equal(res.status, 400);
  } finally { await s.close(); }
});

/*
 * THE HEADERS THAT EXISTED AND NEVER ARRIVED. quotaHeaders was built on every
 * request and passed to send in exactly one place, the 429, so the documented
 * promise that a caller can pace itself BEFORE being refused was impossible:
 * the first rate limit header anyone ever saw was the refusal itself. The
 * spec, the README and the bench docs all claimed otherwise. Found 2026-08-23
 * by curling the live instance and counting what came back.
 */
test('a successful answer carries the rate limit headers, not only a refusal', async () => {
  const s = await live();
  try {
    const res = await fetch(`${s.base}/v1/evidence/${s.ids[0]}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('x-ratelimit-limit') ?? '', /^\d+$/, 'the allowance is stated');
    assert.match(res.headers.get('x-ratelimit-remaining') ?? '', /^\d+$/, 'and what is left of it');
    assert.match(res.headers.get('x-ratelimit-reset') ?? '', /^\d+$/, 'and when it resets');

    /* And remaining actually counts down, or the header is decoration. */
    const first = Number(res.headers.get('x-ratelimit-remaining'));
    const again = await fetch(`${s.base}/v1/evidence/${s.ids[0]}`);
    assert.equal(Number(again.headers.get('x-ratelimit-remaining')), first - 1);
  } finally { await s.close(); }
});

test('healthz is exempt and carries no rate limit headers', async () => {
  const s = await live();
  try {
    const res = await fetch(`${s.base}/v1/healthz`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-ratelimit-limit'), null);
  } finally { await s.close(); }
});

/* ------------------------------------------------------------------ */
/* onboarding: the root signpost and the self served webhook secret    */
/* ------------------------------------------------------------------ */

/*
 * The first thing anyone does with an api host is open it in a browser, and a
 * bare 401 teaches them nothing. The root is a keyless signpost that reads
 * nothing and says where everything is.
 */
test('the root answers without a key, even on a keyed instance', async () => {
  const s = await live({ requireAuth: true, keys: ['a-perfectly-good-key'] });
  try {
    const res = await fetch(`${s.base}/`);
    assert.equal(res.status, 200);
    const body = await res.json() as { name: string; authenticate: string; health: string };
    assert.equal(body.name, 'quorum');
    assert.match(body.authenticate, /Bearer/);
    assert.equal(body.health, '/v1/healthz');
    /* A signpost is not a surface: it reads nothing, so it counts against
     * nothing. */
    assert.equal(res.headers.get('x-ratelimit-limit'), null);
  } finally { await s.close(); }
});

test('everything under /v1 still requires the key the root does not', async () => {
  const s = await live({ requireAuth: true, keys: ['a-perfectly-good-key'] });
  try {
    assert.equal((await fetch(`${s.base}/v1/usage`)).status, 401);
  } finally { await s.close(); }
});

/*
 * SELF SERVED, SCOPED TO THE CALLER. Before this field existed the signing
 * secret was derivable only by the operator, by hand, out of band, so every
 * onboarding included a step nobody had written down. Usage is already the
 * endpoint that answers "what is mine", which makes it the one right place.
 */
test('usage hands each key its own webhook signing secret and nobody elses', async () => {
  const s = await live({
    requireAuth: true,
    keys: ['first-customer-key-value', 'second-customer-key-value'],
    webhookSecret: 'an instance secret for this test',
  });
  try {
    const mine = await (await fetch(`${s.base}/v1/usage`, {
      headers: { authorization: 'Bearer first-customer-key-value' },
    })).json() as { webhookSecret: string };
    const theirs = await (await fetch(`${s.base}/v1/usage`, {
      headers: { authorization: 'Bearer second-customer-key-value' },
    })).json() as { webhookSecret: string };

    assert.match(mine.webhookSecret, /^whsec_/);
    assert.notEqual(mine.webhookSecret, theirs.webhookSecret, 'two keys, two secrets');
    /* The same derivation the delivery worker signs with, so what usage hands
     * out verifies what the worker sends. */
    assert.equal(mine.webhookSecret, deriveSecret('an instance secret for this test', 'key-0'));
    /* And the instance secret itself is not in the response. */
    assert.equal(JSON.stringify(mine).includes('an instance secret'), false);
  } finally { await s.close(); }
});

test('usage says null for the secret when webhooks are off', async () => {
  const s = await live();
  try {
    const body = await (await fetch(`${s.base}/v1/usage`)).json() as { webhookSecret: string | null };
    assert.equal(body.webhookSecret, null, 'a secret that signs nothing is not worth inventing');
  } finally { await s.close(); }
});
