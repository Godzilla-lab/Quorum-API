/*
 * The shapes the corpus stores and returns.
 *
 * Every producer writes the same shape, which is the only reason deduplication
 * works at all. The engine learned this the hard way: the live retrieval path
 * and the corpus path originally built different record shapes and had to be
 * normalised back together at the call site.
 */

/*
 * Where a record came from. Deliberately a union of string literals rather than
 * an enum: enums need code generation, and node strips types rather than
 * compiling them, so `erasableSyntaxOnly` rejects them.
 */
export type SourceId =
  /* Tier A, attested. A named party stated this on the record. */
  | 'sec-edgar'
  | 'cpsc'
  | 'nhtsa'
  | 'openfda'
  | 'eu-safety-gate'
  /* Tier B, transactional. An observable state rather than an opinion. */
  | 'ad'
  | 'shopify'
  | 'woocommerce'
  | 'wayback'
  | 'commoncrawl'
  | 'npm'
  | 'github'
  /* Tier C, voice. What people actually said. */
  | 'reddit'
  | 'hackernews'
  | 'discourse'
  | 'stackexchange'
  | 'lobsters'
  | 'steam'
  | 'appstore'
  | 'youtube'
  | 'review'
  /* Tier D, context. Sets the scene and proves nothing alone. */
  | 'wikipedia'
  | 'gdelt'
  | 'openalex'
  | 'producthunt'
  | 'jobs';

export type RecordKind = 'post' | 'comment';

/*
 * A record on the way in. `receiptId` is absent because the driver derives it,
 * so no caller can accidentally supply one that does not match its own content.
 */
export interface DocInput {
  source: SourceId;
  kind: RecordKind;
  externalId: string;
  channel?: string;
  text: string;
  score?: number;
  url?: string;
  createdUtc?: number;
}

/* A record on the way out. */
export interface Doc {
  receiptId: string;
  source: SourceId;
  kind: RecordKind;
  externalId: string;
  category: string;
  channel: string;
  text: string;
  score: number;
  url: string;
  createdUtc: number;
  harvestedAt: number;
}

/* A search hit is a record plus its rank, which callers use for ordering only. */
export interface DocHit extends Doc {
  rank: number;
}

/*
 * One sighting of an ad at a point in time.
 *
 * These are APPEND ONLY and are never upserted, which is the entire point.
 * Observing ad X today and again in 30 days is what proves it ran for 30 days.
 * The engine wrote ads into the shared `docs` table, which is unique on
 * (source, external_id, category) with INSERT OR IGNORE, so every observation
 * after the first was silently discarded and `daysRunning` froze at first
 * sight. Verified 2026-08-22. That is the defect this table exists to fix.
 */
export interface AdObservationInput {
  adId: string;
  advertiser: string;
  category: string;
  body: string;
  cta?: string;
  url?: string;
  creative: CreativeType;
  platforms?: string[];
  /* Unix seconds. The ad's own reported start, when it reports one. */
  startDate?: number | null;
  /* Unix seconds. Only set when the ad has actually STOPPED, see below. */
  endDate?: number | null;
  isActive: boolean;
  /* Days running as understood at this observation, with its provenance. */
  daysRunning: number | null;
  durationConfidence: DurationConfidence;
}

export interface AdObservation extends AdObservationInput {
  observedAt: number;
}

/*
 * A card we cannot type returns null and leaves the sample rather than joining
 * a bucket, because a ratio computed over guesses is worse than no ratio.
 */
export type CreativeType = 'video' | 'static' | null;

/*
 * Duration provenance, carried all the way to the caller.
 *
 *   reported  came from a reported duration field, or from a start plus a real
 *             end. An end only counts when the ad has actually stopped:
 *             measured 2026-08-13, a live ad reports today's date as its
 *             endDate, which is a read timestamp and not an end date. Treating
 *             it as one would claim reported provenance for a duration nobody
 *             reported.
 *   observed  arithmetic on a real start date and a clock. Honest, but it is
 *             not a stored fact and it goes stale.
 *   none      no evidenced date. Shows no duration at all rather than a guess.
 */
export type DurationConfidence = 'reported' | 'observed' | 'none';

/*
 * The warm signal for a category, and what a caller checks before deciding
 * whether an answer is cheap or expensive.
 */
export interface CategoryStats {
  category: string;
  docs: number;
  comments: number;
  channels: number;
  lastHarvested: number;
  ageDays: number | null;
  warm: boolean;
  subreddits: string[];
  queries: string[];
}

export interface ReportInput {
  productUrl: string;
  productTitle?: string;
  category: string;
  markdown: string;
  findings?: unknown;
  costUsd?: number;
  /* Reports are tenant owned. Records are not. See the tenant boundary note. */
  tenantId?: string | null;
}

export interface PriorReport {
  productTitle: string;
  productUrl: string;
  findings: unknown;
  createdAt: number;
}

export interface ProductFacts {
  url: string;
  title?: string;
  source?: string;
  [key: string]: unknown;
}

export interface CorpusTotals {
  docs: number;
  categories: number;
  reports: number;
  adObservations: number;
}

/*
 * A window over WHEN THE RECORD WAS WRITTEN, never over when we harvested it.
 *
 * Those are two different questions and only one of them is about a market.
 * `createdUtc` answers "what had buyers said by March", which is the question
 * people ask. `harvestedAt` would answer "what did WE know in March", which is
 * a question about us, and is only interesting to an auditor reproducing an
 * old report.
 *
 * A record written in March and harvested in August is INSIDE a March window,
 * and that is the point rather than a leak: the archive is allowed to know more
 * about March than we did at the time, and that is the whole value of keeping
 * one.
 */
export interface DateWindow {
  /* Unix seconds, inclusive. */
  from?: number;
  /* Unix seconds, inclusive. */
  until?: number;
}

export interface SearchOptions extends DateWindow {
  category?: string | null;
  limit?: number;
  minScore?: number | null;
  source?: SourceId | null;
}

/*
 * A monthly histogram of when records were WRITTEN BY THEIR AUTHORS, which is
 * the only date that says anything about a market. `harvestedAt` says when we
 * happened to look and would measure us rather than them.
 *
 * WHY COUNTS AND NOT ROWS. Share of conversation needs the FULL denominator for
 * a category, and a category can hold tens of thousands of records. Computing
 * it from a capped page of rows silently measures the cap.
 */
export interface DateHistogramOptions {
  category: string;
  /* Full text query. Absent means every record in the category, which is the
   * denominator a share needs. */
  query?: string;
  /* Records dated outside this range are counted as undated rather than
   * bucketed, so a corrupt timestamp cannot invent a month. Unix seconds. */
  from?: number;
  until?: number;
}

export interface DateBucket {
  /* `YYYY-MM`, in UTC. */
  period: string;
  records: number;
}

export interface DateHistogram {
  buckets: DateBucket[];
  /*
   * Records with no usable date, reported rather than dropped. A term whose
   * evidence is mostly undated has no trend, and saying so is the answer.
   */
  undated: number;
}

export interface ByCategoryOptions extends DateWindow {
  limit?: number;
  kind?: RecordKind | null;
}
