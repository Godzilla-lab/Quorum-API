/*
 * The guarded fetch. Every outbound request in this project goes through it.
 *
 * WHY THIS IS NOT A WRAPPER AROUND global fetch.
 *
 * Validating a hostname and then calling fetch leaves a gap: fetch performs its
 * own name resolution, so a name that resolved to a public address during the
 * check can resolve to 169.254.169.254 a millisecond later when the request
 * actually goes out. That is DNS rebinding, and it defeats a check-then-fetch
 * guard completely.
 *
 * node:http and node:https accept a `lookup` function, which is the hook that
 * closes it. We resolve once, validate what we got, and then hand the connection
 * a lookup that can only return that same validated address. The address we
 * checked is the address we connect to, by construction.
 *
 * Errors are returned as values rather than thrown, because every caller here is
 * an adapter talking to a vendor that can be down, and a run must degrade rather
 * than fail.
 */

import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupAddress } from 'node:dns';

import { checkAddress, checkScheme } from './ip-guard.ts';

/*
 * How a hostname becomes addresses.
 *
 * Injectable so the guard can be tested without a network, which matters
 * because CI runs with no route off the host. Note carefully what is and is not
 * injectable: the RESOLVER is, so a test can say "pretend this name resolves to
 * loopback". The BLOCKLIST is not. Making the rules swappable would turn the
 * one security control in this module into a configuration option.
 */
export type Resolver = (hostname: string) => Promise<{ address: string; family: 4 | 6 }[] | null>;

const systemResolver: Resolver = (hostname) =>
  new Promise((res) => {
    dnsLookup(hostname, { all: true }, (err, addresses: LookupAddress[]) => {
      if (err || !addresses?.length) { res(null); return; }
      res(addresses.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
    });
  });

export interface SafeFetchOptions {
  method?: string;
  /*
   * Request body, for the vendor APIs that need a POST. Sent as UTF-8 with a
   * matching content-length, which node will not infer for us.
   *
   * A body does not weaken the guard: the destination is still resolved,
   * validated and pinned before a byte moves, and every redirect hop is still
   * revalidated. It exists so an adapter never has to reach past safeFetch to
   * talk to a vendor, which is the only way the "no adapter calls fetch
   * directly" rule stays true.
   */
  body?: string;
  headers?: Record<string, string>;
  /* Total budget for the whole request including redirects. */
  timeoutMs?: number;
  /* Hard ceiling on the response body. A 10GB body cannot pin a worker. */
  maxBytes?: number;
  /*
   * Return the body as base64 rather than utf8 text.
   *
   * Images are binary, and `Buffer.toString('utf8')` silently mangles every
   * byte that is not valid utf8, so a jpeg read as text is corrupt with no
   * error anywhere. Vision needs the real bytes.
   *
   * It stays inside safeFetch rather than being a separate binary client
   * because image urls come from user supplied pages, which is exactly the SSRF
   * case this module exists for. Reading them ourselves also means an internal
   * url is never handed to a third party vendor to fetch on our behalf.
   */
  binary?: boolean;
  maxRedirects?: number;
  signal?: AbortSignal;
  /* Injected by tests. Defaults to the system resolver. */
  resolver?: Resolver;
  /*
   * Injected by tests so redirect revalidation can be exercised with no
   * network. Production always uses the real transport.
   */
  transport?: (target: URL, pinned: { address: string; family: 4 | 6 }) => Promise<HopResult | string>;
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
  /* The URL actually fetched, after any redirects. */
  url: string;
  /* Present when the request was refused or failed. Safe to surface. */
  error?: string;
}

/*
 * WE IDENTIFY OURSELVES ON EVERY REQUEST.
 *
 * This is posture, not politeness theatre, and it is also load bearing.
 *
 * MEASURED 2026-08-22 against a store that had been refusing us. Same host,
 * same path, same transport, only the headers differ:
 *
 *   accept only, no user-agent      403 Forbidden
 *   accept + this user-agent        301 redirect, which we follow to the page
 *
 * So the block was never bot detection defeating us. It was a server declining
 * to serve a client that would not say who it was, which is entirely reasonable
 * of it. An earlier diagnosis blamed the user-agent and was wrong for a
 * revealing reason: the comparison used global fetch, and undici silently adds
 * its own user-agent, so "no user-agent" was never actually being tested.
 *
 * Note what this deliberately is NOT: a browser string. Spoofing Chrome to
 * defeat a bot defence turns a defensible "we read public data logged off"
 * story into an indefensible one. The contact url is the point. A maintainer
 * who dislikes our traffic should be able to email us instead of blocking us.
 */
export const USER_AGENT = 'quorum/0.1 (+https://github.com/quorum)';

const DEFAULTS = {
  timeoutMs: 30_000,
  maxBytes: 8 * 1024 * 1024,
  /*
   * Measured against real sources: archives and CDNs commonly use two or three
   * hops (http to https, then a canonical host). Five leaves headroom without
   * letting a redirect loop run.
   */
  maxRedirects: 5,
};

const refuse = (url: string, error: string): SafeFetchResult =>
  ({ ok: false, status: 0, headers: {}, body: '', url, error });

/*
 * Resolve a hostname and return the address only if it is safe to connect to.
 *
 * An IP literal in the URL skips resolution but not validation, which is the
 * point: http://169.254.169.254/ never had a name to resolve.
 */
async function resolveSafely(
  hostname: string,
  resolver: Resolver,
): Promise<{ address: string; family: 4 | 6 } | string> {
  const literal = checkAddress(hostname);
  const looksLikeLiteral = /^[\d.]+$/.test(hostname) || hostname.includes(':');
  if (looksLikeLiteral) {
    if (!literal.allowed) return literal.reason ?? 'address not allowed';
    return { address: hostname, family: hostname.includes(':') ? 6 : 4 };
  }

  const resolved = await resolver(hostname);
  if (!resolved || !resolved.length) return 'host could not be resolved';

  /*
   * EVERY resolved address must pass, not merely the first. A name that answers
   * with one public address and one loopback address is a rebinding attempt
   * wearing a different hat, and picking the public one would connect us
   * wherever the resolver felt like sending the next lookup.
   */
  for (const a of resolved) {
    const verdict = checkAddress(a.address, a.family);
    if (!verdict.allowed) return verdict.reason ?? 'address not allowed';
  }

  const first = resolved[0];
  if (!first) return 'host could not be resolved';
  return first;
}

export interface HopResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  location?: string;
}

function fetchOneHop(
  target: URL,
  pinned: { address: string; family: 4 | 6 },
  options: Required<Pick<SafeFetchOptions, 'timeoutMs' | 'maxBytes'>> & SafeFetchOptions,
): Promise<HopResult | string> {
  return new Promise((resolve) => {
    const isHttps = target.protocol === 'https:';
    const send = isHttps ? httpsRequest : httpRequest;

    const req = send(
      {
        protocol: target.protocol,
        /*
         * The real hostname stays here so TLS SNI and certificate validation
         * work against the name, while `lookup` forces the connection to the
         * address we already validated. Rewriting the URL to the IP instead
         * would break certificate checking, which trades one hole for another.
         */
        host: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method: options.method ?? 'GET',
        /*
         * Caller headers win, so an adapter can identify itself more specifically.
         * The default is never absent.
         */
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'user-agent': USER_AGENT,
          'accept-language': 'en-US,en;q=0.9',
          /* Node does not infer this, and a vendor rejects a POST without it. */
          ...(options.body === undefined
            ? {}
            : { 'content-length': String(Buffer.byteLength(options.body, 'utf8')) }),
          ...options.headers,
        },
        timeout: options.timeoutMs,
        /*
         * Pinned. This is the whole point of the module.
         *
         * MEASURED 2026-08-22, and this was a real bug: node calls a custom
         * lookup with {hints: 1024, all: true}, and when `all` is set the
         * callback expects an ARRAY of {address, family}, not the scalar
         * (err, address, family) form. Always using the scalar form made the
         * address arrive as undefined and every real request failed with
         * "Invalid IP address: undefined", so DNS pinning never worked at all
         * against a live host. Fixture tests could not catch it, because they
         * replace the transport entirely.
         *
         * Both forms are honoured, since `all` is node's choice and not ours.
         */
        lookup: (_hostname, opts, cb) => {
          if (opts && typeof opts === 'object' && 'all' in opts && opts.all) {
            (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(
              null, [{ address: pinned.address, family: pinned.family }],
            );
            return;
          }
          (cb as unknown as (e: null, a: string, f: number) => void)(null, pinned.address, pinned.family);
        },
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
        }

        const status = res.statusCode ?? 0;
        const location = headers['location'];
        if (status >= 300 && status < 400 && location) {
          res.destroy();
          resolve({ status, headers, body: '', location });
          return;
        }

        let received = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > options.maxBytes) {
            res.destroy();
            resolve(`response exceeded ${options.maxBytes} bytes`);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({
          status,
          headers,
          body: Buffer.concat(chunks).toString(options.binary ? 'base64' : 'utf8'),
        }));
        res.on('error', (e) => resolve(`response failed: ${e.message}`));
      },
    );

    req.on('timeout', () => { req.destroy(); resolve('request timed out'); });
    req.on('error', (e) => resolve(`request failed: ${e.message}`));
    if (options.signal) {
      options.signal.addEventListener('abort', () => { req.destroy(); resolve('request aborted'); }, { once: true });
    }
    if (options.body !== undefined) req.write(options.body, 'utf8');
    req.end();
  });
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return refuse(rawUrl, 'not a valid url');
  }

  const deadline = Date.now() + timeoutMs;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    /*
     * Scheme and address are revalidated on EVERY hop, not only the first. A
     * public URL redirecting to http://169.254.169.254/ is the standard way
     * around a first-hop-only guard, and it costs an attacker nothing.
     */
    const scheme = checkScheme(current.protocol);
    if (!scheme.allowed) return refuse(current.toString(), scheme.reason ?? 'scheme not allowed');

    const pinned = await resolveSafely(current.hostname, options.resolver ?? systemResolver);
    if (typeof pinned === 'string') return refuse(current.toString(), pinned);

    const remaining = deadline - Date.now();
    if (remaining <= 0) return refuse(current.toString(), 'request timed out');

    const hopResult = options.transport
      ? await options.transport(current, pinned)
      : await fetchOneHop(current, pinned, { ...options, timeoutMs: remaining, maxBytes });
    if (typeof hopResult === 'string') return refuse(current.toString(), hopResult);

    if (hopResult.location) {
      let next: URL;
      try {
        next = new URL(hopResult.location, current);
      } catch {
        return refuse(current.toString(), 'redirect target is not a valid url');
      }
      current = next;
      continue;
    }

    return {
      ok: hopResult.status >= 200 && hopResult.status < 300,
      status: hopResult.status,
      headers: hopResult.headers,
      body: hopResult.body,
      url: current.toString(),
    };
  }

  return refuse(current.toString(), `more than ${maxRedirects} redirects`);
}
