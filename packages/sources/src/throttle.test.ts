import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_GAP_MS, MIN_GAP_MS, createThrottle, sharedThrottle, resetSharedThrottles, isOverloadMessage } from './throttle.ts';

/* A fake clock. The suite must not actually wait, or it takes minutes. */
function fakeSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); } };
}

const noJitter = () => 0;

test('the ported curve matches what was measured', () => {
  assert.equal(MIN_GAP_MS, 220);
  assert.equal(MAX_GAP_MS, 4000);
});

test('a penalty steps to the floor rather than merely doubling', () => {
  const t = createThrottle({ sleep: async () => {}, random: noJitter });
  assert.equal(t.state().gapMs, 220);
  t.penalise();
  assert.equal(t.state().gapMs, 600, 'doubling 220 gives 440, which is not enough of a step back');
  t.penalise();
  assert.equal(t.state().gapMs, 1200);
});

test('the gap is capped so one bad spell cannot stall a run forever', () => {
  const t = createThrottle({ sleep: async () => {}, random: noJitter });
  for (let i = 0; i < 20; i++) t.penalise();
  assert.equal(t.state().gapMs, MAX_GAP_MS);
});

test('the gap decays back down and never below the floor', () => {
  const t = createThrottle({ sleep: async () => {}, random: noJitter });
  t.penalise();                       // 600
  t.relax();                          // 480
  assert.equal(t.state().gapMs, 480);
  for (let i = 0; i < 50; i++) t.relax();
  assert.equal(t.state().gapMs, MIN_GAP_MS, 'a hot spell must not poison the whole run');
  assert.equal(t.state().throttled, false);
});

test('throttled reports whether a run was rate limited', () => {
  const t = createThrottle({ sleep: async () => {}, random: noJitter });
  assert.equal(t.state().throttled, false);
  t.penalise();
  assert.equal(t.state().throttled, true, 'a run must be able to report that it got throttled');
});

test('sends are spaced by the current gap', async () => {
  const clock = fakeSleep();
  const t = createThrottle({ sleep: clock.sleep, random: noJitter });
  await t.run(async () => 'a');
  await t.run(async () => 'b');
  assert.deepEqual(clock.waits, [220, 220]);
});

test('sends are serialised rather than fired together', async () => {
  const t = createThrottle({ sleep: async () => {}, random: noJitter });
  const order: string[] = [];
  await Promise.all([
    t.run(async () => { order.push('first'); }),
    t.run(async () => { order.push('second'); }),
    t.run(async () => { order.push('third'); }),
  ]);
  assert.deepEqual(order, ['first', 'second', 'third'], 'concurrency above this queues, it does not parallelise');
});

test('a rejected send does not poison the chain for everything after it', async () => {
  const t = createThrottle({ sleep: async () => {}, random: noJitter });
  await assert.rejects(() => t.run(async () => { throw new Error('one bad request'); }));
  assert.equal(await t.run(async () => 'still working'), 'still working');
});

test('a successful attempt relaxes the gap and returns the result', async () => {
  const t = createThrottle({ sleep: async () => {}, random: noJitter });
  t.penalise();
  const result = await t.attempt(async () => 'data', () => false, 'empty');
  assert.equal(result, 'data');
  assert.equal(t.state().gapMs, 480, 'a clean answer earns a little headroom back');
});

test('an overloaded source is retried with widening gaps', async () => {
  const clock = fakeSleep();
  let calls = 0;
  const t = createThrottle({ sleep: clock.sleep, random: noJitter });

  const result = await t.attempt(
    async () => { calls++; return calls < 3 ? 'RATE_LIMITED' : 'data'; },
    (r) => r === 'RATE_LIMITED',
    'empty',
  );

  assert.equal(result, 'data');
  assert.equal(calls, 3);
  assert.ok(t.state().gapMs > MIN_GAP_MS, 'the client stays cautious after being refused');
});

/*
 * A source that keeps refusing must degrade the run, never fail it. This is the
 * missing key rule applied to a service that is up but unwilling.
 */
test('exhausting attempts returns empty rather than throwing', async () => {
  const t = createThrottle({ sleep: async () => {}, random: noJitter, maxAttempts: 3 });
  let calls = 0;
  const result = await t.attempt(
    async () => { calls++; return 'RATE_LIMITED'; },
    (r) => r === 'RATE_LIMITED',
    'empty',
  );
  assert.equal(result, 'empty');
  assert.equal(calls, 3, 'it gives up after the configured attempts, it does not loop');
});

test('overload is recognised in all three spellings the archive uses', () => {
  assert.equal(isOverloadMessage('Timeout. Maybe slow down a bit'), true);
  assert.equal(isOverloadMessage('Too many requests'), true);
  assert.equal(isOverloadMessage('rate limit exceeded'), true);
  assert.equal(isOverloadMessage('TOO MANY REQUESTS'), true, 'matching is case insensitive');
});

/*
 * A parameter error means stop. Retrying a malformed query spends the budget
 * four times to receive the same refusal.
 */
test('a parameter error is not treated as overload', () => {
  assert.equal(isOverloadMessage('subreddit or author is required'), false);
  assert.equal(isOverloadMessage('unknown field'), false);
  assert.equal(isOverloadMessage(null), false);
  assert.equal(isOverloadMessage(undefined), false);
  assert.equal(isOverloadMessage(''), false);
});

test('two upstreams get independent throttles', () => {
  const archive = createThrottle({ sleep: async () => {}, random: noJitter });
  const other = createThrottle({ sleep: async () => {}, random: noJitter });
  archive.penalise();
  assert.equal(archive.state().gapMs, 600);
  assert.equal(other.state().gapMs, 220, 'one slow upstream must not throttle every other source');
});

/*
 * Concurrency. Measured 2026-08-22: a per client throttle is correct for the
 * CLI, which runs one report per process, and wrong for a server, where ten
 * concurrent reports would build ten throttles and hit a volunteer archive at
 * ten times the calibrated rate, each politely convinced it was behaving.
 */
test('two callers asking for the same upstream get the same throttle', () => {
  resetSharedThrottles();
  const a = sharedThrottle('arctic-shift');
  const b = sharedThrottle('arctic-shift');
  assert.equal(a, b, 'ten tenants must not mean ten times the request rate');
});

test('different upstreams do not queue behind each other', () => {
  resetSharedThrottles();
  assert.notEqual(sharedThrottle('arctic-shift'), sharedThrottle('hackernews'));
});

test('backing off on a shared throttle slows every caller, which is the point', () => {
  resetSharedThrottles();
  const first = sharedThrottle('arctic-shift');
  first.penalise();
  const second = sharedThrottle('arctic-shift');
  assert.equal(second.state().gapMs, first.state().gapMs);
  assert.ok(second.state().gapMs > MIN_GAP_MS, 'the second caller inherits the backoff it did not cause');
});
