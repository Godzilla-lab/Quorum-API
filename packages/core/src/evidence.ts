/*
 * Evidence a caller can actually read, attached to the claim it supports.
 *
 * WHY THIS EXISTS, FOUND BY READING OUR OWN OUTPUT ON 2026-08-22.
 *
 * A real cold run returned a 7,076 byte JSON response containing 183 receipt
 * ids and NOT ONE WORD that a human had written. Every number was there and
 * every quote was absent. An application rendering that response has to make
 * 183 further requests before it can show a person anything, and the text
 * report printed counts with no quotes at all.
 *
 * That is a census, not research. The receipt ids are the proof and they were
 * never meant to be the payload: the whole pitch is that a reader can see what
 * somebody said AND check it, and we were shipping only the second half.
 *
 * WHY A SAMPLE RATHER THAN EVERYTHING.
 *
 * Returning all 183 records inline would put a megabyte on the wire for a claim
 * a reader skims. So a claim carries a bounded, ordered sample plus the full id
 * list, which keeps the response small while leaving every record reachable.
 * The sample is evidence to read; `receiptIds` remains the evidence of record.
 */

import type { Doc, EvidenceTier, SourceId } from '@quorum/corpus';
import { scoreKindOf, tierOf, type ScoreKind } from '@quorum/corpus/tiers';
import type { Corroboration } from './corroborate.ts';
import { countVoices } from './voices.ts';

/*
 * MEASURED 2026-08-22 across 2,373 real comments: p50 is 124 characters and
 * p75 is 223. A 240 character excerpt therefore arrives whole for roughly three
 * quarters of records, and the truncation is marked when it happens so nobody
 * quotes a cut sentence as though it ended there.
 */
const EXCERPT_CHARS = 240;

/*
 * Three, because that is the corroboration threshold. A reader who sees the
 * number of receipts a claim needs and then sees exactly that many quotes can
 * judge the claim without fetching anything, and can still fetch everything.
 */
const SAMPLE_SIZE = 3;

export interface ClaimEvidence {
  receiptId: string;
  source: SourceId;
  tier: EvidenceTier;
  /* The distinct place inside the source: a subreddit, a story thread. */
  channel: string;
  score: number;
  /*
   * What that number means in this source. Votes, stars, or nothing.
   *
   * Without it a renderer prints "2 points" under a two star review, which
   * inverts the meaning: a low number reads as faint agreement when the person
   * said the product was bad. And "0 points" under a federal recall reads as
   * nobody agreeing with a safety notice.
   */
  scoreKind: ScoreKind;
  /* Permalink to the record at its source. Go and read it. */
  url: string;
  createdUtc: number;
  /* The words, trimmed to a readable length. */
  excerpt: string;
  /* True when `excerpt` is shorter than what the person wrote. */
  truncated: boolean;
}

export interface ClaimWithEvidence extends Corroboration {
  /*
   * A bounded sample of what people actually said, ordered so the sample is
   * representative rather than merely the loudest.
   */
  evidence: ClaimEvidence[];
  /*
   * How concentrated the evidence is, so a reader can tell "forty people in
   * forty places" from "forty people in one place".
   *
   * Reported because a real run on 2026-08-22 drew all 143 of its Reddit
   * records from a SINGLE subreddit while the claim line read "53 records
   * across 44 channels", and nothing in the response said which of those two
   * situations the reader was looking at.
   */
  concentration: {
    /* Share of receipts coming from the single largest channel, 0 to 1. */
    largestChannelShare: number;
    /* Named, so the caller can go and look at the place doing the talking. */
    largestChannel: string | null;
    /*
     * True when one channel supplies most of the evidence. A finding can be
     * true and concentrated at the same time; this says which it is rather than
     * deciding for the reader.
     */
    singleChannelDominant: boolean;
  };
  /*
   * The receipt count with near duplicate texts collapsed: the honest lower
   * bound on how many people are talking. Reported next to the raw count and
   * never gated on, for the parity reason given in voices.ts. Twenty five
   * copies of one paragraph are twenty five receipts and one voice, and a
   * reader deserves both numbers.
   */
  voices: {
    independent: number;
    collapsed: number;
  };
}

export function toEvidence(record: Doc): ClaimEvidence {
  const body = record.text.replace(/\s+/g, ' ').trim();
  const truncated = body.length > EXCERPT_CHARS;
  return {
    receiptId: record.receiptId,
    source: record.source,
    tier: tierOf(record.source),
    channel: record.channel,
    score: record.score,
    scoreKind: scoreKindOf(record.source),
    url: record.url,
    createdUtc: record.createdUtc,
    excerpt: truncated ? `${body.slice(0, EXCERPT_CHARS - 3)}...` : body,
    truncated,
  };
}

/*
 * SPREAD BEFORE SCORE, WHICH IS THE WHOLE POINT.
 *
 * Sorting the sample by score alone would return three comments from whichever
 * community is loudest, and a reader would see agreement that the corpus does
 * not contain. So the sample takes the best record from each distinct channel
 * first, and only then fills up from what is left.
 */
export function sampleEvidence(records: readonly Doc[], size = SAMPLE_SIZE): ClaimEvidence[] {
  const seen = new Set<string>();
  const byScore = [...records]
    .filter((r) => {
      if (seen.has(r.receiptId)) return false;
      seen.add(r.receiptId);
      return true;
    })
    .sort((a, b) => b.score - a.score);

  const picked: Doc[] = [];
  const usedChannels = new Set<string>();

  for (const record of byScore) {
    if (picked.length >= size) break;
    const key = `${record.source}/${record.channel}`;
    if (usedChannels.has(key)) continue;
    usedChannels.add(key);
    picked.push(record);
  }
  for (const record of byScore) {
    if (picked.length >= size) break;
    if (picked.includes(record)) continue;
    picked.push(record);
  }

  return picked.map(toEvidence);
}

export function measureConcentration(records: readonly Doc[]): ClaimWithEvidence['concentration'] {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.receiptId)) continue;
    seen.add(record.receiptId);
    const key = `${record.source}/${record.channel}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const total = seen.size;
  if (!total) return { largestChannelShare: 0, largestChannel: null, singleChannelDominant: false };

  let largestChannel: string | null = null;
  let largest = 0;
  for (const [channel, n] of counts) {
    if (n > largest) { largest = n; largestChannel = channel; }
  }

  const share = largest / total;
  return {
    largestChannelShare: share,
    largestChannel,
    /*
     * Two thirds, and it is a reporting threshold rather than a gate. Nothing is
     * rejected for being concentrated: a product discussed in exactly one place
     * is a real situation and the evidence is still real. The reader is simply
     * told.
     */
    singleChannelDominant: total >= 3 && share >= 2 / 3,
  };
}

/* The assembled claim: the counts, a readable sample, and how concentrated it is. */
export function withEvidence(
  claim: Corroboration,
  records: readonly Doc[],
  sampleSize?: number,
): ClaimWithEvidence {
  return {
    ...claim,
    evidence: sampleEvidence(records, sampleSize),
    concentration: measureConcentration(records),
    voices: countVoices(records),
  };
}
