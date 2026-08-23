/*
 * What are we researching.
 *
 * The input is a SUBJECT, not a URL. Plain text works, a URL works, and a URL
 * that cannot be fetched still works.
 *
 * WHY, measured 2026-08-22. Four real product pages were probed with the
 * guarded client:
 *
 *   allbirds.com    403        bot blocked
 *   gymshark.com    ECONNREFUSED
 *   patagonia.com   404        the url shape had changed
 *   rei.com         timeout
 *
 * Four for four. Large stores actively refuse server side fetches, so a
 * pipeline that REQUIRES a resolvable product URL fails on exactly the brands
 * anyone would want to research. Resolution is therefore an enrichment, never a
 * gate: it makes a report better when it works and is skipped when it does not.
 *
 * A blocked URL is still informative. The slug and the host are right there in
 * the string, cost nothing, and cannot be blocked.
 */

import { resolveProduct, type ResolvedProduct } from './resolve.ts';
import { findProductByName } from './catalogue.ts';
import type { safeFetch } from '../http/safe-fetch.ts';

export interface Subject {
  /* What a buyer would call this. Drives every downstream query. */
  category: string;
  /* The specific thing, when there is one. Falls back to the category. */
  title: string;
  /*
   * Where the subject came from, so a caller can weigh it.
   *
   *   text          plain words, and nothing was found to attach to them
   *   catalogue     a name matched a real product in a public store catalogue
   *   page          a url was supplied and read
   *   url-fallback  a url was supplied and refused, so the slug was used
   */
  source: 'text' | 'catalogue' | 'page' | 'url-fallback';
  url?: string | undefined;
  brand?: string | undefined;
  price?: number | undefined;
  /*
   * The currency the price was quoted in, when the page said. Carried because a
   * bare number reads as dollars to a reader wherever it came from, and a price
   * we cannot name the currency of has to say so rather than imply one.
   */
  currency?: string | undefined;
  description?: string | undefined;
  ratingValue?: number | undefined;
  ratingCount?: number | undefined;
  /* Product images, absolute and pointing at the original cdn. */
  images: string[];
  reviews: { text: string; rating?: number | undefined; author?: string | undefined }[];
  /* Present when a URL was supplied and could not be read. Not an error. */
  note?: string;
}

/*
 * Exported because a caller has to know whether a subject is fetchable before
 * deciding whether a cached copy is worth consulting. Plain text costs nothing
 * to resolve, so caching it would be a lookup to avoid no work at all.
 */
export const looksLikeUrl = (input: string): boolean =>
  /^https?:\/\//i.test(input.trim()) || /^[a-z0-9-]+\.[a-z]{2,}\//i.test(input.trim());

/*
 * Words that appear in URL slugs and say nothing about the product.
 * "mens-wool-runners-black-size-10" is about wool runners.
 */
const SLUG_NOISE = new Set([
  'products', 'product', 'shop', 'store', 'collections', 'collection', 'item', 'items',
  'buy', 'p', 'dp', 'ref', 'html', 'htm', 'php', 'index', 'default',
  'black', 'white', 'grey', 'gray', 'blue', 'red', 'green', 'navy', 'beige',
  'small', 'medium', 'large', 'size', 'mens', 'womens', 'unisex', 'new', 'sale',
]);

/*
 * Recover a subject from the URL string alone.
 *
 * No network, so it cannot be blocked, rate limited or timed out. The slug is
 * usually the product name with hyphens, which is exactly what we need.
 */
export function subjectFromUrlString(rawUrl: string): { title: string; brand?: string | undefined } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
  } catch {
    return { title: '' };
  }

  /* The brand is usually the registrable part of the host. */
  const hostParts = parsed.hostname.replace(/^www\./, '').split('.');
  const brand = hostParts[0];

  const segments = parsed.pathname.split('/').filter(Boolean);
  /* The last meaningful segment is the product; earlier ones are shop routing. */
  const slug = [...segments].reverse().find((s) => !SLUG_NOISE.has(s.toLowerCase())) ?? '';

  const words = slug
    .replace(/\.(html?|php|aspx?)$/i, '')
    .split(/[-_+]/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 1 && !SLUG_NOISE.has(w) && !/^\d+$/.test(w));

  return { title: words.join(' '), brand };
}

export interface ResolveSubjectOptions {
  fetch?: typeof safeFetch;
  timeoutMs?: number;
  /* Skip the network entirely. Useful when a caller already knows it is blocked. */
  offline?: boolean;
}

export async function resolveSubject(input: string, options: ResolveSubjectOptions = {}): Promise<Subject> {
  const trimmed = input.trim();

  /*
   * Plain text. The subject already works for every voice source, which can
   * search for "wool runner" without knowing where it is sold, but it used to
   * come back with no price, no images and no brand, so a name produced half a
   * report and did not explain the missing half.
   *
   * A public store catalogue closes that with no key and no search API. It
   * misses often, and a miss is a normal outcome rather than an error: the
   * plain text subject is still perfectly usable and the run continues.
   */
  if (!looksLikeUrl(trimmed)) {
    const plain: Subject = {
      category: trimmed.toLowerCase(), title: trimmed, source: 'text', images: [], reviews: [],
    };
    if (options.offline) return plain;

    const found = await findProductByName(trimmed, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (!found.match) {
      const tried = found.trail.map((t) => t.domain).join(', ');
      return {
        ...plain,
        note: tried
          ? `no public catalogue found for this name, tried ${tried}`
          : 'no public catalogue found for this name',
      };
    }

    const m = found.match;
    return {
      /*
       * The typed NAME stays the category, not the store's title. A buyer
       * searching for "wool runner" does not say "Women's Wool Runner - True
       * Black (Cream Sole)", and every downstream query is written in the words
       * a market would use.
       */
      category: trimmed.toLowerCase(),
      title: m.title,
      source: 'catalogue',
      url: m.url,
      brand: m.vendor ?? undefined,
      price: m.price ?? undefined,
      images: m.images,
      reviews: [],
    };
  }

  const fallback = subjectFromUrlString(trimmed);

  const fromUrl = (note: string): Subject => ({
    /*
     * With no page to read, the slug is the best category available and the
     * title and category are the same thing. Honest rather than clever.
     */
    category: fallback.title,
    title: fallback.title,
    source: 'url-fallback',
    url: trimmed,
    brand: fallback.brand,
    images: [],
    reviews: [],
    note,
  });

  if (options.offline) return fromUrl('page not fetched');

  let resolved: ResolvedProduct;
  try {
    resolved = await resolveProduct(trimmed, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
  } catch (err) {
    return fromUrl(`page could not be read: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  /*
   * A store that refuses us is the common case, not the exception, so it
   * degrades rather than failing. The note travels with the subject so a report
   * can say the page could not be read instead of pretending it had no title.
   */
  if (resolved.error || !resolved.title) {
    return fromUrl(`page could not be read: ${resolved.error ?? 'no product information'}`);
  }

  return {
    category: resolved.category || fallback.title,
    title: resolved.title,
    source: 'page',
    url: trimmed,
    brand: resolved.brand ?? fallback.brand,
    price: resolved.price,
    currency: resolved.currency,
    description: resolved.description,
    ratingValue: resolved.ratingValue,
    ratingCount: resolved.ratingCount,
    images: resolved.images,
    reviews: resolved.reviews,
  };
}
