/*
 * Which corpus a hosted run retrieves into.
 *
 * THE ANSWER HAS TO BE THE SAME CORPUS THE CLAIMS ARE COMPUTED FROM.
 *
 * Until 2026-08-24 this wiring did not exist and the server passed
 * `openSqliteCorpus` to `runResearch` unconditionally, while `claimsFor` and
 * every /v1/evidence route read Postgres. A hosted run wrote its records into
 * a local SQLite file on a platform with no persistent disk, and the report's
 * findings were computed over a corpus that never received them. The report
 * said "stored 2544" and meant a file that vanished on the next restart, the
 * Postgres corpus never warmed, and the warm/cold estimate was always cold.
 *
 * WHY HANDING OUT THE SHARED POSTGRES DRIVER IS SAFE. `runResearch` closes the
 * corpus it was given in a `finally`, which is why SQLite gets a fresh handle
 * per run: its `close()` closes the file. The Postgres driver's `close()` is a
 * documented no op, because the pool is owned by whoever called
 * `openPostgres`, so a finished report cannot close the database out from
 * under every other request.
 */

import { openSqliteCorpus, type CorpusDriver } from '@quorum/corpus';

export function runCorpusOpener(
  shared: { driver: CorpusDriver } | null,
): (path: string) => CorpusDriver {
  if (shared) return () => shared.driver;
  return (path: string) => openSqliteCorpus({ path });
}
