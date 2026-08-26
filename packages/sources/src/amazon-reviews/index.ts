/*
 * Amazon product reviews, via the Apify Amazon Reviews Scraper.
 *
 * WHY A VENDOR AND NOT A DIRECT FETCH. Amazon gates most reviews behind
 * sign-in and blocks logged out crawling, and the never-authenticate rule is
 * architectural: the legal footing is logged off public data and a credential
 * forfeits it. Apify is the same paid vendor category as the Meta ads leg,
 * an account we hold, and the credential goes to Apify, never to Amazon.
 * The actor reads the reviews Amazon embeds on the public product page,
 * which is why coverage is roughly 8 to 14 reviews per product per
 * marketplace rather than the full history: the deep pages are behind
 * sign-in and stay unread on purpose.
 *
 * SCOPE, STATED RATHER THAN IMPLIED. The actor takes ASINs or product URLs,
 * so this source can only answer when the run's subject IS an Amazon
 * product: plan() extracts an ASIN from the product URL and plans nothing
 * otherwise. A category sweep cannot discover Amazon products by itself,
 * because discovery would mean scraping Amazon search, which is the exact
 * thing declined above.
 *
 * PRICING, MEASURED AGAINST REAL BILLING 2026-08-26. One live run of one
 * ASIN moved the account's monthly usage from $0.023660 to $0.049678, a
 * delta of $0.026018 for 8 reviews plus the run start: predicted at the
 * vendor's stated $0.01 per run plus $0.002 per review, that is $0.026.
 * Stated price and billed price agree, so the rates are marked verified.
 */

import type { Ctx, Env, PlanInput, Query, Source, SourceRecord, Citation } from '../source.ts';
import { safeFetch } from '../http/safe-fetch.ts';

/*
 * Pinned by name, exactly like the Meta ads actor: a different actor is a
 * different payload shape, and the fixture beside this file is captured from
 * this one (run 2026-08-26, unedited).
 */
const ACTOR = 'automation-lab~amazon-reviews-scraper';
const RUN_SYNC = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items`;

/* The rate keys the cost meter prices this against. Every review charges,
 * and every run charges its start fee. */
export const COST_KEY_REVIEW = 'apify.amazon-review-item';
export const COST_KEY_RUN = 'apify.amazon-review-run';

/* A sync run is capped by Apify at 300s; the capture run of 8 reviews took
 * under 30s on 2026-08-26. */
const DEFAULT_TIMEOUT_MS = 240_000;

/* The actor reads the reviews embedded on the public product page, which
 * Amazon serves 8 to 14 of. Asking for more than a page holds cannot return
 * more, so the default matches the page. */
const DEFAULT_MAX_REVIEWS = 14;

/*
 * One marketplace by default. Each marketplace is a separate billed page
 * read, and the US page alone answers most subjects; a caller who wants
 * more passes them in.
 */
const DEFAULT_MARKETPLACES = ['US'] as const;

/*
 * The ASIN, from the shapes Amazon product URLs actually take: /dp/ASIN,
 * /gp/product/ASIN, /product-reviews/ASIN. Ten characters, digits and
 * uppercase letters. A bare ASIN passed as a whole URL also resolves.
 */
export function extractAsin(productUrl: string): string | null {
  const url = String(productUrl ?? '').trim();
  if (/^[A-Z0-9]{10}$/.test(url)) return url;
  if (!/amazon\./i.test(url)) return null;
  const match = url.match(/\/(?:dp|gp\/product|product-reviews)\/([A-Z0-9]{10})(?:[/?]|$)/i);
  return match ? match[1]!.toUpperCase() : null;
}

interface RawReview {
  reviewId?: unknown;
  author?: unknown;
  rating?: unknown;
  date?: unknown;
  title?: unknown;
  body?: unknown;
  isVerifiedPurchase?: unknown;
  helpfulVotes?: unknown;
  marketplace?: unknown;
  asin?: unknown;
  productName?: unknown;
  reviewUrl?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/*
 * The payload's date is prose: "Reviewed in the United States on August 7,
 * 2024". The date is the part after the last " on ", and zero stays the
 * honest unknown when it does not parse, exactly as the App Store adapter
 * learned the hard way.
 */
export function reviewDate(raw: RawReview): number {
  const prose = str(raw.date);
  const at = prose.lastIndexOf(' on ');
  const candidate = at === -1 ? prose : prose.slice(at + 4);
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : 0;
}

/* Stars one to five, or zero when absent. Zero is not a rating; the score
 * kind table marks this source `stars` so a renderer never prints it as
 * points, and a fabricated zero would read as the worst possible review. */
export function reviewRating(raw: RawReview): number {
  const n = typeof raw.rating === 'number' ? raw.rating : Number(str(raw.rating));
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 0;
}

/* Title and body together, the title usually being the verdict. */
export function reviewText(raw: RawReview): string {
  const title = str(raw.title);
  const body = str(raw.body);
  if (!body) return '';
  const joined = title && !body.startsWith(title) ? `${title}. ${body}` : body;
  return joined.replace(/\s+/g, ' ').trim();
}

export interface AmazonReviewsOptions {
  fetch?: typeof safeFetch;
  timeoutMs?: number;
  maxReviewsPerProduct?: number;
  marketplaces?: readonly string[];
}

export function createAmazonReviewsSource(options: AmazonReviewsOptions = {}): Source {
  const doFetch = options.fetch ?? safeFetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxReviews = options.maxReviewsPerProduct ?? DEFAULT_MAX_REVIEWS;
  const marketplaces = options.marketplaces ?? DEFAULT_MARKETPLACES;

  return {
    id: 'amazon',
    cost: 'metered',
    /* The channel is the product's own name plus marketplace, natural
     * language, so the title vouch rules read it as prose. */
    channelKind: 'title',

    configured(env: Env): boolean {
      return Boolean(env['APIFY_TOKEN']);
    },

    async plan(input: PlanInput): Promise<Query[]> {
      const asin = extractAsin(input.productUrl);
      /* No ASIN means this source has nothing to say, and says so by
       * planning nothing: a degraded leg, never a guess at discovery. */
      if (!asin) return [];
      /* One query per marketplace. Reviews are reviews; question terms do
       * not change which ones exist, so there is no fan out across terms. */
      return marketplaces.map((marketplace) => ({ text: asin, scope: marketplace }));
    },

    async *retrieve(query: Query, ctx: Ctx): AsyncIterable<SourceRecord> {
      /* Trimmed for the same reason every key here is: the third pasted key
       * to arrive with a trailing character died at the header, 2026-08-24. */
      const token = ctx.env['APIFY_TOKEN']?.trim();
      if (!token) return;

      /*
       * ASK BEFORE SPENDING. Priced at the top of the range so a cap is
       * never overshot: the run fee plus every review the page can hold.
       */
      const estimate = 0.01 + maxReviews * 0.002;
      if (!ctx.cost.canSpend(estimate)) {
        ctx.log?.(`amazon: skipped, ${estimate.toFixed(3)} would exceed the spend cap`);
        return;
      }

      const body = JSON.stringify({
        asins: [query.text],
        marketplace: query.scope ?? DEFAULT_MARKETPLACES[0],
        maxReviewsPerProduct: maxReviews,
        sort: 'recent',
        filterByStars: 'all',
      });

      const result = await doFetch(RUN_SYNC, {
        method: 'POST',
        body,
        timeoutMs,
        maxBytes: 8 * 1024 * 1024,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      if (!result.ok) {
        /* Errors are values on the result, never thrown: a vendor being
         * down degrades a run and never fails it. */
        ctx.log?.(`amazon: ${result.error ?? `status ${result.status}`}`);
        return;
      }

      let rows: unknown;
      try {
        rows = JSON.parse(result.body);
      } catch {
        ctx.log?.('amazon: response was not json');
        return;
      }
      if (!Array.isArray(rows)) return;

      /* The run fee is charged once the vendor actually ran, and every
       * review returned charges whether it survives parsing or not, because
       * that is what we were billed for. */
      ctx.cost.charge(COST_KEY_RUN);

      for (const row of rows) {
        if (ctx.signal?.aborted) return;
        const raw = row as RawReview;
        ctx.cost.charge(COST_KEY_REVIEW);

        const externalId = str(raw.reviewId);
        const text = reviewText(raw);
        if (!externalId || !text) continue;

        const marketplace = str(raw.marketplace) || (query.scope ?? 'US');
        const productName = str(raw.productName);
        yield {
          source: 'amazon',
          kind: 'comment',
          externalId,
          /* One channel per product per marketplace, same shape as the App
           * Store adapter, so concentration stays visible. */
          channel: `${productName || str(raw.asin) || query.text} (${marketplace.toLowerCase()})`,
          text,
          score: reviewRating(raw),
          url: str(raw.reviewUrl) || `https://www.amazon.com/review/${externalId}`,
          createdUtc: reviewDate(raw),
          origin: `Amazon ${marketplace}`,
        };
      }
    },

    cite(record: SourceRecord): Citation {
      return {
        label: `Amazon review, ${record.score || '?'} of 5 stars, ${record.channel ?? ''}`,
        url: record.url ?? '',
        score: record.score ?? 0,
        postedAt: record.createdUtc ?? 0,
      };
    },
  };
}
