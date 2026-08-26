/*
 * Rendering is pure, so these are assertions about what a reader actually sees.
 * The ones that matter are negative: a weak signal must not read as a finding,
 * and a degraded source must not be quietly left out.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareSides, corroborate, fabricationReport, shareOfVoice, trendFor, withEvidence, type ResolvedClaim, type SynthesisReport } from '@quorum/core';
import type { Doc } from '@quorum/corpus';
import { renderJson, renderText } from './render.ts';
import type { RunResult } from './run.ts';

const EM_DASH = String.fromCodePoint(0x2014);
const EN_DASH = String.fromCodePoint(0x2013);

function doc(receiptId: string, channel = 'r/running'): Doc {
  return {
    receiptId,
    source: 'reddit',
    kind: 'comment',
    externalId: receiptId,
    category: 'running shoes',
    channel,
    /* Distinct per receipt: identical text counts as one voice in
     * corroborate, so a shared default would collapse every fixture claim. */
    text: `they run small, says ${receiptId}`,
    score: 4,
    url: 'https://example.test/1',
    createdUtc: 1_700_000_000,
    harvestedAt: 1_700_000_100,
  };
}

/*
 * Claims now carry a readable sample and a concentration measure alongside
 * their counts, so the fixtures build them the same way a run does rather than
 * hand assembling a shape that could drift from the real one.
 */
const claim = (term: string, docs: Doc[]) => withEvidence(corroborate(term, docs), docs);

function result(over: Partial<RunResult> = {}): RunResult {
  return {
    subject: { category: 'running shoes', title: 'wool runner', source: 'page', images: [], reviews: [] },
    subjectCached: false,
    brandsNamed: [],
    hints: null,
    category: 'running shoes',
    offline: false,
    retrieval: {
      category: 'running shoes',
      outcomes: [
        { sourceId: 'reddit', status: 'ok', queriesPlanned: 6, queriesRun: 6, recordsSeen: 400, recordsGated: 60, recordsWritten: 340, elapsedMs: 187_200 },
        { sourceId: 'hackernews', status: 'degraded', reason: 'every record was off topic (95 gated)', queriesPlanned: 3, queriesRun: 3, recordsSeen: 95, recordsGated: 95, recordsWritten: 0, elapsedMs: 2200 },
      ],
      totalWritten: 340,
      totalSeen: 495,
      elapsedMs: 189_400,
      degraded: [{ source: 'hackernews', reason: 'all_off_topic', impact: 'no hackernews evidence in this report' }],
      stoppedEarly: null,
    },
    readings: [],
    attested: null,
    gaps: [],
    silence: null,
    trends: [],
    voice: [],
    themes: [],
    asOf: null,
    diff: null,
    comparison: null,
    synthesis: null,
    warmth: {
      category: 'running shoes', docs: 340, comments: 320, channels: 11, ads: 0,
      lastHarvested: 1_700_000_100, ageDays: 0.2, warm: true, subreddits: ['running'], queries: ['quality'],
    },
    claims: [
      claim('quality', [doc('rc_a'), doc('rc_b', 'r/trailrunning'), doc('rc_c', 'r/runningshoegeeks')]),
      claim('problems', [doc('rc_d'), doc('rc_e')]),
    ],
    adRetrieval: null,
    formats: null,
    durationBasis: { reported: 0, startDate: 0, observationSpan: 0, none: 0 },
    sufficiency: {
      verdict: 'sufficient', reason: '2 of 2 questions have enough corroboration to answer',
      suggestions: [], warnings: [], seen: 495, rejected: 155, stored: 340, findings: 2,
    },
    receiptCheck: { cited: 3, resolved: 3, unresolved: [] },
    cost: { totalUsd: 0, lines: [], hasUnverified: false, overCap: false },
    elapsedMs: 190_000,
    ...over,
  };
}

test('a finding and a weak signal are labelled differently on their own lines', () => {
  const lines = renderText(result()).split('\n');
  const quality = lines.find((l) => l.trimStart().startsWith('quality'))!;
  const problems = lines.find((l) => l.trimStart().startsWith('problems'))!;
  assert.match(quality, /\[finding\]/);
  assert.match(problems, /\[weak signal\]/);
  assert.doesNotMatch(problems, /\[finding\]/, 'a two receipt claim must never read as a finding');
});

test('the corroboration threshold is stated, so the report shows its own working', () => {
  assert.match(renderText(result()), /needs 3 independent receipts/);
});

test('a weak signal comes with the sentence explaining what it is not', () => {
  assert.match(renderText(result()), /never\n\s*printed as a finding/);
});

/*
 * A report that looks complete while a leg crashed is worse than one that
 * admits the gap, so degradation is never summarised away.
 */
test('a degraded source is named, with its reason and what it cost the report', () => {
  const text = renderText(result());
  assert.match(text, /missing from this report:/);
  assert.match(text, /hackernews: all_off_topic, so no hackernews evidence in this report/);
});

test('stopping early is stated rather than left to be inferred from a short run', () => {
  const base = result();
  const text = renderText(result({ retrieval: { ...base.retrieval!, stoppedEarly: 'deadline' } }));
  assert.match(text, /stopped early: deadline/);
});

test('offline says it ran no upstream requests instead of showing an empty retrieval', () => {
  const text = renderText(result({ offline: true, retrieval: null }));
  assert.match(text, /Zero upstream requests/);
  assert.doesNotMatch(text, /RETRIEVAL \d/);
});

/*
 * The loudest thing this renderer can say. A cited receipt that does not
 * resolve is a fabricated citation, which is the failure the product exists to
 * prevent, so it is not a footnote.
 */
test('an unresolved citation invalidates the report in the report itself', () => {
  const text = renderText(result({ receiptCheck: { cited: 3, resolved: 2, unresolved: ['rc_c'] } }));
  assert.match(text, /FAILED: 1 cited receipt did not resolve/);
  assert.match(text, /Nothing above can be trusted/);
  assert.match(text, /rc_c/);
});

test('a clean receipt check does not print a failure block', () => {
  assert.doesNotMatch(renderText(result()), /FAILED/);
});

test('an unverified rate is marked at the point of reading, not in a footnote', () => {
  const text = renderText(result({
    cost: {
      totalUsd: 0.058,
      lines: [{ key: 'brightdata.serp', kind: 'call', provider: null, calls: 10, inputTokens: 0, outputTokens: 0, usd: 0.058, verified: false }],
      hasUnverified: true,
      overCap: false,
    },
  }));
  assert.match(text, /\?\s+brightdata\.serp/);
  assert.match(text, /Treat that line as an estimate/);
});

test('a page we could not read prints its note, because that is information', () => {
  const base = result();
  const text = renderText(result({
    subject: { ...base.subject, source: 'url-fallback', note: 'page could not be read: page returned 403' },
  }));
  assert.match(text, /note: page could not be read: page returned 403/);
});

test('no em dash or en dash reaches a reader', () => {
  const text = renderText(result({ receiptCheck: { cited: 3, resolved: 2, unresolved: ['rc_c'] } }));
  assert.doesNotMatch(text, new RegExp(`${EM_DASH}|${EN_DASH}`));
});

test('json output is valid and carries the receipt ids behind every claim', () => {
  const parsed = JSON.parse(renderJson(result())) as {
    claims: { term: string; verdict: string; receiptIds: string[] }[];
    receiptCheck: { cited: number };
    corpus: { warm: boolean };
  };
  assert.equal(parsed.claims.length, 2);
  assert.equal(parsed.claims[0]?.verdict, 'finding');
  assert.deepEqual(parsed.claims[0]?.receiptIds, ['rc_a', 'rc_b', 'rc_c']);
  assert.equal(parsed.claims[1]?.verdict, 'weak-signal');
  assert.equal(parsed.receiptCheck.cited, 3);
  assert.equal(parsed.corpus.warm, true);
});

test('json nulls absent subject fields rather than dropping the keys', () => {
  const parsed = JSON.parse(renderJson(result())) as { subject: Record<string, unknown> };
  assert.equal(parsed.subject['brand'], null);
  assert.equal(parsed.subject['note'], null);
  assert.ok('url' in parsed.subject);
});

test('zero records reads as no evidence, not as a faint signal', () => {
  const text = renderText(result({ claims: [claim('price', [])] }));
  assert.match(text, /\[no evidence\]/);
  assert.doesNotMatch(text, /\[weak signal\]/);
  assert.doesNotMatch(text, /has not been corroborated/, 'nothing to explain when nothing was found');
});

test('the machine readable verdict is unchanged by that wording', () => {
  const parsed = JSON.parse(renderJson(result({ claims: [claim('price', [])] }))) as {
    claims: { verdict: string; records: number }[];
  };
  assert.equal(parsed.claims[0]?.verdict, 'weak-signal');
  assert.equal(parsed.claims[0]?.records, 0);
});

/* A fixed width column collided with the verdict on the first live run that
 * carried two sources, so the width is measured and the collision is a test. */
test('the source spread never collides with the verdict, however long it gets', () => {
  const wide = claim('comfort', [
    doc('rc_a', 'r/running'), doc('rc_b', 'r/trailrunning'), doc('rc_c', 'r/runningshoegeeks'),
    { ...doc('rc_d'), source: 'hackernews', channel: 'Ask HN: what shoes' },
    { ...doc('rc_e'), source: 'hackernews', channel: 'To Run Better' },
  ]);
  const line = renderText(result({ claims: [wide] })).split('\n').find((l) => l.trimStart().startsWith('comfort'))!;
  assert.match(line, /ch\s+\[finding\]$/, `columns collided: ${JSON.stringify(line)}`);
});

test('the meaning of a channel is spelled out wherever a channel count appears', () => {
  assert.match(renderText(result()), /A channel is a distinct place inside one source/);
});

test('no channel note when there are no channels to misread', () => {
  assert.doesNotMatch(renderText(result({ claims: [claim('price', [])] })), /A channel is a distinct place/);
});

test('a price is never printed as a bare number without naming its currency', () => {
  const base = result();
  const named = renderText(result({ subject: { ...base.subject, price: 110, currency: 'USD' } }));
  assert.match(named, /110 USD/);

  const unnamed = renderText(result({ subject: { ...base.subject, price: 110 } }));
  assert.match(unnamed, /price 110, currency not reported/);
  assert.doesNotMatch(unnamed, /\b110 USD\b/);
});

test('a voice only report does not print a column of zeroes', () => {
  const text = renderText(result());
  assert.doesNotMatch(text, /A0 B0/);
  assert.doesNotMatch(text, /A attested, a named party/);
});

test('when other tiers are present the spread is shown and explained', () => {
  const mixed = claim('defects', [
    { ...doc('rc_a'), source: 'cpsc', channel: 'recall' },
    doc('rc_b'),
  ]);
  const text = renderText(result({ claims: [mixed] }));
  assert.match(text, /A1 B0 C1 D0/);
  assert.match(text, /A attested, a named party stated it on the record/);
  assert.match(text, /\[finding, corroborated across tiers\]/);
});

test('the route that earned a finding is named, not just the verdict', () => {
  const attested = claim('recalls', [
    { ...doc('rc_a'), source: 'cpsc' },
    { ...doc('rc_b'), source: 'nhtsa' },
  ]);
  assert.match(renderText(result({ claims: [attested] })), /\[finding, two attested records\]/);
});

test('json carries the tier spread and the basis', () => {
  const mixed = claim('defects', [
    { ...doc('rc_a'), source: 'cpsc' },
    doc('rc_b'),
  ]);
  const parsed = JSON.parse(renderJson(result({ claims: [mixed] }))) as {
    claims: { tiers: Record<string, number>; basis: string }[];
  };
  assert.equal(parsed.claims[0]?.basis, 'cross-tier');
  assert.equal(parsed.claims[0]?.tiers['A'], 1);
});

/*
 * When a bare name did not resolve on its own, the corpus was asked who makes
 * it. Showing the candidates is how a reader checks the price was attached to
 * the right product rather than a plausible one.
 */
test('the brands the market named are shown, with their support', () => {
  const base = result();
  const text = renderText(result({
    subject: { ...base.subject, source: 'catalogue', brand: 'Allbirds' },
    brandsNamed: [
      { name: 'Allbirds', records: 12, channels: 4, receiptIds: ['rc_1111111111111111'] },
      { name: 'Nike', records: 3, channels: 2, receiptIds: ['rc_2222222222222222'] },
    ],
  }));

  assert.match(text, /Allbirds\s+12 rec \/ 4 ch/);
  assert.match(text, /Nike\s+3 rec \/ 2 ch/);

  /*
   * A receipt beside the count, because this list is a heuristic's output. A
   * real run offered Google, American and China as brands for running shoes,
   * printed in the same confident voice as a corroborated finding.
   */
  assert.match(text, /rc_1111111111111111/);
  assert.doesNotMatch(text, /brands the market named/,
    'it must not claim the market named these, only that the records repeat them');
});

test('no brand line when the subject resolved on its own', () => {
  assert.doesNotMatch(renderText(result()), /brands the market named/);
});

test('a sufficient run does not lecture the reader', () => {
  assert.doesNotMatch(renderText(result()), /NO ANSWER|THIN/);
});

test('a run that answered nothing says why and what would fix it', () => {
  const text = renderText(result({
    claims: [claim('sizing', [])],
    sufficiency: {
      verdict: 'insufficient',
      reason: 'every one of the 73 records found was rejected as off topic, so nothing was stored',
      suggestions: ['the subject may be too broad', 'name the product more specifically'],
      warnings: [], seen: 73, rejected: 73, stored: 0, findings: 0,
    },
  }));
  assert.match(text, /NO ANSWER  every one of the 73 records/);
  assert.match(text, /looked at 73, rejected 73 as off topic, stored 0/);
  assert.match(text, /- the subject may be too broad/);
});

test('a thin run is labelled differently from one that found nothing', () => {
  const text = renderText(result({
    sufficiency: {
      verdict: 'thin', reason: '12 records held, but nothing reached the corroboration threshold',
      suggestions: ['raise --queries'], warnings: [], seen: 40, rejected: 28, stored: 12, findings: 0,
    },
  }));
  assert.match(text, /^THIN  12 records held/m);
  assert.doesNotMatch(text, /NO ANSWER/);
});

/*
 * A hint changed where we looked, so a reader deciding whether to trust a thin
 * report needs to know a model chose the search terms.
 */
test('a model guess is shown and is labelled as a guess', () => {
  const text = renderText(result({
    hints: { brands: ['Allbirds'], category: 'running shoe', aliases: [], context: [], model: 'some/model:free' },
  }));
  assert.match(text, /guessed by some\/model:free: running shoe; brands Allbirds/);
  assert.match(text, /never about what is true/);
});

test('no guess line when the subject resolved on its own', () => {
  assert.doesNotMatch(renderText(result()), /guessed by/);
});

/* ------------------------------------------------------------------ */
/* the synthesis block                                                 */
/* ------------------------------------------------------------------ */

/* Built from real ResolvedClaim shapes rather than hand assembled, so a change
 * to the gate shows up here as a compile error rather than as a stale fixture. */
function synthesis(over: Partial<SynthesisReport> = {}): SynthesisReport {
  const docs = [doc('rc_1111111111111111', 'r/running'), doc('rc_2222222222222222', 'r/trailrunning'), doc('rc_3333333333333333', 'Ask HN')];
  const claims: ResolvedClaim[] = [{
    term: 'sizing',
    text: 'Buyers consistently report that these run small and advise ordering half a size up.',
    receipts: docs,
    corroboration: corroborate('sizing', docs),
    fabricated: [],
    unsupportedQuotes: [],
    verdict: 'finding',
  }];
  return {
    model: 'nvidia/nemotron-nano-9b-v2:free',
    claims,
    fabrication: fabricationReport(claims),
    discarded: [],
    evidence: { records: 3, truncated: 0, characters: 42 },
    usage: { inputTokens: 400, outputTokens: 900 },
    ...over,
  };
}

test('a model written finding is printed in its own block, never among the counts', () => {
  const text = renderText(result({ synthesis: synthesis() }));
  assert.match(text, /^WRITTEN   nvidia\/nemotron-nano-9b-v2:free, from 3 records/m);
  assert.match(text, /Sentences a model wrote/);
  assert.match(text, /\[finding    \] sizing/);
  /* The block sits after the arithmetic, so a reader meets the counts first. */
  assert.ok(text.indexOf('EVIDENCE') < text.indexOf('WRITTEN'));
});

test('nothing prints when no model ran', () => {
  assert.doesNotMatch(renderText(result()), /WRITTEN/);
});

test('AN INVENTED ID IS NAMED IN THE REPORT, NOT COUNTED AND HIDDEN', () => {
  const base = synthesis();
  const claim = { ...base.claims[0]!, fabricated: ['rc_deadbeefdeadbeef'], verdict: 'weak-signal' as const };
  const text = renderText(result({
    synthesis: { ...base, claims: [claim], fabrication: fabricationReport([claim]) },
  }));

  assert.match(text, /INVENTED: rc_deadbeefdeadbeef resolves to no record/);
  assert.match(text, /1 invented/);
  assert.match(text, /This is the check working, not the check failing/);
});

test('a quote nobody said is shown as rejected and quoted back', () => {
  const base = synthesis();
  const claim = {
    ...base.claims[0]!,
    unsupportedQuotes: ['these fell apart within a single week'],
    verdict: 'rejected' as const,
  };
  const text = renderText(result({
    synthesis: { ...base, claims: [claim], fabrication: fabricationReport([claim]) },
  }));
  assert.match(text, /\[REJECTED   \] sizing/);
  assert.match(text, /NOBODY SAID: "these fell apart within a single week"/);
});

test('a provider being down says so and says what it did not cost', () => {
  const text = renderText(result({
    synthesis: synthesis({ claims: [], fabrication: fabricationReport([]), error: 'every model returned 429' }),
  }));
  assert.match(text, /the model did not answer: every model returned 429/);
  assert.match(text, /Nothing else in this report depends on it/);
});

test('a long claim is wrapped rather than blowing out the fixed width layout', () => {
  const base = synthesis();
  const claim = { ...base.claims[0]!, text: 'word '.repeat(60).trim() };
  const text = renderText(result({ synthesis: { ...base, claims: [claim] } }));
  for (const line of text.split('\n')) assert.ok(line.length <= 100, `too wide: ${line.length}`);
});

test('json carries only ids that resolved, and names the ones that did not', () => {
  const base = synthesis();
  const claim = { ...base.claims[0]!, fabricated: ['rc_deadbeefdeadbeef'] };
  const parsed = JSON.parse(renderJson(result({
    synthesis: { ...base, claims: [claim], fabrication: fabricationReport([claim]) },
  }))) as { synthesis: { claims: { receiptIds: string[]; fabricated: string[] }[]; fabrication: { clean: boolean } } };

  assert.deepEqual(parsed.synthesis.claims[0]?.receiptIds, ['rc_1111111111111111', 'rc_2222222222222222', 'rc_3333333333333333']);
  assert.deepEqual(parsed.synthesis.claims[0]?.fabricated, ['rc_deadbeefdeadbeef']);
  assert.equal(parsed.synthesis.fabrication.clean, false);
});

test('json nulls synthesis rather than dropping the key', () => {
  const parsed = JSON.parse(renderJson(result())) as { synthesis: unknown };
  assert.equal(parsed.synthesis, null);
});

test('a model id longer than its column never collides with the next one', () => {
  /* MEASURED 2026-08-22 on a live run: a 31 character model id printed as
   * "nvidia/nemotron-nano-9b-v2:free1,957 in / 963 out". */
  const text = renderText(result({
    cost: {
      totalUsd: 0,
      hasUnverified: false,
      overCap: false,
      lines: [{
        key: 'nvidia/nemotron-nano-9b-v2:free',
        kind: 'llm',
        provider: null,
        calls: 1,
        inputTokens: 1957,
        outputTokens: 963,
        usd: 0,
        verified: true,
      }],
    },
  }));
  assert.match(text, /nvidia\/nemotron-nano-9b-v2:free 1,957 in \/ 963 out/);
});

test('a term the model and the term search disagree about is explained, not left to look like a contradiction', () => {
  /* The live case: the search matched one record for durability and the model,
   * having read them, cited three. Both numbers are right. */
  const docs = [doc('rc_1111111111111111'), doc('rc_2222222222222222'), doc('rc_3333333333333333')];
  const claim: ResolvedClaim = {
    /* The fixture counts two records for `problems`, so it is a weak signal
     * above and a finding here. That is the live case exactly. */
    term: 'problems',
    text: 'The market reports mixed durability.',
    receipts: docs,
    corroboration: corroborate('problems', docs),
    fabricated: [],
    unsupportedQuotes: [],
    verdict: 'finding',
  };
  const text = renderText(result({
    synthesis: synthesis({ claims: [claim], fabrication: fabricationReport([claim]) }),
  }));
  assert.match(text, /problems read differently above, and neither number is wrong/);
});

test('no explanation when the two agree, because that paragraph would be noise', () => {
  const docs = [doc('rc_1111111111111111'), doc('rc_2222222222222222'), doc('rc_3333333333333333')];
  const agreeing: ResolvedClaim = {
    term: 'quality',
    text: 'Buyers say the build holds up.',
    receipts: docs,
    corroboration: corroborate('quality', docs),
    fabricated: [],
    unsupportedQuotes: [],
    verdict: 'finding',
  };
  const text = renderText(result({
    synthesis: synthesis({ claims: [agreeing], fabrication: fabricationReport([agreeing]) }),
  }));
  assert.doesNotMatch(text, /read differently above/);
});

test('a term with no arithmetic claim above is not reported as a disagreement', () => {
  /* `sizing` is not one of the fixture's counted terms, so there is no number
   * on the page to disagree with. */
  assert.doesNotMatch(renderText(result({ synthesis: synthesis() })), /read differently above/);
});

/* ------------------------------------------------------------------ */
/* trends and share of voice                                           */
/* ------------------------------------------------------------------ */

const NOW = Date.UTC(2026, 7, 15);
const hist = (counts: Record<string, number>, undated = 0) => ({
  buckets: Object.entries(counts).map(([period, records]) => ({ period, records })),
  undated,
});
const madeTrend = (term: string, termCounts: Record<string, number>, totals: Record<string, number>, undated = 0) =>
  trendFor({ term, termHistogram: hist(termCounts, undated), categoryHistogram: hist(totals), nowMs: NOW });

const BIG_TOTALS = {
  '2026-03': 300, '2026-04': 300, '2026-05': 300, '2026-06': 300, '2026-07': 300, '2026-08': 300,
};

test('a rising trend is printed with the arithmetic a reader can check', () => {
  const text = renderText(result({
    trends: [madeTrend('quality', { '2026-03': 9, '2026-04': 9, '2026-05': 9, '2026-06': 60, '2026-07': 60, '2026-08': 60 }, BIG_TOTALS)],
  }));
  assert.match(text, /^TRENDS    2026-06 to 2026-08, against 2026-03 to 2026-05$/m);
  assert.match(text, /quality\s+rising\s+\+17\.0pp/);
  assert.match(text, /20\.0% of 900 records now, against 3\.0% of 900 before/);
  /* And it says what it is a share OF, because a share of records we happen to
   * hold is the bug this block exists to avoid. */
  assert.match(text, /Share of what was said in each period, not how many records we hold/);
});

test('THE NOISE FLOOR IS PRINTED, SO A CLOSE CALL IS VISIBLE AS ONE', () => {
  const text = renderText(result({
    trends: [madeTrend('quality', { '2026-03': 9, '2026-04': 9, '2026-05': 9, '2026-06': 60, '2026-07': 60, '2026-08': 60 }, BIG_TOTALS)],
  }));
  assert.match(text, /A move counts only above twice its own standard error, which here was \d+\.\dpp/);
});

test('steady and unknown are not printed, and are still on the json', () => {
  const trends = [
    madeTrend('quality', { '2026-03': 30, '2026-04': 30, '2026-05': 30, '2026-06': 31, '2026-07': 30, '2026-08': 30 }, BIG_TOTALS),
    madeTrend('price', { '2026-06': 2 }, { '2026-03': 4, '2026-06': 4 }),
  ];
  assert.deepEqual(trends.map((t) => t.direction), ['steady', 'unknown']);

  const text = renderText(result({ trends }));
  assert.doesNotMatch(text, /^TRENDS    2026/m, 'nothing changed, so no trend table');

  const parsed = JSON.parse(renderJson(result({ trends }))) as { trends: { direction: string }[] };
  assert.deepEqual(parsed.trends.map((t) => t.direction), ['steady', 'unknown'], 'a caller can still ask');
});

test('"we cannot tell yet" is said out loud, because it is fixed by waiting and steady is not', () => {
  const text = renderText(result({
    trends: [madeTrend('quality', { '2026-06': 2 }, { '2026-03': 4, '2026-06': 4 })],
  }));
  assert.match(text, /TRENDS    not enough dated history yet to compare periods/);
  assert.match(text, /Run this again in a month and it will have two windows/);
});

test('a term nobody raised before is printed as new rather than as a huge percentage', () => {
  const text = renderText(result({
    trends: [madeTrend('quality', { '2026-06': 20, '2026-07': 20 }, BIG_TOTALS)],
  }));
  assert.match(text, /quality\s+NEW/);
  assert.match(text, /nobody raised this in 900 records from 2026-03 to 2026-05, and 40 have since/);
  /* A jump from zero has no percentage change, and inventing one would be the
   * most quotable wrong number in the report. */
  assert.doesNotMatch(text, /Infinity|NaN/);
});

test('undated records are declared, so a thin trend can be doubted', () => {
  const text = renderText(result({
    trends: [madeTrend('quality', { '2026-03': 9, '2026-04': 9, '2026-05': 9, '2026-06': 60, '2026-07': 60, '2026-08': 60 }, BIG_TOTALS, 412)],
  }));
  assert.match(text, /412 records carried no usable date and are in no period above/);
});

test('a count is printed with the denominator that makes it a priority', () => {
  const text = renderText(result({
    voice: shareOfVoice([{ term: 'quality', records: 3 }, { term: 'problems', records: 2 }], 40),
  }));
  assert.match(text, /quality\s+3 receipts \/\s+3 channels\s+7\.5%/);
  assert.match(text, /the percentage is share of all \d+ records held for this category/);
});

test('an empty category prints no percentage rather than a zero that reads as a measurement', () => {
  const text = renderText(result({ voice: shareOfVoice([{ term: 'quality', records: 0 }], 0) }));
  assert.doesNotMatch(text, /share of all/);
});

test('json carries every trend with its window and its noise floor', () => {
  const parsed = JSON.parse(renderJson(result({
    trends: [madeTrend('quality', { '2026-03': 9, '2026-04': 9, '2026-05': 9, '2026-06': 60, '2026-07': 60, '2026-08': 60 }, BIG_TOTALS)],
    voice: shareOfVoice([{ term: 'quality', records: 3 }], 40),
  }))) as {
    trends: { term: string; direction: string; deltaPp: number; noisePp: number; recent: { from: string; total: number } }[];
    voice: { term: string; sharePct: number; rank: number }[];
  };

  assert.equal(parsed.trends[0]?.direction, 'rising');
  assert.equal(parsed.trends[0]?.recent.from, '2026-06');
  assert.equal(parsed.trends[0]?.recent.total, 900);
  assert.ok(parsed.trends[0]!.noisePp > 0, 'the floor travels with the verdict');
  assert.deepEqual(parsed.voice[0], { term: 'quality', records: 3, categoryRecords: 40, sharePct: 7.5, rank: 1 });
});

/* ------------------------------------------------------------------ */
/* versus what                                                         */
/* ------------------------------------------------------------------ */

const compareDocs = (term: string, n: number) =>
  Array.from({ length: n }, (_, i) => doc(`rc_${term}_${i}`, `r/c${i}`));

const comparison = (aRecords: number, aCorpus: number, bRecords: number, bCorpus: number) =>
  compareSides([
    { subject: 'wool runner', category: 'wool runner', corpusRecords: aCorpus, claims: [corroborate('sizing', compareDocs('a', aRecords))] },
    { subject: 'brooks ghost', category: 'brooks ghost', corpusRecords: bCorpus, claims: [corroborate('sizing', compareDocs('b', bRecords))] },
  ], ['sizing']);

test('THE SHARE IS PRINTED AND THE COUNT IS PRINTED AS ITS WORKING', () => {
  /*
   * A reader shown two counts side by side compares them whatever the caption
   * says, and across corpora of different depths that comparison is about how
   * hard we looked rather than about the products.
   */
  const text = renderText(result({ comparison: comparison(45, 300, 6, 300) }));

  assert.match(text, /VERSUS/);
  assert.match(text, /LOUDER FOR wool runner/);
  assert.match(text, /wool runner\s+15\.0%\s+45 of 300 records/);
  assert.match(text, /brooks ghost\s+2\.0%\s+6 of 300 records/);
  assert.match(text, /each retrieved as a corpus of its own/);
});

test('A TERM WE DECLINE TO CALL PRINTS THE REASON, NEVER A BLANK', () => {
  /* A reader who sees nothing assumes we found nothing. */
  const text = renderText(result({ comparison: comparison(4, 50, 4, 60) }));
  assert.match(text, /no call/);
  assert.match(text, /noise floor/);
  assert.doesNotMatch(text, /LOUDER FOR/);
});

test('a side we hold almost nothing for is called out rather than ranked', () => {
  const text = renderText(result({ comparison: comparison(40, 400, 1, 12) }));
  assert.match(text, /too little held to compare at all:/);
  assert.match(text, /brooks ghost\s+12 records/);
});

test('a rival that could not be retrieved is named in the report', () => {
  const c = compareSides(
    [{ subject: 'wool runner', category: 'wool runner', corpusRecords: 300, claims: [corroborate('sizing', compareDocs('a', 45))] }],
    ['sizing'],
    [{ subject: 'brooks ghost', reason: 'resolver timed out' }],
  );
  const text = renderText(result({ comparison: c }));
  assert.match(text, /asked for and not retrieved:/);
  assert.match(text, /brooks ghost\s+resolver timed out/);
});

test('no comparison prints no versus block at all', () => {
  assert.doesNotMatch(renderText(result()), /VERSUS/);
});

test('the json carries the comparison, reasons included', () => {
  const parsed = JSON.parse(renderJson(result({ comparison: comparison(45, 300, 6, 300) })));
  assert.equal(parsed.comparison.baseline, 'wool runner');
  assert.equal(parsed.comparison.terms[0].louder, 'wool runner');
  assert.ok(parsed.comparison.terms[0].reason.length > 0);
  assert.equal(JSON.parse(renderJson(result())).comparison, null);
});
