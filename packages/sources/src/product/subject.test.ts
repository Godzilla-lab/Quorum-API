import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSubject, subjectFromUrlString } from './subject.ts';
import type { SafeFetchResult } from '../http/safe-fetch.ts';

const blocked = (status = 403) =>
  (async (url: string) => ({ ok: false, status, headers: {}, body: '', url } as SafeFetchResult)) as never;

const serves = (body: string) =>
  (async (url: string) => ({ ok: true, status: 200, headers: {}, body, url } as SafeFetchResult)) as never;

/* Plain text is the normal case and must need nothing at all. */
test('a plain text subject works with no network', async () => {
  const s = await resolveSubject('running shoes');
  assert.equal(s.source, 'text');
  assert.equal(s.category, 'running shoes');
  assert.equal(s.title, 'running shoes');
  assert.equal(s.url, undefined);
});

test('a plain text subject is not required to look like a product', async () => {
  const s = await resolveSubject('project management software for agencies');
  assert.equal(s.source, 'text');
  assert.equal(s.category, 'project management software for agencies');
});

/*
 * THE MEASURED CASE, 2026-08-22. Four real stores were probed and all four
 * refused: Allbirds 403, Gymshark ECONNREFUSED, Patagonia 404, REI timeout.
 * A pipeline that requires a readable product page fails on exactly the brands
 * anyone would want to research.
 */
test('a blocked store still produces a usable subject', async () => {
  const s = await resolveSubject('https://www.allbirds.com/products/mens-wool-runners', { fetch: blocked(403) });

  assert.equal(s.source, 'url-fallback');
  assert.equal(s.title, 'wool runners', 'the slug survives what the server refuses');
  assert.equal(s.brand, 'allbirds', 'and the host names the brand');
  assert.ok(s.note, 'the report can say the page could not be read');
  assert.equal(s.url, 'https://www.allbirds.com/products/mens-wool-runners');
});

test('a readable page is used when the store allows it', async () => {
  const page = `<script type="application/ld+json">
    {"@type":"Product","name":"Trail Runner Pro","category":"Trail Shoes",
     "brand":{"name":"Peak"},"offers":{"price":"149.99","priceCurrency":"USD"}}</script>`;
  const s = await resolveSubject('https://peak.example/shop/trail-runner-pro', { fetch: serves(page) });

  assert.equal(s.source, 'page');
  assert.equal(s.title, 'Trail Runner Pro');
  assert.equal(s.category, 'trail shoes');
  assert.equal(s.price, 149.99);
  assert.equal(s.note, undefined);
});

test('a transport that throws degrades rather than propagating', async () => {
  const s = await resolveSubject('https://x.example/products/thing', {
    fetch: (async () => { throw new Error('socket hang up'); }) as never,
  });
  assert.equal(s.source, 'url-fallback');
  assert.equal(s.title, 'thing');
  assert.match(s.note ?? '', /socket hang up/);
});

test('offline mode skips the network entirely', async () => {
  let called = false;
  const s = await resolveSubject('https://x.example/products/wool-runners', {
    offline: true,
    fetch: (async () => { called = true; throw new Error('nope'); }) as never,
  });
  assert.equal(called, false);
  assert.equal(s.title, 'wool runners');
});

/* The slug is usually the product name with hyphens, and cannot be blocked. */
test('slug noise is stripped so the product name survives', () => {
  assert.equal(subjectFromUrlString('https://allbirds.com/products/mens-wool-runners-black').title, 'wool runners');
  assert.equal(subjectFromUrlString('https://shop.example/collections/shoes/products/trail-runner-pro-2').title, 'trail runner pro');
  assert.equal(subjectFromUrlString('https://x.example/p/standing-desk-converter.html').title, 'standing desk converter');
});

test('routing segments are skipped in favour of the product segment', () => {
  assert.equal(subjectFromUrlString('https://x.example/shop/store/products/wool-runners').title, 'wool runners');
});

test('the brand comes from the host, without the www', () => {
  assert.equal(subjectFromUrlString('https://www.patagonia.com/product/better-sweater').brand, 'patagonia');
  assert.equal(subjectFromUrlString('https://gymshark.com/products/arrival-tshirt').brand, 'gymshark');
});

test('a bare domain with no path yields no title rather than a wrong one', () => {
  assert.equal(subjectFromUrlString('https://allbirds.com').title, '');
});

test('a url shaped string without a scheme is still recognised', async () => {
  const s = await resolveSubject('allbirds.com/products/wool-runners', { offline: true });
  assert.equal(s.source, 'url-fallback');
  assert.equal(s.title, 'wool runners');
});

test('a subject containing a dot but no path is treated as text', async () => {
  const s = await resolveSubject('node.js testing tools');
  assert.equal(s.source, 'text', 'a sentence with a dot is not a url');
  assert.equal(s.category, 'node.js testing tools');
});
