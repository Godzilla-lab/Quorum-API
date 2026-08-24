# Evals

Golden sets and the scoring harness. Three layers, built in order.

## Layer 1: relevance gate precision and recall (built, seed sized)

`relevance/<subject>/subject.json` names the subject as phrases. `labels.jsonl`
holds one record per line, hand labelled:

```json
{"id": "rs-03", "source": "hackernews", "mode": "phrase", "channelKind": "title",
 "channel": "The Greatest Running Shoe Never Sold",
 "text": "Newton Running sells running shoes 2x the price of Nike or Adidas.",
 "relevant": true, "why": "price comparison of named brands"}
```

`mode` and `channelKind` are the gate options the source that produced the
record would use, because the gate is calibrated per source and measuring it
under the wrong options measures nothing.

The runner is `packages/sources/src/relevance-eval.test.ts`, so `npm test`
scores every subject offline and asserts the floors in
`relevance/baseline.json`. The floors are the MEASURED performance of the
current gate, recorded so a calibration change cannot regress silently and
must move the baseline in a reviewed commit when it improves. A low floor is
not a target, it is an honest reading of a known weakness: the `love` subject
exists precisely because a run on it stored 2544 of 2544 records seen.

Label provenance is in each record's `why`. Records quoted from live runs are
verbatim harvest text. Records reconstructed from measured cases documented in
`relevance.ts` say so, because the original full text was not preserved and a
label that hides that would be a fabricated fixture, which is how the
Hacker News filter bug survived its own tests.

Seed status 2026-08-24: two subjects, 23 labels. The target in the roadmap is
5 to 10 subjects at 200 to 500 labels each, grown by labelling real harvests.

## Layer 2: voice and duplicate labels (not built)

`{receiptIds: [...], sameVoice: true|false}` pairs, scoring the near duplicate
collapse before independent voice counting ships.

## Layer 3: report scoring (not built, paid, on demand only)

Frozen corpus fixtures per subject; support entailment, coverage against hand
written key findings, and pairwise comparison. Scored, never asserted: the
harness prints a diff against a committed baseline and moving the baseline is
a reviewed commit.
