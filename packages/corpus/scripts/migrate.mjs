/*
 * Apply the corpus migrations to a real PostgreSQL.
 *
 *   npm run migrate -w packages/corpus              # applies what is missing
 *   npm run migrate -w packages/corpus -- --dry-run # says what it would do
 *
 * CLAUDE.md has documented this command since M1 and it did not exist. That is
 * the same class of gap as `saveReport` being on the driver and called by
 * nothing: a thing everyone believes is there, that has never once run.
 *
 * WHY THIS TRACKS WHAT IT APPLIED, rather than just running every file.
 *
 * `001_initial.sql` is not idempotent. Re-running it against a live corpus
 * fails on the first CREATE TABLE, which is the good case; the bad case is a
 * migration that partially succeeds and leaves a schema that matches neither
 * version. So applied migrations are recorded in a table, each file runs at
 * most once, and a file that changed after being applied is refused rather
 * than silently skipped.
 *
 * WHY THE CHECKSUM MATTERS. Editing an already applied migration is the
 * quietest way to make two environments disagree: production has the old text,
 * a fresh database gets the new one, and nothing anywhere reports it. The hash
 * turns that into an error at the next deploy.
 *
 * CONNECTION DETAILS COME FROM THE ENVIRONMENT AND ARE NEVER PRINTED. Every
 * message below names the host and database only, so a password cannot reach a
 * terminal, a CI log or a screenshot.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPgWire, parsePgUri } from '../src/drivers/pg-wire.ts';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const dryRun = process.argv.includes('--dry-run');

/*
 * A local `.env` is read when present, so a connection string lives in a
 * gitignored file rather than in shell history. An absent one is not an error:
 * a deployment sets real environment variables.
 */
try {
  process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env'));
} catch { /* no .env, which is the normal case in a deployment */ }

const uri = process.env['QUORUM_PG_URL'] ?? process.env['DATABASE_URL'];
if (!uri) {
  console.error('migrate: set QUORUM_PG_URL or DATABASE_URL to a postgres connection string.');
  console.error('         A local .env at the repo root is read automatically and is gitignored.');
  process.exit(2);
}

const connection = parsePgUri(uri);

/*
 * The provider CA, if you have downloaded it. Aiven, Supabase and RDS all sign
 * with their own CA, so the public root store rejects the certificate and the
 * path of least resistance is an unverified connection.
 *
 * `sslmode=require`, which is what a provider puts in its copyable uri, means
 * ENCRYPT AND DO NOT VERIFY. That is the standard's meaning and it is a weaker
 * promise than most people read it as. Point QUORUM_PG_CA at the CA file and
 * the connection is verified instead, which is what you want for a database
 * reachable from the public internet.
 */
const caPath = process.env['QUORUM_PG_CA'];
if (caPath) {
  connection.caCert = readFileSync(caPath, 'utf8');
}

const where = `${connection.host}:${connection.port}/${connection.database}`;

const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
if (!files.length) {
  console.error(`migrate: no .sql files in ${MIGRATIONS}`);
  process.exit(1);
}

const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

const how = !connection.ssl
  ? 'unencrypted'
  : connection.caCert ? 'over tls, certificate verified'
  : connection.verify ? 'over tls, verified against the public root store'
  : 'over tls, CERTIFICATE NOT VERIFIED (sslmode=require). Set QUORUM_PG_CA to verify.';
console.log(`migrate: ${where}, ${how}`);
console.log(`         ${files.length} migration(s) on disk`);

const client = await connectPgWire(connection);
let applied = 0;

try {
  /*
   * The ledger is itself created with IF NOT EXISTS rather than through a
   * migration, because a migration runner that needs a migration to have been
   * run cannot bootstrap an empty database.
   *
   * NOT CREATED ON A DRY RUN. It was, until the first dry run against a real
   * database printed "nothing was written" immediately after writing a table.
   * A dry run that leaves anything behind is worse than no dry run, because the
   * whole reason to offer one is so somebody can point it at production without
   * thinking hard first.
   */
  if (!dryRun) {
    await client.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  const ledgerExists = (await client.query(
    "SELECT 1 AS present FROM information_schema.tables WHERE table_name = 'schema_migrations'",
  )).length > 0;
  const rows = ledgerExists
    ? await client.query('SELECT filename, checksum FROM schema_migrations')
    : [];
  const seen = new Map(rows.map((r) => [r.filename, r.checksum]));

  for (const filename of files) {
    const sql = readFileSync(join(MIGRATIONS, filename), 'utf8');
    const checksum = digest(sql);
    const previous = seen.get(filename);

    if (previous !== undefined) {
      if (previous !== checksum) {
        console.error(`migrate: ${filename} was already applied and its contents have CHANGED since.`);
        console.error('         Applied migrations are history. Add a new file rather than editing one.');
        process.exitCode = 1;
        break;
      }
      console.log(`  = ${filename} already applied`);
      continue;
    }

    if (dryRun) {
      console.log(`  ? ${filename} would be applied (${sql.length} bytes)`);
      continue;
    }

    /*
     * The file is run exactly as written, including its own BEGIN and COMMIT.
     * Wrapping it in another transaction would nest, and a migration that
     * deliberately runs outside one, like a concurrent index build, would break
     * in a way that only shows up on a table big enough to matter.
     */
    await client.exec(sql);
    await client.query(
      'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
      [filename, checksum],
    );
    applied++;
    console.log(`  + ${filename} applied`);
  }

  if (!process.exitCode) {
    console.log(dryRun
      ? 'migrate: dry run, nothing was written'
      : `migrate: ${applied} applied, ${files.length - applied} already present`);
  }
} catch (err) {
  /* The message, never the connection string. A driver error can carry the DSN
   * it was handed, and that is how a password reaches a CI log. */
  console.error(`migrate: failed against ${where}: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
