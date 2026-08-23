import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openPostgresCorpus, type SqlExecutor } from './postgres.ts';
import { receiptId } from '../receipt-id.ts';

/*
 * A recording executor.
 *
 * This does NOT test Postgres. It tests the driver's own logic: what SQL it
 * builds, what it binds, and what it does with rows on the way back. Those are
 * real and worth locking down, and they are the parts that would otherwise sit
 * completely unexercised until a database appears.
 *
 * What remains genuinely unverified is whether Postgres accepts and correctly
 * executes this SQL. See the note at the bottom of this file.
 */
interface Call { sql: string; params: readonly unknown[] }

function recorder(responses: Record<string, unknown[]> = {}) {
  const calls: Call[] = [];
  const sql: SqlExecutor = {
    async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      calls.push({ sql: text, params });
      for (const [fragment, rows] of Object.entries(responses)) {
        if (text.includes(fragment)) return rows as T[];
      }
      return [];
    },
  };
  return { sql, calls, last: () => calls[calls.length - 1] };
}

const clock = () => 1_700_000_000;

test('postgres: addDocs derives the receipt id rather than trusting the caller', async () => {
  const r = recorder({ RETURNING: [{ id: 1 }] });
  const c = openPostgresCorpus({ sql: r.sql, now: clock });

  const added = await c.addDocs(
    [{ source: 'reddit', kind: 'comment', externalId: 't1_abc', text: 'sizing runs small' }],
    'running shoes',
  );

  assert.equal(added, 1, 'RETURNING id counts only genuinely new rows');
  const call = r.last();
  assert.ok(call);
  assert.equal(call.params[0], receiptId('reddit', 't1_abc'), 'the id is computed from content, not supplied');
  assert.match(call.sql, /ON CONFLICT \(source, external_id, category\) DO NOTHING/);
  assert.equal(call.params.length, 11);
  assert.equal(call.params[10], clock(), 'harvested_at comes from the injected clock');
});

test('postgres: records without text or an external id never reach the database', async () => {
  const r = recorder({ RETURNING: [{ id: 1 }] });
  const c = openPostgresCorpus({ sql: r.sql, now: clock });

  await c.addDocs([
    { source: 'reddit', kind: 'comment', externalId: '', text: 'orphan' },
    { source: 'reddit', kind: 'comment', externalId: 'x', text: '' },
  ], 'running shoes');

  assert.equal(r.calls.length, 0, 'skipped rows are skipped before the round trip, not after');
});

/*
 * THE REGRESSION GUARD.
 *
 * The whole reason ad_observations exists is that the engine wrote ads through
 * a conflict-ignoring insert, so every sighting after the first was discarded.
 * If an ON CONFLICT clause ever appears on this statement, that defect is back.
 */
test('postgres: the ad observation insert has no conflict clause', async () => {
  const r = recorder();
  const c = openPostgresCorpus({ sql: r.sql, now: clock });

  await c.addAdObservations([{
    adId: 'ad_1', advertiser: 'Acme', category: 'running shoes', body: 'copy',
    creative: 'video', isActive: true, daysRunning: 30, durationConfidence: 'observed',
  }]);

  const call = r.last();
  assert.ok(call);
  assert.match(call.sql, /INSERT INTO ad_observations/);
  assert.doesNotMatch(call.sql, /ON CONFLICT/, 'a second sighting is evidence, never a duplicate to collapse');
  assert.doesNotMatch(call.sql, /DO NOTHING/);
});

test('postgres: an unusable query short circuits without touching the database', async () => {
  const r = recorder();
  const c = openPostgresCorpus({ sql: r.sql, now: clock });

  assert.deepEqual(await c.search('a to at'), []);
  assert.deepEqual(await c.search('   '), []);
  assert.deepEqual(await c.getByReceiptIds([]), []);
  assert.equal(r.calls.length, 0);
});

test('postgres: search binds an OR tsquery, matching the sqlite driver', async () => {
  const r = recorder();
  const c = openPostgresCorpus({ sql: r.sql, now: clock });

  await c.search('sizing durability', { category: 'running shoes', minScore: 10, source: 'reddit' });

  const call = r.last();
  assert.ok(call);
  assert.equal(call.params[0], 'sizing | durability', 'OR, not AND, or the hosted driver returns a fraction of the rows');
  assert.match(call.sql, /to_tsquery\('english', \$1\)/);
  assert.deepEqual(call.params.slice(1), ['running shoes', 'reddit', 10, 200]);
});

test('postgres: one receipt id matching several rows collapses to one record', async () => {
  const row = {
    receipt_id: 'rc_0123456789abcdef', source: 'reddit', kind: 'comment', external_id: 'shared',
    channel: 'running', text: 'runs small', score: '12', url: '', created_utc: '0', harvested_at: '1700000000',
  };
  /* The same utterance harvested into two categories is two rows. */
  const r = recorder({ 'receipt_id = ANY': [{ ...row, category: 'running shoes' }, { ...row, category: 'trail shoes' }] });
  const c = openPostgresCorpus({ sql: r.sql, now: clock });

  const found = await c.getByReceiptIds(['rc_0123456789abcdef']);
  assert.equal(found.length, 1, 'or corroboration counts this person twice');
  assert.equal(found[0]?.score, 12, 'bigint and integer columns arrive as strings and must be coerced');
});

test('postgres: bigint columns arriving as strings are coerced, not concatenated', async () => {
  const r = recorder({
    'SELECT (SELECT COUNT(*) FROM docs)': [{ docs: '42', categories: '3', reports: '7', ad_observations: '11' }],
  });
  const c = openPostgresCorpus({ sql: r.sql, now: clock });

  assert.deepEqual(await c.totals(), { docs: 42, categories: 3, reports: 7, adObservations: 11 });
});

test('postgres: latest ads are keyed on MAX(id), which cannot tie', async () => {
  const r = recorder();
  const c = openPostgresCorpus({ sql: r.sql, now: clock });
  await c.latestAdsByCategory('running shoes');

  const call = r.last();
  assert.ok(call);
  assert.match(call.sql, /SELECT MAX\(id\) FROM ad_observations/);
  assert.doesNotMatch(call.sql, /MAX\(observed_at\)/, 'observations in the same second share a timestamp and would tie');
});

test('postgres: delete reports the number of rows actually removed', async () => {
  const r = recorder({ 'DELETE FROM docs': [{ id: 1 }, { id: 2 }] });
  const c = openPostgresCorpus({ sql: r.sql, now: clock });
  assert.equal(await c.deleteByExternalId('reddit', 'shared'), 2, 'a takedown is not scoped to one category');
});

test('postgres: close does not disconnect a client it does not own', async () => {
  const r = recorder();
  const c = openPostgresCorpus({ sql: r.sql, now: clock });
  await c.close();
  assert.equal(r.calls.length, 0);
});


/*
 * NUL sanitisation, asserted on what is BOUND rather than on what a server
 * does with it. Postgres refuses a NUL in a text column, so a parameter
 * carrying one is a failed write and, inside a transaction, a discarded batch.
 * There is no live database in this suite, and the bound value is the last
 * thing the driver controls, so it is the honest place to draw the line.
 */
const NUL = String.fromCharCode(0);

const carriesNul = (params: readonly unknown[]): boolean =>
  params.some((p) => typeof p === 'string' && p.includes(NUL));

test('postgres: A NUL NEVER REACHES A BOUND PARAMETER ON THE DOC PATH', async () => {
  const r = recorder({ RETURNING: [{ id: 1 }] });
  const c = openPostgresCorpus({ sql: r.sql, now: clock });

  await c.addDocs([{
    source: 'reddit',
    kind: 'comment',
    externalId: `t1_${NUL}abc`,
    channel: `r/run${NUL}ning`,
    text: `sizing${NUL}runs small`,
    url: `https://r.test/${NUL}x`,
  }], `running${NUL}shoes`);

  const call = r.last();
  assert.ok(call);
  assert.equal(carriesNul(call.params), false, JSON.stringify(call.params));
  /* Replaced by a space rather than deleted, so it cannot weld two words into
   * one that nobody wrote. */
  assert.equal(call.params[6], 'sizing runs small');
  /* And the id is minted from the SANITISED external id, so it re-derives from
   * the value actually stored. */
  assert.equal(call.params[0], receiptId('reddit', 't1_ abc'));
  assert.equal(call.params[3], 't1_ abc');
});

test('postgres: a NUL never reaches a bound parameter on the ad path', async () => {
  const r = recorder();
  const c = openPostgresCorpus({ sql: r.sql, now: clock });

  await c.addAdObservations([{
    adId: `ad_${NUL}1`,
    advertiser: `Ac${NUL}me`,
    category: 'running shoes',
    body: `buy${NUL}now`,
    cta: `Shop${NUL}now`,
    url: `https://fb.test/${NUL}1`,
    creative: 'video',
    platforms: ['facebook'],
    startDate: 1_700_000_000,
    endDate: null,
    isActive: true,
    daysRunning: 10,
    durationConfidence: 'reported',
  }]);

  const call = r.last();
  assert.ok(call);
  assert.equal(carriesNul(call.params), false, JSON.stringify(call.params));
  assert.equal(call.params[3], 'buy now');
});

test('postgres: a newline in a record is content and is bound unchanged', async () => {
  const r = recorder({ RETURNING: [{ id: 1 }] });
  const c = openPostgresCorpus({ sql: r.sql, now: clock });

  const text = 'first para about sizing\n\nsecond para about durability';
  await c.addDocs([{ source: 'reddit', kind: 'comment', externalId: 'multi', text }], 'running shoes');

  assert.equal(r.last()?.params[6], text, 'a comment has paragraphs and this is the only copy');
});

/*
 * RUN, on 2026-08-22, against PostgreSQL 17.10. All 32 conformance tests pass,
 * plus 10 row level security tests and 4 concurrency tests. Zero failures.
 *
 * The NUL tests above and their conformance twins were the reason for the
 * second run of the day: a fake cannot reject a value that Postgres rejects,
 * so a sanitiser proven only against a recording executor is a sanitiser
 * nobody has watched work.
 *
 * The suite lives in `postgres.conformance.test.ts` and is gated on
 * `RECEIPTS_PG_URL`, so `npm test` stays offline and keyless while the real run
 * is one environment variable away. See `docs/postgres.md`.
 *
 * The tests above use a recording fake and are still worth keeping: they prove
 * the driver issues the SQL it means to issue, cheaply and with no server. What
 * they cannot prove is that the SQL is valid Postgres, which is exactly the gap
 * that let `002_rls.sql` sit in the repo unable to run at all.
 */
