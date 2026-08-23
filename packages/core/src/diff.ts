/*
 * What changed since the last time this question was asked.
 *
 * WHY THIS IS THE MOST IMPORTANT THING IN THE OUTPUT LAYER.
 *
 * Research into why insight tools get cancelled is blunt about it: companies do
 * not lack insights, they lack activation, and one off usage is the churn
 * pattern. A one shot report is a one off use. The corpus compounds every day
 * and the product gave nobody a reason to come back to it.
 *
 * "Three new complaints about the sole since Tuesday, and two of them name the
 * same batch" is a reason to come back. A report is not. It is also the only
 * thing that makes the `webhookUrl` already in the spec worth anything, because
 * a webhook that fires to say the same thing again is spam.
 *
 * NOTHING HERE IS INFERRED. A DIFF IS STILL A CLAIM.
 *
 * Every number below is the difference between two stored snapshots, and every
 * new receipt is NAMED rather than counted, so a reader can fetch it and see
 * the thing that is new. Where the comparison cannot be made exactly, it says
 * so and falls back to counts rather than quietly presenting an estimate as a
 * measurement. The rule that a claim needs a resolvable record does not stop
 * applying because the claim happens to be about change.
 *
 * THE CORPUS ONLY GROWS, SO A DEMOTION IS INFORMATION.
 *
 * Records are appended and never rewritten, so a claim losing evidence should
 * be impossible. It is not: a takedown removes a record, and a change to the
 * relevance gate or the corroboration threshold moves the bar under a claim
 * that never moved itself. Those are the moments somebody most needs to be
 * told, so a demotion is reported as loudly as a promotion.
 */

import type { ClaimWithEvidence } from './evidence.ts';
import type { Theme } from './themes.ts';
import type { Trend, TrendDirection } from './trend.ts';

/*
 * Bumped when the shape changes in a way that makes an old snapshot
 * unreadable. A stored snapshot outlives the code that wrote it, and a diff
 * computed across two incompatible shapes is a wrong number with a date on it.
 */
export const SNAPSHOT_VERSION = 1;

/*
 * How many receipt ids travel with each claim in a snapshot.
 *
 * They are stored so that a later run can name exactly which receipts are new
 * rather than reporting that the count went up by three. Bounded because a warm
 * category can back a single term with thousands, and a snapshot is written on
 * every run forever.
 *
 * When the cap bites, the snapshot says so and the diff falls back to counts.
 * Reporting "3 new receipts" from a truncated list would be a fabricated
 * number, and it would look exactly like a real one.
 */
export const MAX_SNAPSHOT_IDS = 300;

export interface ClaimSnapshot {
  term: string;
  records: number;
  channels: number;
  verdict: string;
  receiptIds: string[];
  /* True when `receiptIds` is a prefix rather than the whole set. */
  truncated: boolean;
}

export interface ReportSnapshot {
  version: number;
  category: string;
  /* Unix seconds. Taken from the run, never from the clock at diff time. */
  createdAt: number;
  corpusRecords: number;
  claims: ClaimSnapshot[];
  attestedRecords: number;
  themes: string[];
  trends: { term: string; direction: TrendDirection }[];
}

export interface SnapshotInput {
  category: string;
  createdAt: number;
  corpusRecords: number;
  claims: readonly ClaimWithEvidence[];
  attestedRecords: number;
  themes: readonly Theme[];
  trends: readonly Trend[];
}

export function reportSnapshot(input: SnapshotInput): ReportSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    category: input.category,
    createdAt: input.createdAt,
    corpusRecords: input.corpusRecords,
    claims: input.claims.map((claim) => ({
      term: claim.term,
      records: claim.records,
      channels: claim.channels,
      verdict: claim.verdict,
      receiptIds: claim.receiptIds.slice(0, MAX_SNAPSHOT_IDS),
      truncated: claim.receiptIds.length > MAX_SNAPSHOT_IDS,
    })),
    attestedRecords: input.attestedRecords,
    themes: input.themes.map((t) => t.phrase),
    trends: input.trends.map((t) => ({ term: t.term, direction: t.direction })),
  };
}

/*
 * A stored snapshot is DATA, not a contract, so it is checked field by field.
 * The row may have been written by an older build, hand edited, or half
 * written by a run that died, and any of those must degrade to "no comparison
 * available" rather than to a diff full of undefined.
 */
export function parseSnapshot(value: unknown): ReportSnapshot | null {
  const raw = value as Partial<ReportSnapshot> | null;
  if (!raw || typeof raw !== 'object') return null;
  if (raw.version !== SNAPSHOT_VERSION) return null;
  if (typeof raw.category !== 'string' || typeof raw.createdAt !== 'number') return null;
  if (!Array.isArray(raw.claims)) return null;

  const claims: ClaimSnapshot[] = [];
  for (const entry of raw.claims as unknown[]) {
    const claim = entry as Partial<ClaimSnapshot>;
    if (typeof claim?.term !== 'string' || typeof claim.records !== 'number') continue;
    claims.push({
      term: claim.term,
      records: claim.records,
      channels: typeof claim.channels === 'number' ? claim.channels : 0,
      verdict: typeof claim.verdict === 'string' ? claim.verdict : 'weak-signal',
      receiptIds: Array.isArray(claim.receiptIds)
        ? claim.receiptIds.filter((id): id is string => typeof id === 'string')
        : [],
      truncated: claim.truncated === true,
    });
  }

  return {
    version: SNAPSHOT_VERSION,
    category: raw.category,
    createdAt: raw.createdAt,
    corpusRecords: typeof raw.corpusRecords === 'number' ? raw.corpusRecords : 0,
    claims,
    attestedRecords: typeof raw.attestedRecords === 'number' ? raw.attestedRecords : 0,
    themes: Array.isArray(raw.themes) ? raw.themes.filter((t): t is string => typeof t === 'string') : [],
    trends: Array.isArray(raw.trends)
      ? (raw.trends as { term?: unknown; direction?: unknown }[])
        .filter((t) => typeof t?.term === 'string' && typeof t.direction === 'string')
        .map((t) => ({ term: t.term as string, direction: t.direction as TrendDirection }))
      : [],
  };
}

export interface ClaimChange {
  term: string;
  /* Null when this question was not asked last time, which is not a change in
   * the market and is labelled as such. */
  before: { records: number; verdict: string } | null;
  after: { records: number; verdict: string };
  recordsAdded: number;
  /*
   * The receipts that are new, NAMED. Empty when `receiptsExact` is false,
   * because a partial list of new ids is worse than none: it reads as complete.
   */
  newReceiptIds: string[];
  receiptsExact: boolean;
  promoted: boolean;
  demoted: boolean;
}

export interface ReportDiff {
  /* Unix seconds of the report being compared against. */
  since: number;
  ageDays: number;
  corpusGrowth: number;
  attestedAdded: number;
  claims: ClaimChange[];
  newThemes: string[];
  /* Trends that changed direction, which is a change ABOUT a change and is the
   * earliest signal this product can produce. */
  trendChanges: { term: string; before: TrendDirection; after: TrendDirection }[];
}

const SECONDS_PER_DAY = 86_400;

export function diffReports(previous: ReportSnapshot, current: ReportSnapshot): ReportDiff {
  const before = new Map(previous.claims.map((c) => [c.term, c]));

  const claims: ClaimChange[] = current.claims.map((claim) => {
    const prior = before.get(claim.term);
    if (!prior) {
      return {
        term: claim.term,
        before: null,
        after: { records: claim.records, verdict: claim.verdict },
        recordsAdded: 0,
        newReceiptIds: [],
        /* A question nobody asked before has no comparison, and calling every
         * one of its receipts new would report a first run as an event. */
        receiptsExact: false,
        promoted: false,
        demoted: false,
      };
    }

    /*
     * Exact only when NEITHER side was truncated. A new id computed against a
     * partial prior list is any id that happened to fall outside the cap, which
     * is not new at all and is indistinguishable from one that is.
     */
    const receiptsExact = !prior.truncated && !claim.truncated;
    const known = new Set(prior.receiptIds);
    const newReceiptIds = receiptsExact ? claim.receiptIds.filter((id) => !known.has(id)) : [];

    return {
      term: claim.term,
      before: { records: prior.records, verdict: prior.verdict },
      after: { records: claim.records, verdict: claim.verdict },
      recordsAdded: claim.records - prior.records,
      newReceiptIds,
      receiptsExact,
      promoted: prior.verdict !== 'finding' && claim.verdict === 'finding',
      demoted: prior.verdict === 'finding' && claim.verdict !== 'finding',
    };
  });

  const seenThemes = new Set(previous.themes);
  const priorTrends = new Map(previous.trends.map((t) => [t.term, t.direction]));

  return {
    since: previous.createdAt,
    ageDays: Math.max(0, (current.createdAt - previous.createdAt) / SECONDS_PER_DAY),
    corpusGrowth: current.corpusRecords - previous.corpusRecords,
    attestedAdded: current.attestedRecords - previous.attestedRecords,
    claims,
    newThemes: current.themes.filter((t) => !seenThemes.has(t)),
    trendChanges: current.trends
      .filter((t) => priorTrends.has(t.term) && priorTrends.get(t.term) !== t.direction)
      .map((t) => ({ term: t.term, before: priorTrends.get(t.term)!, after: t.direction })),
  };
}

/*
 * Whether anything happened worth telling somebody about.
 *
 * A diff always exists once there are two runs, and most of them are empty.
 * Printing "nothing changed" in a block of its own trains a reader to skip the
 * block, and firing a webhook for it is spam. So the report and the webhook
 * both ask this rather than deciding for themselves, and there is one answer.
 */
export function isNotable(diff: ReportDiff): boolean {
  return diff.claims.some((c) => c.promoted || c.demoted || c.recordsAdded > 0)
    || diff.attestedAdded > 0
    || diff.newThemes.length > 0
    || diff.trendChanges.length > 0;
}
