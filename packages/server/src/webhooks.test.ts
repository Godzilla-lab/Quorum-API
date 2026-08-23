import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openSqliteCorpus } from '@quorum/corpus';
import { safeFetch, type Resolver, type SafeFetchOptions, type SafeFetchResult } from '@quorum/sources';

import {
  DEFAULT_TOLERANCE_SECONDS,
  MAX_ATTEMPTS,
  checkInstanceSecret,
  checkWebhookUrl,
  createWebhookWorker,
  deliver,
  deriveSecret,
  isRetryableRefusal,
  nextAttemptDelaySeconds,
  redactUrl,
  sign,
  signedContent,
  verify,
} from './webhooks.ts';

/* Every test here runs with no network. CI has no route off the host. */

const SECRET = 'whsec_plJ3nmyCDGBKInavdOK15jsl';

/* A fetch that reaches the real guard but never a real socket. */
const guarded = (extra: Partial<SafeFetchOptions>): typeof safeFetch =>
  (url, options = {}) => safeFetch(url, { ...options, ...extra });

const resolvesTo = (...addresses: string[]): Resolver => async () =>
  addresses.map((address) => ({ address, family: address.includes(':') ? 6 as const : 4 as const }));

/* A fetch that answers with a fixed status without touching the guard. */
const answers = (status: number): typeof safeFetch => async (url) => ({
  ok: status >= 200 && status < 300, status, headers: {}, body: '', url,
});

/* ------------------------------------------------------------------ */
/* signing, against somebody else's numbers                            */
/* ------------------------------------------------------------------ */

/*
 * THE ONE TEST THAT DECIDES WHETHER WE ARE ACTUALLY STANDARD WEBHOOKS.
 *
 * Every other signing test here checks us against ourselves, which proves only
 * that we are consistent. This vector is published by Svix, who wrote the
 * spec, and it was not produced by this code. If it ever fails, a receiver
 * using an off the shelf library rejects our deliveries, whatever the rest of
 * this file says.
 */
test('the signature matches a published Standard Webhooks vector', () => {
  const signature = sign(SECRET, 'msg_loFOjxBNrRLzqYUf', 1731705121, '{"event_type":"ping","data":{"success":true}}');
  assert.equal(signature, 'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=');
});

test('the signed content is id, timestamp and body joined by dots', () => {
  assert.equal(signedContent('rep_0000000000000001', 1731705121, '{}'), 'rep_0000000000000001.1731705121.{}');
});

/*
 * The delimiter is a full stop, so an id containing one makes two different
 * messages produce the same signed string. Report ids cannot contain a dot
 * today; this fails loudly on the day that changes rather than signing
 * something forgeable.
 */
test('an id containing the delimiter is refused rather than signed', () => {
  assert.throws(() => signedContent('rep_00.00', 1731705121, '{}'), /delimiter/);
  assert.throws(() => signedContent('rep_0000000000000001', 1.5, '{}'), /whole seconds/);
});

test('a different secret produces a different signature', () => {
  const a = sign(SECRET, 'rep_0000000000000001', 1731705121, '{"a":1}');
  const b = sign(deriveSecret('a different fake instance secret', 'key-1'), 'rep_0000000000000001', 1731705121, '{"a":1}');
  assert.notEqual(a, b);
});

test('one flipped byte of body invalidates the signature', () => {
  const body = '{"verdict":"finding"}';
  const signature = sign(SECRET, 'rep_0000000000000001', 1731705121, body);
  const tampered = '{"verdict":"findinh"}';
  assert.equal(sign(SECRET, 'rep_0000000000000001', 1731705121, tampered) === signature, false);
});

/* Proves the timestamp is genuinely inside the signed content rather than
 * merely travelling alongside it in a header. */
test('changing only the timestamp changes the signature', () => {
  const a = sign(SECRET, 'rep_0000000000000001', 1731705121, '{}');
  const b = sign(SECRET, 'rep_0000000000000001', 1731705122, '{}');
  assert.notEqual(a, b);
});

test('two key labels derive two different secrets, stably', () => {
  const instance = 'a fake instance secret for tests';
  const one = deriveSecret(instance, 'key-1');
  const two = deriveSecret(instance, 'key-2');
  assert.notEqual(one, two);
  assert.equal(one, deriveSecret(instance, 'key-1'), 'derivation must be stable across calls');
  assert.match(one, /^whsec_/);
});

/* ------------------------------------------------------------------ */
/* verification, including the replay window                           */
/* ------------------------------------------------------------------ */

test('a signature verifies inside the tolerance and fails outside it', () => {
  const ts = 1731705121;
  const header = sign(SECRET, 'msg_loFOjxBNrRLzqYUf', ts, '{}');
  const at = (offset: number) => verify(SECRET, 'msg_loFOjxBNrRLzqYUf', ts, '{}', header, { now: () => ts + offset });

  assert.equal(at(0), true);
  assert.equal(at(DEFAULT_TOLERANCE_SECONDS), true, 'the boundary is inside');
  assert.equal(at(DEFAULT_TOLERANCE_SECONDS + 1), false, 'a stale delivery is a replay and must be refused');
  assert.equal(at(-(DEFAULT_TOLERANCE_SECONDS + 1)), false, 'a delivery from the future is refused too');
});

test('a valid signature for the wrong body does not verify', () => {
  const ts = 1731705121;
  const header = sign(SECRET, 'msg_x', ts, '{"a":1}');
  assert.equal(verify(SECRET, 'msg_x', ts, '{"a":2}', header, { now: () => ts }), false);
});

/* The header is a space delimited list precisely so a secret can be rotated by
 * signing with both for a window. Any one match is enough. */
test('a rotated secret verifies while both signatures are sent', () => {
  const ts = 1731705121;
  const old = sign(SECRET, 'msg_x', ts, '{}');
  const fresh = sign(deriveSecret('a rotated fake instance secret', 'key-1'), 'msg_x', ts, '{}');
  const header = `${old} ${fresh}`;
  assert.equal(verify(SECRET, 'msg_x', ts, '{}', header, { now: () => ts }), true);
});

test('a garbage signature header does not verify and does not throw', () => {
  const ts = 1731705121;
  for (const header of ['', 'v1', 'v1,', 'nonsense', 'v2,abcd', 'v1,!!!not-base64!!!']) {
    assert.equal(verify(SECRET, 'msg_x', ts, '{}', header, { now: () => ts }), false, header);
  }
});

/* ------------------------------------------------------------------ */
/* the url, at submit time                                             */
/* ------------------------------------------------------------------ */

test('a webhook url must be https and must not carry credentials', () => {
  assert.equal(checkWebhookUrl('https://receiver.example/hook').ok, true);

  for (const [url, pattern] of [
    ['http://receiver.example/hook', /https/],
    ['ftp://receiver.example/hook', /https/],
    ['https://user:pass@receiver.example/hook', /credentials/],
    ['https://user@receiver.example/hook', /credentials/],
    ['not a url', /absolute/],
    ['/relative/path', /absolute/],
  ] as const) {
    const verdict = checkWebhookUrl(url);
    assert.equal(verdict.ok, false, `${url} must be refused`);
    assert.match(verdict.reason, pattern);
  }
});

/* ------------------------------------------------------------------ */
/* SSRF, the tests that must fail loudly                               */
/* ------------------------------------------------------------------ */

/*
 * Each of these is a real refusal through the real guard. The assertion is not
 * only that delivery failed: it is that the failure is PERMANENT, because a
 * blocked address that is retried on a schedule is a slow port scan wearing a
 * webhook's clothes.
 */
test('a webhook into private or reserved address space is refused permanently', async () => {
  const targets = [
    'https://169.254.169.254/latest/meta-data/',   /* cloud metadata, the one that matters */
    'https://[::ffff:169.254.169.254]/',           /* the v6 mapped form that bypasses a naive check */
    'https://[64:ff9b::a9fe:a9fe]/',               /* nat64 wrapping the same address */
    'https://127.0.0.1/hook',                      /* loopback */
    'https://[::1]/hook',                          /* loopback, v6 */
    'https://10.0.0.1/hook',                       /* RFC1918 */
    'https://192.168.1.1/hook',                    /* RFC1918 */
    'https://172.16.0.1/hook',                     /* RFC1918 */
    'https://100.64.0.1/hook',                     /* carrier grade nat, misclassified by the old regex */
    'https://[fc00::1]/hook',                      /* unique local, also misclassified */
    'https://224.0.0.1/hook',                      /* multicast, also misclassified */
    'https://0177.0.0.1/hook',                     /* octal, normalised to loopback */
    'https://2130706433/hook',                     /* packed integer, normalised to loopback */
  ];

  for (const url of targets) {
    const result = await deliver({ id: 'rep_0000000000000001', url, secret: SECRET, payload: '{}', timestampSeconds: 1731705121 });
    assert.equal(result.delivered, false, `${url} must not be delivered`);
    assert.equal(result.retryable, false, `${url} must be refused permanently, not retried`);
  }
});

/* The error names a range, never the host, so a caller cannot use a refusal as
 * a probe for what exists inside. */
test('a refusal names a range rather than the target host', async () => {
  const result = await deliver({
    id: 'rep_0000000000000001', url: 'https://169.254.169.254/', secret: SECRET,
    payload: '{}', timestampSeconds: 1731705121,
  });
  assert.match(result.detail, /not routable to the public internet/);
  assert.equal(result.detail.includes('169.254.169.254'), false, 'the refusal must not echo the target back');
});

test('a plain http webhook url is refused before anything is resolved', async () => {
  const result = await deliver({
    id: 'rep_0000000000000001', url: 'http://receiver.example/hook', secret: SECRET,
    payload: '{}', timestampSeconds: 1731705121,
  });
  assert.equal(result.delivered, false);
  assert.equal(result.retryable, false);
  assert.match(result.detail, /https/);
});

test('a public host that redirects into metadata is refused at the hop', async () => {
  const fetch = guarded({
    resolver: resolvesTo('93.184.216.34'),
    transport: async (target) => (target.hostname === 'receiver.example'
      ? { status: 302, headers: { location: 'https://169.254.169.254/' }, body: '', location: 'https://169.254.169.254/' }
      : { status: 200, headers: {}, body: '' }),
  });

  const result = await deliver({
    id: 'rep_0000000000000001', url: 'https://receiver.example/hook', secret: SECRET,
    payload: '{}', timestampSeconds: 1731705121,
  }, { fetch });

  assert.equal(result.delivered, false);
  assert.equal(result.retryable, false);
  assert.match(result.detail, /not routable/);
});

/*
 * DNS rebinding. The name answers public once and metadata the second time.
 * The address validated is the address pinned, so the second answer never gets
 * used, and a name that answers with both at once is refused outright.
 */
test('a rebinding resolver cannot move the connection after the check', async () => {
  let call = 0;
  const rebinding: Resolver = async () => {
    call += 1;
    return call === 1
      ? [{ address: '93.184.216.34', family: 4 as const }]
      : [{ address: '169.254.169.254', family: 4 as const }];
  };

  const connectedTo: string[] = [];
  const fetch = guarded({
    resolver: rebinding,
    transport: async (_target, pinned) => {
      connectedTo.push(pinned.address);
      return { status: 200, headers: {}, body: '' };
    },
  });

  const result = await deliver({
    id: 'rep_0000000000000001', url: 'https://receiver.example/hook', secret: SECRET,
    payload: '{}', timestampSeconds: 1731705121,
  }, { fetch });

  assert.equal(result.delivered, true);
  assert.deepEqual(connectedTo, ['93.184.216.34'], 'the pinned address must win, not the later answer');
});

test('a host answering with one public and one blocked address is refused', async () => {
  const fetch = guarded({ resolver: resolvesTo('93.184.216.34', '169.254.169.254') });
  const result = await deliver({
    id: 'rep_0000000000000001', url: 'https://receiver.example/hook', secret: SECRET,
    payload: '{}', timestampSeconds: 1731705121,
  }, { fetch });
  assert.equal(result.delivered, false);
  assert.equal(result.retryable, false);
});

/* ------------------------------------------------------------------ */
/* classification                                                      */
/* ------------------------------------------------------------------ */

/*
 * THE TEST THAT WOULD HAVE CAUGHT THE REGEX. Four of the seven refusals are
 * rules and can never change their answer; three are conditions and might. An
 * unrecognised tag stops rather than retries.
 */
test('only a condition is retryable, never a rule', () => {
  for (const refusal of ['address', 'scheme', 'url', 'redirects'] as const) {
    assert.equal(isRetryableRefusal(refusal), false, `${refusal} is a rule and can never succeed on a retry`);
  }
  for (const refusal of ['dns', 'transport', 'timeout'] as const) {
    assert.equal(isRetryableRefusal(refusal), true, `${refusal} is a condition and may pass later`);
  }
  assert.equal(isRetryableRefusal(undefined), false, 'an unknown refusal stops rather than knocking forever');
});

test('a transport failure and a timeout are retried', async () => {
  for (const tag of ['request failed: ECONNRESET', 'request timed out']) {
    const fetch = guarded({ resolver: resolvesTo('93.184.216.34'), transport: async () => tag });
    const result = await deliver({
      id: 'rep_0000000000000001', url: 'https://receiver.example/hook', secret: SECRET,
      payload: '{}', timestampSeconds: 1731705121,
    }, { fetch });
    assert.equal(result.delivered, false);
    assert.equal(result.retryable, true, `${tag} should be retried`);
  }
});

/* ------------------------------------------------------------------ */
/* what a receiver's status code means                                 */
/* ------------------------------------------------------------------ */

test('a 2xx is delivered, a 5xx and a 429 retry, and a 4xx does not', async () => {
  const request = {
    id: 'rep_0000000000000001', url: 'https://receiver.example/hook',
    secret: SECRET, payload: '{}', timestampSeconds: 1731705121,
  };

  for (const status of [200, 201, 204]) {
    const r = await deliver(request, { fetch: answers(status) });
    assert.equal(r.delivered, true, `${status} is a delivery`);
  }

  for (const status of [500, 502, 503, 429]) {
    const r = await deliver(request, { fetch: answers(status) });
    assert.equal(r.delivered, false);
    assert.equal(r.retryable, true, `${status} should be retried`);
  }

  /* A receiver rejecting the body will reject it again. Retrying somebody's 401
   * for three days is how a webhook sender becomes an attacker. */
  for (const status of [400, 401, 403, 404, 410, 422]) {
    const r = await deliver(request, { fetch: answers(status) });
    assert.equal(r.delivered, false);
    assert.equal(r.retryable, false, `${status} must not be retried`);
  }
});

test('the three Standard Webhooks headers are sent, and the signature covers what is sent', async () => {
  let seen: SafeFetchOptions | undefined;
  const capture: typeof safeFetch = async (url, options = {}) => {
    seen = options;
    return { ok: true, status: 200, headers: {}, body: '', url } satisfies SafeFetchResult;
  };

  const payload = '{"id":"rep_0000000000000001","status":"complete"}';
  await deliver({
    id: 'rep_0000000000000001', url: 'https://receiver.example/hook',
    secret: SECRET, payload, timestampSeconds: 1731705121,
  }, { fetch: capture });

  const headers = seen?.headers ?? {};
  assert.equal(headers['webhook-id'], 'rep_0000000000000001');
  assert.equal(headers['webhook-timestamp'], '1731705121');
  assert.equal(seen?.method, 'POST');
  assert.equal(seen?.body, payload, 'the bytes signed must be the bytes sent');
  assert.equal(
    verify(SECRET, 'rep_0000000000000001', 1731705121, payload, headers['webhook-signature'] ?? '', { now: () => 1731705121 }),
    true,
  );
});

/* ------------------------------------------------------------------ */
/* the schedule                                                        */
/* ------------------------------------------------------------------ */

/*
 * The schedule is the spec's, not ours, so this asserts the actual numbers.
 * The version this replaced summed to 62 seconds and reported a 15 minute
 * ceiling it could never reach.
 */
test('the retry schedule is the one in the spec and spans about 75 hours', () => {
  const noJitter = (): number => 0;
  const waits = Array.from({ length: MAX_ATTEMPTS - 1 }, (_, i) => nextAttemptDelaySeconds(i + 1, noJitter));

  assert.deepEqual(waits, [5, 300, 1_800, 7_200, 18_000, 36_000, 50_400, 72_000, 86_400]);
  assert.equal(MAX_ATTEMPTS, 10);

  const total = waits.reduce((sum, w) => sum + (w ?? 0), 0);
  assert.equal(total, 272_105);
  assert.ok(total / 3600 > 75, 'the horizon must outlast an instance that sleeps, not 62 seconds');
});

test('the schedule is spent after the last attempt, which is the signal to give up', () => {
  assert.equal(nextAttemptDelaySeconds(MAX_ATTEMPTS - 1, () => 0), 86_400);
  assert.equal(nextAttemptDelaySeconds(MAX_ATTEMPTS, () => 0), null);
  assert.equal(nextAttemptDelaySeconds(MAX_ATTEMPTS + 5, () => 0), null);
});

test('jitter only ever adds, and never more than a tenth', () => {
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    const base = nextAttemptDelaySeconds(attempt, () => 0) ?? 0;
    const jittered = nextAttemptDelaySeconds(attempt, () => 1) ?? 0;
    assert.ok(jittered >= base, 'jitter never brings a retry forward');
    assert.ok(jittered <= Math.round(base * 1.1), `jitter stayed within a tenth at attempt ${attempt}`);
  }
});

/* ------------------------------------------------------------------ */
/* the secret and the log                                              */
/* ------------------------------------------------------------------ */

test('an instance secret shorter than the spec floor is refused', () => {
  assert.equal(checkInstanceSecret('short').ok, false);
  assert.equal(checkInstanceSecret('a'.repeat(23)).ok, false);
  assert.equal(checkInstanceSecret('a'.repeat(24)).ok, true);
  assert.match(checkInstanceSecret('short').reason, /at least 24/);
});

/* A receiver's token usually lives in the query string, which makes the url
 * closer to a credential than to an address. */
test('a url is redacted to host and path before it can reach a log', () => {
  assert.equal(redactUrl('https://receiver.example/hook?token=supersecret'), 'https://receiver.example/hook?...');
  assert.equal(redactUrl('https://receiver.example/hook'), 'https://receiver.example/hook');
  assert.equal(redactUrl('nonsense'), '<unparseable url>');
  assert.equal(redactUrl('https://receiver.example/hook?token=supersecret').includes('supersecret'), false);
});

/* ------------------------------------------------------------------ */
/* the worker, against a real corpus                                   */
/* ------------------------------------------------------------------ */

function harness(over: { fetch?: typeof safeFetch } = {}) {
  let clock = 1_700_000_000;
  const now = (): number => clock;
  const corpus = openSqliteCorpus({ path: ':memory:', now });
  const logged: string[] = [];
  const worker = createWebhookWorker({
    corpus,
    instanceSecret: 'a fake instance secret for tests',
    now,
    random: () => 0,
    ...(over.fetch ? { fetch: over.fetch } : {}),
    log: (m) => logged.push(m),
  });
  return {
    worker, corpus, logged,
    advance: (seconds: number) => { clock += seconds; },
    now,
    close: () => corpus.close(),
  };
}

const enqueued = (reportId = 'rep_0000000000000001') => ({
  reportId, tenantId: 'tenant-a', keyLabel: 'key-1',
  url: 'https://receiver.example/hook', payload: `{"id":"${reportId}"}`,
});

test('the worker delivers a queued webhook and marks it delivered', async () => {
  const h = harness({ fetch: answers(200) });
  try {
    await h.worker.enqueue(enqueued());
    assert.equal(await h.worker.tick(), 1);
    assert.deepEqual(await h.corpus.dueDeliveries(h.now() + 86_400), [], 'a delivered row never comes back');
  } finally { await h.close(); }
});

test('the worker retries a 500 on the schedule and stops at the last attempt', async () => {
  const h = harness({ fetch: answers(500) });
  try {
    await h.worker.enqueue(enqueued());

    /* Attempt 1, then every scheduled wait in turn. */
    let attempts = 0;
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      attempts += await h.worker.tick();
      const wait = nextAttemptDelaySeconds(i + 1, () => 0);
      h.advance((wait ?? 0) + 1);
    }

    assert.equal(attempts, MAX_ATTEMPTS, 'exactly the bounded number of attempts');
    h.advance(86_400 * 10);
    assert.deepEqual(await h.corpus.dueDeliveries(h.now()), [], 'an exhausted delivery stops being due');
    assert.equal(h.logged.some((m) => /giving up/.test(m)), true, 'giving up is said out loud');
    assert.equal(h.logged.some((m) => /token|payload/.test(m)), false, 'and says it without leaking the url or body');
  } finally { await h.close(); }
});

test('the worker does not retry a 400 at all', async () => {
  const h = harness({ fetch: answers(400) });
  try {
    await h.worker.enqueue(enqueued());
    assert.equal(await h.worker.tick(), 1);
    h.advance(86_400 * 10);
    assert.deepEqual(await h.corpus.dueDeliveries(h.now()), [], 'a rejected body is never sent again');
  } finally { await h.close(); }
});

/*
 * A caller can submit many reports all aimed at one victim. Without a per host
 * cap the worker would point its whole concurrency at that host, which turns a
 * webhook feature into an amplifier.
 */
test('the worker sends at most one delivery per host per pass', async () => {
  const hosts: string[] = [];
  const record: typeof safeFetch = async (url) => {
    hosts.push(new URL(url).host);
    return { ok: true, status: 200, headers: {}, body: '', url };
  };
  const h = harness({ fetch: record });
  try {
    await h.worker.enqueue({ ...enqueued('rep_00000000000000a1'), url: 'https://victim.example/1' });
    await h.worker.enqueue({ ...enqueued('rep_00000000000000a2'), url: 'https://victim.example/2' });
    await h.worker.enqueue({ ...enqueued('rep_00000000000000a3'), url: 'https://elsewhere.example/3' });

    const sent = await h.worker.tick();
    assert.equal(sent, 2, 'one for each distinct host, not three');
    assert.deepEqual([...hosts].sort(), ['elsewhere.example', 'victim.example']);

    /* The one that was held back is still due and goes on the next pass. */
    assert.equal(await h.worker.tick(), 1);
  } finally { await h.close(); }
});

/*
 * The schedule runs to 75 hours. A retry carrying the timestamp it was queued
 * with arrives three days stale and any receiver enforcing the spec's replay
 * window rejects it, so every attempt has to be signed afresh.
 */
test('every attempt is signed with the timestamp of that attempt', async () => {
  const stamps: string[] = [];
  const signatures: string[] = [];
  const capture: typeof safeFetch = async (url, options = {}) => {
    stamps.push(options.headers?.['webhook-timestamp'] ?? '');
    signatures.push(options.headers?.['webhook-signature'] ?? '');
    return { ok: false, status: 500, headers: {}, body: '', url };
  };

  const h = harness({ fetch: capture });
  try {
    await h.worker.enqueue(enqueued());
    await h.worker.tick();
    h.advance(5 + 1);
    await h.worker.tick();

    assert.equal(stamps.length, 2);
    assert.notEqual(stamps[0], stamps[1], 'the retry carries its own timestamp, not the enqueue time');
    assert.notEqual(signatures[0], signatures[1], 'and is therefore signed afresh');
  } finally { await h.close(); }
});

test('the id a receiver deduplicates on is stable across retries', async () => {
  const ids: string[] = [];
  const capture: typeof safeFetch = async (url, options = {}) => {
    ids.push(options.headers?.['webhook-id'] ?? '');
    return { ok: false, status: 500, headers: {}, body: '', url };
  };

  const h = harness({ fetch: capture });
  try {
    await h.worker.enqueue(enqueued());
    await h.worker.tick();
    h.advance(6);
    await h.worker.tick();
    assert.deepEqual(ids, ['rep_0000000000000001', 'rep_0000000000000001']);
  } finally { await h.close(); }
});

test('a delivery into metadata is refused by the worker and never retried', async () => {
  const h = harness();
  try {
    await h.worker.enqueue({ ...enqueued(), url: 'https://169.254.169.254/' });
    assert.equal(await h.worker.tick(), 1);
    h.advance(86_400 * 10);
    assert.deepEqual(await h.corpus.dueDeliveries(h.now()), [], 'a blocked address is refused, not scanned on a schedule');
  } finally { await h.close(); }
});

test('the worker starts and stops without holding the process open', async () => {
  const h = harness({ fetch: answers(200) });
  try {
    h.worker.start();
    h.worker.start();
    h.worker.stop();
    h.worker.stop();
  } finally { await h.close(); }
});

/*
 * An ip literal is refused at submit, a hostname is not, and the asymmetry is
 * deliberate. A name can resolve to something different by the time we
 * connect, so checking it here proves nothing; a literal cannot change and
 * refusing it now turns a silent non delivery into an immediate 400.
 */
test('an ip literal in a webhook url is refused at submit, a hostname is not', () => {
  for (const url of [
    'https://169.254.169.254/',
    'https://127.0.0.1/hook',
    'https://10.0.0.1/hook',
    'https://[::1]/hook',
    'https://[::ffff:169.254.169.254]/',
    'https://0177.0.0.1/hook',
    'https://2130706433/hook',
  ]) {
    const verdict = checkWebhookUrl(url);
    assert.equal(verdict.ok, false, `${url} must be refused at submit`);
    assert.match(verdict.reason, /address refused/);
  }

  /* A public literal is fine, and so is every hostname: the name is settled at
   * delivery, against the address that then gets pinned. */
  assert.equal(checkWebhookUrl('https://93.184.216.34/hook').ok, true);
  assert.equal(checkWebhookUrl('https://receiver.example/hook').ok, true);
});

/*
 * THE CRASH THAT ALMOST SHIPPED. `start()` fires ticks as `void this.tick()`,
 * so a rejection from tick is an unhandled rejection, and node's default for
 * an unhandled rejection is to kill the process. The first version of tick had
 * a `finally` and no `catch`, which meant a transient database error during
 * any background pass took the whole API server down. Proved 2026-08-23
 * before fixing: the rejection reached the process handler.
 */
test('a database error during a tick is survived, not thrown', async () => {
  let calls = 0;
  const flaky = {
    enqueueDelivery: async () => {},
    dueDeliveries: async () => {
      calls += 1;
      if (calls === 1) throw new Error('Connection terminated unexpectedly');
      return [];
    },
    recordDeliveryAttempt: async () => {},
    pruneDeliveries: async () => 0,
  };
  const logged: string[] = [];
  const worker = createWebhookWorker({
    corpus: flaky, instanceSecret: 'a fake instance secret for tests', log: (m) => logged.push(m),
  });

  /* The failing tick RESOLVES rather than rejecting. If it rejects, this await
   * throws and the test fails, which is the point. */
  assert.equal(await worker.tick(), 0);
  assert.equal(logged.some((m) => /tick failed/.test(m)), true, 'the failure is said out loud');

  /* And the worker is not wedged: the next tick runs normally. */
  assert.equal(await worker.tick(), 0);
  assert.equal(calls, 2, 'the running flag was released despite the throw');
});

test('a database error while recording an attempt is survived too', async () => {
  const rows = [{
    reportId: 'rep_0000000000000001', tenantId: 't', keyLabel: 'key-1',
    url: 'https://receiver.example/hook', payload: '{}', attempts: 0,
    nextAttemptAt: 0, status: 'pending' as const, lastStatus: null, lastError: null,
    createdAt: 0, deliveredAt: null,
  }];
  const broken = {
    enqueueDelivery: async () => {},
    dueDeliveries: async () => rows,
    recordDeliveryAttempt: async () => { throw new Error('database is down'); },
    pruneDeliveries: async () => 0,
  };
  const worker = createWebhookWorker({
    corpus: broken, instanceSecret: 'a fake instance secret for tests', fetch: answers(200),
  });
  /* Resolves. The row was never marked, so it is still pending and the next
   * boot or tick simply finds it again: at least once, as documented. */
  assert.equal(await worker.tick(), 0);
});

/*
 * A verifier's id and timestamp arrive from whoever is POSTing at the
 * receiver, which means an attacker chooses them. sign() throws on a dotted id
 * and a fractional timestamp, correctly, because WE must never produce one. A
 * verifier that did the same handed the attacker an exception in the
 * receiver's process for the price of one crafted header, and until 2026-08-23
 * it did exactly that.
 */
test('verify refuses attacker shaped input rather than throwing on it', () => {
  const ts = 1731705121;
  const header = sign(SECRET, 'msg_x', ts, '{}');
  const at = (id: string, timestamp: number) =>
    verify(SECRET, id, timestamp, '{}', header, { now: () => ts });

  assert.equal(at('msg_x', ts + 0.5), false, 'a fractional timestamp is refused, not thrown');
  assert.equal(at('msg.x', ts), false, 'a dotted id is refused, not thrown');
  assert.equal(at('msg_x', Number.NaN), false);
  assert.equal(at('msg_x', Number.POSITIVE_INFINITY), false);
  /* And the honest case still verifies, so the guards above cost nothing. */
  assert.equal(at('msg_x', ts), true);
});
