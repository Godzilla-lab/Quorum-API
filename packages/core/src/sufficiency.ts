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

import { MIN_RECEIPTS } from '@quorum/corpus/constants';
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
  /*
   * Trouble the verdict does NOT capture, printed even when the verdict is
   * `sufficient`. The verdict answers "was this enough", and a collapsed gate
   * produces plenty: a run on the subject "love" stored 2544 of 2544 records
   * seen, printed findings from all of them, and this module called it
   * sufficient. The alarm that catches a gate rejecting everything existed;
   * the symmetric one for a gate rejecting nothing did not.
   */
  warnings: string[];
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

/*
 * The gate pass rate above which a run is flagged rather than trusted.
 *
 * 0.95 rather than 1.0 because dedupe and per source budgets shave a few
 * records off `stored` even when the gate rejected nothing, so a collapsed
 * gate does not reliably present as exactly 100%. The floor on `seen` keeps a
 * legitimately scoped run quiet: a regulator queried by product name returns
 * five records that are all on topic, and five for five is health, not
 * collapse. 200 is above every scoped source's observed yield and far below
 * the thousands a general forum returns when the gate has stopped gating.
 */
export const GATE_ALARM_PASS_RATE = 0.95;
export const GATE_ALARM_MIN_SEEN = 200;

/*
 * The share of stored records that passed on their container's word alone
 * above which the run is flagged. A healthy scoped community carries real
 * elliptical evidence ("Same, had to size up" in a shoe subreddit), so a
 * minority share is normal and a 0.5 threshold would cry wolf on dedicated
 * communities whose members rarely repeat the subject. Near one, the
 * container was doing all the work: the "love" failure stored reality TV
 * chatter from communities that merely have love in their names, and next to
 * none of it named the subject itself. 0.8 is chosen conservatively, not
 * measured; revisit when the evals/ label sets are large enough to measure
 * it, and record the measurement here when they are.
 */
export const CHANNEL_VOUCH_ALARM_SHARE = 0.8;

export function assessSufficiency(input: SufficiencyInput): Sufficiency {
  const seen = input.retrieval?.totalSeen ?? 0;
  const rejected = input.retrieval?.outcomes.reduce((n, o) => n + o.recordsGated, 0) ?? 0;
  const stored = input.retrieval?.totalWritten ?? 0;
  const findings = input.claims.filter((c) => c.verdict === 'finding').length;

  const warnings: string[] = [];
  if (seen >= GATE_ALARM_MIN_SEEN && stored / seen > GATE_ALARM_PASS_RATE) {
    warnings.push(
      `stored ${stored} of ${seen} records seen, and a gate that rejects nothing usually is not gating`,
    );
    warnings.push(
      'the subject may be a single common word: communities matched by name can vouch for every record in them, so treat these findings with suspicion and name the product more specifically',
    );
  }

  /*
   * The second alarm on the same failure, from the other side. The pass rate
   * says the gate rejected nothing; this says that of what was stored, almost
   * none of it names the subject in its own words. Either alone can be
   * innocent. A run where nearly everything was vouched for by its container
   * is a run whose evidence is about whatever those containers are actually
   * about, which on a one word subject is not the subject.
   */
  const vouched = input.retrieval?.outcomes.reduce((n, o) => n + (o.recordsChannelVouched ?? 0), 0) ?? 0;
  if (stored >= GATE_ALARM_MIN_SEEN && vouched / stored > CHANNEL_VOUCH_ALARM_SHARE) {
    warnings.push(
      `${vouched} of ${stored} stored records never name the subject themselves and were vouched for by a community name or thread title, so the evidence may be about what those places discuss rather than the subject as asked`,
    );
  }

  const base = { seen, rejected, stored, findings, warnings };
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
