/*
 * One caller's claims, from the corpus as it stands.
 *
 * This is the half of a report that is NEVER shared between callers. The
 * retrieval that filled the corpus is shared, because the corpus is global and
 * its cost is genuinely common. The questions are not: joining somebody else's
 * run must not mean inheriting their questions, and this function is where that
 * separation is enforced rather than promised.
 *
 * It reads the corpus and never writes to it, so it is safe to call once per
 * attached report after a single retrieval, and safe to call at all on a warm
 * category with no retrieval at all.
 */

import {
  assessSufficiency, corroborate, discoverThemes, shareOfVoice, trendFor, withEvidence,
  type ClaimWithEvidence, type RetrievalResult, type Trend,
} from '@receipts/core';
import type { CorpusDriver, Doc } from '@receipts/corpus';
import type { ReportClaims } from './jobs.ts';

/*
 * How many records back a single claim before we stop counting. Well above the
 * corroboration threshold and bounded, so a warm category cannot pull its whole
 * corpus into memory once per term per caller. Same number as the CLI uses,
 * because a hosted report and a local one must not disagree about a count.
 */
const EVIDENCE_PER_TERM = 500;

export interface ClaimsInput {
  corpus: CorpusDriver;
  category: string;
  terms: readonly string[];
  /* From the run that filled the corpus, so sufficiency can tell "nobody
   * discusses this" apart from "we looked in the wrong place". Null on a warm
   * category answered with no retrieval at all, which is a real state. */
  retrieval: RetrievalResult | null;
  subjectResolved: boolean;
  /* Injected so a test can run at a fixed instant, and so the windows a report
   * compares are the ones its own timestamp implies. */
  nowMs?: number;
}

export async function computeClaims(input: ClaimsInput): Promise<ReportClaims> {
  const { corpus, category, terms } = input;

  const claims: ClaimWithEvidence[] = [];
  for (const term of terms) {
    const rows: Doc[] = await corpus.search(term, { category, limit: EVIDENCE_PER_TERM });
    /* The same rows that produced the count produce the sample, so a quote can
     * never come from a record that was not counted. */
    claims.push(withEvidence(corroborate(term, rows), rows));
  }

  const warmth = await corpus.categoryStats(category);

  /*
   * What the corpus is about, as opposed to what this caller asked about.
   * Per report, because the exclusion depends on this caller's own terms: a
   * theme is only a discovery if the person did not already ask for it.
   */
  const held = await corpus.byCategory(category, { limit: 1000 });
  const themes = discoverThemes(held, { exclude: [category, ...terms] });

  /*
   * TREND, PER CALLER, FROM DATES ALREADY IN THE CORPUS.
   *
   * Aggregate counts rather than rows, because a share of conversation needs
   * the WHOLE denominator and computing it from a capped page would measure
   * the cap. See `trend.ts` for what the naive version reported.
   */
  const nowMs = input.nowMs ?? Date.now();
  const categoryHistogram = await corpus.dateHistogram({ category });
  const trends: Trend[] = [];
  for (const term of terms) {
    const termHistogram = await corpus.dateHistogram({ category, query: term });
    trends.push(trendFor({ term, termHistogram, categoryHistogram, nowMs }));
  }
  const sufficiency = assessSufficiency({
    retrieval: input.retrieval,
    claims,
    corpusRecords: warmth.docs,
    subjectResolved: input.subjectResolved,
  });

  /*
   * SEPARATE ARRAYS, NOT ONE ARRAY WITH A FLAG.
   *
   * A consumer cannot print a two record claim as a market pattern by
   * forgetting a filter, because there is no filter to forget. That is one
   * missing `if` away in every client that has ever been written against a flag.
   */
  const findings = claims.filter((c) => c.verdict === 'finding');
  const weakSignals = claims.filter((c) => c.verdict !== 'finding');

  /*
   * EVERY RECEIPT THE REPORT PRINTS, fetched back before it is returned.
   *
   * Today the ids come from corpus rows we just read, so this is close to a
   * tautology. It stops being one the moment synthesis supplies them, and the
   * check goes in now while it costs nothing rather than being built under
   * pressure later.
   */
  const cited = [...new Set([
    ...findings.flatMap((c) => c.receiptIds),
    /* The samples are printed too, so their ids are cited in every sense that
     * matters and must resolve like any other. */
    ...claims.flatMap((c) => c.evidence.map((e) => e.receiptId)),
  ])];
  const resolved = cited.length ? await corpus.getByReceiptIds(cited) : [];
  const resolvedIds = new Set(resolved.map((r) => r.receiptId));

  return {
    findings,
    weakSignals,
    /* Only synthesis can produce a rejected claim, because rejection means a
     * model quoted something nobody said. Arithmetic over the corpus cannot. */
    rejected: [],
    sufficiency,
    trends,
    themes,
    /* Built from the same counts the claims carry, so the two halves of one
     * report cannot disagree about how many records mention a term. */
    voice: shareOfVoice(claims.map((c) => ({ term: c.term, records: c.records })), warmth.docs),
    receiptCheck: {
      cited: cited.length,
      resolved: resolvedIds.size,
      unresolved: cited.filter((id) => !resolvedIds.has(id)),
    },
  };
}
