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
  assessSufficiency, corroborate, createCostMeter, discoverThemes, splitEvidenceRows,
  shareOfVoice, synthesiseAndResolve, trendFor, withEvidence,
  type AskModel, type ClaimWithEvidence, type RetrievalResult, type SynthesisReport, type Trend,
} from '@quorum/core';
import type { CorpusDriver, Doc } from '@quorum/corpus';
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
  /*
   * SYNTHESIS, WHEN THE OPERATOR CONFIGURED A MODEL AND THE BUDGET SAID YES.
   *
   * Absent, the report is what it always was: arithmetic over the corpus. The
   * caller decides whether to pass one, because the spend decision belongs to
   * whoever pays the bill and this module owns neither the keys nor the
   * quotas. The model's claims travel through the same fabrication gate the
   * CLI uses, `synthesiseAndResolve`, so an invented id is dropped and
   * counted before anything here sees it.
   */
  askModel?: AskModel;
  /* What to call the subject in the prompt. Falls back to the category. */
  subjectTitle?: string;
}

export async function computeClaims(input: ClaimsInput): Promise<ReportClaims> {
  const { corpus, category, terms } = input;

  const claims: ClaimWithEvidence[] = [];
  const termRows = new Map<string, Doc[]>();
  for (const term of terms) {
    const found: Doc[] = await corpus.search(term, { category, limit: EVIDENCE_PER_TERM });
    /* "had absolutely no problem" is praise, not a problems receipt. The
     * stance split sends records whose every mention of a complaint shaped
     * term is negated to the REFUTING side, where they are counted against
     * the claim instead of being silently discarded. See stance.ts. */
    const { supporting: rows, refuting } = splitEvidenceRows(term, found);
    termRows.set(term, rows);
    /* The same rows that produced the count produce the sample, so a quote can
     * never come from a record that was not counted. */
    claims.push(withEvidence(corroborate(term, rows, { refuting }), rows));
  }

  /*
   * The records handed to the model are exactly the rows that produced the
   * counts above, deduped by receipt id, same rule as the CLI: a model
   * reasoning over evidence the counts never saw could cite a record the
   * report cannot account for. Cost is computed from the tokens the provider
   * reported and returned to the caller, who owns the quota to charge.
   */
  let synthesis: (SynthesisReport & { costUsd: number }) | null = null;
  if (input.askModel) {
    const forModel = [...new Map(
      [...termRows.values()].flat().map((r) => [r.receiptId, r]),
    ).values()];
    /*
     * A SYNTHESIS FAILURE COSTS THE PROSE AND NOTHING ELSE. The layers below
     * already return errors as values, and this catch is the belt for
     * whatever they have not met yet: the first production synthesis attempt
     * (2026-08-24) failed a customer's whole report because a malformed env
     * var made the transport throw at request build time. The arithmetic
     * findings above owed that caller nothing model shaped.
     */
    try {
      const report = await synthesiseAndResolve(
        { subject: input.subjectTitle ?? category, terms: [...terms], records: forModel },
        input.askModel,
        corpus,
      );
      const meter = createCostMeter({ label: 'quorum-hosted-synthesis' });
      if (report.model && report.usage) {
        meter.usage(report.model, {
          input_tokens: report.usage.inputTokens,
          output_tokens: report.usage.outputTokens,
        });
      }
      synthesis = { ...report, costUsd: meter.total() };
    } catch (cause) {
      synthesis = {
        model: null,
        claims: [],
        fabrication: {
          claimsChecked: 0, idsCited: 0, idsFabricated: 0,
          quotesChecked: 0, quotesUnsupported: 0, claimsRejected: 0, clean: true,
        },
        discarded: [],
        evidence: { records: 0, truncated: 0, characters: 0 },
        usage: null,
        error: cause instanceof Error ? cause.message : 'synthesis failed',
        costUsd: 0,
      };
    }
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
  /* Divided evidence gets its own arrays for the same reason findings do: a
   * contested claim buried among weak signals reads as "not enough evidence"
   * when the truth is "plenty of evidence, and it disagrees". */
  const contested = claims.filter((c) => c.verdict === 'contested');
  const refuted = claims.filter((c) => c.verdict === 'refuted');
  const weakSignals = claims.filter((c) => c.verdict === 'weak-signal');

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
    /* Synthesis receipts already survived resolveCitations; checking them
     * again here is defence in depth, and it keeps the receiptCheck line an
     * honest total over everything the report prints. */
    ...(synthesis?.claims ?? [])
      .filter((c) => c.verdict === 'finding')
      .flatMap((c) => c.receipts.map((r) => r.receiptId)),
  ])];
  const resolved = cited.length ? await corpus.getByReceiptIds(cited) : [];
  const resolvedIds = new Set(resolved.map((r) => r.receiptId));

  return {
    findings,
    contested,
    refuted,
    weakSignals,
    /* Only synthesis can produce a rejected claim, because rejection means a
     * model quoted something nobody said. Arithmetic over the corpus cannot. */
    rejected: synthesis ? synthesis.claims.filter((c) => c.verdict === 'rejected') : [],
    synthesis,
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
