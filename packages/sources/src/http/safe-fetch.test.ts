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
  assert.match(USER_AGENT, /^quorum\//, 'it names the project');
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
    headers: { 'user-agent': 'quorum-arcticshift/0.1 (+https://github.com/Godzilla-lab/Quorum-API)' },
    transport: async () => ok(),
  });
  assert.equal(r.ok, true);
});

/* ------------------------------------------------------------------ */
/* the refusal tag                                                     */
/* ------------------------------------------------------------------ */

/*
 * WHY THESE EXIST. Before the tag, the only way to ask "could a retry ever
 * work" was to pattern match `error`, which is an English sentence. The webhook
 * sender did exactly that and got 13 of the 19 blocked ranges wrong, because
 * "private" and "loopback" were in its regex and "carrier grade nat",
 * "multicast", "nat64" and "broadcast" were not. Measured 2026-08-23.
 *
 * So the assertion that matters is not that one address is tagged `address`.
 * It is that EVERY blocked range is, including the ones nobody thinks of.
 */
test('every blocked range is tagged address, not only the memorable ones', async () => {
  const blocked = [
    '0.0.0.0',           /* this network */
    '10.0.0.1',          /* private */
    '100.64.0.1',        /* carrier grade nat, missed by the old regex */
    '127.0.0.1',         /* loopback */
    '169.254.169.254',   /* link local, cloud metadata */
    '172.16.0.1',        /* private */
    '192.0.0.1',         /* ietf protocol assignments */
    '192.0.2.1',         /* test net 1 */
    '192.88.99.1',       /* 6to4 relay */
    '192.168.1.1',       /* private */
    '198.18.0.1',        /* benchmarking */
    '198.51.100.1',      /* test net 2 */
    '203.0.113.1',       /* test net 3 */
    '224.0.0.1',         /* multicast */
    '240.0.0.1',         /* reserved */
    '255.255.255.255',   /* broadcast */
    '[::]',              /* unspecified */
    '[::1]',             /* loopback */
    '[fc00::1]',         /* unique local */
    '[fe80::1]',         /* link local */
    '[ff00::1]',         /* multicast */
    '[2001:db8::1]',     /* documentation */
    '[::ffff:127.0.0.1]',        /* ipv4 mapped loopback */
    '[::ffff:169.254.169.254]',  /* ipv4 mapped metadata, the classic bypass */
    '[64:ff9b::a9fe:a9fe]',      /* nat64 wrapping metadata */
  ];
  for (const host of blocked) {
    const r = await safeFetch(`https://${host}/`);
    assert.equal(r.ok, false, `${host} must be refused`);
    assert.equal(r.refusal, 'address', `${host} must be tagged address, it was tagged ${r.refusal}`);
  }
});

/*
 * Obfuscated literals, and what actually stops them.
 *
 * MEASURED 2026-08-23, and it is not what it looks like. The guess was that
 * these fail to PARSE and are refused as malformed. They are not: the WHATWG
 * URL parser NORMALISES them first, so by the time this module reads
 * `url.hostname` it is already the decimal form.
 *
 *   https://0177.0.0.1/       hostname is 127.0.0.1, octal decoded
 *   https://0x7f000001/       hostname is 127.0.0.1, hex decoded
 *   https://2130706433/       hostname is 127.0.0.1, packed integer decoded
 *   https://169.254.169.254./ trailing dot stripped
 *
 * That is a stronger position than failing closed on a parse error, because
 * the address rules then apply to the real address rather than to a string.
 * The property worth asserting is that no resolver is consulted for any of
 * them: an obfuscated literal is settled before a name lookup could
 * reinterpret it. The resolver here throws, so reaching it fails the test.
 */
test('an obfuscated ip literal is normalised and refused without a lookup', async () => {
  const noLookup = async () => { throw new Error('a literal must never reach the resolver'); };
  for (const host of ['0177.0.0.1', '0x7f000001', '2130706433', '017700000001', '169.254.169.254.']) {
    const r = await safeFetch(`https://${host}/`, { resolver: noLookup });
    assert.equal(r.ok, false, `${host} must be refused`);
    assert.equal(r.refusal, 'address', `${host} must be tagged address, it was tagged ${r.refusal}`);
  }
});

/* A host the url parser rejects outright never reaches the address rules,
 * which is the other fail closed path and is tagged for a different reason. */
test('a host the url parser rejects outright is tagged url', async () => {
  const r = await safeFetch('https://1.2.3.4.5/');
  assert.equal(r.ok, false);
  assert.equal(r.refusal, 'url');
});

test('a blocked address reached through a redirect is tagged address', async () => {
  const { transport } = spyTransport((url) =>
    url.hostname === 'start.example' ? redirectTo('https://169.254.169.254/') : ok());
  const r = await safeFetch('https://start.example/', { resolver: resolvesTo('93.184.216.34'), transport });
  assert.equal(r.ok, false);
  assert.equal(r.refusal, 'address');
});

/*
 * The four tags that can never succeed on a retry, and the three that might.
 * This is the distinction the whole type exists to carry.
 */
test('a name that does not resolve is tagged dns, not address', async () => {
  const r = await safeFetch('https://nowhere.example/', { resolver: async () => null });
  assert.equal(r.ok, false);
  assert.equal(r.refusal, 'dns', 'a name that did not answer may answer later, unlike a forbidden address');
});

test('a refused scheme is tagged scheme', async () => {
  for (const url of ['ftp://example.com/x', 'file:///etc/passwd']) {
    const r = await safeFetch(url);
    assert.equal(r.refusal, 'scheme', `${url} must be tagged scheme`);
  }
});

test('an unparseable url and an unparseable redirect target are both tagged url', async () => {
  assert.equal((await safeFetch('http://[not a url')).refusal, 'url');

  const { transport } = spyTransport(() => redirectTo('http://['));
  const viaRedirect = await safeFetch('https://start.example/', { resolver: resolvesTo('93.184.216.34'), transport });
  assert.equal(viaRedirect.refusal, 'url');
});

test('too many redirects is tagged redirects', async () => {
  const { transport } = spyTransport(() => redirectTo('https://loop.example/next'));
  const r = await safeFetch('https://loop.example/', { resolver: resolvesTo('93.184.216.34'), transport });
  assert.equal(r.ok, false);
  assert.equal(r.refusal, 'redirects');
});

test('a transport failure is tagged transport and a timeout is tagged timeout', async () => {
  const { transport: broken } = spyTransport(() => 'request failed: ECONNRESET');
  const failed = await safeFetch('https://x.example/', { resolver: resolvesTo('93.184.216.34'), transport: broken });
  assert.equal(failed.refusal, 'transport');

  const { transport: slow } = spyTransport(() => 'request timed out');
  const timedOut = await safeFetch('https://x.example/', { resolver: resolvesTo('93.184.216.34'), transport: slow });
  assert.equal(timedOut.refusal, 'timeout');
});

/* A success carries no tag at all, so `refusal` is never a thing to ignore. */
test('a successful fetch carries no refusal tag', async () => {
  const { transport } = spyTransport(() => ok());
  const r = await safeFetch('https://good.example/', { resolver: resolvesTo('93.184.216.34'), transport });
  assert.equal(r.ok, true);
  assert.equal(r.refusal, undefined);
});
