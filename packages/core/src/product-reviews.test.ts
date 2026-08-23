/*
 * Reviews that were being extracted and thrown away.
 *
 * `Subject.reviews` was populated on every run that read a product page and
 * consumed by nothing. Found 2026-08-22 by grepping for consumers of a field we
 * already had.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { productReviewDocs, reviewChannel, reviewExternalId } from './product-reviews.ts';

const review = (text: string, over: { rating?: number; author?: string } = {}) => ({ text, ...over });
const LONG = 'These run small and I had to order a full size up, otherwise perfect.';

test('an id is derived from the content, so a re-read mints the same receipt', () => {
  /* Page markup carries no review id. An unstable one would create a new
   * receipt every run and count the same person twice. */
  const a = reviewExternalId(review(LONG, { author: 'Sam' }));
  const b = reviewExternalId(review(LONG, { author: 'Sam' }));
  assert.equal(a, b);
  assert.equal(a.length, 24);
});

test('two people leaving the same words are two reviews, not one', () => {
  const a = reviewExternalId(review(LONG, { author: 'Sam' }));
  const b = reviewExternalId(review(LONG, { author: 'Alex' }));
  assert.notEqual(a, b, 'collapsing them would undercount rather than overcount');
});

test('the same review rendered twice on one page is stored once', () => {
  const docs = productReviewDocs({
    url: 'https://store.test/p',
    reviews: [review(LONG, { author: 'Sam' }), review(LONG, { author: 'Sam' })],
  });
  assert.equal(docs.length, 1);
});

test('a fragment is not an opinion', () => {
  const docs = productReviewDocs({ url: 'https://store.test/p', reviews: [review('Great!'), review(LONG)] });
  assert.equal(docs.length, 1, 'the length floor matches the forum adapters');
});

test('the store is the channel, because a brand chooses what appears on its own site', () => {
  assert.equal(reviewChannel('https://www.allbirds.com/products/x'), 'allbirds.com');
  assert.equal(reviewChannel(undefined), 'product page');
  assert.equal(reviewChannel('not a url'), 'product page');
});

test('a rating becomes stars, and a missing or impossible one becomes zero', () => {
  const [five] = productReviewDocs({ url: 'https://s.test/p', reviews: [review(LONG, { rating: 5 })] });
  assert.equal(five?.score, 5);

  const [none] = productReviewDocs({ url: 'https://s.test/p', reviews: [review(LONG)] });
  assert.equal(none?.score, 0);

  const [bad] = productReviewDocs({ url: 'https://s.test/p', reviews: [review(LONG, { rating: 9 })] });
  assert.equal(bad?.score, 0, 'nine stars is not a rating and must not be stored as one');
});

test('records are tier C voice under the review source', () => {
  const [doc] = productReviewDocs({ url: 'https://s.test/p', reviews: [review(LONG)] });
  assert.equal(doc?.source, 'review');
  assert.equal(doc?.kind, 'comment');
  /* No date is emitted by most stores and the extractor does not read one. An
   * invented timestamp would be worse than an absent one. */
  assert.equal(doc?.createdUtc, 0);
});

test('no reviews means no records, not an empty placeholder', () => {
  assert.deepEqual(productReviewDocs({ url: 'https://s.test/p', reviews: [] }), []);
});
