/*
 * Attested records, surfaced because they exist rather than because they
 * matched a question.
 *
 * FOUND BY RUNNING IT, 2026-08-22.
 *
 * A "knee brace" report retrieved twelve real FDA enforcement reports, stored
 * all twelve, and then answered "no evidence" to all three questions. The
 * questions were safety, defects and failure. The recalls say "potential for
 * outer pouch sterile barrier to be compromised".
 *
 * Nothing was broken. Claims are built by searching the corpus for the caller's
 * own terms, and regulatory prose does not use the words a buyer would. So the
 * strongest evidence in the corpus, the only tier A evidence in it, was held
 * and never shown.
 *
 * THE FIX IS NOT MORE KEYWORDS, IT IS RECOGNISING WHAT THIS EVIDENCE IS.
 *
 * A forum comment is evidence about a question. A recall is not: it is a fact
 * about the product that a named party told a regulator, and its existence is
 * the finding whether or not anybody asked. "Three recall notices name this
 * product" is an answer to a question nobody typed, and it is usually the most
 * important sentence in the report.
 *
 * So attested records get their own block, gated by the same corroboration
 * rules as everything else. Two of them are a finding by the attested route,
 * one is a weak signal, and none is silence.
 */

import type { Doc } from '@quorum/corpus';
import { PROMOTING_TIERS, tierOf } from '@quorum/corpus/tiers';
import { corroborate, type Corroboration } from './corroborate.ts';
import { sampleEvidence, type ClaimEvidence } from './evidence.ts';

export interface AttestedFindings {
  /* Distinct attested records held for this subject. */
  records: number;
  /* Distinct named parties. Two recalls against one firm are one firm's
   * problem; two against different firms are a category's. */
  parties: number;
  /* The corroboration verdict, computed by the same rules as any other claim. */
  corroboration: Corroboration;
  /* What they actually say, so a reader does not have to fetch to find out. */
  evidence: ClaimEvidence[];
  /* Every one of them, for checking. */
  receiptIds: string[];
}

/*
 * Only tier A. Deliberately not "everything strong": a price is transactional
 * and factual, and it is still not a named party accepting consequences for a
 * statement. Widening this would make the block mean less every time it fired.
 */
export function attestedFindings(records: readonly Doc[], sampleSize = 3): AttestedFindings | null {
  const attested = records.filter((r) => tierOf(r.source) === 'A');
  if (!attested.length) return null;

  /* The term is what these records are about, not a question that was asked.
   * Named so a renderer cannot accidentally print it as a caller's question. */
  const corroboration = corroborate('attested records', attested);
  const parties = new Set(attested.map((r) => `${r.source}/${r.channel}`)).size;

  return {
    records: corroboration.records,
    parties,
    corroboration,
    evidence: sampleEvidence(attested, sampleSize),
    receiptIds: corroboration.receiptIds,
  };
}

/*
 * Exported so a caller can check the assumption this module rests on: that
 * tier A is the only tier whose records are findings by existence.
 */
export const ATTESTED_TIER = 'A' as const;
export const PROMOTES = PROMOTING_TIERS;
