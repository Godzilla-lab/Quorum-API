# Running the Postgres driver against a real database

The corpus has two drivers. SQLite is what a CLI user runs and what the test
suite exercises by default. Postgres is what the hosted product runs, and at
any real number of concurrent callers it is the only one of the two that is a
candidate at all.

Until 2026-08-22 the Postgres SQL in this repo had never been executed by
anything. Its logic was tested against a recording fake, which proves the driver
issues the statements it means to issue and proves nothing about whether those
statements are valid Postgres. This document is how that gap gets closed and
stays closed.

## What the first real run found

`001_initial.sql` applied cleanly. The driver's SQL was correct, and all 21
conformance tests passed on PostgreSQL 17.10 without a single change to it.

The suite has since grown to 32, and the run is repeated whenever the write path
changes. A recording fake cannot reject a value that a real server rejects, so
anything that decides what may be STORED has to be watched working against one.
That is how the NUL sanitiser was verified rather than assumed.

`002_rls.sql` **could not run at all**:

    ERROR 42704: role "service_role" does not exist

`service_role` is provided by Supabase. On a stock PostgreSQL it does not exist,
so every grant in that migration failed and took the whole file with it. Self
hosting is the free tier, and self hosting was broken on the second migration.
A fake never rejects invalid SQL, so no amount of testing against one would have
found this.

The migration now creates the role when it is absent and leaves it alone when it
is not, so the policies mean the same thing on every provider.

## Running it

The suite is gated on an environment variable, because `npm test` runs offline,
keyless and with no services, and that property is worth more than the
convenience of having this run by default.

    QUORUM_PG_URL=postgres://user@127.0.0.1:5432/quorum_conformance \
      node --disable-warning=ExperimentalWarning \
      --test packages/corpus/src/drivers/postgres.conformance.test.ts

Each test creates its own schema, applies the real migrations into it, runs, and
drops the schema afterwards. Nothing is shared between tests and nothing is left
behind.

## Getting a Postgres without installing one

You do not need Docker and you do not need a hosted database. Neither one is
wrong, but both are heavier than this, and a hosted database would mean the
suite could never run without credentials.

The Zonky project publishes self contained PostgreSQL builds as plain archives.
Nothing is installed, nothing is registered with the system, and deleting the
directory removes every trace.

    ARCH=darwin-arm64v8      # or linux-amd64, darwin-amd64, linux-arm64v8
    VERSION=17.10.0
    BASE=https://repo1.maven.org/maven2/io/zonky/test/postgres
    curl -sL "$BASE/embedded-postgres-binaries-$ARCH/$VERSION/embedded-postgres-binaries-$ARCH-$VERSION.jar" -o pg.jar
    unzip -q pg.jar -d jar && mkdir -p dist && tar -xJf jar/postgres-*.txz -C dist

    ./dist/bin/initdb -D data -U quorum --auth=trust -E UTF8 --locale=C
    ./dist/bin/pg_ctl -D data -l server.log -o "-p 55432 -c listen_addresses=127.0.0.1" -w start

The archive ships the server only, with no `psql` and no client library. That is
not a problem here, because the driver takes an injected executor and the repo
carries a small wire protocol client for exactly this purpose. See
`packages/corpus/src/drivers/pg-wire.ts`, which is test infrastructure and says
so in its own header. A deployment passes a real client instead.

Stopping and removing it:

    ./dist/bin/pg_ctl -D data -w stop && rm -rf data dist jar pg.jar

## The tenant boundary, exercised rather than assumed

`postgres.rls.test.ts`, 10 tests. Conformance cannot cover this: it talks to the
database as the role that **owns** the tables, and an owner bypasses row level
security entirely, so a green conformance run would sit happily on top of a
policy that permitted everything.

These tests connect as a separate unprivileged role with full table grants, so
anything it cannot do is a policy doing it rather than a missing `GRANT`
standing in for one. Verified: a tenant reads the shared corpus and cannot write
or delete in it, sees only its own reports, sees nothing at all when its tenant
id is unset, and cannot forge a report under another tenant's id.

**That run corrected the boundary itself.** The header of `002_rls.sql` listed
`products` as tenant owned and said leaking it between tenants was a breach. The
table has no `tenant_id` column, so it could never have been scoped, and the
policies had always shared it. The policies were right: it caches public product
pages by url and every tenant benefits.

The comment was the dangerous half. It invites someone either to "fix" the
policy and break the shared cache, or to write customer data into a globally
readable table believing it is isolated. A test now asserts that `reports` is
the only table in the schema carrying a `tenant_id`.

## Concurrency, measured

`postgres.concurrency.test.ts`, plus a scaling probe. Sixty four concurrent
writers stored 6,400 rows in 218ms with nothing lost. Eight writers racing to
insert the **same** 100 rows settled in 28ms with no deadlock, and between them
claimed exactly 100 new rows. Eight concurrent observations of one ad correctly
produced eight rows rather than one, because ad observations are append only and
collapsing them is the defect that table exists to prevent.

The full curve is in `docs/rate-limits.md`. The short version: throughput
plateaus near 30,000 rows a second, a cold report writes about 400 records, and
the politeness ceiling upstream is 785 cold reports a day. Storage is four
orders of magnitude away from being the constraint.

## What is still not proven

Nothing about this database at production scale, only at development scale on
one machine. In particular there is no measurement of connection pool exhaustion
and no test of what happens when a report's transaction is open while a vendor
call hangs, which is the shape of a real outage rather than a real benchmark.
