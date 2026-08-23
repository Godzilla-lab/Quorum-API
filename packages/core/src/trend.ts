/*
 * Trend, as share of conversation over time.
 *
 * THE NAIVE VERSION MEASURES US, NOT THE MARKET, AND IT NEARLY SHIPPED.
 *
 * MEASURED 2026-08-22 on a real 1,181 record corpus. Counting records per month
 * and comparing the last three to the previous three reported RISING for all
 * five terms tested, which is not a market, it is a harvest: retrieval returns
 * far more recent records than old ones, so every term rises together.
 *
 * Dividing by the SAME PERIOD'S TOTAL fixes it, and the fix is not cosmetic.
 * Three of the five verdicts changed:
 *
 *   sizing      naive RISING  ->  +5.4pp  genuinely rising
 *   durability  naive RISING  ->  +2.3pp  genuinely rising
 *   price       naive RISING  ->  -1.1pp  flat, and slightly DOWN in share
 *   comfort     naive RISING  ->  +0.1pp  flat
 *   wide        naive RISING  ->  +0.8pp  flat
 *
 * `price` gained fifteen records and lost share. Shipping the obvious version
 * would have put a fabricated trend under a real receipt, which is the exact
 * failure this product exists to make impossible.
 *
 * A PARTIAL MONTH IS SAFE HERE, WHICH IS WHY THE WINDOW IS CALENDAR MONTHS.
 *
 * A share is a ratio inside one period, so a month that is three days old
 * deflates its numerator and its denominator equally. Counting records would
 * have made the current month look like a collapse in every report run before
 * the 28th.
 *
 * AND IT REFUSES TO SPEAK WHEN THE EVIDENCE CANNOT CARRY IT.
 *
 * Two proportions from small samples differ by chance constantly. A direction
 * is only reported when the change clears twice its own standard error, which
 * is the same discipline as the corroboration threshold: below the bar it is
 * printed as what it is rather than promoted into a claim.
 */

import { MIN_RECEIPTS, isUsableDate } from '@quorum/corpus/constants';
import type { DateBucket, DateHistogram } from '@quorum/corpus';

/*
 * `rising` and `fading`  the share moved by more than the noise floor
 * `steady`               it did not, which is a real answer and not a failure
 * `new`                  nobody raised it in a period where plenty was said
 * `unknown`              too little evidence in one of the windows to compare
 */
export type TrendDirection = 'rising' | 'fading' | 'steady' | 'new' | 'unknown';

export interface TrendWindow {
  /* Inclusive `YYYY-MM` bounds, so a reader can check the arithmetic. */
  from: string;
  to: string;
  /* Records mentioning the term. */
  records: number;
  /* Every record in the category in this window. The denominator. */
  total: number;
  sharePct: number;
}

export interface Trend {
  term: string;
  direction: TrendDirection;
  recent: TrendWindow;
  prior: TrendWindow;
  /* Change in percentage points of share. Percentage points, never percent:
   * 2% to 4% is +2pp and a doubling, and calling it "+100%" is how a flat
   * market gets reported as an explosion. */
  deltaPp: number;
  /*
   * Twice the standard error of the difference, in percentage points. The
   * change had to clear this to be called anything. Printed so a reader can see
   * how close it was rather than trusting the verdict.
   */
  noisePp: number;
  reason: string;
  /* Records excluded because their own date could not be believed. */
  undated: number;
}

/*
 * How many months each window covers. Three, which is long enough that one
 * loud week does not become a trend and short enough that a real shift is not
 * averaged away.
 */
export const WINDOW_MONTHS = 3;

/*
 * A window holding fewer records than this cannot support a share. Thirty is
 * where the standard error of a small proportion stops being wider than the
 * effects worth reporting: at n=30 a 10% share carries a standard error of
 * 5.5 points, so anything under that would be reporting noise with a decimal.
 */
export const MIN_WINDOW_RECORDS = 30;

const monthKey = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

/*
 * `count` calendar months ending `skip` months before the current one, oldest
 * first. Built by walking a UTC date rather than by arithmetic on the month
 * number, so December to January needs no special case.
 */
export function monthsWindow(nowMs: number, count: number, skip = 0): string[] {
  const months: string[] = [];
  for (let back = skip + count - 1; back >= skip; back--) {
    const cursor = new Date(nowMs);
    cursor.setUTCDate(1);
    cursor.setUTCMonth(cursor.getUTCMonth() - back);
    months.push(monthKey(cursor));
  }
  return months;
}

const sumOver = (buckets: readonly DateBucket[], months: readonly string[]): number => {
  const wanted = new Set(months);
  return buckets.reduce((n, b) => (wanted.has(b.period) ? n + b.records : n), 0);
};

const pct = (part: number, whole: number): number => (whole ? (100 * part) / whole : 0);

/*
 * Standard error of the difference between two proportions, in percentage
 * points. Plain binomial, no continuity correction: this is a threshold for
 * whether to print a word, not a p value anybody will quote.
 *
 * Exported and shaped structurally because the comparison between two
 * PRODUCTS asks the same question as the comparison between two PERIODS, and
 * two copies of a noise floor drift into two different answers to "is this
 * difference real".
 */
export function shareNoiseFloorPp(
  a: { sharePct: number; total: number },
  b: { sharePct: number; total: number },
): number {
  const p1 = a.sharePct / 100;
  const p2 = b.sharePct / 100;
  const variance = (p1 * (1 - p1)) / a.total + (p2 * (1 - p2)) / b.total;
  return 2 * Math.sqrt(variance) * 100;
}

export interface TrendInput {
  term: string;
  /* Histogram for records matching the term. The numerator. */
  termHistogram: DateHistogram;
  /* Histogram for every record in the category. The denominator. */
  categoryHistogram: DateHistogram;
  nowMs: number;
  windowMonths?: number;
}

export function trendFor(input: TrendInput): Trend {
  const months = input.windowMonths ?? WINDOW_MONTHS;
  const recentMonths = monthsWindow(input.nowMs, months, 0);
  const priorMonths = monthsWindow(input.nowMs, months, months);

  const build = (window: readonly string[]): TrendWindow => {
    const records = sumOver(input.termHistogram.buckets, window);
    const total = sumOver(input.categoryHistogram.buckets, window);
    return {
      from: window[0]!,
      to: window[window.length - 1]!,
      records,
      total,
      sharePct: pct(records, total),
    };
  };

  const recent = build(recentMonths);
  const prior = build(priorMonths);
  const deltaPp = recent.sharePct - prior.sharePct;
  const undated = input.termHistogram.undated;

  const thin = (window: TrendWindow, name: string): Trend | null =>
    window.total >= MIN_WINDOW_RECORDS ? null : {
      term: input.term,
      direction: 'unknown',
      recent,
      prior,
      deltaPp: 0,
      noisePp: 0,
      undated,
      reason: `only ${window.total} dated record${window.total === 1 ? '' : 's'} in the ${name} window, which is too few to compare a share against`,
    };

  /* Checked before anything is computed from them, because a share of four
   * records is a number with no information in it. */
  const tooThin = thin(prior, 'earlier') ?? thin(recent, 'recent');
  if (tooThin) return tooThin;

  /*
   * ABSENCE, WHEN THERE WAS PLENTY OF ROOM TO BE PRESENT.
   *
   * Handled before the statistic because a proportion of exactly zero makes
   * the standard error understate. And it is the more useful answer: "in 157
   * records from that quarter nobody raised this" is a finding, not a delta.
   */
  if (prior.records === 0 && recent.records >= MIN_RECEIPTS) {
    return {
      term: input.term,
      direction: 'new',
      recent,
      prior,
      deltaPp,
      noisePp: 0,
      undated,
      reason: `nobody raised this in ${prior.total} records from ${prior.from} to ${prior.to}, and ${recent.records} have since`,
    };
  }

  const noisePp = shareNoiseFloorPp(recent, prior);
  if (Math.abs(deltaPp) <= noisePp) {
    return {
      term: input.term,
      direction: 'steady',
      recent,
      prior,
      deltaPp,
      noisePp,
      undated,
      reason: `share moved ${deltaPp >= 0 ? '+' : ''}${deltaPp.toFixed(1)}pp, inside the ${noisePp.toFixed(1)}pp this much evidence can tell apart from chance`,
    };
  }

  return {
    term: input.term,
    direction: deltaPp > 0 ? 'rising' : 'fading',
    recent,
    prior,
    deltaPp,
    noisePp,
    undated,
    reason: `${recent.sharePct.toFixed(1)}% of ${recent.total} records now, against ${prior.sharePct.toFixed(1)}% of ${prior.total} before`,
  };
}

/*
 * SHARE OF VOICE, WHICH IS THE DENOMINATOR A COUNT IS MISSING.
 *
 * "sizing: 15 receipts" is unreadable on its own. Fifteen out of two hundred is
 * a footnote and fifteen out of forty is the thing to fix first, and the report
 * has always had both numbers and printed only one of them.
 */
export interface ShareOfVoice {
  term: string;
  records: number;
  categoryRecords: number;
  sharePct: number;
  /* Where this term ranks among the terms asked about. 1 is loudest. */
  rank: number;
}

export function shareOfVoice(
  claims: readonly { term: string; records: number }[],
  categoryRecords: number,
): ShareOfVoice[] {
  return [...claims]
    .sort((a, b) => b.records - a.records)
    .map((claim, index) => ({
      term: claim.term,
      records: claim.records,
      categoryRecords,
      sharePct: pct(claim.records, categoryRecords),
      rank: index + 1,
    }));
}

/*
 * Which trends are worth printing. `steady` and `unknown` are true and are not
 * news, and a block that lists five terms as unchanged trains people to skip
 * the block. They stay on the JSON, where a caller can ask for them.
 */
export function notableTrends(trends: readonly Trend[]): Trend[] {
  return trends.filter((t) => t.direction === 'rising' || t.direction === 'fading' || t.direction === 'new');
}

/* Re-exported so a caller filtering records by hand uses the same rule the
 * histogram used, rather than inventing a second definition of a usable date. */
export { isUsableDate };
