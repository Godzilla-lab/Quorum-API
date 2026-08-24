import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/*
 * THE CLI, RUN THE WAY THE README TELLS PEOPLE TO RUN IT.
 *
 * Every other test in this package imports a function. That is why the bug
 * these tests exist for survived: npm installs a bin as a SYMLINK, so
 * `npx quorum` invokes node with argv[1] pointing at node_modules/.bin/quorum
 * while `import.meta.filename` is the real packages/cli/src/bin.ts. The entry
 * point guard compared the two directly, never matched, and the CLI printed
 * nothing and exited 0.
 *
 * Measured 2026-08-23 in a clean checkout: zero bytes on both streams. Running
 * the file by its real path worked perfectly, which is how it always got
 * tested and how it stayed hidden.
 *
 * So these spawn the real linked binary. No network: --offline, and a corpus
 * path that does not exist is a cold corpus rather than an error.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LINKED_BIN = join(ROOT, 'node_modules', '.bin', 'quorum');

/*
 * The corpus goes through --corpus, NOT through QUORUM_CORPUS. The first
 * version of this file set the env var, which the CLI does not read (only the
 * server and the MCP server do), so the offline run below quietly opened the
 * repo's own ./quorum.db instead. The test still passed, which is exactly how
 * that kind of mistake survives: nothing checks where the bytes landed.
 */
const SCRATCH_CORPUS = join(ROOT, 'node_modules', '.cache', 'cli-bin-test.db');

const runLinked = (args: string[]): { stdout: string; status: number } => {
  try {
    const stdout = execFileSync(LINKED_BIN, args, {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? 1 };
  }
};

test('the linked bin is a symlink, which is the whole reason for these tests', () => {
  if (!existsSync(LINKED_BIN)) return;
  assert.notEqual(
    realpathSync(LINKED_BIN), LINKED_BIN,
    'the bin stopped being a symlink, so these tests no longer cover what they were written for',
  );
});

/*
 * The takedown path, end to end through the real binary: write a record,
 * remove it, prove the corpus forgot it. The second call proves removing
 * nothing is an answer rather than an error.
 */
test('quorum takedown removes a record and says so, and removing nothing says that too', async () => {
  if (!existsSync(LINKED_BIN)) return;
  const { openSqliteCorpus } = await import('@quorum/corpus');
  const path = join(ROOT, 'node_modules', '.cache', 'cli-takedown-test.db');
  const { rmSync } = await import('node:fs');
  rmSync(path, { force: true });

  const corpus = openSqliteCorpus({ path });
  await corpus.addDocs([{
    source: 'reddit', kind: 'comment', externalId: 't1_gone', channel: 'running',
    text: 'please remove this comment of mine', score: 1, url: 'https://e.test', createdUtc: 1,
  }], 'running shoes');
  await corpus.close();

  const removed = runLinked(['takedown', 'reddit', 't1_gone', '--corpus', path]);
  assert.equal(removed.status, 0);
  assert.match(removed.stdout, /removed 1 row/);

  const again = runLinked(['takedown', 'reddit', 't1_gone', '--corpus', path, '--json']);
  assert.equal(again.status, 0);
  assert.equal(JSON.parse(again.stdout).removed, 0, 'nothing held is an answer, not an error');

  const check = openSqliteCorpus({ path });
  assert.deepEqual(await check.search('remove this comment'), [], 'and search has forgotten it');
  await check.close();
  rmSync(path, { force: true });
});

test('npx quorum --help prints something rather than exiting silently', () => {
  if (!existsSync(LINKED_BIN)) return;
  const { stdout } = runLinked(['--help']);
  assert.ok(stdout.length > 0, 'the documented command produced no output at all');
  assert.match(stdout, /quorum/i);
});

test('npx quorum --version prints a version', () => {
  if (!existsSync(LINKED_BIN)) return;
  const { stdout } = runLinked(['--version']);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

/* The README's own quickstart line, executed. */
test('npx quorum "a subject" --offline runs a report and touches no network', () => {
  if (!existsSync(LINKED_BIN)) return;
  const { stdout } = runLinked(['running shoes', '--offline', '--corpus', SCRATCH_CORPUS]);
  assert.ok(stdout.length > 0, 'the README quickstart produced no output at all');
  assert.match(stdout, /RETRIEVAL skipped/, 'offline must say it answered from the corpus alone');
  assert.match(stdout, /RECEIPTS/);
});
