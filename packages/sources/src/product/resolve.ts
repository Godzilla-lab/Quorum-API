/*
 * Product URL to research subject.
 *
 * This closes the loop the whole product is named after. Everything downstream
 * needs a category and a title; a user has a link. Without this, someone has to
 * hand the pipeline a category, which is both a worse experience and a worse
 * report, because a hand written category is a guess and a resolved one is
 * evidence.
 *
 * Three strategies, cheapest and most reliable first:
 *
 *   1. SHOPIFY. Appending .json to a product URL returns the product as JSON,
 *      with variants and prices, unauthenticated. Roughly a third of the DTC
 *      web is Shopify, so this one endpoint covers a lot of ground exactly.
 *   2. JSON-LD. Schema.org Product markup, which search engines reward, so most
 *      other stores carry it whatever platform they run.
 *   3. TITLE TAG. A weak signal, and labelled as one. Still better than
 *      refusing to research a product because its store skipped schema.org.
 *
 * Everything is fetched logged off through the guarded client. No credentials,
 * ever, and no direct fetch: the URL comes from a user, so an unguarded request
 * is an SSRF hole.
 */

import { safeFetch } from '../http/safe-fetch.ts';
import { extractProductFacts, extractTitleFallback, type ProductFactsExtract } from './jsonld.ts';
import { commercialFactsUsable, fetchArchived, type WaybackSnapshot } from './wayback.ts';
import { normaliseImages } from './images.ts';

export type ResolveStrategy = 'shopify' | 'json-ld' | 'title' | 'wayback' | 'unblocker' | 'none';

/*
 * One rung of the ladder, recorded whether it worked or not.
 *
 * Borrowed from the engine, where the comment is blunt about why: the trail is
 * what proves the ladder works. Without it, a resolution that quietly fell
 * through to the weakest tier is indistinguishable from one that succeeded on
 * the first, and the difference is the whole quality of the report.
 */
export interface TrailStep {
  tier: ResolveStrategy | 'direct';
  ok: boolean;
  /* Why it did not work, in words worth showing a caller. */
  note?: string | undefined;
}

/*
 * A pluggable unblocker for pages that refuse a direct fetch.
 *
 * Deliberately an interface with no implementation in this repo. Paid
 * unblockers are account specific and some carry resale questions, so a self
 * hoster plugs in whatever they already have rather than inheriting ours. The
 * free rungs of the ladder run first and cover most of what an unblocker would
 * be asked to do.
 */
export interface Unblocker {
  readonly id: string;
  /* Returns page html, or null when it could not read the page either. */
  fetchPage(url: string): Promise<string | null>;
}

export interface ResolvedProduct {
  url: string;
  title: string;
  /* What the market would call this. Drives every downstream query. */
  category: string;
  /* How we got here, so a caller can weigh it. `title` is a guess. */
  strategy: ResolveStrategy;
  /* True when the category was inferred rather than stated by the page. */
  categoryInferred: boolean;
  brand?: string | undefined;
  price?: number | undefined;
  currency?: string | undefined;
  description?: string | undefined;
  ratingValue?: number | undefined;
  ratingCount?: number | undefined;
  /*
   * Product images, absolute and pointing at the ORIGINAL cdn even when the
   * markup came from an archived copy. Image cdns do not run the bot defences
   * a storefront does, so these usually load when the page itself would not.
   */
  images: string[];
  /* Review text found in page markup. Voice of customer at zero extra cost. */
  reviews: { text: string; rating?: number | undefined; author?: string | undefined }[];
  /* Which rungs ran, in order. Proof of how hard this was to resolve. */
  trail: TrailStep[];
  /*
   * Set when facts came from an archived copy. Identity facts are fine at any
   * age; commercial facts are not, and `commercialFactsStale` says which.
   */
  archivedAt?: Date | null | undefined;
  commercialFactsStale?: boolean | undefined;
  error?: string;
}

interface ShopifyProductResponse {
  product?: {
    title?: string;
    body_html?: string;
    vendor?: string;
    product_type?: string;
    tags?: string[] | string;
    variants?: { price?: string; available?: boolean }[];
    images?: { src?: string }[];
  };
}

const stripHtml = (html: string): string =>
  html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/*
 * Title tags are full of encoded entities: a real page gave us
 * "Allbirds Men&#39;s Shoes". Left alone that reaches a prompt and then a
 * reader, and looks like a bug in our product rather than in theirs.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/*
 * What would a buyer call this category.
 *
 * Prefers what the page states over anything we derive. A stated product_type
 * of "Running Shoes" is the market's own word for it; a category guessed from a
 * title is our word for it, and the difference matters because the category
 * drives every query afterwards.
 */
export function inferCategory(facts: {
  category?: string | undefined;
  productType?: string | undefined;
  tags?: string[] | undefined;
  title?: string | undefined;
}): { category: string; inferred: boolean } {
  const stated = facts.productType?.trim() || facts.category?.trim();
  if (stated) return { category: stated.toLowerCase(), inferred: false };

  const tag = facts.tags?.find((t) => t.trim().length > 2);
  if (tag) return { category: tag.trim().toLowerCase(), inferred: true };

  /*
   * Last resort: the tail of the title, which is usually the noun.
   * "Allbirds Men's Wool Runners" gives "wool runners". Crude, and flagged as
   * inferred so a caller can decide whether to trust it.
   */
  const title = facts.title?.trim() ?? '';
  if (!title) return { category: '', inferred: true };
  const words = title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  return { category: words.slice(-2).join(' '), inferred: true };
}

export interface ResolveOptions {
  fetch?: typeof safeFetch;
  timeoutMs?: number;
  /* Optional paid rung, tried only after every free one has failed. */
  unblocker?: Unblocker;
  /* Set false to skip the archive lookup, which costs one extra request. */
  useWayback?: boolean;
  now?: () => number;
}

export async function resolveProduct(rawUrl: string, options: ResolveOptions = {}): Promise<ResolvedProduct> {
  const fetchImpl = options.fetch ?? safeFetch;
  const fetchOptions = options.timeoutMs ? { timeoutMs: options.timeoutMs } : {};

  const trail: TrailStep[] = [];
  const empty = (error: string): ResolvedProduct => ({
    url: rawUrl, title: '', category: '', strategy: 'none',
    categoryInferred: true, images: [], reviews: [], trail, error,
  });

  /* Shared by the direct, archived and unblocked rungs: same markup, same parse. */
  const fromHtml = (
    html: string,
    strategy: ResolveStrategy,
    snapshot?: WaybackSnapshot,
  ): ResolvedProduct | null => {
    const structured: ProductFactsExtract | null = extractProductFacts(html);
    if (!structured?.title) return null;

    const { category, inferred } = inferCategory({ category: structured.category, title: structured.title });
    /*
     * A price from an archived page is a price from whenever that page was
     * captured, and the measured snapshots run to six years old. Identity
     * facts survive that; commercial facts do not, so they are withheld
     * rather than shown with a caveat nobody reads.
     */
    const stale = snapshot ? !commercialFactsUsable(snapshot) : false;

    return {
      url: rawUrl,
      title: structured.title,
      category,
      categoryInferred: inferred,
      strategy,
      brand: structured.brand,
      price: stale ? undefined : structured.price,
      currency: stale ? undefined : structured.currency,
      description: structured.description,
      ratingValue: stale ? undefined : structured.ratingValue,
      ratingCount: stale ? undefined : structured.ratingCount,
      /*
       * Images are NOT withheld on a stale snapshot. A six year old photo of a
       * black t shirt is still a photo of that t shirt, unlike its price.
       */
      images: normaliseImages(structured.images, rawUrl),
      reviews: structured.reviews,
      trail,
      archivedAt: snapshot?.capturedAt,
      commercialFactsStale: snapshot ? stale : undefined,
    };
  };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return empty('not a valid url');
  }

  /* 1. Shopify. Exact, cheap, and covers a large share of the DTC web. */
  if (/\/products\/[^/]+$/.test(url.pathname)) {
    const jsonUrl = `${url.origin}${url.pathname}.json`;
    const res = await fetchImpl(jsonUrl, fetchOptions);
    trail.push({ tier: 'shopify', ok: res.ok, note: res.ok ? undefined : res.error ?? `status ${res.status}` });
    if (res.ok) {
      try {
        const body = JSON.parse(res.body) as ShopifyProductResponse;
        const p = body.product;
        if (p?.title) {
          const tags = Array.isArray(p.tags) ? p.tags : typeof p.tags === 'string' ? p.tags.split(',') : undefined;
          const { category, inferred } = inferCategory({
            productType: p.product_type, tags, title: p.title,
          });
          const priceRaw = p.variants?.[0]?.price;
          return {
            url: rawUrl,
            title: p.title,
            category,
            categoryInferred: inferred,
            strategy: 'shopify',
            brand: p.vendor,
            price: priceRaw ? Number(priceRaw) : undefined,
            description: p.body_html ? stripHtml(p.body_html).slice(0, 2000) : undefined,
            images: normaliseImages(p.images?.map((i) => i.src ?? '') ?? [], rawUrl),
            reviews: [],
            trail,
          };
        }
      } catch {
        /* Not a Shopify store, or it answered with something else. Fall through. */
      }
    }
  }

  /* 2. The page itself. */
  const page = await fetchImpl(url.toString(), fetchOptions);
  trail.push({ tier: 'direct', ok: page.ok, note: page.ok ? undefined : page.error ?? `status ${page.status}` });

  /*
   * Structured data from the live page is the best outcome, so it returns
   * immediately.
   */
  if (page.ok) {
    const direct = fromHtml(page.body, 'json-ld');
    if (direct) return direct;
  }

  /*
   * A TITLE TAG RESULT IS HELD BACK RATHER THAN RETURNED.
   *
   * MEASURED 2026-08-22, and this was a real regression. Once we started
   * identifying ourselves, a store stopped returning 403 and started
   * redirecting us to its category LISTING page. The fetch then "succeeded",
   * the title tag read "Shop Sustainable Footwear for Men", and the ladder
   * stopped there, discarding the archived copy that had the actual product
   * with its brand, price, rating and photograph.
   *
   * A successful fetch of the wrong page is worse than a failed one, because
   * success is what halts a ladder. So rungs are ordered by RESULT QUALITY, not
   * by whether the request worked: a title tag is the weakest possible outcome
   * and must never preempt an attempt that could return real markup.
   */
  let weakFallback: ResolvedProduct | null = null;
  if (page.ok) {
    const fallback = extractTitleFallback(page.body);
    if (fallback.title) {
      const title = decodeEntities(fallback.title);
      const { category } = inferCategory({ title });
      weakFallback = {
        url: rawUrl,
        title,
        category,
        /* Always inferred. A title tag is marketing copy, not a category. */
        categoryInferred: true,
        strategy: 'title',
        description: fallback.description ? decodeEntities(fallback.description) : undefined,
        images: [],
        reviews: [],
        trail,
      };
    }
  }

  /*
   * 3. The archive. Free, no account, and measured to recover two of three
   * pages that refused a direct fetch. Runs before anything paid, always.
   */
  if (options.useWayback !== false) {
    const archived = await fetchArchived(url.toString(), {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    trail.push({
      tier: 'wayback',
      ok: Boolean(archived),
      note: archived ? `snapshot ${archived.snapshot.timestamp}` : 'no snapshot',
    });
    if (archived) {
      const fromArchive = fromHtml(archived.html, 'wayback', archived.snapshot);
      if (fromArchive) return fromArchive;
    }
  }

  /* 4. A paid unblocker, if the caller brought one. Nothing ships here. */
  if (options.unblocker) {
    let html: string | null = null;
    try {
      html = await options.unblocker.fetchPage(url.toString());
    } catch (err) {
      html = null;
      trail.push({ tier: 'unblocker', ok: false, note: err instanceof Error ? err.message : 'failed' });
    }
    if (html) {
      trail.push({ tier: 'unblocker', ok: true, note: options.unblocker.id });
      const unblocked = fromHtml(html, 'unblocker');
      if (unblocked) return unblocked;
    }
  }

  /* Every stronger rung failed, so the weak one is now the best we have. */
  if (weakFallback) {
    trail.push({ tier: 'title', ok: true, note: 'no structured data anywhere, title tag only' });
    return weakFallback;
  }

  return empty(page.ok ? 'no product information found on the page' : page.error ?? `page returned ${page.status}`);
}
