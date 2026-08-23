import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MIN_RECEIPTS, WARM_MAX_AGE_DAYS, WARM_MIN_DOCS, ageInDays, isWarm } from './constants.ts';

/*
 * These assert the ported values, not arbitrary ones. If a threshold changes,
 * this test failing is the point: report parity against the old engine has to
 * be re-established rather than quietly assumed.
 */
test('thresholds match the engine they were ported from', () => {
  assert.equal(WARM_MIN_DOCS, 150);
  assert.equal(WARM_MAX_AGE_DAYS, 14);
  assert.equal(MIN_RECEIPTS, 3);
});

test('a category never harvested has null age and is never warm', () => {
  assert.equal(ageInDays(null, 1_000_000), null);
  assert.equal(ageInDays(undefined, 1_000_000), null);
  assert.equal(ageInDays(0, 1_000_000), null);
  assert.equal(isWarm(10_000, null), false);
});

test('warm needs both enough docs and recent enough harvest', () => {
  assert.equal(isWarm(WARM_MIN_DOCS, 0), true, 'exactly at the doc floor counts');
  assert.equal(isWarm(WARM_MIN_DOCS - 1, 0), false, 'one below the floor does not');
  assert.equal(isWarm(10_000, WARM_MAX_AGE_DAYS), false, 'exactly at the age limit is stale');
  assert.equal(isWarm(10_000, WARM_MAX_AGE_DAYS - 0.01), true, 'just inside the age limit is warm');
});

test('age is computed in days from unix seconds', () => {
  const now = 1_000_000;
  assert.equal(ageInDays(now - 86400, now), 1);
  assert.equal(ageInDays(now - 86400 * 14, now), 14);
});
