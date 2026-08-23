/*
 * The catalogue payload here is CAPTURED from allbirds.com/products.json on
 * 2026-08-22: 250 products, 1.6MB, no key and no account. A search for "wool
 * runner" matched 28 of them with live prices, which is a product NAME
 * resolving to a real product for free.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SafeFetchResult } from '../http/safe-fetch.ts';
import {
  brandDomains, fetchCatalogue, findProductByName, parseCatalogue, searchCatalogue,
} from './catalogue.ts';

/* Field names and value shapes exactly as the live endpoint sends them:
 * prices are strings, availability is per variant, images are objects. */
const CATALOGUE = JSON.stringify({
  products: [
    {
      title: "Men's Wool Runner - Natural Grey", handle: 'mens-wool-runners-natural-grey',
      vendor: 'Allbirds', product_type: 'Shoes', published_at: '2026-06-16T10:00:00-07:00',
      variants: [
        { price: '110.00', compare_at_price: '135.00', available: true },
        { price: '105.00', compare_at_price: null, available: false },
      ],
      images: [{ src: 'https://cdn.shopify.com/a.jpg' }, { src: 'https://cdn.shopify.com/b.jpg' }],
    },
    {
      title: "Women's Wool Runner NZ Mid Waterproof - Natural Black (Natural White Sole)",
      handle: 'womens-wool-runner-nz-mid-waterproof', vendor: 'Allbirds', product_type: 'Shoes',
      published_at: '2026-06-30T18:03:14-07:00',
      variants: [{ price: '160.00', available: true }],
      images: [],
    },
    {
      title: 'Anytime Crew Sock', handle: 'anytime-crew-sock', vendor: 'Allbirds',
      product_type: 'Socks', published_at: '2025-01-02T00:00:00Z',
      variants: [{ price: '18.00', available: false }],
      images: [],
    },
  ],
});

const okFetch = (body: string): (() => Promise<SafeFetchResult>) => async () => ({
  ok: true, status: 200, headers: {}, body, url: 'https://allbirds.com/products.json',
});

test('prices arrive as strings and are parsed to the lowest variant', () => {
  const products = parseCatalogue(CATALOGUE, 'allbirds.com');
  const runner = products[0]!;
  assert.equal(runner.price, 105, 'the lowest variant price is the one a buyer sees advertised');
  assert.equal(runner.compareAtPrice, 135);
  assert.equal(runner.variants, 2);
  assert.equal(runner.url, 'https://allbirds.com/products/mens-wool-runners-natural-grey');
});

test('a product is available when any variant is', () => {
  const products = parseCatalogue(CATALOGUE, 'allbirds.com');
  assert.equal(products[0]?.available, true, 'one sellable variant is enough');
  assert.equal(products[2]?.available, false, 'no sellable variant means it is on the way out');
});

test('the store publishes its own launch date, and it is free', () => {
  const products = parseCatalogue(CATALOGUE, 'allbirds.com');
  assert.equal(products[0]?.publishedAt?.getUTCFullYear(), 2026);
  assert.equal(products[2]?.publishedAt?.getUTCFullYear(), 2025);
});

test('a payload that is not a catalogue yields nothing rather than throwing', () => {
  assert.deepEqual(parseCatalogue('<html>403</html>', 'x.com'), []);
  assert.deepEqual(parseCatalogue('{"errors":"not found"}', 'x.com'), []);
  assert.deepEqual(parseCatalogue('{"products":[{"handle":"no-title"}]}', 'x.com'), []);
});

/*
 * Partial matching on a 250 product catalogue returns most of the catalogue,
 * and a best guess product is worse than admitting we could not find it: the
 * price would attach to the wrong thing and every number downstream inherits it.
 */
test('every query term must appear, so a near miss returns nothing', () => {
  const products = parseCatalogue(CATALOGUE, 'allbirds.com');
  assert.equal(searchCatalogue(products, 'wool runner').length, 2);
  assert.equal(searchCatalogue(products, 'wool runner tennis').length, 0);
});

/* A store names its canonical product plainly and its variants at length. */
test('the shortest matching title wins, which is the canonical product', () => {
  const products = parseCatalogue(CATALOGUE, 'allbirds.com');
  const hits = searchCatalogue(products, 'wool runner');
  assert.match(hits[0]!.product.title, /^Men's Wool Runner/);
});

test('an available product outranks a discontinued one of the same shape', () => {
  const products = parseCatalogue(JSON.stringify({
    products: [
      { title: 'Crew Sock', handle: 'a', variants: [{ price: '18.00', available: false }], images: [] },
      { title: 'Crew Sock', handle: 'b', variants: [{ price: '18.00', available: true }], images: [] },
    ],
  }), 'x.com');
  assert.equal(searchCatalogue(products, 'crew sock')[0]?.product.handle, 'b');
});

test('an empty query matches nothing rather than everything', () => {
  assert.deepEqual(searchCatalogue(parseCatalogue(CATALOGUE, 'x.com'), '   '), []);
});

/* Each guess is a real request to a real host, so the list stays short. */
test('brand guessing stays to a handful of candidates', () => {
  assert.deepEqual(brandDomains('Allbirds Wool Runner'), ['allbirds.com', 'allbirdswool.com', 'allbirds-wool.com']);
  assert.deepEqual(brandDomains('Allbirds'), ['allbirds.com']);
  assert.deepEqual(brandDomains(''), []);
  assert.deepEqual(brandDomains('a b'), [], 'initials are not brands');
});

test('a store that refuses us is an error value, never a throw', async () => {
  const result = await fetchCatalogue('gymshark.com', {
    fetch: async () => ({ ok: false, status: 403, headers: {}, body: '', url: '', error: 'connect ECONNREFUSED' }),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.products, []);
  assert.match(result.error ?? '', /ECONNREFUSED/);
});

test('a 200 that is not a catalogue is still a miss, not a success', async () => {
  const result = await fetchCatalogue('nike.com', { fetch: okFetch('<html>home page</html>') });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /no catalogue/);
});

/*
 * The brand words are how the store was found, so they are absent from the
 * titles inside it. Searching allbirds.com for "allbirds wool runner" matches
 * nothing; searching it for "wool runner" matches everything it should.
 */
test('the brand is stripped before searching the store it identified', async () => {
  const found = await findProductByName('Allbirds Wool Runner', { fetch: okFetch(CATALOGUE) });
  assert.ok(found.match, 'the brand word must not be required to appear in the title');
  assert.match(found.match!.title, /Wool Runner/);
  assert.equal(found.alternatives.length, 1);
});

test('a miss records every domain tried and why each failed', async () => {
  const found = await findProductByName('Nike Air Max', {
    fetch: async () => ({ ok: true, status: 200, headers: {}, body: '<html>404</html>', url: '' }),
  });
  assert.equal(found.match, null);
  assert.ok(found.trail.length >= 1);
  for (const step of found.trail) assert.match(step.outcome, /no catalogue/);
});

test('a catalogue at the page cap says so rather than reading as complete', async () => {
  const many = JSON.stringify({
    products: Array.from({ length: 3 }, (_, i) => ({
      title: `Thing ${i}`, handle: `t${i}`, variants: [{ price: '1.00', available: true }], images: [],
    })),
  });
  const capped = await fetchCatalogue('x.com', { fetch: okFetch(many), limit: 3 });
  assert.equal(capped.truncated, true);
  const roomy = await fetchCatalogue('x.com', { fetch: okFetch(many), limit: 4 });
  assert.equal(roomy.truncated, false);
});
