import { test } from 'node:test';
import assert from 'node:assert/strict';

import { safeFetch, type HopResult, type Resolver } from './safe-fetch.ts';

/* Every test here runs with no network. CI has no route off the host. */

const resolvesTo = (...addresses: string[]): Resolver => async () =>
  addresses.map((address) => ({ address, family: address.includes(':') ? 6 as const : 4 as const }));

const ok = (body = 'hello'): HopResult => ({ status: 200, headers: {}, body });
const redirectTo = (location: string): HopResult => ({ status: 302, headers: { location }, body: '', location });

/* Records which URLs the transport was actually asked to fetch. */
function spyTransport(script: (url: URL) => HopResult | string) {
  const attempted: string[] = [];
  const transport = async (target: URL): Promise<HopResult | string> => {
    attempted.push(target.toString());
    return script(target);
  };
  return { transport, attempted };
}

test('a non http scheme is refused before anything is resolved', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com', 'data:text/plain,hi']) {
    const r = await safeFetch(url);
    assert.equal(r.ok, false, `${url} must be refused`);
    assert.match(r.error ?? '', /scheme/);
  }
});

test('a malformed url is refused', async () => {
  const r = await safeFetch('http://[not a url');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /not a valid url/);
});

/*
 * The credential disclosure case. No DNS involved: the address is right there
 * in the URL, so a guard that only inspects resolved names never sees it.
 */
test('an ip literal pointing at cloud metadata is refused', async () => {
  const r = await safeFetch('http://169.254.169.254/latest/meta-data/');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /link local/);
});

test('ip literals in private space are refused', async () => {
  for (const host of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '[::1]']) {
    const r = await safeFetch(`http://${host}/`);
    assert.equal(r.ok, false, `${host} must be refused`);
  }
});

/* Rebinding: the name looks fine, the address it answers with does not. */
test('a public hostname resolving to a blocked address is refused', async () => {
  const r = await safeFetch('https://totally-normal.example/', { resolver: resolvesTo('169.254.169.254') });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /link local/);
});

/*
 * A name answering with one good address and one bad one is a rebinding attempt
 * wearing a different hat. Taking the first public answer would connect us
 * wherever the resolver felt like sending the next lookup.
 */
test('every resolved address must pass, not just the first', async () => {
  const r = await safeFetch('https://mixed.example/', { resolver: resolvesTo('93.184.216.34', '127.0.0.1') });
  assert.equal(r.ok, false, 'one bad answer poisons the name');
});

test('a public hostname resolving to a public address is fetched', async () => {
  const spy = spyTransport(() => ok('body text'));
  const r = await safeFetch('https://example.com/thing', {
    resolver: resolvesTo('93.184.216.34'),
    transport: spy.transport,
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.body, 'body text');
  assert.deepEqual(spy.attempted, ['https://example.com/thing']);
});

/*
 * THE HOP THAT MATTERS. A first-hop-only guard is defeated by a public URL that
 * redirects inward, and it costs an attacker nothing to set one up.
 */
test('a redirect into private space is refused at the hop, not followed', async () => {
  const spy = spyTransport((url) =>
    url.hostname === 'example.com' ? redirectTo('http://169.254.169.254/latest/') : ok());

  const r = await safeFetch('https://example.com/start', {
    resolver: resolvesTo('93.184.216.34'),
    transport: spy.transport,
  });

  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /link local/);
  assert.deepEqual(spy.attempted, ['https://example.com/start'], 'the metadata host was never contacted');
});

test('a redirect to a non http scheme is refused', async () => {
  const spy = spyTransport(() => redirectTo('file:///etc/passwd'));
  const r = await safeFetch('https://example.com/', {
    resolver: resolvesTo('93.184.216.34'),
    transport: spy.transport,
  });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /scheme/);
});

test('a legitimate redirect chain is followed and the final url reported', async () => {
  const spy = spyTransport((url) => {
    if (url.pathname === '/start') return redirectTo('https://example.com/middle');
    if (url.pathname === '/middle') return redirectTo('/end');
    return ok('arrived');
  });

  const r = await safeFetch('https://example.com/start', {
    resolver: resolvesTo('93.184.216.34'),
    transport: spy.transport,
  });

  assert.equal(r.ok, true);
  assert.equal(r.body, 'arrived');
  assert.equal(r.url, 'https://example.com/end', 'relative redirects resolve against the current hop');
  assert.equal(spy.attempted.length, 3);
});

test('a redirect loop terminates rather than running forever', async () => {
  const spy = spyTransport(() => redirectTo('https://example.com/loop'));
  const r = await safeFetch('https://example.com/loop', {
    resolver: resolvesTo('93.184.216.34'),
    transport: spy.transport,
    maxRedirects: 3,
  });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /redirects/);
  assert.equal(spy.attempted.length, 4, 'the initial request plus three redirects');
});

test('a host that does not resolve is refused, not assumed reachable', async () => {
  const r = await safeFetch('https://nope.example/', { resolver: async () => null });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /resolved/);
});

test('a transport failure is returned as a value rather than thrown', async () => {
  const r = await safeFetch('https://example.com/', {
    resolver: resolvesTo('93.184.216.34'),
    transport: async () => 'connection reset',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'connection reset');
  assert.equal(r.status, 0, 'a run degrades rather than failing');
});

test('a non 2xx response is returned, not treated as an error', async () => {
  const r = await safeFetch('https://example.com/', {
    resolver: resolvesTo('93.184.216.34'),
    transport: async () => ({ status: 404, headers: {}, body: 'gone' }),
  });
  assert.equal(r.ok, false, 'ok tracks 2xx');
  assert.equal(r.status, 404);
  assert.equal(r.body, 'gone', 'the body is still available to the caller');
  assert.equal(r.error, undefined, 'a 404 is an answer, not a failure');
});

test('an error string never leaks the blocked target back to a caller', async () => {
  const r = await safeFetch('http://169.254.169.254/latest/meta-data/iam/');
  assert.doesNotMatch(r.error ?? '', /169\.254/);
  assert.doesNotMatch(r.error ?? '', /meta-data/);
});

/*
 * REGRESSION, measured 2026-08-22. Against a store that had been refusing us,
 * with the same host, path and transport and only the headers differing:
 *   accept only, no user-agent   403 Forbidden
 *   accept + our user-agent      301 redirect, followed to the page
 * The block was a server declining to serve a client that would not say who it
 * was, not a bot defence beating us.
 */
test('every request identifies itself', async () => {
  let sent: Record<string, string> = {};
  const transport = async (_t: URL): Promise<HopResult> => ok();

  /* The header is applied in the real transport, so assert on the constant and
   * on the shape rather than on a stubbed call. */
  const { USER_AGENT } = await import('./safe-fetch.ts');
  assert.match(USER_AGENT, /^receipts\//, 'it names the project');
  assert.match(USER_AGENT, /\+https?:\/\//, 'and carries a contact url so we can be emailed rather than blocked');

  const r = await safeFetch('https://example.com/', {
    resolver: resolvesTo('93.184.216.34'), transport,
  });
  assert.equal(r.ok, true);
  void sent;
});

/*
 * Deliberately NOT a browser string. Spoofing Chrome to defeat a bot defence
 * turns a defensible "we read public data logged off" story into an
 * indefensible one.
 */
test('the user agent is not a browser impersonation', async () => {
  const { USER_AGENT } = await import('./safe-fetch.ts');
  for (const forbidden of [/Mozilla/i, /Chrome/i, /Safari/i, /AppleWebKit/i, /Gecko/i]) {
    assert.doesNotMatch(USER_AGENT, forbidden, 'we identify, we do not disguise');
  }
});

test('a caller can override the user agent to identify a specific adapter', async () => {
  /* The Arctic Shift client does this, so its traffic is attributable to it. */
  const r = await safeFetch('https://example.com/', {
    resolver: resolvesTo('93.184.216.34'),
    headers: { 'user-agent': 'receipts-arcticshift/0.1 (+https://github.com/receipts)' },
    transport: async () => ok(),
  });
  assert.equal(r.ok, true);
});
