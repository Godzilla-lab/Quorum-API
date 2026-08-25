/*
 * Comparison between products, "versus what".
 *
 * WHY THIS WAS THE LAST OF THE M9 ITEMS TO BE BUILT, AND WHY IT LOOKS LIKE
 * THIS RATHER THAN LIKE THE OBVIOUS VERSION.
 *
 * The obvious version reads `brandsNamed`, counts records in ONE corpus that
 * mention a rival, and prints "Brooks: 14 sizing complaints". That number is
 * co-occurrence. A record saying "these run smaller than my Brooks" mentions a
 * rival and a complaint and attributes the complaint to NEITHER. Printing it
 * puts a defect claim about a named company in front of a buyer on evidence
 * that does not say it, which is the one thing this product exists not to do.
 *
 * So a side of a comparison is A CORPUS OF ITS OWN, retrieved for that subject,
 * and every number on that side comes only from records about it. That makes
 * comparison a retrieval feature wearing an output feature's clothes, and it is
 * why the caller pays for a second run rather than a second query.
 *
 * THREE THINGS THIS REFUSES TO SAY, EACH LEARNED SOMEWHERE ELSE IN THIS REPO:
 *
 *   Counts are never compared. Fourteen against six measures how hard we looked
 *   in each place. Only SHARE of each corpus is comparable, which is the same
 *   lesson the trend code learned when counting records per month reported
 *   every term as rising.
 *
 *   A difference smaller than sampling noise is not a difference. The noise
 *   floor is the one the trend code uses, shared rather than copied.
 *
 *   Holding nothing is not evidence of nothing. A term absent from one side
 *   says we retrieved nothing about it there, and it is reported in those
 *   words rather than as a clean sheet.
 */

import { MIN_WINDOW_RECORDS, shareNoiseFloorPp } from './trend.ts';
import type { Corroboration } from './corroborate.ts';

/*
 * A side needs at least this many records before a share of it means anything.
 * The same threshold, for the same reason, as a trend window: at n=30 a 10%
 * share carries a standard error of 5.5 points, so anything thinner is a
 * decimal place on noise.
 */
export const MIN_COMPARE_RECORDS = MIN_WINDOW_RECORDS;

/*
 * Receipts carried per side per term. A SAMPLE, named as one, because unlike
 * the diff this list makes no claim to be complete: it is here so a reader can
 * fetch one back and disagree, which is the whole bar for printing anything.
 */
export const COMPARE_RECEIPTS_PER_SIDE = 8;

export interface CompareSide {
  /* As the caller typed it, because that is the string they will read back. */
  subject: string;
  category: string;
  /* Every record held for this side's category. The denominator. */
  corpusRecords: number;
  claims: readonly Corroboration[];
}

export interface SideTerm {
  subject: string;
  /*
   * The category this side's records are filed under, carried through because
   * a consumer grouping rows by category would otherwise file every rival's
   * numbers under the subject's own category.
   */
  category: string;
  records: number;
  channels: number;
  corpusRecords: number;
  sharePct: number;
  /*
   * `no-records` is an extra state on purpose and is never collapsed into
   * `weak-signal`. One means we looked and found little, the other means this
   * side's corpus says nothing at all about the term. The corroboration
   * verdicts pass through unchanged, contested and refuted included, because
   * a side whose evidence disagrees with itself must not present either half
   * as its answer.
   */
  verdict: Corroboration['verdict'] | 'no-records';
  sampleReceiptIds: string[];
  /* True when this side's whole corpus is too thin to support a share. */
  thin: boolean;
}

export interface TermComparison {
  term: string;
  /* Loudest share first, so the table reads in the order a person would rank it. */
  sides: SideTerm[];
  /*
   * The subject where this term is loudest, and null whenever we cannot say so
   * without overstating the evidence. `reason` always says which it is.
   */
  louder: string | null;
  /* Gap in percentage points between the loudest two sides. */
  deltaPp: number;
  /* What that gap has to beat to be called a difference. */
  noisePp: number;
  reason: string;
}

export interface Comparison {
  /* The subject the run was actually about. Always the first side. */
  baseline: string;
  terms: TermComparison[];
  /*
   * Sides we hold too little for, named once here rather than repeated as a
   * caveat under every term.
   */
  thinSides: { subject: string; corpusRecords: number }[];
  /*
   * Rivals that were asked for and could not be retrieved. Named rather than
   * dropped: a comparison silently missing a side looks exactly like a
   * comparison where that side had nothing to say.
   */
  unavailable: { subject: string; reason: string }[];
}

const pct = (part: number, whole: number): number => (whole ? (100 * part) / whole : 0);

function sideTerm(side: CompareSide, term: string): SideTerm {
  const claim = side.claims.find((c) => c.term === term);
  const records = claim?.records ?? 0;
  return {
    subject: side.subject,
    category: side.category,
    records,
    channels: claim?.channels ?? 0,
    corpusRecords: side.corpusRecords,
    sharePct: pct(records, side.corpusRecords),
    verdict: claim && records > 0 ? claim.verdict : 'no-records',
    sampleReceiptIds: (claim?.receiptIds ?? []).slice(0, COMPARE_RECEIPTS_PER_SIDE),
    thin: side.corpusRecords < MIN_COMPARE_RECORDS,
  };
}

/*
 * Why one term cannot be called, or null when it can. Ordered from the reason
 * that matters most: a caller who is told "too thin" should not also have to
 * work out that the gap was noise anyway.
 */
function refuse(top: SideTerm, second: SideTerm, deltaPp: number, noisePp: number): string | null {
  const thin = [top, second].filter((s) => s.thin);
  if (thin.length) {
    return `not comparable: ${thin.map((s) => `${s.subject} holds ${s.corpusRecords} records`).join(', ')}, `
      + `under the ${MIN_COMPARE_RECORDS} a share needs`;
  }
  if (top.records === 0) return 'neither side holds a record on this term';
  if (top.verdict !== 'finding') {
    /* Doctrine: a claim below the threshold is never printed as a finding, and
     * "X is louder about this" is a claim about the market like any other. */
    return `the loudest side is a weak signal at ${top.records} records, under the corroboration threshold`;
  }
  if (deltaPp <= noisePp) {
    return `${deltaPp.toFixed(1)} points apart, inside the ${noisePp.toFixed(1)} point noise floor for these corpus sizes`;
  }
  return null;
}

export function compareSides(
  sides: readonly CompareSide[],
  terms: readonly string[],
  unavailable: readonly { subject: string; reason: string }[] = [],
): Comparison {
  const baseline = sides[0]?.subject ?? '';

  const compared: TermComparison[] = terms.map((term) => {
    const rows = sides.map((side) => sideTerm(side, term))
      .sort((a, b) => b.sharePct - a.sharePct || b.records - a.records);

    const top = rows[0];
    const second = rows[1];
    if (!top || !second) {
      return {
        term, sides: rows, louder: null, deltaPp: 0, noisePp: 0,
        reason: 'a comparison needs two sides',
      };
    }

    const deltaPp = top.sharePct - second.sharePct;
    const noisePp = shareNoiseFloorPp(
      { sharePct: top.sharePct, total: top.corpusRecords },
      { sharePct: second.sharePct, total: second.corpusRecords },
    );
    const refused = refuse(top, second, deltaPp, noisePp);

    const nothingHeld = second.records === 0
      ? `, and ${second.subject} holds no record of it, which is not evidence that it is fine`
      : '';

    return {
      term,
      sides: rows,
      louder: refused ? null : top.subject,
      deltaPp,
      noisePp,
      reason: refused
        ?? `${top.sharePct.toFixed(1)}% of what is said about ${top.subject} against `
          + `${second.sharePct.toFixed(1)}% for ${second.subject}${nothingHeld}`,
    };
  });

  return {
    baseline,
    terms: compared,
    thinSides: sides
      .filter((s) => s.corpusRecords < MIN_COMPARE_RECORDS)
      .map((s) => ({ subject: s.subject, corpusRecords: s.corpusRecords })),
    unavailable: [...unavailable],
  };
}

/* Whether there is anything here worth printing at all. */
export const hasCallableTerms = (comparison: Comparison): boolean =>
  comparison.terms.some((t) => t.louder !== null);
