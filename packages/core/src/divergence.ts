/*
 * The gap between what a market says and what anyone has attested.
 *
 * WHY THIS IS THE THING COMPETITORS CANNOT COPY.
 *
 * Researched 2026-08-22. Regulatory aggregation is a solved market:
 * RecallStream normalises 31 official sources across 22 countries, SuperRecall
 * covers 18 regulators in 60 countries from $449 a month. Social listening is
 * equally crowded. Research APIs that return citations are well funded and
 * several of them cite better than we do per field.
 *
 * Every one of those products holds ONE KIND of evidence. A recall aggregator
 * has regulators and no buyers. A listening tool has buyers and no regulators.
 * A search API has whatever the index returned this second, with no tier at all.
 *
 * Holding both, with a receipt behind each, makes a question askable that none
 * of them can ask: WHERE DO THE TWO DISAGREE?
 *
 * TWO ASYMMETRIES, AND BOTH ARE ACTIONABLE.
 *
 *   VOICE WITHOUT ATTESTATION
 *   Buyers report a problem repeatedly and no regulator and no filing mentions
 *   it. Either it is an emerging issue nobody has acted on yet, which is the
 *   most valuable thing a researcher can find, or it is a preference rather
 *   than a defect. The report says which is unknown and hands over the
 *   receipts.
 *
 *   ATTESTATION WITHOUT VOICE
 *   A regulator acted and buyers are not discussing it. Usually that means the
 *   market does not know. For a buyer that is a warning; for a competitor it is
 *   an opening; for the brand it is a recall that is not reaching people.
 *
 * WHY THERE IS NO SENTIMENT HERE, AND THERE NEVER WILL BE.
 *
 * The obvious version of this feature scores how positive each side is and
 * reports the delta. That would be an unfalsifiable number, which is the one
 * thing this product refuses. So the comparison is on PRESENCE, which is a fact
 * a reader can check: did anybody attest to this, did anybody say it, how many,
 * and here are their ids.
 */

import type { Doc } from '@quorum/corpus';
import { MIN_RECEIPTS } from '@quorum/corpus/constants';
import { tierOf } from '@quorum/corpus/tiers';
import type { Corroboration } from './corroborate.ts';

export type Divergence =
  /* Buyers repeatedly report it, nobody has attested to it. */
  | 'voice-without-attestation'
  /* A named party attested to it, buyers are not discussing it. */
  | 'attestation-without-voice'
  /* Both, which is the strongest state evidence can be in. */
  | 'corroborated-across-tiers'
  /* Not enough of either side to say anything about the gap. */
  | 'thin';

export interface TierGap {
  term: string;
  /* Distinct receipts per side. Counted, not scored. */
  attested: number;
  transactional: number;
  voice: number;
  divergence: Divergence;
  /* One sentence a reader can act on, and check. */
  reason: string;
  /* Both sides listed, so the gap itself is verifiable. */
  attestedReceiptIds: string[];
  voiceReceiptIds: string[];
}

/*
 * The records behind one claim, split by what kind of evidence they are.
 *
 * Deduplicated by receipt id first, because the same utterance harvested under
 * two categories is two rows and counting it twice on either side of a
 * comparison would manufacture a gap that is not there.
 */
export function tierGap(claim: Corroboration, records: readonly Doc[]): TierGap {
  const seen = new Set<string>();
  const attested: string[] = [];
  const voice: string[] = [];
  let transactional = 0;

  for (const record of records) {
    if (seen.has(record.receiptId)) continue;
    seen.add(record.receiptId);

    const tier = tierOf(record.source);
    if (tier === 'A') attested.push(record.receiptId);
    else if (tier === 'B') transactional++;
    else if (tier === 'C') voice.push(record.receiptId);
  }

  const divergence: Divergence =
    attested.length > 0 && voice.length > 0 ? 'corroborated-across-tiers'
      : attested.length > 0 ? 'attestation-without-voice'
        : voice.length >= MIN_RECEIPTS ? 'voice-without-attestation'
          : 'thin';

  const reason = {
    'corroborated-across-tiers':
      `${attested.length} attested and ${voice.length} from buyers, so both sides of the market say this`,
    'attestation-without-voice':
      `${attested.length} attested and nobody discussing it, so the market may not know`,
    'voice-without-attestation':
      `${voice.length} buyers report this and nobody has attested to it, so it is unacted on or it is a preference`,
    thin: 'not enough on either side to compare',
  }[divergence];

  return {
    term: claim.term,
    attested: attested.length,
    transactional,
    voice: voice.length,
    divergence,
    reason,
    attestedReceiptIds: attested,
    voiceReceiptIds: voice,
  };
}

/*
 * The gaps worth printing.
 *
 * `thin` is dropped because a comparison with nothing on either side is not a
 * finding, and `corroborated-across-tiers` is kept because agreement between a
 * regulator and a thousand buyers is the strongest statement this product can
 * make about anything.
 */
export function notableGaps(gaps: readonly TierGap[]): TierGap[] {
  return gaps.filter((g) => g.divergence !== 'thin');
}

/*
 * Silence, reported as a result rather than as an absence.
 *
 * "We searched five regulators across two continents and twenty years of
 * European alerts and found nothing" is a real answer, and for a buyer it is
 * often the answer they wanted. Every competitor in this space returns an empty
 * array here, which reads as a failed query rather than as a clean record.
 *
 * It is only honest when the attested sources actually ran, so the caller has
 * to say which did. A source that was skipped or degraded proves nothing.
 */
export interface AttestedSilence {
  /* Sources that ran and returned nothing relevant. */
  searched: string[];
  /* True only when at least one attested source completed successfully. */
  meaningful: boolean;
  reason: string;
}

export function attestedSilence(
  attestedSourcesRun: readonly string[],
  attestedRecordsFound: number,
): AttestedSilence | null {
  if (attestedRecordsFound > 0) return null;
  if (!attestedSourcesRun.length) return null;

  return {
    searched: [...attestedSourcesRun],
    meaningful: true,
    reason:
      `no recall, filing or safety alert names this, across ${attestedSourcesRun.length} `
      + `regulator${attestedSourcesRun.length === 1 ? '' : 's'} that answered`,
  };
}
