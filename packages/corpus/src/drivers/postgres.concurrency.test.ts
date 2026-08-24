/*
 * Postgres under concurrent writers.
 *
 * WHY THIS IS NOT OPTIONAL.
 *
 * The capacity note in `docs/rate-limits.md` assumes Postgres handles what
 * SQLite could not, and an assumption in a capacity note is exactly the kind of
 * thing that is discovered to be wrong at the worst moment. SQLite was measured
 * rather than assumed, and the measurement was ugly: three processes opened one
 * corpus and TWO CRASHED with "database is locked", on the `journal_mode`
 * pragma, before either had written a row.
 *
 * So the same question gets asked of Postgres rather than answered by
 * reputation. Two shapes, because they fail differently:
 *
 *   DISJOINT   writers that never touch the same row. This is the ordinary
 *              case, many reports harvesting different categories at once, and
 *              it should scale cleanly.
 *
 *   OVERLAPPING  every writer inserting the SAME rows at the same time. This is
 *              the case that matters and the one nobody tests, because it is
 *              what coalescing failure looks like: two reports on the same
 *              popular product, racing on `ON CONFLICT (source, external_id,
 *              category) DO NOTHING`. Concurrent upserts on one unique key are
 *              where Postgres deadlocks if a driver holds locks in an
 *              inconsistent order.
 *
 * Gated on QUORUM_PG_URL like the rest of the Postgres suite.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { openPostgresCorpus } from './postgres.ts';
import { connectPgWire, parsePgUri, type PgWireClient } from './pg-wire.ts';
import type { CorpusDriver, DocInput } from '../index.ts';

const PG_URL = process.env['QUORUM_PG_URL'];
const MIGRATIONS = join(fileURLToPath(new URL('.', import.meta.url)), '../../migrations');

/*
 * Eight writers and 150 rows each, so the disjoint case writes 1200 rows. The
 * same 1200 the SQLite measurement used, so the two numbers compare.
 *
 * RUN THIS AGAINST A DATABASE NEAR YOU. It is calibrated for a local server at
 * about 0.1ms, and it is latency bound rather than concurrency bound: the work
 * is round trips, not contention. Measured 2026-08-23 from a laptop to an Aiven
 * instance in Amsterdam, the round trip was 174ms, roughly 1,700 times a local
 * one, and the suite blew through a 90 second timeout.
 *
 * That is not a driver defect and the throughput it would print is not a
 * finding, because across an ocean this measures the ocean. A deployment puts
 * the app beside the database, which is the case worth measuring.
 */
const WRITERS = 8;
const ROWS_PER_WRITER = 150;

if (!PG_URL) {
  test('postgres: concurrent writers', { skip: 'set QUORUM_PG_URL to run this' }, () => {});
} else {
  /* Parsed, not split: a hosted url needs its sslmode honoured and its
   * password decoded. See parsePgUri. */
  const connection = parsePgUri(PG_URL);
  const connect = (): Promise<PgWireClient> => connectPgWire(connection);

  const doc = (i: number): DocInput => ({
    source: 'reddit',
    kind: 'comment',
    externalId: `t1_${i}`,
    channel: 'r/running',
    text: `record ${i}: these running shoes felt narrow after a week`,
    score: 1,
    url: `https://example.test/${i}`,
    createdUtc: 1_700_000_000,
  });

  test('postgres: concurrent writers', async (t) => {
    const schema = `conc_${process.pid}`;
    const owner = await connect();
    await owner.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await owner.exec(`CREATE SCHEMA ${schema}`);
    await owner.exec(`SET search_path TO ${schema}`);
    for (const file of ['001_initial.sql', '002_rls.sql', '003_webhook_deliveries.sql', '004_report_snapshots.sql']) {
      await owner.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    }

    /* One connection per writer. Sharing one would serialise the test and
     * measure nothing, since this client runs one statement at a time. */
    const clients: PgWireClient[] = [];
    const drivers: CorpusDriver[] = [];
    for (let i = 0; i < WRITERS; i++) {
      const client = await connect();
      await client.exec(`SET search_path TO ${schema}`);
      clients.push(client);
      drivers.push(openPostgresCorpus({ sql: client }));
    }

    try {
      await t.test(`${WRITERS} writers on disjoint rows all land`, async () => {
        const started = Date.now();
        const results = await Promise.allSettled(
          drivers.map((d, w) => d.addDocs(
            Array.from({ length: ROWS_PER_WRITER }, (_, i) => doc(w * ROWS_PER_WRITER + i)),
            'running shoes',
          )),
        );
        const elapsed = Date.now() - started;

        const failed = results.filter((r) => r.status === 'rejected');
        assert.equal(failed.length, 0,
          `${failed.length} of ${WRITERS} writers failed: ${failed.map((f) => String((f as PromiseRejectedResult).reason)).join('; ')}`);

        const [row] = await owner.query<{ n: unknown }>('SELECT COUNT(*) AS n FROM docs');
        const stored = Number(row?.n ?? 0);
        assert.equal(stored, WRITERS * ROWS_PER_WRITER,
          `${WRITERS * ROWS_PER_WRITER} rows were written and ${stored} landed`);

        console.log(`    measured: ${WRITERS} concurrent writers stored ${stored} of ${stored} rows in ${elapsed}ms`);
      });

      await t.test('every writer racing on the SAME rows deduplicates without deadlocking', async () => {
        /*
         * The coalescing failure case. All eight insert the identical 100 rows
         * at once. Exactly 100 must exist afterwards, and the "genuinely new"
         * counts must sum to 100 across all eight, because a row is new for
         * exactly one of them. If that sum were higher, `addDocs` would be
         * reporting work it did not do and a warm category would look colder
         * than it is.
         */
        const shared = Array.from({ length: 100 }, (_, i) => doc(100_000 + i));

        const started = Date.now();
        const results = await Promise.allSettled(
          drivers.map((d) => d.addDocs(shared, 'contested')),
        );
        const elapsed = Date.now() - started;

        const failed = results.filter((r) => r.status === 'rejected');
        assert.equal(failed.length, 0,
          `${failed.length} writers failed on contested rows: ${failed.map((f) => String((f as PromiseRejectedResult).reason)).join('; ')}`);

        const [row] = await owner.query<{ n: unknown }>("SELECT COUNT(*) AS n FROM docs WHERE category = 'contested'");
        assert.equal(Number(row?.n ?? 0), 100, 'the unique constraint did not hold under concurrency');

        const claimedNew = results
          .filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled')
          .reduce((sum, r) => sum + r.value, 0);
        assert.equal(claimedNew, 100,
          `writers between them claimed ${claimedNew} new rows for 100 actual rows`);

        console.log(`    measured: ${WRITERS} writers racing on 100 identical rows settled in ${elapsed}ms, no deadlock`);
      });

      await t.test('an ad is observed once per writer, because observations are append only', async () => {
        /*
         * The mirror image of the test above, and it must come out the other
         * way. Two sightings of one ad are the evidence it is still running, so
         * concurrency here must NOT deduplicate.
         */
        const observation = {
          adId: 'ad_contested', advertiser: 'Acme', category: 'contested',
          body: 'The shoe that fits', cta: 'Shop now', url: 'https://example.test/ad',
          creative: 'video' as const, platforms: ['facebook'],
          startDate: 1_700_000_000, endDate: null, isActive: true,
          daysRunning: 30, durationConfidence: 'observed' as const,
        };

        const results = await Promise.allSettled(drivers.map((d) => d.addAdObservations([observation])));
        assert.equal(results.filter((r) => r.status === 'rejected').length, 0);

        const [row] = await owner.query<{ n: unknown }>("SELECT COUNT(*) AS n FROM ad_observations WHERE ad_id = 'ad_contested'");
        assert.equal(Number(row?.n ?? 0), WRITERS,
          'concurrent observations of one ad collapsed, which is the exact defect the append only table exists to prevent');
      });
    } finally {
      for (const client of clients) await client.end();
      await owner.exec(`DROP SCHEMA ${schema} CASCADE`);
      await owner.end();
    }
  });
}
