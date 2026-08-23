/*
 * Was this enough to answer the question.
 *
 * "NOT ENOUGH EVIDENCE" IS AN ANSWER, AND IT HAS TO BE A FIRST CLASS ONE.
 *
 * A run on a niche subject used to print an empty evidence table and stop. That
 * is technically correct and completely useless: the reader cannot tell whether
 * nobody discusses this product, or whether we looked in the wrong place, or
 * whether we found plenty and threw it all away.
 *
 * Those three are entirely different situations and only one of them is the
 * market's fault. Measured live 2026-08-22 on the subject "wool runner":
 *
 *   before the relevance fix   73 seen, 0 rejected, 73 stored, and the report
 *                              printed "sizing: 5 receipts [finding]" from
 *                              comments about supermarket facemasks
 *   after the relevance fix    73 seen, 69 rejected, 4 stored, no findings
 *   after the discovery fix     0 seen,  0 rejected,  0 stored, no findings
 *
 * The middle one means our gate did its job on a bad community. The last one
 * means we could not find anywhere to look. A reader deserves to know which,
 * and what would fix it, rather than being handed the same blank table.
 */

import { MIN_RECEIPTS } from '@receipts/corpus/constants';
import type { Corroboration } from './corroborate.ts';
import type { RetrievalResult } from './retrieve.ts';

export type SufficiencyVerdict = 'sufficient' | 'thin' | 'insufficient';

export interface Sufficiency {
  verdict: SufficiencyVerdict;
  /* One sentence a reader can act on. */
  reason: string;
  /*
   * What would actually change the outcome. Concrete and specific: "try
   * --communities" is useless without saying why it would help.
   */
  suggestions: string[];
  /* The numbers behind the verdict, so it can be checked rather than believed. */
  seen: number;
  rejected: number;
  stored: number;
  findings: number;
}

export interface SufficiencyInput {
  retrieval: RetrievalResult | null;
  claims: readonly Corroboration[];
  /* Everything the corpus holds for this category, warm or freshly gathered. */
  corpusRecords: number;
  /* True when the subject resolved to a real product with commercial facts. */
  subjectResolved: boolean;
}

export function assessSufficiency(input: SufficiencyInput): Sufficiency {
  const seen = input.retrieval?.totalSeen ?? 0;
  const rejected = input.retrieval?.outcomes.reduce((n, o) => n + o.recordsGated, 0) ?? 0;
  const stored = input.retrieval?.totalWritten ?? 0;
  const findings = input.claims.filter((c) => c.verdict === 'finding').length;

  const base = { seen, rejected, stored, findings };
  const suggestions: string[] = [];

  if (findings > 0) {
    return {
      ...base,
      verdict: 'sufficient',
      reason: `${findings} of ${input.claims.length} questions have enough corroboration to answer`,
      suggestions: [],
    };
  }

  /*
   * Nothing in the corpus at all. Split by WHY, because the two causes need
   * opposite advice and telling someone to narrow their subject when the real
   * problem is that we found nowhere to look wastes their time.
   */
  if (input.corpusRecords === 0) {
    if (seen > 0 && rejected >= seen) {
      suggestions.push('the subject may be too broad: a single common word matches communities about something else');
      suggestions.push('name the product more specifically, for example a brand plus a model');
      return {
        ...base,
        verdict: 'insufficient',
        reason: `every one of the ${seen} records found was rejected as off topic, so nothing was stored`,
        suggestions,
      };
    }

    suggestions.push('pass --communities with the names of places this is discussed');
    if (!input.subjectResolved) {
      suggestions.push('pass the product URL directly, which also recovers price, images and brand');
    }
    suggestions.push('a product this new or this niche may genuinely have no public discussion yet');
    return {
      ...base,
      verdict: 'insufficient',
      reason: 'no records were found anywhere we looked',
      suggestions,
    };
  }

  /*
   * Records exist but nothing cleared the bar. This is the honest middle, and
   * it is the state a good report should be willing to end in.
   */
  const best = [...input.claims].sort((a, b) => b.records - a.records)[0];
  suggestions.push(`a claim needs ${MIN_RECEIPTS} independent receipts, and the strongest here has ${best?.records ?? 0}`);
  suggestions.push('raise --queries to gather more, or re-run later once the corpus is warmer');
  if (input.retrieval?.degraded.length) {
    suggestions.push(`${input.retrieval.degraded.map((d) => d.source).join(', ')} contributed nothing, so the report is missing a leg`);
  }
  return {
    ...base,
    verdict: 'thin',
    reason: `${input.corpusRecords} records held, but nothing reached the corroboration threshold`,
    suggestions,
  };
}
