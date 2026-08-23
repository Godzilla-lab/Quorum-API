/*
 * Public store catalogues, and finding a product by NAME.
 *
 * THE INPUT IS NOT A URL, AND THIS IS THE FILE THAT MAKES THAT TRUE FOR
 * COMMERCIAL FACTS.
 *
 * Plain text already worked for the voice sources: you can search Reddit for
 * "wool runner" without knowing where it is sold. But a text subject came back
 * with no price, no images and no brand, because those live on a product page
 * and nothing knew which page. So "receipts wool runner" produced half a
 * report and did not say why.
 *
 * A Shopify store publishes its entire catalogue at `/products.json`, with no
 * key, no account and no login. Measured 2026-08-22: allbirds.com returned 250
 * products and 1.6MB, and a search for "wool runner" matched 28 of them with
 * live prices. That is a product NAME resolving to a real product, for free.
 *
 * Two limits, stated rather than discovered later:
 *
 *   NOT EVERY STORE IS SHOPIFY. A miss is a normal outcome, not an error, and
 *   the run continues with whatever the voice sources found.
 *
 *   NOT EVERY SHOPIFY STORE ANSWERS. Measured the same day: allbirds.com
 *   returned 200 and gymshark.com returned 403 behind Cloudflare. Roughly half
 *   the stores worth researching refuse a plain server side fetch.
 */

import { safeFetch } from '../http/safe-fetch.ts';

/*
 * Shopify caps this at 250 and ignores anything larger. Asking for more is not
 * an error, it just silently gives you 250, which is the kind of quiet
 * truncation worth naming rather than discovering.
 */
const MAX_PER_PAGE = 250;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface CatalogueProduct {
  title: string;
  handle: string;
  url: string;
  vendor: string | null;
  productType: string | null;
  /* Lowest variant price. Strings in the payload, so parsed once here. */
  price: number | null;
  compareAtPrice: number | null;
  images: string[];
  variants: number;
  /* True when any variant can be bought. A product with none is on the way out. */
  available: boolean;
  /* When the store first published it. The launch date, free. */
  publishedAt: Date | null;
}

export interface CatalogueResult {
  ok: boolean;
  domain: string;
  products: CatalogueProduct[];
  /* True when the page cap was reached, so a caller never reads a bounded
   * catalogue as a complete one. */
  truncated: boolean;
  error?: string;
}

interface RawVariant { price?: unknown; compare_at_price?: unknown; available?: unknown }
interface RawProduct {
  title?: unknown; handle?: unknown; vendor?: unknown; product_type?: unknown;
  published_at?: unknown; variants?: unknown; images?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const money = (v: unknown): number | null => {
  /* Shopify sends prices as strings: "160.00". */
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

export function parseCatalogue(body: string, domain: string): CatalogueProduct[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const raw = (parsed as { products?: unknown })?.products;
  if (!Array.isArray(raw)) return [];

  const out: CatalogueProduct[] = [];
  for (const item of raw as RawProduct[]) {
    const title = str(item.title);
    const handle = str(item.handle);
    if (!title || !handle) continue;

    const variants = Array.isArray(item.variants) ? (item.variants as RawVariant[]) : [];
    const prices = variants.map((v) => money(v.price)).filter((n): n is number => n !== null);
    const compares = variants.map((v) => money(v.compare_at_price)).filter((n): n is number => n !== null);
    const publishedAt = item.published_at ? new Date(str(item.published_at)) : null;

    out.push({
      title,
      handle,
      url: `https://${domain}/products/${handle}`,
      vendor: str(item.vendor) || null,
      productType: str(item.product_type) || null,
      /* The lowest variant price, because that is the advertised one. */
      price: prices.length ? Math.min(...prices) : null,
      compareAtPrice: compares.length ? Math.max(...compares) : null,
      images: Array.isArray(item.images)
        ? (item.images as { src?: unknown }[]).map((i) => str(i.src)).filter(Boolean)
        : [],
      variants: variants.length,
      available: variants.some((v) => v.available === true),
      publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
    });
  }
  return out;
}

export interface CatalogueOptions {
  fetch?: typeof safeFetch;
  timeoutMs?: number;
  limit?: number;
  signal?: AbortSignal;
}

/* Never throws. A store that is not Shopify, or refuses us, is a normal
 * outcome and the run continues without it. */
export async function fetchCatalogue(domain: string, options: CatalogueOptions = {}): Promise<CatalogueResult> {
  const doFetch = options.fetch ?? safeFetch;
  const limit = Math.min(options.limit ?? MAX_PER_PAGE, MAX_PER_PAGE);

  const result = await doFetch(`https://${domain}/products.json?limit=${limit}`, {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    /* Measured 1.6MB for 250 products, so sized well above it. */
    maxBytes: 16 * 1024 * 1024,
    headers: { accept: 'application/json' },
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!result.ok) {
    return { ok: false, domain, products: [], truncated: false, error: result.error ?? `status ${result.status}` };
  }

  const products = parseCatalogue(result.body, domain);
  if (!products.length) {
    return { ok: false, domain, products: [], truncated: false, error: 'no catalogue at this domain' };
  }
  return { ok: true, domain, products, truncated: products.length >= limit };
}

export interface ScoredProduct {
  product: CatalogueProduct;
  /* How many query terms the title carried. */
  matched: number;
  /* Title words the query did not ask for. Fewer means more canonical. */
  extra: number;
}

const words = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter((w) => w.length > 1);

/*
 * Rank a catalogue against a name.
 *
 * EVERY QUERY TERM MUST APPEAR. A partial match on a 250 product catalogue
 * returns most of the catalogue, and a "best guess" product is worse than
 * admitting we could not find it: the price would be attached to the wrong
 * thing and every downstream number would inherit the error.
 *
 * Among real matches the shortest title wins, because a store names its
 * canonical product plainly and its variants at length. Measured on allbirds
 * for "wool runner": this puts "Men's Wool Runner" above "Women's Wool Runner
 * NZ Mid Waterproof - Natural Black (Natural White Sole)".
 */
export function searchCatalogue(products: readonly CatalogueProduct[], query: string): ScoredProduct[] {
  const terms = words(query);
  if (!terms.length) return [];

  const scored: ScoredProduct[] = [];
  for (const product of products) {
    const titleWords = words(product.title);
    const haystack = new Set([...titleWords, ...words(product.handle)]);
    const matched = terms.filter((t) => haystack.has(t)).length;
    if (matched < terms.length) continue;
    scored.push({ product, matched, extra: Math.max(0, titleWords.length - terms.length) });
  }

  return scored.sort((a, b) =>
    a.extra - b.extra
    /* Then an available product over a discontinued one. */
    || Number(b.product.available) - Number(a.product.available)
    || a.product.title.length - b.product.title.length);
}

/*
 * Domains a brand might live at, from the words in a name.
 *
 * Deliberately a short list. Each guess is a real request to a real host, and
 * spraying twenty variants at strangers to find one store is rude and slow.
 * Three candidates covers the common shapes and stops.
 */
export function brandDomains(name: string): string[] {
  const parts = words(name);
  if (!parts.length) return [];
  const first = parts[0]!;
  const two = parts.length > 1 ? `${first}${parts[1]}` : '';
  const hyphen = parts.length > 1 ? `${first}-${parts[1]}` : '';

  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of [first, two, hyphen]) {
    if (!candidate || candidate.length < 3) continue;
    const domain = `${candidate}.com`;
    if (seen.has(domain)) continue;
    seen.add(domain);
    out.push(domain);
  }
  return out;
}

export interface NameResolution {
  /* Null when nothing was found, which is a normal outcome. */
  match: CatalogueProduct | null;
  /* Runners up, so a caller can show alternatives rather than only a guess. */
  alternatives: CatalogueProduct[];
  /* Every domain tried and what happened, so a miss explains itself. */
  trail: { domain: string; outcome: string }[];
}

/*
 * Find a product from its name alone. No key, no search API, no URL.
 *
 * Guesses the brand's domain from the leading words, reads the public
 * catalogue, and ranks it against the rest of the name. It fails often and
 * says so: a store that is not Shopify, or one behind Cloudflare, simply is
 * not found, and the report carries on with the voice evidence it has.
 */
export async function findProductByName(
  name: string,
  options: CatalogueOptions = {},
): Promise<NameResolution> {
  const trail: NameResolution['trail'] = [];
  const domains = brandDomains(name);

  for (const domain of domains) {
    const catalogue = await fetchCatalogue(domain, options);
    if (!catalogue.ok) {
      trail.push({ domain, outcome: catalogue.error ?? 'no catalogue' });
      continue;
    }

    /*
     * The brand words are how we found the store, so they are usually absent
     * from the product titles inside it. Searching allbirds.com for "allbirds
     * wool runner" matches nothing; searching it for "wool runner" matches 28.
     */
    const brandWords = new Set(words(domain.replace(/\.com$/, '')));
    const remainder = words(name).filter((w) => !brandWords.has(w)).join(' ');
    const query = remainder || name;

    const hits = searchCatalogue(catalogue.products, query);
    if (!hits.length) {
      trail.push({ domain, outcome: `catalogue of ${catalogue.products.length}, no title matched ${JSON.stringify(query)}` });
      continue;
    }

    trail.push({ domain, outcome: `matched ${hits.length} of ${catalogue.products.length}` });
    return {
      match: hits[0]!.product,
      alternatives: hits.slice(1, 5).map((h) => h.product),
      trail,
    };
  }

  return { match: null, alternatives: [], trail };
}
