/*
 * Layer 1 of evals/: the relevance gate scored against hand labelled records.
 *
 * WHY THIS LIVES WITH THE GATE AND READS FROM evals/. The golden sets are
 * repo level assets that outlive any one module, but the thing being measured
 * is `isRelevantRecord`, and a harness that drifts from the real gate options
 * measures a gate nobody ships. Keeping the runner next to the gate keeps the
 * two honest, and `npm test` picks it up like any other test.
 *
 * THE FLOORS ARE MEASUREMENTS, NOT TARGETS. baseline.json records what the
 * current gate actually scores on each subject, including the subjects it is
 * known to fail: the `love` set exists because a live run stored 2544 of 2544
 * records seen. A calibration change that improves a number moves the
 * baseline up in the same commit, reviewed; a change that regresses one fails
 * here first instead of in a customer's report. Every threshold in this
 * system was hand set from single dated runs and protected by nothing
 * executable until this file.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isRelevantRecord, subjectTerms } from './relevance.ts';

const EVALS_DIR = fileURLToPath(new URL('../../../evals/relevance/', import.meta.url));

interface Label {
  id: string;
  source: string;
  mode: 'terms' | 'phrase';
  channelKind: 'title' | 'handle';
  channel: string;
  text: string;
  relevant: boolean;
  why: string;
}

interface SubjectSpec {
  slug: string;
  phrases: string[];
}

interface Scores {
  records: number;
  precision: number;
  recall: number;
}

function loadSubjects(): { spec: SubjectSpec; labels: Label[] }[] {
  return readdirSync(EVALS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(EVALS_DIR, entry.name);
      const spec = JSON.parse(readFileSync(join(dir, 'subject.json'), 'utf8')) as SubjectSpec;
      const labels = readFileSync(join(dir, 'labels.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Label);
      return { spec, labels };
    });
}

function score(spec: SubjectSpec, labels: Label[]): Scores {
  const terms = subjectTerms(spec.phrases);
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (const label of labels) {
    const passed = isRelevantRecord(label.text, label.channel, terms, {
      mode: label.mode,
      channelKind: label.channelKind,
      phrases: spec.phrases,
    });
    if (passed && label.relevant) truePositives++;
    if (passed && !label.relevant) falsePositives++;
    if (!passed && label.relevant) falseNegatives++;
  }

  const kept = truePositives + falsePositives;
  return {
    records: labels.length,
    /* A gate that keeps nothing has no precision to speak of; report 1 so the
     * recall floor is what fails, which is the number that describes what
     * actually went wrong. */
    precision: kept === 0 ? 1 : truePositives / kept,
    recall: truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives),
  };
}

const baseline = JSON.parse(readFileSync(join(EVALS_DIR, 'baseline.json'), 'utf8')) as Record<string, Scores>;
const subjects = loadSubjects();

test('every subject in evals/relevance has a committed baseline, and the reverse', () => {
  const measured = subjects.map((s) => s.spec.slug).sort();
  assert.deepEqual(Object.keys(baseline).sort(), measured);
});

for (const { spec, labels } of subjects) {
  test(`relevance gate holds its measured floor on "${spec.slug}"`, () => {
    const scores = score(spec, labels);
    const floor = baseline[spec.slug]!;

    /* Printed so a calibration session can read the live numbers without
     * re-deriving them, and so a regression's diagnostic says both values. */
    console.log(
      `evals relevance ${spec.slug}: precision ${scores.precision.toFixed(3)} `
      + `(floor ${floor.precision.toFixed(3)}), recall ${scores.recall.toFixed(3)} `
      + `(floor ${floor.recall.toFixed(3)}), ${scores.records} labels`,
    );

    assert.equal(scores.records, floor.records,
      'the label count changed: re-measure and move the baseline in this commit');
    assert.ok(scores.precision >= floor.precision,
      `precision ${scores.precision.toFixed(3)} fell below the measured floor ${floor.precision.toFixed(3)}`);
    assert.ok(scores.recall >= floor.recall,
      `recall ${scores.recall.toFixed(3)} fell below the measured floor ${floor.recall.toFixed(3)}`);
  });
}
