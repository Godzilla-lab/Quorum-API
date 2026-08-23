/*
 * The job queue, with the network replaced by a promise a test controls.
 *
 * Every property under test here is a rule the spec states in prose, and prose
 * is not a constraint. Coalescing that quietly shared claims, or a cancel that
 * quietly killed somebody else's run, would look completely correct in review
 * and would be discovered by a customer.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  coalescingKey, createJobQueue,
  type JobQueue, type ReportRequest, type RunContext, type RunOutcome,
} from './jobs.ts';

function request(over: Partial<ReportRequest> = {}): ReportRequest {
  return {
    subject: 'wool runner',
    terms: ['quality'],
    communities: [],
    sources: ['reddit'],
    includeAds: false,
    offline: false,
    capUsd: undefined,
    deadlineMs: undefined,
    webhookUrl: undefined,
    ...over,
  };
}

/*
 * A runner whose completion the test decides. Every queue property worth
 * testing is about what happens WHILE a run is in flight, and a runner that
 * finished on its own would make all of them races.
 */
function controllable() {
  const calls: { request: ReportRequest; ctx: RunContext }[] = [];
  let release: ((outcome: RunOutcome) => void) | null = null;
  let fail: ((error: Error) => void) | null = null;

  const runReport = async (req: ReportRequest, ctx: RunContext): Promise<RunOutcome> => {
    calls.push({ request: req, ctx });
    return new Promise<RunOutcome>((resolve, reject) => { release = resolve; fail = reject; });
  };

  return {
    runReport,
    calls,
    finish: (over: Partial<RunOutcome> = {}) => {
      release?.({
        subject: { title: 'wool runner' },
        category: 'wool runner',
        subjectResolved: false,
        retrieval: { totalWritten: 5 },
        warmth: { docs: 5 },
        degraded: [],
        cost: { totalUsd: 0 },
        ...over,
      });
    },
    throw: (message: string) => { fail?.(new Error(message)); },
  };
}

/* Claims per report, so a test can prove a joiner got its OWN questions. */
function claimsRecorder() {
  const asked: { category: string; terms: string[] }[] = [];
  const claimsFor = async (outcome: RunOutcome, terms: readonly string[]) => {
    asked.push({ category: outcome.category, terms: [...terms] });
    return {
      findings: terms.map((t) => ({ term: t, verdict: 'finding' })),
      weakSignals: [],
      rejected: [],
      sufficiency: { verdict: 'sufficient' },
      receiptCheck: { cited: 0, resolved: 0, unresolved: [] },
      trends: [], voice: [], themes: [],
    };
  };
  return { claimsFor, asked };
}

const settled = async (): Promise<void> => {
  /* Two turns: one for the runner's promise, one for the per report claims
   * loop that runs in its `finally`. */
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function queue(over: Partial<Parameters<typeof createJobQueue>[0]> = {}) {
  const runner = controllable();
  const claims = claimsRecorder();
  const q: JobQueue = createJobQueue({
    runReport: runner.runReport,
    claimsFor: claims.claimsFor,
    ...over,
  });
  return { q, runner, claims };
}

/* ------------------------------------------------------------------ */
/* the happy path                                                      */
/* ------------------------------------------------------------------ */

test('a submitted report queues, runs and completes', async () => {
  const { q, runner } = queue();
  const result = await q.submit(request(), { keyLabel: 'key-a' });
  assert.equal(result.ok, true);
  const { id } = (result as { accepted: { id: string } }).accepted;
  assert.match(id, /^rep_[0-9a-f]{16}$/);

  assert.equal(q.get(id)?.status, 'running', 'a free worker starts it immediately');
  runner.finish();
  await settled();

  const done = q.get(id)!;
  assert.equal(done.status, 'complete');
  assert.equal(done.category, 'wool runner');
  assert.deepEqual(done.findings, [{ term: 'quality', verdict: 'finding' }]);
  assert.equal(done.completedAt !== null, true);
});

test('an unknown id is null rather than an empty report', () => {
  const { q } = queue();
  assert.equal(q.get('rep_0000000000000000'), null);
  assert.equal(q.cancel('rep_0000000000000000'), null);
  assert.equal(q.eventsSince('rep_0000000000000000', 0), null);
});

test('a run that throws fails its report and does not take the queue with it', async () => {
  const { q, runner } = queue();
  const a = (await q.submit(request(), { keyLabel: 'k' }) as { accepted: { id: string } }).accepted.id;
  runner.throw('upstream exploded');
  await settled();

  assert.equal(q.get(a)?.status, 'failed');
  assert.deepEqual(q.get(a)?.error, { type: 'internal', message: 'upstream exploded' });
  assert.equal(q.stats().running, 0, 'the worker was released');

  /* And the next submit runs, rather than inheriting a wedged worker. */
  const b = await q.submit(request({ subject: 'something else' }), { keyLabel: 'k' });
  assert.equal(b.ok, true);
  assert.equal(q.stats().running, 1);
});

/* ------------------------------------------------------------------ */
/* coalescing                                                          */
/* ------------------------------------------------------------------ */

test('COALESCING SHARES THE RETRIEVAL', async () => {
  const { q, runner } = queue();
  const first = (await q.submit(request(), { keyLabel: 'a' }) as { accepted: { coalesced: boolean } }).accepted;
  const second = (await q.submit(request({ subject: 'Wool  Runner' }), { keyLabel: 'b' }) as { accepted: { coalesced: boolean } }).accepted;

  assert.equal(first.coalesced, false);
  assert.equal(second.coalesced, true, 'whitespace and case are the same subject');
  assert.equal(runner.calls.length, 1, 'ONE retrieval, which is the whole point');
});

test('AND NEVER SHARES THE CLAIMS', async () => {
  const { q, runner, claims } = queue();
  const a = (await q.submit(request({ terms: ['quality'] }), { keyLabel: 'a' }) as { accepted: { id: string } }).accepted.id;
  const b = (await q.submit(request({ terms: ['price'] }), { keyLabel: 'b' }) as { accepted: { id: string } }).accepted.id;

  runner.finish();
  await settled();

  /*
   * The line that makes joining somebody else's run safe. A joiner that
   * inherited the first caller's questions would be a different product.
   */
  assert.deepEqual(q.get(a)?.findings, [{ term: 'quality', verdict: 'finding' }]);
  assert.deepEqual(q.get(b)?.findings, [{ term: 'price', verdict: 'finding' }]);
  assert.equal(claims.asked.length, 2, 'claims are computed once per report');
});

test('a joiner arriving before the run starts gets its terms searched upstream', async () => {
  /* Concurrency 0 is not expressible, so the queue is filled first and the
   * second run waits, which is the state a joiner can still influence. */
  const { q, runner } = queue({ concurrency: 1 });
  await q.submit(request({ subject: 'blocker' }), { keyLabel: 'a' });

  const first = await q.submit(request({ subject: 'wool runner', terms: ['quality'] }), { keyLabel: 'a' });
  const second = await q.submit(request({ subject: 'wool runner', terms: ['price'] }), { keyLabel: 'b' });
  assert.deepEqual((second as { accepted: { termsDeferred: string[] } }).accepted.termsDeferred, []);
  assert.equal((first as { accepted: { queuePosition: number | null } }).accepted.queuePosition, 1);

  runner.finish();
  await settled();
  const planned = runner.calls[1]?.request.terms;
  assert.deepEqual(planned, ['quality', 'price'], 'both callers questions were planned');
});

test('A JOINER ARRIVING MID FLIGHT GETS ITS EXTRA TERMS BACK AS DEFERRED', async () => {
  const { q, runner } = queue();
  await q.submit(request({ terms: ['quality'] }), { keyLabel: 'a' });
  const second = await q.submit(request({ terms: ['quality', 'price'] }), { keyLabel: 'b' });

  /*
   * The run had already planned its queries, so `price` is never searched
   * upstream. Reported rather than silently answered thin, and never by
   * starting a second full run, which would defeat coalescing entirely.
   */
  assert.deepEqual((second as { accepted: { termsDeferred: string[] } }).accepted.termsDeferred, ['price']);
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0]?.request.terms, ['quality'], 'the plan was not changed under it');

  /* Its claims are still computed, from the corpus as it stands. */
  runner.finish();
  await settled();
  const id = (second as { accepted: { id: string } }).accepted.id;
  assert.equal(q.get(id)?.findings.length, 2);
  assert.deepEqual(q.get(id)?.termsDeferred, ['price']);
});

test('a finished run is not joinable, because its retrieval ended before the joiner asked', async () => {
  const { q, runner } = queue();
  await q.submit(request(), { keyLabel: 'a' });
  runner.finish();
  await settled();

  const second = await q.submit(request(), { keyLabel: 'b' });
  assert.equal((second as { accepted: { coalesced: boolean } }).accepted.coalesced, false);
  assert.equal(runner.calls.length, 2, 'a fresh run, not a stale one handed over');
});

/* ------------------------------------------------------------------ */
/* cancellation                                                        */
/* ------------------------------------------------------------------ */

test('CANCELLING A COALESCED REPORT DOES NOT CANCEL SOMEBODY ELSE RUN', async () => {
  const { q, runner } = queue();
  const a = (await q.submit(request(), { keyLabel: 'a' }) as { accepted: { id: string } }).accepted.id;
  const b = (await q.submit(request(), { keyLabel: 'b' }) as { accepted: { id: string } }).accepted.id;

  assert.equal(q.cancel(a)?.status, 'cancelled');
  assert.equal(runner.calls[0]?.ctx.signal.aborted, false, 'the run continues for b');

  runner.finish();
  await settled();
  assert.equal(q.get(b)?.status, 'complete', 'b got its report');
  assert.equal(q.get(a)?.status, 'cancelled', 'and a stayed cancelled');
  assert.deepEqual(q.get(a)?.findings, [], 'a cancelled report gets no claims');
});

test('the run aborts when the LAST attached report detaches', async () => {
  const { q, runner } = queue();
  const a = (await q.submit(request(), { keyLabel: 'a' }) as { accepted: { id: string } }).accepted.id;
  const b = (await q.submit(request(), { keyLabel: 'b' }) as { accepted: { id: string } }).accepted.id;

  q.cancel(a);
  assert.equal(runner.calls[0]?.ctx.signal.aborted, false);
  q.cancel(b);
  assert.equal(runner.calls[0]?.ctx.signal.aborted, true, 'nobody is waiting, so stop spending');
});

test('cancelling a queued run frees the worker for the next one', async () => {
  const { q, runner } = queue({ concurrency: 1 });
  await q.submit(request({ subject: 'first' }), { keyLabel: 'a' });
  const queued = (await q.submit(request({ subject: 'second' }), { keyLabel: 'a' }) as { accepted: { id: string } }).accepted.id;
  await q.submit(request({ subject: 'third' }), { keyLabel: 'a' });

  q.cancel(queued);
  runner.finish();
  await settled();

  /* `second` was abandoned while waiting, so it must never have been run. */
  assert.deepEqual(runner.calls.map((c) => c.request.subject), ['first', 'third']);
});

test('cancelling a finished report is a no op that still returns it', async () => {
  const { q, runner } = queue();
  const id = (await q.submit(request(), { keyLabel: 'a' }) as { accepted: { id: string } }).accepted.id;
  runner.finish();
  await settled();

  assert.equal(q.cancel(id)?.status, 'complete', 'already finished, so nothing to cancel');
});

/* ------------------------------------------------------------------ */
/* idempotency                                                         */
/* ------------------------------------------------------------------ */

test('a replayed idempotency key returns the original report rather than a second job', async () => {
  const { q, runner } = queue();
  const first = await q.submit(request(), { keyLabel: 'a', idempotencyKey: 'retry-me-please' });
  const again = await q.submit(request(), { keyLabel: 'a', idempotencyKey: 'retry-me-please' });

  assert.equal(
    (first as { accepted: { id: string } }).accepted.id,
    (again as { accepted: { id: string } }).accepted.id,
  );
  assert.equal(runner.calls.length, 1);
});

test('the same key with a different body is a 409, never a silently wrong answer', async () => {
  const { q } = queue();
  await q.submit(request({ terms: ['quality'] }), { keyLabel: 'a', idempotencyKey: 'same-key-here' });
  const conflict = await q.submit(request({ terms: ['price'] }), { keyLabel: 'a', idempotencyKey: 'same-key-here' });

  assert.equal(conflict.ok, false);
  assert.equal((conflict as { status: number }).status, 409);
});

test('term order is not a different body, because a set was asked for', async () => {
  const { q } = queue();
  const first = await q.submit(request({ terms: ['quality', 'price'] }), { keyLabel: 'a', idempotencyKey: 'ordering-key' });
  const again = await q.submit(request({ terms: ['price', 'quality'] }), { keyLabel: 'a', idempotencyKey: 'ordering-key' });
  assert.equal(again.ok, true);
  assert.equal(
    (again as { accepted: { id: string } }).accepted.id,
    (first as { accepted: { id: string } }).accepted.id,
  );
});

test('one key cannot replay another key idempotency key', async () => {
  const { q } = queue();
  const mine = await q.submit(request(), { keyLabel: 'a', idempotencyKey: 'shared-string' });
  const theirs = await q.submit(request(), { keyLabel: 'b', idempotencyKey: 'shared-string' });
  assert.notEqual(
    (mine as { accepted: { id: string } }).accepted.id,
    (theirs as { accepted: { id: string } }).accepted.id,
  );
});

test('an idempotency record expires, so a key is reusable a day later', async () => {
  let clock = 1_000_000;
  const { q } = queue({ now: () => clock, idempotencyTtlMs: 1000 });
  const first = await q.submit(request(), { keyLabel: 'a', idempotencyKey: 'expiring-key' });
  clock += 5000;
  const later = await q.submit(request({ terms: ['different'] }), { keyLabel: 'a', idempotencyKey: 'expiring-key' });

  assert.equal(later.ok, true, 'a different body is no longer a conflict once the record has expired');
  assert.notEqual(
    (later as { accepted: { id: string } }).accepted.id,
    (first as { accepted: { id: string } }).accepted.id,
  );
});

/* ------------------------------------------------------------------ */
/* limits                                                              */
/* ------------------------------------------------------------------ */

test('THE QUEUE SAYS 503 RATHER THAN ACCEPTING WORK IT CANNOT DO', async () => {
  const { q } = queue({ concurrency: 1, maxQueued: 1, maxPerKey: 99 });
  await q.submit(request({ subject: 'one' }), { keyLabel: 'a' });
  await q.submit(request({ subject: 'two' }), { keyLabel: 'a' });
  const full = await q.submit(request({ subject: 'three' }), { keyLabel: 'a' });

  assert.equal(full.ok, false);
  assert.equal((full as { status: number }).status, 503);
  /* And it says what to do instead, because a warm category costs nothing. */
  assert.match((full as { message: string }).message, /categories/);
});

test('a saturated queue still coalesces, because joining costs no upstream capacity', async () => {
  const { q } = queue({ concurrency: 1, maxQueued: 1, maxPerKey: 99 });
  await q.submit(request({ subject: 'one' }), { keyLabel: 'a' });
  await q.submit(request({ subject: 'two' }), { keyLabel: 'a' });
  const joiner = await q.submit(request({ subject: 'two' }), { keyLabel: 'b' });

  assert.equal(joiner.ok, true, 'joining an existing run adds no work');
  assert.equal((joiner as { accepted: { coalesced: boolean } }).accepted.coalesced, true);
});

test('one key cannot hold every worker, which a request rate limit would not prevent', async () => {
  const { q } = queue({ maxPerKey: 2, concurrency: 5 });
  await q.submit(request({ subject: 'one' }), { keyLabel: 'greedy' });
  await q.submit(request({ subject: 'two' }), { keyLabel: 'greedy' });
  const third = await q.submit(request({ subject: 'three' }), { keyLabel: 'greedy' });

  assert.equal(third.ok, false);
  assert.equal((third as { status: number }).status, 429);

  /* Another key is unaffected, because this is a fairness cap and not a
   * global one. */
  const other = await q.submit(request({ subject: 'four' }), { keyLabel: 'polite' });
  assert.equal(other.ok, true);
});

test('a finished report releases the per key allowance', async () => {
  const { q, runner } = queue({ maxPerKey: 1 });
  await q.submit(request({ subject: 'one' }), { keyLabel: 'k' });
  runner.finish();
  await settled();

  const next = await q.submit(request({ subject: 'two' }), { keyLabel: 'k' });
  assert.equal(next.ok, true);
});

test('concurrency is a limit on upstream pressure, not a suggestion', async () => {
  const { q, runner } = queue({ concurrency: 2, maxPerKey: 9 });
  for (const subject of ['a', 'b', 'c', 'd']) {
    await q.submit(request({ subject }), { keyLabel: 'k' });
  }
  assert.equal(runner.calls.length, 2);
  assert.deepEqual(q.stats(), { queued: 2, running: 2, reports: 4 });
});

/* ------------------------------------------------------------------ */
/* events and resume                                                   */
/* ------------------------------------------------------------------ */

test('events carry monotonic ids so a dropped connection resumes rather than restarts', async () => {
  const { q, runner } = queue();
  const id = (await q.submit(request(), { keyLabel: 'a' }) as { accepted: { id: string } }).accepted.id;

  runner.calls[0]!.ctx.onStage('plan', 'six queries');
  runner.calls[0]!.ctx.onDegraded({ source: 'hackernews', reason: 'returned nothing' });
  runner.finish();
  await settled();

  const all = q.eventsSince(id, 0)!;
  assert.deepEqual(all.map((e) => e.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(all.map((e) => e.type), ['stage', 'stage', 'degraded', 'finding', 'done']);

  /* Resuming from event 3 replays only what was missed. */
  assert.deepEqual(q.eventsSince(id, 3)!.map((e) => e.type), ['finding', 'done']);
});

test('a run event reaches every attached report, and each numbers it for itself', async () => {
  const { q, runner } = queue();
  const a = (await q.submit(request(), { keyLabel: 'a' }) as { accepted: { id: string } }).accepted.id;
  runner.calls[0]!.ctx.onStage('plan');
  const b = (await q.submit(request(), { keyLabel: 'b' }) as { accepted: { id: string } }).accepted.id;
  runner.calls[0]!.ctx.onStage('retrieve');

  /* b joined late, so its stream starts where it joined rather than pretending
   * it saw the beginning. */
  assert.deepEqual(q.eventsSince(a, 0)!.map((e) => e.data), [
    { stage: 'retrieve', state: 'started' }, { stage: 'plan' }, { stage: 'retrieve' },
  ]);
  assert.deepEqual(q.eventsSince(b, 0)!.map((e) => e.data), [{ stage: 'retrieve' }]);
  assert.equal(q.eventsSince(b, 0)![0]?.id, 1, 'ids are per report, so a resume is unambiguous');
});

test('nextEvent wakes on the next event and never on one already delivered', async () => {
  const { q, runner } = queue();
  const id = (await q.submit(request(), { keyLabel: 'a' }) as { accepted: { id: string } }).accepted.id;
  const pending = q.nextEvent(id, 1);
  runner.calls[0]!.ctx.onStage('plan');
  assert.deepEqual((await pending)?.data, { stage: 'plan' });
});

test('nextEvent on a terminal report resolves null rather than hanging forever', async () => {
  const { q, runner } = queue();
  const id = (await q.submit(request(), { keyLabel: 'a' }) as { accepted: { id: string } }).accepted.id;
  runner.finish();
  await settled();

  const last = q.eventsSince(id, 0)!.at(-1)!.id;
  assert.equal(await q.nextEvent(id, last), null, 'the report is done and there will never be another');
});

test('an aborted subscriber stops waiting and leaves nothing behind', async () => {
  const { q } = queue();
  const id = (await q.submit(request(), { keyLabel: 'a' }) as { accepted: { id: string } }).accepted.id;
  const controller = new AbortController();
  const waiting = q.nextEvent(id, 99, controller.signal);
  controller.abort();
  assert.equal(await waiting, null);
});

test('the version changes exactly when the report advances, which is what an ETag needs', async () => {
  const { q, runner } = queue();
  const id = (await q.submit(request(), { keyLabel: 'a' }) as { accepted: { id: string } }).accepted.id;
  const first = q.get(id)!.version;
  assert.equal(q.get(id)!.version, first, 'polling does not change it');
  runner.calls[0]!.ctx.onStage('plan');
  assert.notEqual(q.get(id)!.version, first);
});

/* ------------------------------------------------------------------ */
/* the key itself                                                      */
/* ------------------------------------------------------------------ */

test('the coalescing key normalises case and whitespace and nothing else', () => {
  assert.equal(coalescingKey(request({ subject: '  Wool   Runner ' })), 'wool runner');
  assert.notEqual(
    coalescingKey(request({ subject: 'https://a.test/x' })),
    coalescingKey(request({ subject: 'https://a.test/y' })),
    'two links to the same product miss, and that costs a duplicate run rather than a wrong answer',
  );
});

test('shutdown aborts every run rather than leaving them spending', async () => {
  const { q, runner } = queue();
  await q.submit(request(), { keyLabel: 'a' });
  q.shutdown();
  assert.equal(runner.calls[0]?.ctx.signal.aborted, true);
});

test('THE CLAIMS FUNCTION SEES WHAT THE RUN ACTUALLY DID, NOT JUST ITS CATEGORY', async () => {
  /*
   * FOUND LIVE 2026-08-22. Passing only the category meant sufficiency was
   * computed with no retrieval, so a real report printed "seen 41, gated 19"
   * in its retrieval table and "seen 0, rejected 0, stored 0" three blocks
   * below it, then advised the caller to pass a product URL they had already
   * passed. A report that contradicts its own working is worse than one that
   * says nothing.
   */
  const seen: unknown[] = [];
  const { q, runner } = queue({
    claimsFor: async (outcome) => {
      seen.push({ retrieval: outcome.retrieval, subjectResolved: outcome.subjectResolved });
      return {
        findings: [], weakSignals: [], rejected: [],
        sufficiency: null, receiptCheck: null, trends: [], voice: [], themes: [],
      };
    },
  });
  await q.submit(request(), { keyLabel: 'a' });
  runner.finish({ retrieval: { totalSeen: 41, totalWritten: 22 }, subjectResolved: true });
  await settled();

  assert.deepEqual(seen, [{ retrieval: { totalSeen: 41, totalWritten: 22 }, subjectResolved: true }]);
});
