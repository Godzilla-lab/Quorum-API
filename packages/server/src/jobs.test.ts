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

/*
 * Wait for a run to reach its terminal state.
 *
 * THIS USED TO BE FOUR MICROTASK TURNS, chosen because the settle path was one
 * turn for the runner's promise and one for the per report claims loop in its
 * `finally`. On 2026-08-23 `finishReport` became async, so each report in the
 * loop costs additional turns, and a fixed count silently stopped covering the
 * SECOND report of a coalesced run: a test asserting two webhooks saw one, and
 * the code was right.
 *
 * A macrotask boundary drains every pending microtask however many there are,
 * so this no longer has to be kept in step with the number of awaits on the
 * path. Counting turns was the bug.
 */
const settled = async (): Promise<void> => {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
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

/* ------------------------------------------------------------------ */
/* webhooks                                                            */
/* ------------------------------------------------------------------ */

/* Records what the queue asked to have delivered, without delivering it. */
function webhookRecorder() {
  const enqueued: { reportId: string; tenantId: string; keyLabel: string; url: string; payload: string }[] = [];
  return {
    enqueued,
    enqueueWebhook: async (d: { reportId: string; tenantId: string; keyLabel: string; url: string; payload: string }) => {
      enqueued.push(d);
    },
  };
}

test('a completed report with a webhook url is queued for delivery', async () => {
  const hook = webhookRecorder();
  const { q, runner } = queue({ enqueueWebhook: hook.enqueueWebhook });
  const accepted = await q.submit(request({ webhookUrl: 'https://receiver.example/hook' }), { keyLabel: 'key-1' });
  runner.finish();
  await settled();

  assert.equal(hook.enqueued.length, 1);
  assert.equal(hook.enqueued[0]?.url, 'https://receiver.example/hook');
  assert.equal(hook.enqueued[0]?.keyLabel, 'key-1', 'the key label selects the signing secret');
  /* The row is tenant owned. It carried NULL until 2026-08-23, which made its
   * RLS policy match nothing, exactly as reports did. */
  assert.equal(hook.enqueued[0]?.tenantId, 'key-1', 'the delivery row must name its tenant');
  assert.equal(hook.enqueued[0]?.reportId, (accepted as { accepted: { id: string } }).accepted.id);
});

/*
 * The payload has to be the same bytes GET /v1/reports/{id} serves, because
 * that is what a receiver compares against and what the signature covers.
 */
test('the queued payload is byte identical to the report body', async () => {
  const hook = webhookRecorder();
  const { q, runner } = queue({ enqueueWebhook: hook.enqueueWebhook });
  const accepted = await q.submit(request({ webhookUrl: 'https://receiver.example/hook' }), { keyLabel: 'key-1' });
  runner.finish();
  await settled();

  const id = (accepted as { accepted: { id: string } }).accepted.id;
  assert.equal(hook.enqueued[0]?.payload, JSON.stringify(q.get(id), null, 2));
});

test('a report with no webhook url queues nothing', async () => {
  const hook = webhookRecorder();
  const { q, runner } = queue({ enqueueWebhook: hook.enqueueWebhook });
  await q.submit(request(), { keyLabel: 'key-1' });
  runner.finish();
  await settled();
  assert.deepEqual(hook.enqueued, []);
});

/* A caller who cancelled does not need to be told their report finished, which
 * is why cancel deliberately bypasses the terminal path. */
test('a cancelled report never fires its webhook', async () => {
  const hook = webhookRecorder();
  const { q, runner } = queue({ enqueueWebhook: hook.enqueueWebhook });
  const accepted = await q.submit(request({ webhookUrl: 'https://receiver.example/hook' }), { keyLabel: 'key-1' });
  q.cancel((accepted as { accepted: { id: string } }).accepted.id);
  runner.finish();
  await settled();
  assert.deepEqual(hook.enqueued, []);
});

test('a failed report still fires its webhook, because failure is an outcome', async () => {
  const hook = webhookRecorder();
  const { q, runner } = queue({ enqueueWebhook: hook.enqueueWebhook });
  await q.submit(request({ webhookUrl: 'https://receiver.example/hook' }), { keyLabel: 'key-1' });
  runner.throw('upstream fell over');
  await settled();
  assert.equal(hook.enqueued.length, 1);
});

/*
 * THE COALESCING CASE, which is where a webhook implementation goes wrong.
 * One run serves both reports, and each must go to its own caller's url. A
 * fan out from the run would send one customer's report to another's endpoint.
 */
test('two reports coalesced onto one run each get their own webhook', async () => {
  const hook = webhookRecorder();
  const { q, runner } = queue({ enqueueWebhook: hook.enqueueWebhook });
  await q.submit(request({ webhookUrl: 'https://first.example/hook' }), { keyLabel: 'key-1' });
  await q.submit(request({ webhookUrl: 'https://second.example/hook' }), { keyLabel: 'key-2' });
  runner.finish();
  await settled();

  assert.equal(runner.calls.length, 1, 'one retrieval serves both');
  assert.equal(hook.enqueued.length, 2);
  assert.deepEqual(
    hook.enqueued.map((e) => e.url).sort(),
    ['https://first.example/hook', 'https://second.example/hook'],
  );
  assert.deepEqual(hook.enqueued.map((e) => e.keyLabel).sort(), ['key-1', 'key-2']);
  assert.deepEqual(hook.enqueued.map((e) => e.tenantId).sort(), ['key-1', 'key-2'],
    'each delivery belongs to the caller that asked for it, never to the run');
});

/* An enqueue that throws must not fail a report that itself succeeded and is
 * readable over the API. */
test('a webhook that cannot be queued does not fail the report', async () => {
  const { q, runner } = queue({ enqueueWebhook: async () => { throw new Error('database is down'); } });
  const accepted = await q.submit(request({ webhookUrl: 'https://receiver.example/hook' }), { keyLabel: 'key-1' });
  runner.finish();
  await settled();
  assert.equal(q.get((accepted as { accepted: { id: string } }).accepted.id)?.status, 'complete');
});

/*
 * The idempotency fingerprint omitted webhookUrl until 2026-08-23, so a caller
 * reusing a key with a new url got the first submit replayed and their new url
 * silently dropped. Silent is the part that matters.
 */
test('reusing an idempotency key with a different webhook url is a conflict', async () => {
  const { q } = queue();
  const first = await q.submit(
    request({ webhookUrl: 'https://first.example/hook' }),
    { keyLabel: 'key-1', idempotencyKey: 'same-key' },
  );
  assert.equal(first.ok, true);

  const second = await q.submit(
    request({ webhookUrl: 'https://second.example/hook' }),
    { keyLabel: 'key-1', idempotencyKey: 'same-key' },
  );
  assert.equal(second.ok, false, 'a different destination is a different request, not a replay');
  assert.equal((second as { status: number }).status, 409);
});

test('reusing an idempotency key with the same webhook url is still a replay', async () => {
  const { q } = queue();
  const first = await q.submit(
    request({ webhookUrl: 'https://first.example/hook' }),
    { keyLabel: 'key-1', idempotencyKey: 'same-key' },
  );
  const second = await q.submit(
    request({ webhookUrl: 'https://first.example/hook' }),
    { keyLabel: 'key-1', idempotencyKey: 'same-key' },
  );
  assert.equal(second.ok, true);
  assert.equal(
    (second as { accepted: { id: string } }).accepted.id,
    (first as { accepted: { id: string } }).accepted.id,
  );
});

/*
 * The estimate is cosmetic, and a cosmetic number must never refuse a submit.
 * Until 2026-08-23 estimateSeconds throwing (a database timeout while the free
 * tier instance wakes) 500ed the whole POST even though the job was already
 * registered and running. Found end to end against the real database under
 * load, which no unit test had simulated.
 */
test('an estimate that cannot be computed degrades to null, never a refusal', async () => {
  const { q } = queue({ estimateSeconds: async () => { throw new Error('Connection terminated due to connection timeout'); } });
  const accepted = await q.submit(request(), { keyLabel: 'key-1' });
  assert.equal(accepted.ok, true, 'the submit must be accepted');
  assert.equal((accepted as { accepted: { estimatedSeconds: number | null } }).accepted.estimatedSeconds, null);
});
