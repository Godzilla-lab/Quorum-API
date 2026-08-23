import { test } from 'node:test';
import assert from 'node:assert/strict';

import { USER_AGENT, createArcticShiftClient } from './client.ts';
import { createThrottle } from '../throttle.ts';
import type { SafeFetchResult } from '../http/safe-fetch.ts';

const instant = () => createThrottle({ sleep: async () => {}, random: () => 0 });

function fakeFetch(script: (url: string, call: number) => Partial<SafeFetchResult>) {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const impl = (async (url: string, options: { headers?: Record<string, string> } = {}) => {
    urls.push(url);
    headers.push(options.headers ?? {});
    const r = script(url, urls.length);
    return { ok: true, status: 200, headers: {}, body: '{"data":[]}', url, ...r } as SafeFetchResult;
  }) as unknown as typeof import('../http/safe-fetch.ts').safeFetch;
  return { impl, urls, headers };
}

test('the client identifies itself, because this is a volunteer run service', async () => {
  const f = fakeFetch(() => ({}));
  const c = createArcticShiftClient({ throttle: instant(), fetch: f.impl });
  await c.get('posts/search', { subreddit: 'running' });

  assert.equal(f.headers[0]?.['user-agent'], USER_AGENT);
  assert.match(USER_AGENT, /\+https?:\/\//, 'being contactable is what stops us being blocked');
});

test('parameters are encoded rather than concatenated', async () => {
  const f = fakeFetch(() => ({}));
  const c = createArcticShiftClient({ throttle: instant(), fetch: f.impl });
  await c.get('posts/search', { subreddit: 'running', query: 'sizing & fit', limit: 25 });

  const url = f.urls[0] ?? '';
  assert.match(url, /query=sizing\+%26\+fit/, 'an unencoded ampersand would truncate the query');
  assert.match(url, /limit=25/);
});

test('the data envelope is unwrapped', async () => {
  const f = fakeFetch(() => ({ body: '{"data":[{"id":"a"},{"id":"b"}]}' }));
  const c = createArcticShiftClient({ throttle: instant(), fetch: f.impl });
  assert.equal((await c.get('posts/search', {})).length, 2);
});

/*
 * Overload arrives as a 200 with an error in the body, which is the shape most
 * likely to be mistaken for a successful empty result.
 */
test('a 200 carrying an overload message is retried', async () => {
  const f = fakeFetch((_u, call) => call < 3
    ? { body: '{"error":"Timeout. Maybe slow down a bit"}' }
    : { body: '{"data":[{"id":"a"}]}' });

  const c = createArcticShiftClient({ throttle: instant(), fetch: f.impl });
  assert.equal((await c.get('posts/search', {})).length, 1);
  assert.equal(f.urls.length, 3, 'it backed off and came back rather than reporting empty');
  assert.equal(c.throttleState().throttled, true, 'and it stays cautious afterwards');
});

test('"Too many requests" is also treated as overload', async () => {
  const f = fakeFetch((_u, call) => call < 2
    ? { body: '{"error":"Too many requests"}' }
    : { body: '{"data":[{"id":"a"}]}' });
  const c = createArcticShiftClient({ throttle: instant(), fetch: f.impl });
  assert.equal((await c.get('posts/search', {})).length, 1);
});

/*
 * A parameter error means stop. Retrying spends the whole attempt budget to
 * receive the same refusal four times over, on a service we are trying not to
 * lean on.
 */
test('a parameter error is not retried', async () => {
  const f = fakeFetch(() => ({ body: '{"error":"subreddit or author is required"}' }));
  const c = createArcticShiftClient({ throttle: instant(), fetch: f.impl });

  assert.deepEqual(await c.get('posts/search', {}), []);
  assert.equal(f.urls.length, 1, 'one refusal is enough to learn from');
});

test('a 429 is retried', async () => {
  const f = fakeFetch((_u, call) => call < 2 ? { ok: false, status: 429 } : { body: '{"data":[{"id":"a"}]}' });
  const c = createArcticShiftClient({ throttle: instant(), fetch: f.impl });
  assert.equal((await c.get('posts/search', {})).length, 1);
});

test('a persistent failure returns empty rather than throwing', async () => {
  const f = fakeFetch(() => ({ ok: false, status: 503 }));
  const c = createArcticShiftClient({ throttle: instant(), fetch: f.impl });
  assert.deepEqual(await c.get('posts/search', {}), [], 'a source that is down degrades a run, it never fails one');
});

test('a non json body is survived', async () => {
  const f = fakeFetch(() => ({ body: '<html>maintenance</html>' }));
  const c = createArcticShiftClient({ throttle: instant(), fetch: f.impl });
  assert.deepEqual(await c.get('posts/search', {}), []);
});

test('a response with no data key yields empty', async () => {
  const f = fakeFetch(() => ({ body: '{}' }));
  const c = createArcticShiftClient({ throttle: instant(), fetch: f.impl });
  assert.deepEqual(await c.get('posts/search', {}), []);
});

/*
 * REGRESSION, measured live 2026-08-22.
 *
 * Overload arrives as HTTP 422 carrying {"error":"Timeout. Maybe slow down a
 * bit"}. An earlier version returned early on any non 2xx response, so it never
 * parsed the body, never recognised the overload, and gave up instantly. On the
 * probe that found this, posts/search returned 422 four times in a row and
 * succeeded on the fifth, so giving up on the first would have reported an
 * empty category as fact.
 */
test('a 422 carrying an overload message is retried, not treated as failure', async () => {
  const f = fakeFetch((_u, call) => call < 5
    ? { ok: false, status: 422, body: '{"error":"Timeout. Maybe slow down a bit"}' }
    : { ok: true, status: 200, body: '{"data":[{"id":"a"}]}' });

  const c = createArcticShiftClient({ throttle: createThrottle({ sleep: async () => {}, random: () => 0, maxAttempts: 6 }), fetch: f.impl });

  assert.equal((await c.get('posts/search', {})).length, 1, 'the archive answered on the fifth attempt in the real probe');
  assert.equal(f.urls.length, 5);
});

test('a 400 parameter error is still not retried, even though the body is now parsed', async () => {
  /* The live message, verbatim. */
  const f = fakeFetch(() => ({
    ok: false, status: 400,
    body: '{"error":"\'query\' query parameter requires one of: author, subreddit"}',
  }));
  const c = createArcticShiftClient({ throttle: instant(), fetch: f.impl });

  assert.deepEqual(await c.get('posts/search', { query: 'sizing' }), []);
  assert.equal(f.urls.length, 1, 'parsing the body must not turn every 4xx into a retry');
});
