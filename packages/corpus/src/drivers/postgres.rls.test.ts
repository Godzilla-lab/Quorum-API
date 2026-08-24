/*
 * Row level security, exercised by a role that is not the table owner.
 *
 * WHY THE CONFORMANCE SUITE CANNOT COVER THIS.
 *
 * Conformance applies the migrations and then talks to the database as the role
 * that owns the tables. A table owner BYPASSES row level security unless the
 * table is set to FORCE ROW LEVEL SECURITY. So conformance proves the policies
 * were created and proves nothing about what they do, and a green suite there
 * would sit happily on top of a policy that permitted everything.
 *
 * THE BOUNDARY BEING TESTED, and it is expensive to get wrong in both
 * directions at once:
 *
 *   docs, categories, ad_observations   GLOBAL, readable by anyone.
 *     Cross tenant warmth is the entire hosted product. A category one tenant
 *     paid to harvest answers instantly for the next one. Scoping these per
 *     tenant destroys the business.
 *
 *   reports, products                   TENANT OWNED.
 *     Customer work product. One tenant reading another's reports is a breach.
 *
 * The engine ran every read and write through the service role with RLS enabled
 * and no policy attached, so its effective policy was "trust the caller". These
 * tests are what replaces that.
 *
 * Gated on QUORUM_PG_URL, like the conformance suite, and it additionally
 * needs a role that can CREATE ROLE.
 */

import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { connectPgWire, parsePgUri, type PgWireClient } from './pg-wire.ts';

const PG_URL = process.env['QUORUM_PG_URL'];
const MIGRATIONS = join(fileURLToPath(new URL('.', import.meta.url)), '../../migrations');

if (!PG_URL) {
  test('postgres: row level security', { skip: 'set QUORUM_PG_URL to run this' }, () => {});
} else {
  /* Parsed, not split: a hosted url needs its sslmode honoured and its
   * password decoded. See parsePgUri. */
  const connection = parsePgUri(PG_URL);
  /*
   * Same connection, different role: this suite proves the policies by logging
   * in as a tenant rather than as the owner.
   *
   * THE TENANT ROLE NEEDS ITS OWN PASSWORD, and that is not a detail. Against a
   * local server using trust authentication, `CREATE ROLE ... LOGIN` with no
   * password logs in happily and this suite passed for months. Against any
   * managed database it fails with 28P01, because password authentication is
   * the only kind on offer. Measured 2026-08-23 against Aiven: the suite could
   * not run at all, which meant the tenant isolation policies had never been
   * verified anywhere that has tenants.
   *
   * Generated per run rather than fixed, so a role left behind by a crashed run
   * cannot be logged into by the next one.
   */
  const tenantPassword = randomBytes(18).toString('hex');
  const connect = (user: string): Promise<PgWireClient> => connectPgWire(
    user === connection.user
      ? connection
      : { ...connection, user, password: tenantPassword },
  );

  const OWNER = connection.user;
  const schema = `rls_${process.pid}`;
  const tenantRole = `rls_tenant_${process.pid}`;

  /*
   * One fixture for the whole file. Creating a role is cluster wide rather than
   * schema scoped, so doing it per test would leave debris behind on a failure.
   */
  const setup = async (): Promise<{ owner: PgWireClient; tenant: PgWireClient }> => {
    const owner = await connect(OWNER);
    await owner.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await owner.exec(`CREATE SCHEMA ${schema}`);
    await owner.exec(`SET search_path TO ${schema}`);
    for (const file of ['001_initial.sql', '002_rls.sql', '003_webhook_deliveries.sql', '004_report_snapshots.sql', '005_spend_ledger.sql']) {
      await owner.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    }

    /*
     * A tenant is an ordinary caller. It gets full table privileges on purpose,
     * so that anything it cannot do is row level security doing it and not a
     * missing GRANT standing in for a policy.
     */
    await owner.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${tenantRole}') THEN
          CREATE ROLE ${tenantRole} LOGIN PASSWORD '${tenantPassword}';
        END IF;
      END $$;
    `);
    await owner.exec(`GRANT USAGE ON SCHEMA ${schema} TO ${tenantRole}, service_role`);
    await owner.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${tenantRole}, service_role`);
    await owner.exec(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${tenantRole}, service_role`);

    /* Seed the shared corpus as the owner, which bypasses policy by design. */
    await owner.query(
      `INSERT INTO docs (receipt_id, source, kind, external_id, category, channel, text, harvested_at)
       VALUES ('rc_1111111111111111','reddit','comment','t1_a','running shoes','r/running','runs small', 1700000000)`,
    );

    const tenant = await connect(tenantRole);
    await tenant.exec(`SET search_path TO ${schema}`);
    return { owner, tenant };
  };

  const teardown = async (owner: PgWireClient, tenant: PgWireClient): Promise<void> => {
    await tenant.end();
    await owner.exec(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${tenantRole}, service_role`);
    await owner.exec(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${tenantRole}, service_role`);
    await owner.exec(`REVOKE USAGE ON SCHEMA ${schema} FROM ${tenantRole}, service_role`);
    await owner.exec(`DROP SCHEMA ${schema} CASCADE`);
    await owner.exec(`DROP ROLE IF EXISTS ${tenantRole}`);
    await owner.end();
  };

  test('postgres row level security', async (t) => {
    const { owner, tenant } = await setup();

    try {
      await t.test('the corpus is readable by any caller, because shared warmth is the product', async () => {
        const rows = await tenant.query('SELECT receipt_id FROM docs');
        assert.equal(rows.length, 1, 'a tenant must be able to read the shared corpus');
      });

      await t.test('a tenant cannot write to the shared corpus', async () => {
        /*
         * This is the one that protects every other tenant. A caller who can
         * insert into docs can poison a category that everyone else then reads,
         * and a poisoned corpus is permanent.
         */
        await assert.rejects(
          () => tenant.query(
            `INSERT INTO docs (receipt_id, source, kind, external_id, category, channel, text, harvested_at)
             VALUES ('rc_2222222222222222','reddit','comment','t1_evil','running shoes','r/running','poison', 1700000000)`,
          ),
          /row-level security/i,
          'a tenant was able to write into the shared corpus',
        );
      });

      await t.test('a tenant cannot delete from the shared corpus either', async () => {
        const before = await tenant.query('SELECT receipt_id FROM docs');
        await tenant.query("DELETE FROM docs WHERE receipt_id = 'rc_1111111111111111'");
        const after = await tenant.query('SELECT receipt_id FROM docs');
        /*
         * A DELETE with no matching policy removes nothing and does not error,
         * which is worth asserting explicitly: the failure is silent, so code
         * that trusts a row count would read this as success.
         */
        assert.equal(after.length, before.length, 'a tenant deleted a shared corpus row');
      });

      await t.test('a tenant sees only its own reports', async () => {
        await owner.query(
          `INSERT INTO reports (tenant_id, product_url, product_title, category, markdown, created_at)
           VALUES ('tenant-a','https://a.test','A','running shoes','# a', 1700000000),
                  ('tenant-b','https://b.test','B','running shoes','# b', 1700000000)`,
        );

        await tenant.exec("SET quorum.tenant_id = 'tenant-a'");
        const mine = await tenant.query('SELECT tenant_id, product_title FROM reports');
        assert.deepEqual(mine.map((r) => r['product_title']), ['A']);

        await tenant.exec("SET quorum.tenant_id = 'tenant-b'");
        const theirs = await tenant.query('SELECT tenant_id, product_title FROM reports');
        assert.deepEqual(theirs.map((r) => r['product_title']), ['B']);
      });

      await t.test('an unset tenant sees nothing, so it fails closed', async () => {
        await tenant.exec('RESET quorum.tenant_id');
        const rows = await tenant.query('SELECT tenant_id FROM reports');
        assert.equal(rows.length, 0, 'an unset tenant id must match nothing rather than everything');
      });

      await t.test('a tenant cannot write a report under another tenant id', async () => {
        await tenant.exec("SET quorum.tenant_id = 'tenant-a'");
        await assert.rejects(
          () => tenant.query(
            `INSERT INTO reports (tenant_id, product_url, product_title, category, markdown, created_at)
             VALUES ('tenant-b','https://x.test','X','running shoes','# x', 1700000000)`,
          ),
          /row-level security/i,
          'a tenant forged a report belonging to another tenant',
        );
      });

      await t.test('the product cache is shared, and carries nothing tenant specific', async () => {
        /*
         * The header of 002_rls.sql called this table tenant owned until
         * 2026-08-22 while its policies always shared it. The policies were
         * right: it caches public product pages by url and benefits everyone,
         * and it has no tenant_id column to scope by even if we wanted one.
         *
         * The column assertion is the load bearing half. If someone adds a
         * tenant_id here later, they have made a shared table hold private data
         * and this test is what tells them.
         */
        await owner.query(
          `INSERT INTO products (url, title, category, facts, source, fetched_at)
           VALUES ('https://p.test/x','X','running shoes','{}'::jsonb,'page', 1700000000)`,
        );

        const rows = await tenant.query('SELECT url FROM products');
        assert.equal(rows.length, 1, 'the product cache must be readable by every tenant');

        await assert.rejects(
          () => tenant.query(
            `INSERT INTO products (url, title, category, facts, source, fetched_at)
             VALUES ('https://p.test/evil','E','running shoes','{}'::jsonb,'page', 1700000000)`,
          ),
          /row-level security/i,
          'a tenant was able to poison the shared product cache',
        );

        const columns = await tenant.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'products'`,
          [schema],
        );
        assert.ok(
          !columns.some((c) => c['column_name'] === 'tenant_id'),
          'products carries a tenant_id, so it is holding private data in a globally readable table',
        );
      });

      /*
       * WHY THIS ASSERTION CHANGED SHAPE ON 2026-08-23.
       *
       * It used to say "reports is the only table carrying a tenant id". That
       * was true, and it was a proxy for the property that actually matters: a
       * table holding one customer's data must not be readable by another. When
       * `webhook_deliveries` arrived, holding a customer's callback url and
       * their rendered report, the proxy stopped being true while the property
       * it stood for was unchanged.
       *
       * Loosening it to "some tables carry a tenant id" would have thrown the
       * guard away. So it is now two halves, and the second is the one with
       * teeth:
       *
       *   1. The set of tenant owned tables is an explicit list, so adding one
       *      is a deliberate edit to this file rather than a side effect of a
       *      migration nobody read.
       *   2. EVERY table in that set has row level security enabled AND a
       *      policy attached. A tenant table with RLS on and no policy matches
       *      nothing, and a tenant table with RLS off matches everything. The
       *      second is the silent breach this file exists to prevent.
       */
      /* report_snapshots joined in migration 004: the exact bytes of a
       * customer's finished report are customer work product by any reading.
       * spend_ledger is deliberately NOT here: its key_label names who spent,
       * but the rows are the operator's accounting against the operator's own
       * vendor balance, and no caller facing endpoint reads them. */
      const TENANT_OWNED = ['report_snapshots', 'reports', 'webhook_deliveries'];

      await t.test('the tenant owned tables are exactly the expected set', async () => {
        const rows = await tenant.query(
          `SELECT table_name FROM information_schema.columns
           WHERE table_schema = $1 AND column_name = 'tenant_id'
           ORDER BY table_name`,
          [schema],
        );
        assert.deepEqual(
          rows.map((r) => r['table_name']),
          TENANT_OWNED,
          'a table gained or lost a tenant_id without this list being updated',
        );
      });

      await t.test('every tenant owned table has row level security and a policy', async () => {
        for (const table of TENANT_OWNED) {
          const [enabled] = await owner.query<{ relrowsecurity: boolean }>(
            `SELECT c.relrowsecurity FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relname = $2`,
            [schema, table],
          );
          assert.equal(
            enabled?.relrowsecurity, true,
            `${table} holds tenant data with row level security DISABLED, so every row is readable by every tenant`,
          );

          const policies = await owner.query<{ policyname: string }>(
            `SELECT policyname FROM pg_policies WHERE schemaname = $1 AND tablename = $2`,
            [schema, table],
          );
          assert.ok(
            policies.length > 0,
            `${table} has row level security enabled and NO policy, so it matches nothing and fails closed silently`,
          );
        }
      });

      await t.test('the service role can write to the shared corpus', async () => {
        /*
         * SET ROLE rather than a second connection, because the point is the
         * policy and not the login. A superuser would bypass RLS entirely and
         * prove nothing, so this asserts the grant actually carries.
         */
        await owner.exec(`SET ROLE service_role`);
        await owner.query(
          `INSERT INTO docs (receipt_id, source, kind, external_id, category, channel, text, harvested_at)
           VALUES ('rc_3333333333333333','reddit','comment','t1_svc','running shoes','r/running','legitimate', 1700000000)`,
        );
        const rows = await owner.query("SELECT receipt_id FROM docs WHERE receipt_id = 'rc_3333333333333333'");
        await owner.exec('RESET ROLE');
        assert.equal(rows.length, 1, 'the service role could not write the corpus it is supposed to own');
      });
    } finally {
      await teardown(owner, tenant);
    }
  });
}
