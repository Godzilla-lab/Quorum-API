/*
 * Ranking evals: labelled pairwise orderings scored against the live search
 * path, in the spirit of evals/relevance and for the same reason. Until
 * 2026-08-26 the suite held 1,233 passing tests while the hosted driver
 * ranked a prospectus above every real customer on "out of stock sold out",
 * because coverage measured plumbing correctness and nothing measured
 * ordering. An outside evaluation caught it live; the fixture pairs in
 * evals/ranking are analogues of the exact records that failed.
 *
 * THE FLOORS ARE MEASUREMENTS, NOT TARGETS, exactly as in the relevance
 * harness: baseline.json records what search() actually scores today, so a
 * ranking change that regresses ordering fails here before it reaches a
 * report, and a change that improves it moves the floor in the same commit.
 *
 * This runner scores the sqlite driver, which is what runs offline in CI.
 * The postgres driver is held to the same ordering by the conformance rank
 * test, which runs under the gated postgres harness.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { openSqliteCorpus } from './drivers/sqlite.ts';
import type { DocInput } from './types.ts';

const EVALS_DIR = fileURLToPath(new URL('../../../evals/ranking/', import.meta.url));

interface SubjectSpec {
  slug: string;
  category: string;
}

/* One labelled ordering: for this query, `better` must outrank `worse`. */
interface Pair {
  query: string;
  better: string;
  worse: string;
  why: string;
}

interface Scores {
  pairs: number;
  accuracy: number;
}

function loadSubjects(): { spec: SubjectSpec; docs: DocInput[]; pairs: Pair[] }[] {
  return readdirSync(EVALS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(EVALS_DIR, entry.name);
      const spec = JSON.parse(readFileSync(join(dir, 'subject.json'), 'utf8')) as SubjectSpec;
      const docs = readFileSync(join(dir, 'docs.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as DocInput);
      const pairs = readFileSync(join(dir, 'queries.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Pair);
      return { spec, docs, pairs };
    });
}

async function score(spec: SubjectSpec, docs: DocInput[], pairs: Pair[]): Promise<Scores> {
  const corpus = openSqliteCorpus({ path: ':memory:' });
  try {
    await corpus.addDocs(docs, spec.category);
    let wins = 0;
    for (const pair of pairs) {
      const hits = await corpus.search(pair.query, { category: spec.category, limit: 50 });
      const betterAt = hits.findIndex((h) => h.externalId === pair.better);
      const worseAt = hits.findIndex((h) => h.externalId === pair.worse);
      /*
       * The better record must actually be found; an absent `worse` counts as
       * a win because not returning the off topic record at all is the best
       * possible ordering of it.
       */
      if (betterAt !== -1 && (worseAt === -1 || betterAt < worseAt)) wins++;
    }
    return { pairs: pairs.length, accuracy: pairs.length ? wins / pairs.length : 1 };
  } finally {
    await corpus.close();
  }
}

const baseline = JSON.parse(readFileSync(join(EVALS_DIR, 'baseline.json'), 'utf8')) as Record<string, Scores>;
const subjects = loadSubjects();

test('every subject in evals/ranking has a committed baseline, and the reverse', () => {
  const measured = subjects.map((s) => s.spec.slug).sort();
  assert.deepEqual(Object.keys(baseline).sort(), measured);
});

for (const { spec, docs, pairs } of subjects) {
  test(`ranking holds its measured floor on "${spec.slug}"`, async () => {
    const scores = await score(spec, docs, pairs);
    const floor = baseline[spec.slug]!;

    /* Printed so a calibration session can read the live numbers without
     * re-deriving them, and so a regression's diagnostic says both values. */
    console.log(
      `evals ranking ${spec.slug}: accuracy ${scores.accuracy.toFixed(3)} `
      + `(floor ${floor.accuracy.toFixed(3)}), ${scores.pairs} pairs`,
    );

    assert.equal(scores.pairs, floor.pairs,
      'the pair count changed: re-measure and move the baseline in this commit');
    assert.ok(scores.accuracy >= floor.accuracy,
      `pairwise accuracy ${scores.accuracy.toFixed(3)} fell below the measured floor ${floor.accuracy.toFixed(3)}`);
  });
}
