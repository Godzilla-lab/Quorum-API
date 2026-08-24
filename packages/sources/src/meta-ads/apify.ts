/*
 * Meta ads, via the Apify Ad Library scraper.
 *
 * WHY THIS SOURCE IS WORTH PAYING FOR, WHEN NOTHING ELSE HERE IS.
 *
 * Meta does not archive inactive commercial ads. Outside the EEA and the UK,
 * `ad_type=ALL` returns nothing at all, and once a commercial ad stops running
 * it is gone from the API. So every observation written here becomes a record
 * that cannot be reconstructed later at any price, because the source destroys
 * it. That is the one thing in this project a funded competitor cannot buy past.
 *
 * ON THE CREDENTIAL. This is the single place the engine sends one, and it does
 * not breach the no-auth rule. That rule is about SCRAPED sources: never
 * authenticate to a site whose public pages we are reading, because the legal
 * footing is logged off public data and a session cookie forfeits it. Apify is
 * a paid vendor API we hold an account with, which is a different category.
 * We authenticate to Apify. We never authenticate to Meta.
 *
 * THREE CALIBRATIONS, ALL RE-MEASURED AGAINST A LIVE 30 AD PULL ON 2026-08-22.
 */

import type { AdQuery, AdRecord, AdSource } from '../ad-source.ts';
import type { Ctx, Env, PlanInput } from '../source.ts';
import { safeFetch } from '../http/safe-fetch.ts';
import { creativeType, type RawAd } from './creative.ts';
import { scoreText, subjectTerms } from '../relevance.ts';

/*
 * 17.6 million runs at the time of writing, which is why this actor and not one
 * of the five near identical alternatives. Pinned by name: a different actor is
 * a different payload shape, and the fixture beside this file is captured from
 * this one.
 */
const ACTOR = 'curious_coder~facebook-ads-library-scraper';
const RUN_SYNC = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items`;

/* The rate key the cost meter prices this against. Every ad charges. */
export const COST_KEY = 'apify.fb-ads-item';

/*
 * A sync run is capped by Apify at 300s. The capture of 30 ads took 23s on
 * 2026-08-22, so this leaves generous headroom without letting a stuck run hold
 * a report open.
 */
const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_LIMIT = 30;

/*
 * CALIBRATION 1. KEYWORD SEARCH CANNOT SCOPE A COMPETITOR SET, AT ANY THRESHOLD.
 *
 * Measured on a live "running shoes" pull of 30 ads, 2026-08-22:
 *
 *   phrase mode        4 of 30   loses Clarks Shoes, VIVAIA and Tip Top Shoes,
 *                                which are real competitors whose ad copy simply
 *                                does not contain the phrase
 *   terms, minHits 1  21 of 30   keeps "Cholesterol Relief Community"
 *   terms, minHits 2  12 of 30   STILL keeps "Cholesterol Relief Community" and
 *                                "Arthritis Support Community", because long
 *                                body copy about joint pain mentions running and
 *                                shoes in passing
 *   terms, minHits 3   0 of 30   the subject only has two distinct terms, so
 *                                this can never pass
 *
 * There is no threshold that keeps Clarks and drops a cholesterol supplement,
 * because the discriminating information is not in the text. The real fix is
 * the same shape the Reddit adapter already uses: discover the containers
 * first, gate THOSE, then harvest. For Reddit a container is a subreddit; here
 * it is an advertiser page. `AdQuery.scope` carries a page, and a scoped query
 * skips this gate entirely because the scoping already happened.
 *
 * Until a competitor set is supplied, the gate below is a BACKSTOP and is
 * documented as imprecise rather than presented as sufficient.
 */
const MIN_SUBJECT_HITS = 2;

interface RawSnapshot {
  body?: { text?: unknown } | null;
  cta_text?: unknown;
  title?: unknown;
  link_url?: unknown;
  link_description?: unknown;
  caption?: unknown;
  display_format?: unknown;
}

interface RawApifyAd extends RawAd {
  ad_archive_id?: unknown;
  page_name?: unknown;
  page_id?: unknown;
  ad_library_url?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  is_active?: unknown;
  publisher_platform?: unknown;
  snapshot?: RawSnapshot & RawAd['snapshot'];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const SECONDS_PER_DAY = 86_400;

/* Everything a reader could match the subject against, in one string. */
export function adHaystack(raw: RawApifyAd): string {
  const snap = raw.snapshot ?? {};
  return [
    str(snap.title),
    str(snap.body?.text),
    str(raw.page_name),
    str(snap.link_description),
    str(snap.caption),
  ].filter(Boolean).join(' ');
}

/*
 * CALIBRATION 2. AN END DATE ONLY COUNTS ONCE THE AD HAS ACTUALLY STOPPED.
 *
 * First measured 2026-08-13, replicated exactly on 2026-08-22: of 30 ads, 19
 * were `is_active: true` and ALL 19 reported `end_date` equal to the day of the
 * pull. The other 11 were inactive and carried real end dates. The correlation
 * was perfect, 19/11.
 *
 * So a live ad reports the READ TIMESTAMP as its end date. Treating that as an
 * end date would compute a duration from a start plus a date nobody set, and
 * then label it `reported`, which claims the advertiser stated a duration they
 * never stated. That is the difference between evidence and a number.
 *
 * Note also that `total_active_time` was absent on 30 of 30, so there is no
 * reported duration field in this payload at all. `reported` is therefore only
 * reachable through a real start plus a real end.
 */
export function normaliseAd(raw: RawApifyAd, observedAt: number): AdRecord | null {
  const adId = str(raw.ad_archive_id);
  if (!adId) return null;

  const isActive = raw.is_active === true;
  const startDate = num(raw.start_date);
  const rawEnd = num(raw.end_date);
  /* The calibration, in one line. */
  const endDate = !isActive && rawEnd !== null ? rawEnd : null;

  let daysRunning: number | null = null;
  let durationConfidence: AdRecord['durationConfidence'] = 'none';
  if (startDate !== null && endDate !== null) {
    daysRunning = Math.max(0, Math.floor((endDate - startDate) / SECONDS_PER_DAY));
    durationConfidence = 'reported';
  } else if (startDate !== null) {
    /*
     * Honest but perishable: arithmetic against the moment we looked, not a
     * stored fact. `deriveDuration` in core recomputes this across the whole
     * observation history, which is what makes a span defensible later.
     */
    daysRunning = Math.max(0, Math.floor((observedAt - startDate) / SECONDS_PER_DAY));
    durationConfidence = 'observed';
  }

  const platforms = Array.isArray(raw.publisher_platform)
    ? raw.publisher_platform.filter((p): p is string => typeof p === 'string').map((p) => p.toLowerCase())
    : [];

  return {
    adId,
    advertiser: str(raw.page_name) || 'unknown',
    body: str(raw.snapshot?.body?.text),
    ...(str(raw.snapshot?.cta_text) ? { cta: str(raw.snapshot?.cta_text) } : {}),
    url: str(raw.ad_library_url) || `https://www.facebook.com/ads/library/?id=${adId}`,
    /* Reads the media arrays, never `display_format`. See creative.ts. */
    creative: creativeType(raw),
    platforms,
    startDate,
    endDate,
    isActive,
    daysRunning,
    durationConfidence,
  };
}

export interface MetaAdsApifyOptions {
  fetch?: typeof safeFetch;
  timeoutMs?: number;
  limit?: number;
  /* Injected in tests. Unix seconds. */
  now?: () => number;
}

export function createMetaAdsApifySource(options: MetaAdsApifyOptions = {}): AdSource {
  const doFetch = options.fetch ?? safeFetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  /* Captured at plan time, applied at retrieve time, exactly as Hacker News does. */
  let subject: string[] = [];

  return {
    id: 'meta-ads-apify',
    cost: 'metered',

    configured(env: Env): boolean {
      return Boolean(env['APIFY_TOKEN']);
    },

    async plan(input: PlanInput): Promise<AdQuery[]> {
      subject = subjectTerms([input.category, input.productTitle]);
      /*
       * One query. An ads pull is the most expensive thing in a run, so this
       * deliberately does not fan out across question terms the way a voice of
       * customer source does: the ads for a category are the ads for a
       * category, and asking about sizing does not change which ones ran.
       */
      return [{ text: input.category, limit }];
    },

    async *retrieve(query: AdQuery, ctx: Ctx): AsyncIterable<AdRecord> {
      /*
       * Trimmed because a pasted key carries a newline. The third key to fail
       * this exact way: OPENROUTER_API_KEY died at the authorization header on
       * 2026-08-24 and got its trim, and the hosted ads leg then failed
       * identically the same day with "Invalid character in header content"
       * from a trailing character on Render's APIFY_TOKEN.
       */
      const token = ctx.env['APIFY_TOKEN']?.trim();
      if (!token) return;

      const wanted = query.limit ?? limit;

      /*
       * ASK BEFORE SPENDING. The meter cannot prevent a call it does not make,
       * so a caller about to spend must check first. Priced at the top of the
       * range so a cap is never overshot by an underestimate.
       */
      const estimate = wanted * 0.006;
      if (!ctx.cost.canSpend(estimate)) {
        ctx.log?.(`meta-ads-apify: skipped, ${estimate.toFixed(2)} would exceed the spend cap`);
        return;
      }

      const searchUrl = query.scope
        ? `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=${(query.countries?.[0] ?? 'US')}&view_all_page_id=${encodeURIComponent(query.scope)}`
        : `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=${(query.countries?.[0] ?? 'US')}&q=${encodeURIComponent(query.text)}&search_type=keyword_unordered&media_type=all`;

      const body = JSON.stringify({
        urls: [{ url: searchUrl }],
        scrapeAdDetails: true,
        count: wanted,
        'scrapePageAds.activeStatus': 'all',
      });

      const result = await doFetch(RUN_SYNC, {
        method: 'POST',
        body,
        timeoutMs,
        /*
         * A run of 30 ads came back at 1.05MB on 2026-08-22, so the default
         * body cap is far too small here. Sized at roughly 4x that.
         */
        maxBytes: 32 * 1024 * 1024,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      if (!result.ok) {
        /*
         * Errors are values on the result, never thrown. A vendor being down
         * degrades a run and never fails it, and a report missing its ads leg
         * is still a good report.
         */
        ctx.log?.(`meta-ads-apify: ${result.error ?? `status ${result.status}`}`);
        return;
      }

      let rows: unknown;
      try {
        rows = JSON.parse(result.body);
      } catch {
        ctx.log?.('meta-ads-apify: response was not json');
        return;
      }
      if (!Array.isArray(rows)) return;

      const observedAt = now();
      for (const row of rows) {
        if (ctx.signal?.aborted) return;
        const raw = row as RawApifyAd;

        /*
         * Charged for every ad the vendor returned, on topic or not, because
         * that is what we were billed for. Charging only the survivors would
         * under report the true cost of a run and make the meter a comforting
         * fiction.
         */
        ctx.cost.charge(COST_KEY);

        /* A scoped query already narrowed to one advertiser, so the backstop
         * gate would only throw away ads we deliberately asked for. */
        if (!query.scope && subject.length) {
          if (scoreText(adHaystack(raw), subject).hits < MIN_SUBJECT_HITS) continue;
        }

        const record = normaliseAd(raw, observedAt);
        if (record) yield record;
      }
    },

    cite(record: AdRecord) {
      return {
        label: `${record.advertiser} on Meta`,
        url: record.url ?? `https://www.facebook.com/ads/library/?id=${record.adId}`,
      };
    },
  };
}
