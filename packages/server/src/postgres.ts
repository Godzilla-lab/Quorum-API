/*
 * The production PostgreSQL client, and the only place `pg` is used.
 *
 * WHY THE DEPENDENCY LIVES HERE AND NOWHERE ELSE.
 *
 * `packages/corpus` still has zero dependencies, and that is not an accident
 * of layering: its driver takes an INJECTED executor precisely so a CLI user
 * who only ever touches SQLite never installs a Postgres client. This file is
 * the injection, so the cost is paid by the one package that actually serves
 * hosted traffic.
 *
 * WHY NOT `pg-wire.ts`, WHICH ALREADY SPEAKS TO THIS DATABASE. Because its own
 * header says not to. It has no pool, no reconnection, no cancellation, and it
 * assumes one statement in flight. It exists to prove the driver's SQL is valid
 * against a real server, and it does that well. Serving traffic through it
 * would mean hand writing a connection pool that survives a database restart,
 * which is a genuine project with a lot of ways to be quietly wrong under load.
 *
 * THE POOL IS SMALL ON PURPOSE. A managed free tier allows 20 connections in
 * total, shared with migrations, an admin session, and the provider's own
 * monitoring. A pool of 5 is far more than one instance needs, because a
 * connection is held for the milliseconds a query runs and then returned: at a
 * 10ms round trip, five connections serve roughly 500 queries a second, which
 * is well past what the process itself can produce.
 */

import { Pool, type PoolClient } from 'pg';
import { openPostgresCorpus, type CorpusDriver, type SqlExecutor } from '@quorum/corpus';

export interface PostgresOptions {
  /* The provider's connection uri, whole, including any `?sslmode=`. */
  url: string;
  /*
   * The provider's CA, as a PEM.
   *
   * WITHOUT IT THE CERTIFICATE IS NOT VERIFIED, and that is what `sslmode=
   * require` actually means: encrypt, do not verify. It is weaker than nearly
   * everybody reads it as, because libpq treats verification as a separate
   * escalation to `verify-ca`. A managed provider signs with its own CA, so
   * the public root store rejects it and an unverified connection is the
   * default anyone falls into. Supply this and the connection is verified.
   */
  caCert?: string;
  /* Bounded well below the provider's limit. See the header. */
  max?: number;
  /* Milliseconds a query may run before the pool gives up on it. */
  statementTimeoutMs?: number;
}

export interface PostgresCorpus {
  driver: CorpusDriver;
  /* Closes every pooled connection. Called on shutdown, after the server has
   * stopped accepting. */
  end(): Promise<void>;
  /* For the boot banner: says whether the certificate is actually verified,
   * because "over tls" and "over tls to the server I meant" are different
   * claims and only the second is worth anything against an active attacker. */
  describe(): string;
}

/* Adapts one pg client or pool to the two calls the corpus driver declares. */
function executor(runner: Pool | PoolClient): SqlExecutor {
  return {
    async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      const result = await runner.query(sql, params as unknown[]);
      return result.rows as T[];
    },
  };
}

export function openPostgres(options: PostgresOptions): PostgresCorpus {
  const url = new URL(options.url);
  const sslmode = url.searchParams.get('sslmode');
  const wantsTls = sslmode !== null && sslmode !== 'disable';
  const verified = Boolean(options.caCert) || sslmode === 'verify-ca' || sslmode === 'verify-full';

  /*
   * `sslmode` IS STRIPPED FROM THE URL, AND THAT IS NOT TIDYING.
   *
   * node-postgres and libpq disagree about what `sslmode=require` means.
   * libpq: encrypt, do not verify. node-postgres: an alias for `verify-full`,
   * which it announces at runtime as a SECURITY WARNING. Left in the
   * connection string it silently overrode the explicit `ssl` block below, so
   * a deliberate configuration was ignored and every query died with
   * `self-signed certificate in certificate chain` against a provider that
   * signs with its own CA. Measured 2026-08-23 against Aiven.
   *
   * Two libraries in this repo read the same uri: this one and `pg-wire.ts`,
   * which follows libpq. Removing the parameter leaves exactly one thing
   * deciding, here, where it is written down.
   */
  const connection = new URL(options.url);
  connection.searchParams.delete('sslmode');

  const pool = new Pool({
    connectionString: connection.toString(),
    max: options.max ?? 5,
    /*
     * A managed database closes idle connections on its own schedule, and a
     * pool holding one it thinks is alive produces a confusing error on the
     * next query rather than at the moment it was dropped. Recycling first is
     * cheaper than diagnosing that.
     */
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    /*
     * A runaway query holds a connection out of a pool of five, so four more
     * like it take the whole instance down. The corpus's slowest read was
     * measured at 8.5ms, so 30 seconds is not a tuning knob, it is a
     * backstop with three orders of magnitude of headroom.
     */
    ...(options.statementTimeoutMs === undefined
      ? { statement_timeout: 30_000 }
      : { statement_timeout: options.statementTimeoutMs }),
    ...(wantsTls
      ? {
        ssl: {
          rejectUnauthorized: verified,
          ...(options.caCert ? { ca: options.caCert } : {}),
        },
      }
      : {}),
  });

  /*
   * A pool emits `error` for a connection that dies while IDLE, and an
   * unhandled 'error' event takes the process down. That is the wrong outcome
   * for a database blip: the pool discards the dead connection and makes a new
   * one on the next query, which is exactly the recovery this dependency was
   * added for. Logged rather than thrown.
   */
  pool.on('error', (err) => {
    process.stderr.write(`postgres: idle connection died, the pool will replace it: ${err.message}\n`);
  });

  const sql: SqlExecutor = {
    ...executor(pool),
    /*
     * A transaction has to hold ONE connection for its whole life. Running the
     * statements through the pool would scatter them across connections, so
     * BEGIN and COMMIT would land on different sessions and the atomicity the
     * driver asked for would silently not exist.
     */
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(executor(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        /* A failed rollback must not replace the error that caused it, which
         * is the one that says what actually went wrong. */
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };

  return {
    driver: openPostgresCorpus({ sql }),
    end: () => pool.end(),
    describe: () => {
      if (!wantsTls) return `${url.hostname}:${url.port || 5432}, UNENCRYPTED`;
      return verified
        ? `${url.hostname}:${url.port || 5432}, tls with the certificate verified`
        /* Names BOTH variables, because the one you need depends on where this
         * is running and the banner is read by somebody trying to fix it. A
         * hosting platform hands you environment variables and not files, so
         * telling a Render operator to set a file path sends them looking for
         * a filesystem they do not have. */
        : `${url.hostname}:${url.port || 5432}, tls but the certificate is NOT verified. `
          + 'Paste the provider CA into QUORUM_PG_CA_PEM, or point QUORUM_PG_CA at a file, to verify it.';
    },
  };
}
