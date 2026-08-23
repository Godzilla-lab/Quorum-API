/*
 * Structured data extraction from a product page.
 *
 * This is the highest leverage parser in the project. Schema.org Product,
 * Offer and AggregateRating markup is on most ecommerce pages regardless of
 * platform, because search engines reward it, so one parser reads Shopify,
 * WooCommerce, BigCommerce, Squarespace and bespoke stores alike.
 *
 * It also reaches review data on Shopify stores without touching a review
 * vendor API: Judge.me, Okendo and Junip all emit per product Review JSON-LD
 * by default.
 *
 * Everything here is public page content, read logged off. No authentication,
 * ever.
 */

/*
 * Optional fields are written as `| undefined` rather than plain `?` because
 * exactOptionalPropertyTypes distinguishes "absent" from "present and
 * undefined", and an extractor assigns the latter constantly: a page simply may
 * not carry a brand.
 */
export interface ProductFactsExtract {
  title?: string | undefined;
  description?: string | undefined;
  brand?: string | undefined;
  price?: number | undefined;
  currency?: string | undefined;
  availability?: string | undefined;
  sku?: string | undefined;
  ratingValue?: number | undefined;
  ratingCount?: number | undefined;
  category?: string | undefined;
  images: string[];
  /* Review bodies found in markup, which are voice of customer for free. */
  reviews: { text: string; rating?: number | undefined; author?: string | undefined }[];
}

type Json = Record<string, unknown>;

const str = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number') return String(v);
  return undefined;
};

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    /* Prices arrive as "1,299.00", "$49.99" and "49.99 USD" in the wild. */
    const cleaned = v.replace(/[^0-9.]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) && cleaned !== '' ? n : undefined;
  }
  return undefined;
};

/*
 * Pull every JSON-LD block out of a page.
 *
 * Deliberately tolerant. Real pages ship trailing commas, HTML comments wrapped
 * around the JSON, and several blocks where only one is a Product. A parser
 * that throws on the first malformed block reads nothing on a page that is
 * mostly fine.
 */
export function extractJsonLdBlocks(html: string): Json[] {
  const blocks: Json[] = [];
  const pattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of html.matchAll(pattern)) {
    const raw = (match[1] ?? '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) blocks.push(...(parsed as Json[]));
      else if (parsed && typeof parsed === 'object') blocks.push(parsed as Json);
    } catch {
      /* One malformed block must not cost us the rest of the page. */
    }
  }
  return blocks;
}

/* @graph is how most CMSes emit several entities in one block. */
function flatten(blocks: Json[]): Json[] {
  const out: Json[] = [];
  for (const b of blocks) {
    out.push(b);
    const graph = b['@graph'];
    if (Array.isArray(graph)) out.push(...(graph as Json[]));
  }
  return out;
}

const typeOf = (node: Json): string[] => {
  const t = node['@type'];
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
};

const isType = (node: Json, want: string): boolean =>
  typeOf(node).some((t) => t.toLowerCase() === want.toLowerCase());

/*
 * Every schema.org type that means "this page is selling a thing".
 *
 * ProductGroup is not an edge case. Measured 2026-08-22: Allbirds emits a
 * ProductGroup with 49 variants and no Product node anywhere on the page, so an
 * extractor that only knows about Product reads nothing at all on a page that
 * is fully and correctly marked up. It carries the same fields we want (name,
 * brand, description, offers, sku), so it needs no special handling beyond
 * being recognised.
 */
const PRODUCT_TYPES = ['Product', 'ProductGroup', 'ProductModel'];

const isProductNode = (node: Json): boolean => PRODUCT_TYPES.some((t) => isType(node, t));

export function extractProductFacts(html: string): ProductFactsExtract | null {
  const nodes = flatten(extractJsonLdBlocks(html));
  const product = nodes.find(isProductNode);
  if (!product) return null;

  const facts: ProductFactsExtract = { images: [], reviews: [] };

  facts.title = str(product['name']);
  facts.description = str(product['description']);
  facts.sku = str(product['sku']);
  facts.category = str(product['category']);

  const brand = product['brand'];
  facts.brand = typeof brand === 'string' ? brand : str((brand as Json | undefined)?.['name']);

  /* Offers is a single object on some stores and an array on others. */
  const offers = product['offers'];
  const firstOffer = (Array.isArray(offers) ? offers[0] : offers) as Json | undefined;
  if (firstOffer) {
    facts.price = num(firstOffer['price']) ?? num((firstOffer['priceSpecification'] as Json | undefined)?.['price']);
    facts.currency = str(firstOffer['priceCurrency']);
    /* Availability arrives as a schema.org URL, so keep only the last segment. */
    const avail = str(firstOffer['availability']);
    facts.availability = avail?.split('/').pop();
  }

  /*
   * The rating is often NOT on the product node. Allbirds emits it as a
   * separate top level block carrying nothing but an aggregateRating, which a
   * parser looking only at the product would miss entirely.
   */
  const rating = (product['aggregateRating']
    ?? nodes.find((n) => n !== product && n['aggregateRating'])?.['aggregateRating']) as Json | undefined;
  if (rating) {
    facts.ratingValue = num(rating['ratingValue']);
    facts.ratingCount = num(rating['reviewCount']) ?? num(rating['ratingCount']);
  }

  const image = product['image'];
  if (typeof image === 'string') facts.images.push(image);
  else if (Array.isArray(image)) facts.images.push(...image.filter((i): i is string => typeof i === 'string'));

  /*
   * Reviews in markup are voice of customer for free, with no review vendor
   * API and no authentication. Judge.me, Okendo and Junip all emit these.
   */
  const reviews = product['review'];
  const reviewList = Array.isArray(reviews) ? reviews : reviews ? [reviews] : [];
  for (const r of reviewList as Json[]) {
    const text = str(r['reviewBody']) ?? str(r['description']);
    if (!text) continue;
    const author = r['author'];
    const ratingNode = r['reviewRating'] as Json | undefined;
    facts.reviews.push({
      text,
      rating: num(ratingNode?.['ratingValue']),
      author: typeof author === 'string' ? author : str((author as Json | undefined)?.['name']),
    });
  }

  return facts;
}

/*
 * Last resort when a page carries no structured data at all.
 *
 * A title tag is a weak signal and it is honestly labelled as one by the
 * caller. It is still better than refusing to research a product because its
 * store did not implement schema.org.
 */
export function extractTitleFallback(html: string): { title?: string | undefined; description?: string | undefined } {
  const out: { title?: string | undefined; description?: string | undefined } = {};

  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const title = ogTitle?.[1] ?? html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
  if (title) out.title = title.replace(/\s+/g, ' ').trim();

  const desc =
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (desc) out.description = desc.replace(/\s+/g, ' ').trim();

  return out;
}
