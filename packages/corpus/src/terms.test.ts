import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractTerms, toFts5Phrase, toFts5Query, toTsQuery } from './terms.ts';

/*
 * The cutoff is length >= 3, ported unchanged from the engine's `w.length > 2`.
 * So "the" survives and "is" does not. That is not an oversight: three letter
 * stop words are cheap to carry in an OR query, and changing the cutoff would
 * change retrieval results and therefore break report parity.
 */
test('words of two characters or fewer are dropped', () => {
  assert.deepEqual(extractTerms('the toe box is too narrow'), ['the', 'toe', 'box', 'too', 'narrow']);
  assert.deepEqual(extractTerms('a to at'), [], 'nothing reaches the cutoff');
  assert.deepEqual(extractTerms('an ox is'), []);
});

test('query operator characters are stripped, not escaped', () => {
  /* Each of these would be a syntax error if it reached either engine raw. */
  assert.deepEqual(extractTerms('sizing"'), ['sizing']);
  assert.deepEqual(extractTerms('(sizing)'), ['sizing']);
  assert.deepEqual(extractTerms('sizing & fit'), ['sizing', 'fit']);
  assert.deepEqual(extractTerms('sizing | fit'), ['sizing', 'fit']);
  assert.deepEqual(extractTerms('!sizing'), ['sizing']);
  assert.deepEqual(extractTerms('sizing:fit'), ['sizing', 'fit']);
  assert.deepEqual(extractTerms('"""'), []);
});

/*
 * The conformance property. Both drivers must search the SAME terms, or the CLI
 * and the hosted API quietly produce different reports for the same product.
 */
test('both drivers derive identical terms from a query', () => {
  const query = 'Sizing runs (small): fit & comfort!';
  const terms = extractTerms(query);

  assert.equal(toFts5Query(query), terms.map((t) => `"${t}"`).join(' OR '));
  assert.equal(toTsQuery(query), terms.join(' | '));
});

/*
 * OR, not AND. Measured 2026-08-13: a four word phrase returned zero hits where
 * one word from it returned plenty. AND semantics would have made the hosted
 * driver return a fraction of what the local one does.
 */
test('terms are OR-ed for recall in both dialects', () => {
  assert.equal(toFts5Query('sizing durability'), '"sizing" OR "durability"');
  assert.equal(toTsQuery('sizing durability'), 'sizing | durability');
});

test('a query with nothing usable returns null rather than matching everything', () => {
  assert.equal(toFts5Query('a to at'), null);
  assert.equal(toTsQuery('   '), null);
  assert.equal(toFts5Query('"""'), null);
});

/* ------------------------------------------------------------------ */
/* control characters                                                  */
/* ------------------------------------------------------------------ */

test('A NUL BYTE IN A QUERY CANNOT REACH THE ENGINE', () => {
  /*
   * MEASURED 2026-08-22 during a 10,000 request load run. SQLite takes a NUL
   * terminated string, so a NUL inside the match text truncated it to a lone
   * opening quote and the FTS5 parser threw "unterminated string": HTTP 500,
   * twelve times out of twelve, from one byte that any caller can send.
   *
   * Postgres refuses a NUL in text outright, so both drivers needed this and
   * neither of them is the right place to put it.
   */
  const NUL = String.fromCharCode(0);
  assert.equal(toFts5Query(`${NUL}nul byte`), '"nul" OR "byte"');
  assert.equal(toTsQuery(`${NUL}nul byte`), 'nul | byte');
  /* It SEPARATES rather than being deleted, so it cannot weld two words into a
   * term that nobody wrote. */
  assert.deepEqual(extractTerms(`sizing${NUL}durability`), ['sizing', 'durability']);
});

test('no control character survives into a term', () => {
  for (let code = 0; code <= 0x1f; code++) {
    const ch = String.fromCharCode(code);
    assert.deepEqual(extractTerms(`sizing${ch}durability`), ['sizing', 'durability'], `U+${code.toString(16)}`);
  }
  assert.deepEqual(extractTerms(`sizing${String.fromCharCode(0x7f)}durability`), ['sizing', 'durability']);
});

test('the phrase builder keeps short words and survives punctuation', () => {
  /* "out of stock" quoted without its "of" is a different phrase, so the
   * phrase form keeps the short words the term extractor drops. */
  assert.equal(toFts5Phrase('out of stock'), '"out of stock"');
  assert.equal(toFts5Phrase('  Sold   OUT!  '), '"sold out"',
    'whitespace collapses, case folds, and operator characters are stripped');
  assert.equal(toFts5Phrase('runs "small" (really)'), '"runs small really"');
  assert.equal(toFts5Phrase('   '), null);
  assert.equal(toFts5Phrase('"()"'), null);
});
