import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdObservation } from '@receipts/corpus';
import { deriveDuration, resolveAdDuration } from './ad-duration.ts';

const DAY = 86_400;
/* 2026-08-22, so the arithmetic below can be checked by hand. */
const T0 = 1_787_000_000;

function obs(over: Partial<AdObservation> = {}): AdObservation {
  return {
    adId: 'ad_1',
    advertiser: 'Allbirds',
    category: 'running shoes',
    body: 'try the wool runner',
    creative: 'video',
    platforms: ['facebook'],
    startDate: null,
    endDate: null,
    isActive: true,
    daysRunning: null,
    durationConfidence: 'none',
    observedAt: T0,
    ...over,
  };
}

test('no observations means no duration, not zero', () => {
  const d = deriveDuration([]);
  assert.equal(d.days, null);
  assert.equal(d.confidence, 'none');
  assert.equal(d.basis, 'none');
});

/*
 * The whole reason the table is append only. Meta destroys this the moment the
 * ad stops, so two sightings are the only record that will ever exist.
 */
test('two sightings of an ad that reports nothing still prove how long it ran', () => {
  const d = deriveDuration([
    obs({ observedAt: T0 }),
    obs({ observedAt: T0 + 30 * DAY }),
  ]);
  assert.equal(d.days, 30);
  assert.equal(d.confidence, 'observed');
  assert.equal(d.basis, 'observation-span');
  assert.equal(d.observations, 2);
});

test('one sighting is a moment and proves no duration', () => {
  const d = deriveDuration([obs()]);
  assert.equal(d.days, null);
  assert.equal(d.basis, 'none');
  assert.equal(d.observations, 1);
});

test('observations arrive in any order and the span is still right', () => {
  const late = obs({ observedAt: T0 + 30 * DAY });
  const early = obs({ observedAt: T0 });
  assert.equal(deriveDuration([late, early]).days, 30);
  assert.equal(deriveDuration([early, late]).days, 30);
});

test('a reported duration outranks anything we worked out ourselves', () => {
  const d = deriveDuration([
    obs({ observedAt: T0, daysRunning: 94, durationConfidence: 'reported' }),
    obs({ observedAt: T0 + 5 * DAY }),
  ]);
  assert.equal(d.days, 94);
  assert.equal(d.confidence, 'reported');
  assert.equal(d.basis, 'reported');
});

test('a duration cannot go backwards, so the largest reported figure wins', () => {
  const d = deriveDuration([
    obs({ observedAt: T0, daysRunning: 40, durationConfidence: 'reported' }),
    obs({ observedAt: T0 + 10 * DAY, daysRunning: 50, durationConfidence: 'reported' }),
    obs({ observedAt: T0 + 5 * DAY, daysRunning: 45, durationConfidence: 'reported' }),
  ]);
  assert.equal(d.days, 50);
});

test('a start date is measured to the last time we saw it, never to the clock', () => {
  const d = deriveDuration([
    obs({ observedAt: T0, startDate: T0 - 60 * DAY }),
    obs({ observedAt: T0 + 10 * DAY, startDate: T0 - 60 * DAY }),
  ]);
  /* 60 days before first sighting, plus the 10 days we watched. Not "until now". */
  assert.equal(d.days, 70);
  assert.equal(d.confidence, 'observed');
  assert.equal(d.basis, 'start-date');
});

test('the wider evidenced window wins, and a start date normally reaches further back', () => {
  const d = deriveDuration([
    obs({ observedAt: T0, startDate: T0 - 200 * DAY }),
    obs({ observedAt: T0 + 3 * DAY, startDate: T0 - 200 * DAY }),
  ]);
  assert.equal(d.basis, 'start-date');
  assert.equal(d.days, 203);
});

test('our own span wins when it is the wider one', () => {
  const d = deriveDuration([
    obs({ observedAt: T0, startDate: T0 - 1 * DAY }),
    obs({ observedAt: T0 + 90 * DAY, startDate: T0 - 1 * DAY }),
  ]);
  assert.equal(d.basis, 'start-date');
  /* Start date is one day wider here, so it still wins. Make it narrower: */
  const narrower = deriveDuration([
    obs({ observedAt: T0, startDate: null }),
    obs({ observedAt: T0 + 90 * DAY, startDate: null }),
  ]);
  assert.equal(narrower.basis, 'observation-span');
  assert.equal(narrower.days, 90);
});

/*
 * Measured 2026-08-13: a live ad reports today's date as its endDate, which is
 * a read timestamp and not an end date. Only a stopped ad has really ended.
 */
test('an end date only counts once the ad has actually stopped', () => {
  const stillRunning = deriveDuration([
    obs({ observedAt: T0, startDate: T0 - 10 * DAY, isActive: true, endDate: T0 + 500 * DAY }),
    obs({ observedAt: T0 + 2 * DAY, startDate: T0 - 10 * DAY, isActive: true, endDate: T0 + 500 * DAY }),
  ]);
  assert.equal(stillRunning.days, 12, 'a live ad must not borrow its own read timestamp');

  const stopped = deriveDuration([
    obs({ observedAt: T0, startDate: T0 - 10 * DAY, isActive: true }),
    obs({ observedAt: T0 + 2 * DAY, startDate: T0 - 10 * DAY, isActive: false, endDate: T0 + 20 * DAY }),
  ]);
  assert.equal(stopped.days, 30, 'a stopped ad ended when it stopped');
});

test('a partial day rounds down, because rounding up claims a day nobody watched', () => {
  const d = deriveDuration([
    obs({ observedAt: T0 }),
    obs({ observedAt: T0 + 30 * DAY - 1 }),
  ]);
  assert.equal(d.days, 29);
});

test('a negative span is corrupt data and says nothing rather than guessing', () => {
  const d = deriveDuration([
    obs({ observedAt: T0, startDate: T0 + 400 * DAY }),
  ]);
  assert.equal(d.days, null);
  assert.equal(d.basis, 'none');
});

test('first and last seen are reported, so a span carries its own receipt', () => {
  const d = deriveDuration([obs({ observedAt: T0 + 30 * DAY }), obs({ observedAt: T0 })]);
  assert.equal(d.firstSeen, T0);
  assert.equal(d.lastSeen, T0 + 30 * DAY);
});

test('resolveAdDuration joins what the ad is to how long it ran', () => {
  const latest = obs({ observedAt: T0 + 30 * DAY, creative: 'static', platforms: ['instagram'] });
  const history = [obs({ observedAt: T0 }), obs({ observedAt: T0 + 15 * DAY })];
  const resolved = resolveAdDuration(latest, history);

  assert.equal(resolved.adId, 'ad_1');
  assert.equal(resolved.creative, 'static', 'what it is comes from the latest sighting');
  assert.deepEqual(resolved.platforms, ['instagram']);
  assert.equal(resolved.daysRunning, 30, 'how long it ran comes from the whole history');
  assert.equal(resolved.basis, 'observation-span');
  assert.equal(resolved.observations, 3);
});

test('counting the latest sighting twice cannot widen a window', () => {
  const latest = obs({ observedAt: T0 + 30 * DAY });
  const history = [obs({ observedAt: T0 }), latest];
  const resolved = resolveAdDuration(latest, history);
  assert.equal(resolved.observations, 2);
  assert.equal(resolved.daysRunning, 30);
});
