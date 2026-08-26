# Ranking evals

Labelled pairwise orderings scored against the live `corpus.search()` path.
Same doctrine as `evals/relevance`: the floors in `baseline.json` are
MEASUREMENTS of what the current ranker does, not targets. A change that
improves ordering moves the floor up in the same commit, reviewed; a change
that regresses ordering fails in `npm test` before it reaches a report.

## Why this exists

Until 2026-08-26 nothing executable measured result ordering. An outside
evaluation of the hosted MCP surface found a long Hacker News project update
in the top five for three unrelated queries, and two SEC filings outranking
every real customer on "out of stock sold out". The root cause was driver
specific: the sqlite driver ranks with FTS5 bm25, which normalises for
document length, while the postgres driver called `ts_rank` with no
normalisation argument, so on the hosted instance document length was
ignored and long documents accumulated rank without penalty.

The fixture docs in each subject are analogues of the records that failed
live: short first person records competing against a long omnibus post and a
prospectus that share their vocabulary.

## Format

`<subject>/subject.json` names the slug and the corpus category the docs
load under. `docs.jsonl` holds one `DocInput` per line, hand authored.
`queries.jsonl` holds one labelled pair per line:

```json
{"query": "sold out", "better": "short-stock", "worse": "filing",
 "why": "a buyer saying sold out beats a prospectus that mentions it"}
```

For each pair the runner searches the query and asserts `better` ranks above
`worse`. A `worse` record that does not come back at all counts as a win,
because not returning the off topic record is the best possible ordering of
it. Both records of a pair deliberately contain every query word, so the
strict AND pass returns both and the pair measures ordering rather than
filtering.

The runner is `packages/corpus/src/ranking-eval.test.ts`, which scores the
sqlite driver offline in `npm test`. The postgres driver is held to the same
ordering by the conformance rank test under the gated postgres harness
(`npm run test:postgres`).

Seed status 2026-08-26: one subject, 7 pairs. Grown the same way the
relevance labels are grown: by labelling orderings from real harvests.
