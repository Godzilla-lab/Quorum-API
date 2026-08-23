/*
 * The Postgres driver against a REAL PostgreSQL server.
 *
 * WHY THIS IS GATED ON AN ENVIRONMENT VARIABLE.
 *
 * `npm test` runs offline, keyless and with no services, and that property is
 * worth more than the convenience of running this by default. So the suite
 * skips unless `QUORUM_PG_URL` points at a database, and CI stays green on a
 * bare runner.
 *
 * It is not a token skip. Every test in the shared conformance suite runs
 * against a real server when the variable is set, in a schema of its own that
 * RUN THIS SERIALLY. `npm run test:postgres` passes --test-concurrency=1, and
 * it has to: the harness opens a connection per test, node:test defaults to one
 * worker per core, and a managed database allows far fewer connections than a
 * laptop has cores. Measured 2026-08-23 against an Aiven free instance with a
 * 20 connection limit: 18 of 32 tests failed in parallel and all 32 passed
 * serially. The schema was never the problem, and eighteen red tests that mean
 * "too many connections" read exactly like eighteen red tests that mean "the
 * driver is broken".
 *
 * is dropped afterwards, using the migrations in `packages/corpus/migrations`
 * exactly as a deployment would apply them.
 *
 *   node --test packages/corpus/src/drivers/postgres.conformance.test.ts
 *   with QUORUM_PG_URL=postgres://user@127.0.0.1:5432/dbname
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT.
 *
 * It proves the SQL is valid Postgres and returns what the driver expects. It
 * does NOT prove the row level security policies work, because the migrations
 * are applied by the role that owns the tables, and a table owner bypasses RLS
 * unless the table is set to FORCE ROW LEVEL SECURITY. Testing the policies
 * needs a second, unprivileged role and is a separate exercise.
 */

import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runConformanceSuite } from '../conformance.ts';
import type { CorpusDriver } from '../driver.ts';
import { openPostgresCorpus } from './postgres.ts';
import { connectPgWire, parsePgUri } from './pg-wire.ts';

const PG_URL = process.env['QUORUM_PG_URL'];
const MIGRATIONS = join(fileURLToPath(new URL('.', import.meta.url)), '../../migrations');

if (!PG_URL) {
  test('postgres: conformance against a real database', { skip: 'set QUORUM_PG_URL to run this' }, () => {});
} else {
  /* Parsed rather than split by hand, so a hosted url works: `sslmode=require`
   * becomes a real TLS negotiation, and a password containing `@` or `/`
   * survives instead of being silently truncated. */
  const connection = parsePgUri(PG_URL);
  let counter = 0;

  runConformanceSuite('postgres', async (now?: () => number): Promise<CorpusDriver> => {
    /*
     * A schema per test rather than a database per test. Same isolation, far
     * cheaper, and it means a failing test leaves its schema behind for
     * inspection only if the drop never runs.
     */
    const schema = `conf_${process.pid}_${++counter}`;

    const client = await connectPgWire(connection);

    await client.exec(`CREATE SCHEMA ${schema}`);
    await client.exec(`SET search_path TO ${schema}`);
    for (const file of ['001_initial.sql', '002_rls.sql']) {
      await client.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    }

    const driver = openPostgresCorpus({ sql: client, ...(now ? { now } : {}) });

    return {
      ...driver,
      /* The driver deliberately does not close a connection it did not open, so
       * the harness that opened it closes it. */
      async close(): Promise<void> {
        await client.exec(`DROP SCHEMA ${schema} CASCADE`);
        await client.end();
      },
    };
  });
}
