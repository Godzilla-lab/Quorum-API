/*
 * The Wayback CDX index.
 *
 * The availability API beside this file answers "what is the ONE snapshot
 * closest to a date". CDX answers "every snapshot there has ever been", with a
 * content digest on each, and that difference is what makes catalogue history
 * possible at all.
 *
 * MEASURED 2026-08-22, AND THE NUMBERS DECIDE HOW THIS IS USED.
 *
 * Six identical queries took 2.5s, 7.2s, 32.6s, 32.1s, 48.6s and one timed out
 * at 60s. Same endpoint, same parameters, an order of magnitude apart. There is
 * no documented rate limit and no `Retry-After` to back off against, so a
 * timeout here is a NORMAL OUTCOME rather than an error, and the default
 * timeout is generous because a tight one would fail most of the time.
 *
 * Consequence: this is never on the default path of a report. One call can cost
 * more wall clock than the entire Reddit and Hacker News retrieval, which
 * measured 39.9s for 411 records on the same day. It belongs in an explicit,
 * opt in backfill.
 *
 * WHAT IS ACTUALLY ARCHIVED, WHICH IS NOT WHAT THE PLAN ASSUMED.
 *
 *   allbirds.com/products.json      1 snapshot, from 2020
 *   gymshark.com/products.json      0
 *   shop.tesla.com/products.json    0
 *   allbirds.com/products/*         2000+, and 4000+ distinct product urls
 *                                   spanning 2016-03-05 to 2026-08-19
 *
 * Nothing links to a `/products.json`, so the crawler does not go there. Every
 * product PAGE is linked from a category page, so the crawler goes there
 * constantly. Catalogue history is therefore recoverable, but through the html
 * pages rather than through the json endpoint the plan expected.
 */

import { safeFetch } from '../http/safe-fetch.ts';
import { parseWaybackTimestamp } from './wayback.ts';

const CDX_ENDPOINT = 'https://web.archive.org/cdx/search/cdx';

/*
 * Generous on purpose. See the header: a 20s timeout would abandon most calls
 * that were going to succeed, and retrying a slow endpoint makes it slower for
 * everyone including us.
 */
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_LIMIT = 2000;

export interface CdxSnapshot {
  timestamp: string;
  /* The url as the archive recorded it, which may differ in host or scheme. */
  original: string;
  status: string;
  /* Identifies identical content, so K fetches cover K distinct versions. */
  digest: string;
  capturedAt: Date | null;
}

export interface CdxResult {
  ok: boolean;
  snapshots: CdxSnapshot[];
  /*
   * TRUE WHEN THE LIMIT WAS HIT, AND THIS FIELD IS NOT OPTIONAL POLISH.
   *
   * Both exploratory queries on 2026-08-22 came back exactly at the limit I had
   * set, 2000 and then 4000, and both times the obvious reading was "that is
   * the total". It was not. A bounded result that does not say it was bounded
   * reads as complete coverage, which is how a report ends up quietly wrong.
   */
  truncated: boolean;
  /* Present when the call failed. Safe to show a caller. */
  error?: string;
}

export interface CdxOptions {
  fetch?: typeof safeFetch;
  timeoutMs?: number;
  limit?: number;
  /* Treat the url as a prefix, so `site.com/products` matches every product. */
  prefix?: boolean;
  /* One row per distinct url, oldest first. The catalogue history query. */
  collapseUrls?: boolean;
  /* One row per distinct content digest, so unchanged captures collapse. */
  collapseDigest?: boolean;
  /* Successful captures only. A 404 in the archive is a page that had gone. */
  onlyOk?: boolean;
  /* Four digit years, or full timestamps. */
  from?: string;
  to?: string;
  signal?: AbortSignal;
}

export function cdxUrl(url: string, options: CdxOptions = {}): string {
  const params = new URLSearchParams({
    url,
    output: 'json',
    fl: 'timestamp,original,statuscode,digest',
    limit: String(options.limit ?? DEFAULT_LIMIT),
  });
  if (options.prefix) params.set('matchType', 'prefix');
  /*
   * The archive accepts only one collapse field per query. Urls win because the
   * catalogue question ("which products existed") is the one worth the latency,
   * and digest collapsing is a refinement of a single url's history.
   */
  if (options.collapseUrls) params.set('collapse', 'urlkey');
  else if (options.collapseDigest) params.set('collapse', 'digest');
  if (options.onlyOk) params.set('filter', 'statuscode:200');
  if (options.from) params.set('from', options.from);
  if (options.to) params.set('to', options.to);
  return `${CDX_ENDPOINT}?${params.toString()}`;
}

/*
 * Never throws. A slow archive is the normal case, not an exception, and a
 * backfill that dies because one query took too long is worse than one that
 * records the gap and carries on.
 */
export async function listSnapshots(url: string, options: CdxOptions = {}): Promise<CdxResult> {
  const doFetch = options.fetch ?? safeFetch;
  const limit = options.limit ?? DEFAULT_LIMIT;

  const result = await doFetch(cdxUrl(url, { ...options, limit }), {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    /* Four thousand rows measured about 400KB. Sized well above that. */
    maxBytes: 16 * 1024 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!result.ok) {
    return { ok: false, snapshots: [], truncated: false, error: result.error ?? `status ${result.status}` };
  }

  let rows: unknown;
  try {
    rows = JSON.parse(result.body);
  } catch {
    return { ok: false, snapshots: [], truncated: false, error: 'cdx response was not json' };
  }
  /* An empty body is a real answer: nothing was ever archived at that url. */
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: true, snapshots: [], truncated: false };
  }

  /* The first row is the header, echoing the `fl` fields back. */
  const body = (rows as unknown[]).slice(1).filter((r): r is string[] => Array.isArray(r));
  const snapshots: CdxSnapshot[] = body.map((r) => {
    const timestamp = r[0] ?? '';
    return {
      timestamp,
      original: r[1] ?? '',
      status: r[2] ?? '',
      digest: r[3] ?? '',
      capturedAt: parseWaybackTimestamp(timestamp),
    };
  });

  return { ok: true, snapshots, truncated: snapshots.length >= limit };
}

/*
 * The raw archived bytes for one snapshot.
 *
 * The `id_` modifier is load bearing. Without it the archive injects its own
 * toolbar and rewrites every url in the page, which corrupts JSON-LD and turns
 * a product's image urls into archive urls. With it, the original response
 * comes back untouched, which is what a parser needs.
 */
export function archivedContentUrl(snapshot: CdxSnapshot): string {
  return `https://web.archive.org/web/${snapshot.timestamp}id_/${snapshot.original}`;
}

export interface CatalogueEntry {
  url: string;
  firstSeen: Date | null;
  lastSeen: Date | null;
  captures: number;
}

/*
 * Which products a store has ever had, and when each was last seen alive.
 *
 * This is the product mortality signal. A delisted product vanishes from a live
 * catalogue with no trace, so "what did they launch and then kill" is normally
 * unanswerable. Here it is a `lastSeen` that stopped moving.
 *
 * Takes snapshots rather than fetching, so the caller owns the latency and can
 * decide whether to spend it. See the header on why that matters.
 */
export function catalogueHistory(snapshots: readonly CdxSnapshot[]): CatalogueEntry[] {
  const byUrl = new Map<string, { first: Date | null; last: Date | null; captures: number }>();

  for (const snap of snapshots) {
    /*
     * Keyed without the scheme, the www prefix or a query string, because the
     * archive holds `http://www.site.com/products/x`,
     * `https://site.com/products/x` and `...?variant=123` as separate rows for
     * what is one product. Counting those separately would invent a catalogue
     * several times larger than the store.
     */
    const key = normaliseProductUrl(snap.original);
    if (!key) continue;

    const entry = byUrl.get(key) ?? { first: null, last: null, captures: 0 };
    entry.captures++;
    if (snap.capturedAt) {
      if (!entry.first || snap.capturedAt < entry.first) entry.first = snap.capturedAt;
      if (!entry.last || snap.capturedAt > entry.last) entry.last = snap.capturedAt;
    }
    byUrl.set(key, entry);
  }

  return [...byUrl]
    .map(([url, e]) => ({ url, firstSeen: e.first, lastSeen: e.last, captures: e.captures }))
    .sort((a, b) => (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0));
}

/*
 * Representations of a product that are not separate products.
 *
 * Measured 2026-08-22 against 4000 real rows: the archive holds
 * `/products/mens-cruiser-medium-grey`, `...grey.json` and `...grey.oembed` as
 * three rows. Treating those as three products inflated a 456 product
 * catalogue and, worse, manufactured deaths: an `.oembed` url crawled once in
 * 2024 and never again looks exactly like a product that launched and was
 * killed the same day.
 */
const REPRESENTATION_SUFFIX = /\.(json|oembed|xml|atom|rss)$/i;

/*
 * The catalogue endpoint itself is not a product. `/products`, `/products.json`
 * and `/products/` are the store's index, and letting them through puts a row
 * called "products.json" at the top of a list of what a brand sells.
 */
const CATALOGUE_INDEX = /\/products$/i;

export function normaliseProductUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.replace(/^www\./, '');
    /* A trailing slash is the same page. */
    let path = parsed.pathname.replace(/\/+$/, '');
    /* `x.oembed.json` needs two passes, and there are real rows like it. */
    let previous = '';
    while (previous !== path) { previous = path; path = path.replace(REPRESENTATION_SUFFIX, ''); }
    if (CATALOGUE_INDEX.test(path)) return '';
    return `${host}${path}`;
  } catch {
    return '';
  }
}

export interface DelistedOptions {
  /* Anything last seen before this is treated as gone. */
  goneBefore: Date;
  /*
   * A product seen exactly once cannot support a claim about its lifespan.
   *
   * The same rule as ad durations, for the same reason: one sighting is a
   * moment, not a span. Measured 2026-08-22, every single "dead product" in the
   * first run of this had firstSeen equal to lastSeen, which is one crawl
   * rather than a life and a death.
   */
  minCaptures?: number;
}

/*
 * Products a store has stopped showing.
 *
 * This is the tombstone nobody else keeps. A delisted product vanishes from a
 * live catalogue with no trace, so the question "what did they launch and then
 * kill" has no other answer.
 *
 * It is evidence of ABSENCE, which is weaker than evidence of presence and is
 * labelled that way: the archive may simply have stopped crawling a page. That
 * is why a minimum capture count exists and why the caller supplies the cutoff
 * rather than inheriting a hidden default.
 */
export function delistedProducts(
  history: readonly CatalogueEntry[],
  options: DelistedOptions,
): CatalogueEntry[] {
  const minCaptures = options.minCaptures ?? 2;
  return history.filter((entry) => {
    if (entry.captures < minCaptures) return false;
    if (!entry.lastSeen || !entry.firstSeen) return false;
    /* Seen more than once but all on the same day is still one moment. */
    if (entry.firstSeen.getTime() === entry.lastSeen.getTime()) return false;
    return entry.lastSeen < options.goneBefore;
  });
}
