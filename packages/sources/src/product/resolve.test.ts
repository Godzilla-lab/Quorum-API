import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inferCategory, resolveProduct } from './resolve.ts';
import { extractJsonLdBlocks, extractProductFacts, extractTitleFallback } from './jsonld.ts';
import type { SafeFetchResult } from '../http/safe-fetch.ts';

const responder = (routes: Record<string, Partial<SafeFetchResult>>) =>
  (async (url: string) => {
    for (const [fragment, res] of Object.entries(routes)) {
      if (url.includes(fragment)) {
        return { ok: true, status: 200, headers: {}, body: '', url, ...res } as SafeFetchResult;
      }
    }
    return { ok: false, status: 404, headers: {}, body: '', url } as SafeFetchResult;
  }) as unknown as typeof import('../http/safe-fetch.ts').safeFetch;

const SHOPIFY = JSON.stringify({
  product: {
    title: "Men's Wool Runners",
    vendor: 'Allbirds',
    product_type: 'Running Shoes',
    body_html: '<p>Made with <b>ZQ merino wool</b>.</p>',
    tags: ['shoes', 'wool'],
    variants: [{ price: '98.00', available: true }],
  },
});

const JSONLD_PAGE = `<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Trail Runner Pro","description":"A trail shoe",
 "brand":{"@type":"Brand","name":"Peak"},"category":"Trail Shoes",
 "offers":{"@type":"Offer","price":"149.99","priceCurrency":"USD","availability":"https://schema.org/InStock"},
 "aggregateRating":{"@type":"AggregateRating","ratingValue":"4.4","reviewCount":"312"},
 "review":[{"@type":"Review","reviewBody":"Runs half a size small, otherwise perfect",
            "reviewRating":{"ratingValue":4},"author":{"@type":"Person","name":"Dana"}}]}
</script></head><body></body></html>`;

test('a shopify product url resolves exactly, with no guessing', async () => {
  const r = await resolveProduct('https://allbirds.com/products/mens-wool-runners', {
    fetch: responder({ '.json': { body: SHOPIFY } }),
  });

  assert.equal(r.strategy, 'shopify');
  assert.equal(r.title, "Men's Wool Runners");
  assert.equal(r.category, 'running shoes', 'product_type is the market word for it');
  assert.equal(r.categoryInferred, false, 'stated by the page, not derived by us');
  assert.equal(r.brand, 'Allbirds');
  assert.equal(r.price, 98);
  assert.match(r.description ?? '', /ZQ merino wool/);
  assert.doesNotMatch(r.description ?? '', /<b>/, 'html is stripped before it reaches a prompt');
});

test('a non shopify store falls through to structured data', async () => {
  const r = await resolveProduct('https://peak.example/shop/trail-runner-pro', {
    fetch: responder({ 'trail-runner-pro': { body: JSONLD_PAGE } }),
  });

  assert.equal(r.strategy, 'json-ld');
  assert.equal(r.title, 'Trail Runner Pro');
  assert.equal(r.category, 'trail shoes');
  assert.equal(r.categoryInferred, false);
  assert.equal(r.brand, 'Peak');
  assert.equal(r.price, 149.99);
  assert.equal(r.currency, 'USD');
  assert.equal(r.ratingValue, 4.4);
  assert.equal(r.ratingCount, 312);
});

/* Review markup is voice of customer at zero extra cost and no vendor API. */
test('reviews embedded in markup are extracted', async () => {
  const r = await resolveProduct('https://peak.example/shop/trail-runner-pro', {
    fetch: responder({ 'trail-runner-pro': { body: JSONLD_PAGE } }),
  });
  assert.equal(r.reviews.length, 1);
  assert.match(r.reviews[0]!.text, /size small/);
  assert.equal(r.reviews[0]!.rating, 4);
  assert.equal(r.reviews[0]!.author, 'Dana');
});

test('a page with no structured data still yields a subject, flagged as a guess', async () => {
  const page = `<html><head><title>Peak Trail Runner Pro | Peak Outdoors</title>
    <meta name="description" content="A durable trail running shoe"></head></html>`;
  const r = await resolveProduct('https://peak.example/p/123', { fetch: responder({ '/p/123': { body: page } }) });

  assert.equal(r.strategy, 'title');
  assert.match(r.title, /Trail Runner Pro/);
  assert.equal(r.categoryInferred, true, 'a title tag is marketing copy, not a category');
  assert.match(r.description ?? '', /durable trail running shoe/);
});

test('a shopify path that is not shopify falls through rather than failing', async () => {
  const r = await resolveProduct('https://other.example/products/thing', {
    fetch: responder({ '.json': { body: '<html>not json</html>' }, '/products/thing': { body: JSONLD_PAGE } }),
  });
  assert.equal(r.strategy, 'json-ld', 'the .json probe is cheap and failing it costs nothing');
});

test('an unreachable page returns an error value rather than throwing', async () => {
  const r = await resolveProduct('https://gone.example/p', { fetch: responder({}) });
  assert.equal(r.strategy, 'none');
  assert.ok(r.error);
  assert.equal(r.title, '');
});

test('a malformed url is refused before any request', async () => {
  let called = false;
  const r = await resolveProduct('http://[bad', {
    fetch: (async () => { called = true; throw new Error('should not fetch'); }) as never,
  });
  assert.equal(r.error, 'not a valid url');
  assert.equal(called, false);
});

test('a page with no product information at all says so', async () => {
  const r = await resolveProduct('https://x.example/p', { fetch: responder({ '/p': { body: '<html></html>' } }) });
  assert.equal(r.strategy, 'none');
  assert.match(r.error ?? '', /no product information/);
});

/* The category drives every downstream query, so its provenance matters. */
test('a stated category always beats a derived one', () => {
  assert.deepEqual(inferCategory({ productType: 'Running Shoes', title: 'Wool Runners' }),
    { category: 'running shoes', inferred: false });
  assert.deepEqual(inferCategory({ category: 'Trail Shoes', title: 'Peak Pro' }),
    { category: 'trail shoes', inferred: false });
  assert.deepEqual(inferCategory({ tags: ['shoes'], title: 'Peak Pro' }),
    { category: 'shoes', inferred: true });
  assert.deepEqual(inferCategory({ title: "Allbirds Men's Wool Runners" }),
    { category: 'wool runners', inferred: true });
  assert.deepEqual(inferCategory({}), { category: '', inferred: true });
});

/* Real pages are messy. A parser that gives up on the first bad block reads
 * nothing on a page that is mostly fine. */
test('one malformed json-ld block does not cost us the rest of the page', () => {
  const html = `
    <script type="application/ld+json">{ this is not json }</script>
    <script type="application/ld+json">{"@type":"Product","name":"Survivor"}</script>`;
  const blocks = extractJsonLdBlocks(html);
  assert.equal(blocks.length, 1);
  assert.equal(extractProductFacts(html)?.title, 'Survivor');
});

test('a product inside an @graph is found', () => {
  const html = `<script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[
      {"@type":"WebSite","name":"Store"},
      {"@type":"Product","name":"Graphed Product","offers":{"@type":"Offer","price":"12.00"}}]}
  </script>`;
  const facts = extractProductFacts(html);
  assert.equal(facts?.title, 'Graphed Product');
  assert.equal(facts?.price, 12);
});

test('an array of blocks and a multi typed node are both handled', () => {
  const html = `<script type="application/ld+json">
    [{"@type":"BreadcrumbList"},{"@type":["Product","Thing"],"name":"Multi Typed"}]</script>`;
  assert.equal(extractProductFacts(html)?.title, 'Multi Typed');
});

test('prices are read despite currency symbols and separators', () => {
  const price = (raw: string) => extractProductFacts(
    `<script type="application/ld+json">{"@type":"Product","name":"P","offers":{"price":"${raw}"}}</script>`,
  )?.price;
  assert.equal(price('1,299.00'), 1299);
  assert.equal(price('$49.99'), 49.99);
  assert.equal(price('49.99 USD'), 49.99);
  assert.equal(price('free'), undefined, 'a price we cannot read is absent, never zero');
});

test('availability keeps the value, not the schema url', () => {
  const facts = extractProductFacts(
    `<script type="application/ld+json">{"@type":"Product","name":"P","offers":{"availability":"https://schema.org/OutOfStock"}}</script>`,
  );
  assert.equal(facts?.availability, 'OutOfStock');
});

test('a page with no product markup extracts nothing rather than guessing', () => {
  assert.equal(extractProductFacts('<html><body>hello</body></html>'), null);
  assert.equal(extractProductFacts('<script type="application/ld+json">{"@type":"Article","name":"A"}</script>'), null);
});

test('og tags are preferred over the title tag', () => {
  const html = `<meta property="og:title" content="Better Title"><title>Worse Title | Store</title>`;
  assert.equal(extractTitleFallback(html).title, 'Better Title');
});

/*
 * REGRESSION, measured live 2026-08-22. Allbirds marks its pages up as a
 * ProductGroup with 49 variants and no Product node anywhere. An extractor that
 * only recognised Product read NOTHING on a page that was fully and correctly
 * marked up, and the resolution fell all the way through the ladder to failure.
 */
test('a ProductGroup is recognised as a product', () => {
  const html = `<script type="application/ld+json">
    {"@context":"https://schema.org","@type":"ProductGroup","productGroupID":"MENS_WOOL_RUNNERS",
     "name":"Men's Wool Runner","brand":{"@type":"Brand","name":"Allbirds"},
     "description":"The original wool sneaker","sku":"MENS_WOOL_RUNNERS",
     "offers":{"@type":"Offer","price":"98.00","priceCurrency":"USD"},
     "hasVariant":[{"@type":"Product","url":"https://x/1"},{"@type":"Product","url":"https://x/2"}]}
  </script>`;

  const facts = extractProductFacts(html);
  assert.equal(facts?.title, "Men's Wool Runner");
  assert.equal(facts?.brand, 'Allbirds');
  assert.equal(facts?.price, 98);
  assert.equal(facts?.sku, 'MENS_WOOL_RUNNERS');
});

test('a ProductModel is recognised too', () => {
  const html = `<script type="application/ld+json">{"@type":"ProductModel","name":"Model X"}</script>`;
  assert.equal(extractProductFacts(html)?.title, 'Model X');
});

/*
 * The rating is frequently NOT on the product node. Allbirds emits it as a
 * separate top level block containing nothing else.
 */
test('an aggregateRating in a detached block is still found', () => {
  const html = `
    <script type="application/ld+json">{"@type":"ProductGroup","name":"Wool Runner"}</script>
    <script type="application/ld+json">{"aggregateRating":{"@type":"AggregateRating","ratingValue":"4.6","reviewCount":"12043"}}</script>`;

  const facts = extractProductFacts(html);
  assert.equal(facts?.title, 'Wool Runner');
  assert.equal(facts?.ratingValue, 4.6);
  assert.equal(facts?.ratingCount, 12043);
});

test('a rating on the product node still wins over a detached one', () => {
  const html = `
    <script type="application/ld+json">{"@type":"Product","name":"P","aggregateRating":{"ratingValue":"4.9","reviewCount":"10"}}</script>
    <script type="application/ld+json">{"aggregateRating":{"ratingValue":"1.0","reviewCount":"9999"}}</script>`;
  assert.equal(extractProductFacts(html)?.ratingValue, 4.9);
});
