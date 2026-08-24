/*
 * The wiring that decides where a hosted run's records go.
 *
 * The regression this guards: the server once retrieved into a local SQLite
 * file while claims and evidence routes read Postgres, so every hosted report
 * was computed over a corpus that never received its own retrieval. The test
 * asserts identity, not behaviour, because identity is the property that was
 * silently wrong.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CorpusDriver } from '@quorum/corpus';
import { runCorpusOpener } from './run-corpus.ts';

test('with a shared driver configured, every run gets that exact driver', () => {
  const driver = { close: async () => {} } as unknown as CorpusDriver;
  const open = runCorpusOpener({ driver });
  assert.equal(open('./ignored.db'), driver);
  assert.equal(open('./another.db'), driver, 'the path must not matter: there is one corpus');
});

test('without a shared driver, each run opens sqlite at the path it was given', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-run-corpus-'));
  const path = join(dir, 'corpus.db');
  const open = runCorpusOpener(null);
  const a = open(path);
  const b = open(path);
  try {
    assert.notEqual(a, b, 'sqlite handles are per run, because close() really closes');
    assert.equal((await a.totals()).docs, 0);
  } finally {
    await a.close();
    await b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
