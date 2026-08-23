import { runConformanceSuite } from '../conformance.ts';
import { openSqliteCorpus } from './sqlite.ts';

/*
 * In memory, so the suite needs no filesystem, no cleanup, and no ordering
 * between tests. Each call gets a fresh database, and an optional injected
 * clock for the tests that care about time.
 */
runConformanceSuite('sqlite', async (now) =>
  openSqliteCorpus(now ? { path: ':memory:', now } : { path: ':memory:' }));
