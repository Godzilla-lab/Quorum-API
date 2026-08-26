/*
 * Corroboration counting.
 *
 * "31 independent records across 5 channels" is the number the whole product
 * rests on, so it is computed here, once, and never in a renderer. A renderer
 * that counts for itself is a renderer that can disagree with the API, and the
 * CLI and the hosted server must print the same figure for the same evidence.
 *
 * THE COUNT DEDUPES BY RECEIPT ID, AND THAT IS A CORRECTNESS RULE, NOT A TIDY UP.
 *
 * A receipt id is `sha256(source, externalId)`, with category deliberately
 * excluded. The docs table is unique on (source, externalId, category), so one
 * comment harvested under two categories is two rows. Counting rows would count
 * one human twice, put a fabricated number under a claim, and that is the exact
 * failure this product cannot have.
 *
 * WHAT THIS CANNOT DO, STATED RATHER THAN GLOSSED.
 *
 * Records carry no author, so three comments by one person count as three. The
 * channel spread is reported alongside the record count so a reader can see how
 * concentrated the evidence is, but it is not gated on: the engine's threshold
 * is an absolute record count and it stays that way, because report parity
 * against the engine has to be measurable before the number is allowed to move.
 *
 * THREE ROUTES TO A FINDING, ALL ADDED RATHER THAN SUBSTITUTED.
 *
 * Counting receipts equally was right while every source was a forum. Across
 * tiers it is wrong, because a recall notice and a forum thread saying the same
 * thing are more independent than three comments in one thread. So:
 *
 *   RECEIPT COUNT  MIN_RECEIPTS distinct receipts, exactly as before
 *   CROSS TIER     two or more promoting tiers, at least one of them attested
 *                  or transactional
 *   ATTESTED       two attested receipts, even from the same tier
 *
 * The third route exists because the second one got a real case wrong. A CPSC
 * recall and an NHTSA complaint are both tier A, so they cross no tier, and the
 * rule called two independent government records a weak signal. The threshold
 * of three was calibrated for forum comments, where a comment is one person's
 * impression. It was never calibrated for filings that a named party made on
 * the record with consequences for lying, and applying it there under claims so
 * badly it is simply incorrect.
 *
 * Nothing got weaker. The first route is untouched, so parity against the
 * engine on a Reddit only run is still measurable. The others only ever add.
 *
 * Tier D never promotes anything on its own. A spike in pageviews is not
 * somebody saying a shoe runs small, and letting context corroborate a claim is
 * how a report starts sounding confident about noise.
 */

/*
 * The threshold comes from the constants subpath rather than the package root
 * on purpose. The root index loads the sqlite driver, and `node:sqlite` is
 * experimental, so importing it prints a warning and pulls a database into any
 * process that only wanted to count. A pure function should not drag a driver
 * in behind it, and the hosted server runs on postgres regardless.
 */
import { MIN_RECEIPTS } from '@quorum/corpus/constants';
import { PROMOTING_TIERS, tierOf } from '@quorum/corpus/tiers';
import type { Doc, EvidenceTier, SourceId } from '@quorum/corpus';

export interface SourceSpread {
  source: SourceId;
  /* Distinct receipts from this source. */
  records: number;
  /* Distinct channels within this source: subreddits, story threads. */
  channels: number;
}

export interface Corroboration {
  /* What was asked about: "sizing", "durability". */
  term: string;
  /*
   * Every distinct receipt behind this claim, so a reader can fetch any of them
   * back. A claim that cannot list these does not ship.
   */
  receiptIds: string[];
  records: number;
  channels: number;
  sources: SourceSpread[];
  /* Distinct receipts per evidence tier, so a reader sees the spread. */
  tiers: Record<EvidenceTier, number>;
  /*
   * Which route earned the finding, so the report can show its working rather
   * than assert a verdict.
   */
  basis: 'receipt-count' | 'cross-tier' | 'attested' | 'none';
  /*
   * The records that say the OPPOSITE, counted with the same dedupe rule as
   * the records that agree. Populated only when the caller supplies refuting
   * rows (see `splitEvidenceRows` in stance.ts for what qualifies); empty
   * otherwise, and empty is a real answer meaning no detectable disagreement.
   */
  refuting: {
    records: number;
    channels: number;
    receiptIds: string[];
  };
  /*
   * `finding` may be printed as a statement about the market. `contested`
   * means BOTH sides cleared the threshold: report both counts, state no
   * conclusion. `refuted` means only the disagreement cleared it. Neither of
   * those may ever be printed as a finding, and `weak-signal` may not either,
   * no matter how good the quotes are.
   *
   * Deliberately four values and not the seven a fact checking taxonomy
   * offers: a below threshold lean either way is readable from the counts
   * this object already carries, and a verdict the arithmetic cannot defend
   * is exactly what this product refuses to print.
   */
  verdict: 'finding' | 'contested' | 'refuted' | 'weak-signal';
  /* The threshold actually applied, so a report can show its own working. */
  threshold: number;
}

export interface CorroborateOptions {
  /* Overridable so a test can drive the boundary without rewriting fixtures. */
  minReceipts?: number;
  /*
   * Records that affirmatively contradict the claim, from the stance split.
   * Counted against the same threshold as the supporting side, because
   * disagreement corroborated by one voice is not disagreement.
   */
  refuting?: readonly Doc[];
}

export function corroborate(
  term: string,
  records: readonly Doc[],
  options: CorroborateOptions = {},
): Corroboration {
  const threshold = options.minReceipts ?? MIN_RECEIPTS;

  const seen = new Set<string>();
  const channels = new Set<string>();
  const bySource = new Map<SourceId, { records: Set<string>; channels: Set<string> }>();
  const receiptIds: string[] = [];
  const tiers: Record<EvidenceTier, number> = { A: 0, B: 0, C: 0, D: 0 };
  /* Counted separately from `seen`, because tier D must not promote a claim. */
  let promoting = 0;
  /*
   * IDENTICAL TEXT IS ONE VOICE, however many ids carry it. Receipt ids name
   * (source, externalId), not the words, so the same boilerplate under two
   * SEC accessions or the same paste in two repos is two ids with one text.
   * Measured live 2026-08-26 by an outside evaluation: one Cleaner Yoga Mat
   * S-1 counted twice toward "10 independent records". A repeated text still
   * has its id LISTED, so the dedupe is visible and every id resolves, but it
   * counts toward nothing: not records, not channels, not tiers.
   */
  const seenTexts = new Set<string>();
  const textKey = (t: string): string => t.trim().replace(/\s+/g, ' ');
  let counted = 0;

  for (const record of records) {
    if (seen.has(record.receiptId)) continue;
    seen.add(record.receiptId);
    receiptIds.push(record.receiptId);

    const key = textKey(record.text);
    /* An empty text cannot prove two records are the same utterance. */
    if (key) {
      if (seenTexts.has(key)) continue;
      seenTexts.add(key);
    }
    counted++;

    const tier = tierOf(record.source);
    tiers[tier]++;
    if (PROMOTING_TIERS.includes(tier)) promoting++;

    /*
     * An empty channel is one bucket, not many. Sources that do not scope their
     * records (a general index has no equivalent of a subreddit) would otherwise
     * inflate the channel count with a blank string per record.
     */
    channels.add(`${record.source}/${record.channel}`);

    const entry = bySource.get(record.source) ?? { records: new Set<string>(), channels: new Set<string>() };
    entry.records.add(record.receiptId);
    entry.channels.add(record.channel);
    bySource.set(record.source, entry);
  }

  const sources: SourceSpread[] = [...bySource]
    .map(([source, entry]) => ({ source, records: entry.records.size, channels: entry.channels.size }))
    .sort((a, b) => b.records - a.records || a.source.localeCompare(b.source));

  /*
   * Route two. Two or more promoting tiers with at least one of A or B, so a
   * regulator record plus a forum thread lands, while two forum threads and a
   * pageview spike does not.
   */
  const tiersPresent = PROMOTING_TIERS.filter((t) => tiers[t] > 0);
  const crossTier = tiersPresent.length >= 2 && (tiers.A > 0 || tiers.B > 0);
  /* Two records nobody could make casually. See the header on why this is its
   * own route rather than a special case of the one above. */
  const attested = tiers.A >= 2;

  const basis: Corroboration['basis'] = promoting >= threshold
    ? 'receipt-count'
    : crossTier ? 'cross-tier'
      : attested ? 'attested' : 'none';

  /*
   * The other side, deduped by receipt id exactly like the supporting side,
   * because a person saying "no problems" twice is still one person. A row
   * appearing on both sides is impossible by construction (splitEvidenceRows
   * partitions), but the dedupe against `seen` guards the invariant anyway:
   * one receipt must never count both for and against a claim.
   */
  const refutingSeen = new Set<string>();
  const refutingChannels = new Set<string>();
  const refutingIds: string[] = [];
  const refutingTexts = new Set<string>();
  let refutingCounted = 0;
  for (const record of options.refuting ?? []) {
    if (seen.has(record.receiptId) || refutingSeen.has(record.receiptId)) continue;
    refutingSeen.add(record.receiptId);
    refutingIds.push(record.receiptId);
    /* The same text dedupe as the supporting side, plus the cross side guard:
     * a text already counted in support must never also count against. */
    const key = textKey(record.text);
    if (key) {
      if (seenTexts.has(key) || refutingTexts.has(key)) continue;
      refutingTexts.add(key);
    }
    refutingCounted++;
    refutingChannels.add(`${record.source}/${record.channel}`);
  }

  /*
   * Disagreement is held to the same bar as agreement: below the threshold it
   * shapes nothing, because one "works fine for me" must not un-say a
   * corroborated pattern any more than one complaint may state one.
   */
  const refuted = refutingCounted >= threshold;
  const verdict: Corroboration['verdict'] = basis !== 'none'
    ? (refuted ? 'contested' : 'finding')
    : (refuted ? 'refuted' : 'weak-signal');

  return {
    term,
    receiptIds,
    records: counted,
    channels: channels.size,
    sources,
    tiers,
    basis,
    refuting: {
      records: refutingCounted,
      channels: refutingChannels.size,
      receiptIds: refutingIds,
    },
    verdict,
    threshold,
  };
}

/*
 * Only the claims that earned the right to be stated.
 *
 * Provided so a caller cannot forget the filter. `corroborate` returns the
 * verdict, but a renderer that iterates everything and prints it is one missing
 * `if` away from shipping a two record claim as a market pattern. A contested
 * or refuted claim is excluded by the same equality: divided evidence is not
 * a finding, whatever the supporting count alone would have said.
 */
export function findingsOnly(claims: readonly Corroboration[]): Corroboration[] {
  return claims.filter((c) => c.verdict === 'finding');
}
