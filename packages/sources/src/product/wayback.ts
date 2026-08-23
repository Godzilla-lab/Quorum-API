/*
 * The Wayback Machine as a free unblocker.
 *
 * MEASURED 2026-08-22. Four large stores refused a direct server side fetch
 * (403, connection refused, 404, timeout). Two of the three retried through the
 * archive came back with a full page carrying schema.org Product markup:
 *
 *   allbirds.com   snapshot 2026-06-05, 1063KB, Product markup present
 *   gymshark.com   snapshot 2019-10-14,  305KB, Product markup present
 *   rei.com        no snapshot
 *
 * So an archive lookup recovers a meaningful share of the pages a live fetch
 * cannot reach, for free, with no account and no vendor. It belongs in the
 * ladder before anything paid.
 *
 * THE CATCH, AND IT IS NOT OPTIONAL. Look at those dates. A 2019 snapshot has a
 * 2019 price and a 2019 stock status. Identity facts are stable across years:
 * a product's name, category and description barely move. COMMERCIAL facts are
 * not: price and availability are wrong the moment the page is re-published.
 *
 * So this tier returns identity and deliberately withholds commercial facts,
 * carrying the snapshot date so a caller can say where the information came
 * from. Showing a 2019 price as today's price is the same class of mistake as
 * showing an inferred ad duration as a reported one.
 */

import { parseJsonObject } from '../http/parse-json.ts';
import { safeFetch } from '../http/safe-fetch.ts';

const AVAILABILITY_API = 'https://archive.org/wayback/available';

export interface WaybackSnapshot {
  url: string;
  /* YYYYMMDDHHMMSS, as the archive reports it. */
  timestamp: string;
  /* Parsed to a date so a caller can reason about staleness. */
  capturedAt: Date | null;
  ageDays: number | null;
}

interface AvailabilityResponse {
  archived_snapshots?: {
    closest?: { available?: boolean; url?: string; timestamp?: string; status?: string };
  };
}

/* The archive reports timestamps as YYYYMMDDHHMMSS in UTC. */
export function parseWaybackTimestamp(ts: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/.exec(ts);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface WaybackOptions {
  fetch?: typeof safeFetch;
  timeoutMs?: number;
  /* Unix milliseconds. Injected in tests so age is deterministic. */
  now?: () => number;
}

export async function findSnapshot(url: string, options: WaybackOptions = {}): Promise<WaybackSnapshot | null> {
  const fetchImpl = options.fetch ?? safeFetch;
  const now = options.now ?? (() => Date.now());
  const fetchOptions = options.timeoutMs ? { timeoutMs: options.timeoutMs } : {};

  const res = await fetchImpl(`${AVAILABILITY_API}?url=${encodeURIComponent(url)}`, fetchOptions);
  if (!res.ok) return null;

  let body: AvailabilityResponse;
  try {
    const parsed = parseJsonObject<AvailabilityResponse>(res.body);
    if (!parsed) return null;
    body = parsed;
  } catch {
    return null;
  }

  const closest = body.archived_snapshots?.closest;
  if (!closest?.available || !closest.url) return null;

  const timestamp = closest.timestamp ?? '';
  const capturedAt = parseWaybackTimestamp(timestamp);

  return {
    /*
     * Forced to https. The archive answers on both, and a mixed scheme redirect
     * costs a hop through the guard for nothing.
     */
    url: closest.url.replace(/^http:/, 'https:'),
    timestamp,
    capturedAt,
    ageDays: capturedAt ? (now() - capturedAt.getTime()) / 86_400_000 : null,
  };
}

export interface ArchivedPage {
  html: string;
  snapshot: WaybackSnapshot;
}

export async function fetchArchived(url: string, options: WaybackOptions = {}): Promise<ArchivedPage | null> {
  const snapshot = await findSnapshot(url, options);
  if (!snapshot) return null;

  const fetchImpl = options.fetch ?? safeFetch;
  const fetchOptions = options.timeoutMs ? { timeoutMs: options.timeoutMs } : {};

  const page = await fetchImpl(snapshot.url, fetchOptions);
  if (!page.ok || !page.body) return null;

  return { html: page.body, snapshot };
}

/*
 * How old is too old for a commercial fact.
 *
 * Ninety days is generous for a price and still catches the 2019 snapshots that
 * make this necessary. Identity facts are not subject to it: a product's name
 * does not go stale.
 */
export const COMMERCIAL_FACT_MAX_AGE_DAYS = 90;

export function commercialFactsUsable(snapshot: WaybackSnapshot): boolean {
  return snapshot.ageDays !== null && snapshot.ageDays <= COMMERCIAL_FACT_MAX_AGE_DAYS;
}
