/*
 * Product image URLs, normalised.
 *
 * Images are worth carrying: they identify the product a report is about, and
 * they are the thing a creative comparison would need. But the URLs that come
 * out of real markup are not usable as they arrive.
 *
 * MEASURED 2026-08-22 against archived pages for two stores.
 *
 *   1. THE ARCHIVE REWRITES THEM. An image on an archived page reads
 *      https://web.archive.org/web/20260605172231/https://allbirds.com/cdn/...
 *      Stripping that prefix gives the original CDN url, and the CDN STILL
 *      SERVES IT: a HEAD returned 200 image/png for a store whose HTML page had
 *      refused us outright. Image CDNs do not run the bot defences the storefront
 *      does, so this is a reliable way to get the picture even when the page is
 *      closed to us.
 *   2. PROTOCOL RELATIVE URLS EXIST. Gymshark's markup gave //web.archive.org/...
 *      which throws in new URL() and would have crashed a naive consumer.
 *   3. PLACEHOLDERS ARE WORSE THAN NOTHING. That same snapshot's only image was
 *      Shopify's no-image-2048 placeholder. Showing it renders an empty grey box
 *      labelled as the product, which is a confident wrong answer where no
 *      answer was available.
 */

/*
 * Files that are not the product. Shopify, WooCommerce and most themes ship a
 * house placeholder, and every one of them is a picture of nothing.
 */
const PLACEHOLDER = /no[-_]?image|placeholder|default[-_]product|blank\.(gif|png)|spacer\.gif|1x1\.(gif|png)|transparent\.(gif|png)/i;

const ARCHIVE_PREFIX = /^https?:\/\/web\.archive\.org\/web\/\d+[a-z_]*\//i;

/*
 * Turn whatever the markup said into an absolute, live, original url.
 *
 * Returns null when the url is unusable, which callers treat as "no image"
 * rather than as an error.
 */
export function normaliseImageUrl(raw: string, pageUrl?: string): string | null {
  let url = raw.trim();
  if (!url) return null;

  /* Protocol relative, which throws in new URL() on its own. */
  if (url.startsWith('//')) url = `https:${url}`;

  /*
   * Strip the archive wrapper so the url points at the original CDN. Done
   * BEFORE anything else, because the wrapper hides the real host, and done in
   * a loop because a doubly archived url is a real thing.
   */
  let previous = '';
  while (url !== previous && ARCHIVE_PREFIX.test(url)) {
    previous = url;
    url = url.replace(ARCHIVE_PREFIX, '');
    if (url.startsWith('//')) url = `https:${url}`;
  }

  /* Relative paths, resolved against the page they were found on. */
  if (!/^https?:\/\//i.test(url)) {
    if (!pageUrl) return null;
    try {
      url = new URL(url, pageUrl).toString();
    } catch {
      return null;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  /* A picture of nothing is a confident wrong answer. */
  if (PLACEHOLDER.test(parsed.pathname)) return null;

  return parsed.toString();
}

/*
 * Normalise a whole set, dropping unusable entries and duplicates.
 *
 * Deduplication ignores the query string, because image CDNs append size and
 * format parameters to the same asset: the Allbirds page carried the same file
 * four times at different widths.
 */
export function normaliseImages(raw: string[], pageUrl?: string, limit = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const candidate of raw) {
    const url = normaliseImageUrl(candidate, pageUrl);
    if (!url) continue;

    const key = url.split('?')[0] ?? url;
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}
