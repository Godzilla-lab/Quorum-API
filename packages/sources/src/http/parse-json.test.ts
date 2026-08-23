/*
 * The guard that exists because three adapters had the same bug at once.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrayField, parseJsonArray, parseJsonObject } from './parse-json.ts';

test('a literal null body is valid json and is not an object', () => {
  /* This is the one. `JSON.parse('null')` does not throw, so a try/catch that
   * looks correct never runs, and the next property read crashes the run. */
  assert.equal(parseJsonObject('null'), null);
  assert.equal(parseJsonArray('null'), null);
});

test('scalars and strings are not objects or arrays either', () => {
  for (const body of ['7', '"a string"', 'true', '""']) {
    assert.equal(parseJsonObject(body), null, `object: ${body}`);
    assert.equal(parseJsonArray(body), null, `array: ${body}`);
  }
});

test('malformed json is null rather than a throw', () => {
  assert.equal(parseJsonObject('{oops'), null);
  assert.equal(parseJsonArray('[1,'), null);
});

test('an array is not an object, and an object is not an array', () => {
  assert.equal(parseJsonObject('[]'), null, 'an array would iterate as an object elsewhere');
  assert.equal(parseJsonArray('{}'), null);
  assert.deepEqual(parseJsonArray('[1,2]'), [1, 2]);
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
});

test('a field that should be an array is empty when it is anything else', () => {
  /* `for (const x of "nope")` iterates the characters of the string rather
   * than failing, which turns drift into silent garbage in the corpus. */
  assert.deepEqual(arrayField({ hits: 'nope' }, 'hits'), []);
  assert.deepEqual(arrayField({}, 'hits'), []);
  assert.deepEqual(arrayField(null, 'hits'), []);
  assert.deepEqual(arrayField({ hits: [1] }, 'hits'), [1]);
});
