import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseImageUrl, normaliseImages } from './images.ts';

/*
 * THE MEASURED CASE, 2026-08-22. An image on an archived Allbirds page reads
 * https://web.archive.org/web/20260605172231/https://www.allbirds.com/cdn/...
 * Stripping the wrapper gives the original cdn url, and a HEAD against it
 * returned 200 image/png for a store whose HTML page had refused us with a 403.
 * Image cdns do not run the bot defences a storefront does.
 */
test('the archive wrapper is stripped so the url points at the original cdn', () => {
  const archived = 'https://web.archive.org/web/20260605172231/https://www.allbirds.com/cdn/shop/files/runner.png';
  assert.equal(normaliseImageUrl(archived), 'https://www.allbirds.com/cdn/shop/files/runner.png');
});

test('the archive wrapper is stripped with its resource suffix too', () => {
  const archived = 'https://web.archive.org/web/20191014110340im_/https://cdn.shopify.com/s/files/shirt.jpg';
  assert.equal(normaliseImageUrl(archived), 'https://cdn.shopify.com/s/files/shirt.jpg');
});

test('a doubly archived url unwraps completely', () => {
  const twice = 'https://web.archive.org/web/2026/https://web.archive.org/web/2019im_/https://cdn.example/a.png';
  assert.equal(normaliseImageUrl(twice), 'https://cdn.example/a.png');
});

/* Gymshark's markup gave //web.archive.org/..., which throws in new URL(). */
test('a protocol relative url does not throw', () => {
  assert.equal(
    normaliseImageUrl('//cdn.shopify.com/s/files/shirt.jpg'),
    'https://cdn.shopify.com/s/files/shirt.jpg',
  );
  assert.equal(
    normaliseImageUrl('//web.archive.org/web/20191014110340/https://cdn.shopify.com/s/files/shirt.jpg'),
    'https://cdn.shopify.com/s/files/shirt.jpg',
  );
});

/*
 * A placeholder renders an empty grey box labelled as the product, which is a
 * confident wrong answer where no answer was available. Gymshark's 2019
 * snapshot carried exactly one image and it was Shopify's no-image-2048 file.
 */
test('house placeholders are rejected, because a picture of nothing is worse than none', () => {
  for (const p of [
    'https://cdn.shopify.com/s/assets/no-image-2048-5e88c1b2.gif',
    'https://x.example/img/placeholder.png',
    'https://x.example/default-product.jpg',
    'https://x.example/assets/blank.gif',
    'https://x.example/1x1.gif',
    'https://x.example/spacer.gif',
  ]) {
    assert.equal(normaliseImageUrl(p), null, `placeholder passed: ${p}`);
  }
});

test('a relative path resolves against the page it was found on', () => {
  assert.equal(
    normaliseImageUrl('/cdn/shop/runner.png', 'https://allbirds.com/products/wool-runners'),
    'https://allbirds.com/cdn/shop/runner.png',
  );
  assert.equal(normaliseImageUrl('/cdn/runner.png'), null, 'with no page url there is nothing to resolve against');
});

test('non http schemes are refused', () => {
  assert.equal(normaliseImageUrl('data:image/png;base64,iVBORw0KGgo='), null);
  assert.equal(normaliseImageUrl('file:///etc/passwd'), null);
  assert.equal(normaliseImageUrl(''), null);
  assert.equal(normaliseImageUrl('   '), null);
});

/*
 * Image cdns append size and format parameters to the same asset. The Allbirds
 * page carried the same file four times at different widths.
 */
test('the same asset at different sizes is one image', () => {
  const images = normaliseImages([
    'https://cdn.example/runner.png?width=400',
    'https://cdn.example/runner.png?width=800',
    'https://cdn.example/runner.png?width=1600&format=webp',
    'https://cdn.example/other.png',
  ]);
  assert.deepEqual(images, ['https://cdn.example/runner.png?width=400', 'https://cdn.example/other.png']);
});

test('unusable entries are dropped without dropping the set', () => {
  const images = normaliseImages([
    'https://cdn.example/no-image-2048.gif',
    '',
    'not a url at all',
    'https://cdn.example/real.png',
  ]);
  assert.deepEqual(images, ['https://cdn.example/real.png']);
});

test('the set is capped so a gallery cannot flood a report', () => {
  const many = Array.from({ length: 40 }, (_, i) => `https://cdn.example/img${i}.png`);
  assert.equal(normaliseImages(many).length, 8);
  assert.equal(normaliseImages(many, undefined, 2).length, 2);
});
