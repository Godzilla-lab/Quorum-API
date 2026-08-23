/*
 * The corpus driver interface.
 *
 * WHY EVERY METHOD IS ASYNC, INCLUDING ON SQLITE.
 *
 * The engine has two corpus implementations and they disagree on this. Its
 * SQLite module is synchronous by design, because `node:sqlite` exposes
 * `DatabaseSync` and callers iterate results directly. Its Supabase module is
 * async, and its own header says you cannot paper over the difference at the
 * call site.
 *
 * That header is right. A synchronous interface cannot be implemented over a
 * network, and a call site written against one cannot be reused against the
 * other. Since the hosted product needs the network driver and the CLI needs
 * the local one to behave identically, the interface is async and the SQLite
 * driver wraps its synchronous calls.
 *
 * The cost is real and worth naming: every corpus call site in the pipeline
 * takes an await. That is why porting the corpus is not a typing exercise.
 */

import type {
  AdObservation,
  AdObservationInput,
  ByCategoryOptions,
  CategoryStats,
  CorpusTotals,
  Doc,
  DocHit,
  DocInput,
  PriorReport,
  ProductFacts,
  ReportInput,
  DateHistogram,
  DateHistogramOptions,
  SearchOptions,
  SourceId,
} from './types.ts';

export interface CorpusDriver {
  /*
   * Write records. Returns how many rows were genuinely new, which is the
   * honest measure of whether a harvest was worth running: a run that adds
   * nothing has told you the category was already warm.
   *
   * Records upsert on (source, externalId, category), because a Reddit comment's
   * text does not change and collapsing duplicates is correct. Ads do NOT go
   * here, see `addAdObservations`.
   */
  addDocs(docs: DocInput[], category: string): Promise<number>;

  /*
   * Ranked full text retrieval. This is the call that replaces roughly 500
   * throttled HTTP requests on a warm category, measured at 0.5s against 596s.
   */
  search(query: string, options?: SearchOptions): Promise<DocHit[]>;

  /*
   * Everything held for a category, best scoring first. Used when a category is
   * warm enough that searching is unnecessary, and to top up a narrow query set
   * so it cannot starve a report.
   */
  byCategory(category: string, options?: ByCategoryOptions): Promise<Doc[]>;

  /* Resolve receipt ids to records. The endpoint the whole product rests on. */
  getByReceiptIds(receiptIds: string[]): Promise<Doc[]>;

  /* The warm/cold decision, and what a caller checks before spending. */
  categoryStats(category: string): Promise<CategoryStats>;

  /*
   * When records were written, bucketed by month.
   *
   * Called twice to compute a trend: once with a query for the numerator and
   * once without for the denominator. It returns COUNTS rather than rows on
   * purpose, because a share computed from a capped page of rows measures the
   * cap. Measured 2026-08-22 on a 1,181 record category: counting raw records
   * per month reported every term as rising, because it was measuring our
   * harvest. Dividing by the same period's total is what makes it a market
   * signal, and that division needs the whole denominator.
   */
  dateHistogram(options: DateHistogramOptions): Promise<DateHistogram>;

  /* Remember the plan that worked, so a repeat run skips re-planning. */
  rememberCategory(
    category: string,
    plan: { subreddits?: string[]; queries?: string[] },
  ): Promise<void>;

  /*
   * Ad observations, APPEND ONLY. Never upserted, because two sightings of the
   * same ad thirty days apart are the evidence that it ran for thirty days.
   * Returns the number of observations recorded, which equals the number
   * supplied: nothing is deduplicated away.
   */
  addAdObservations(observations: AdObservationInput[]): Promise<number>;

  /* Every sighting of one ad, oldest first, so a duration can be derived. */
  adObservations(adId: string): Promise<AdObservation[]>;

  /* Latest sighting per ad in a category, which is what a report renders. */
  latestAdsByCategory(category: string, limit?: number): Promise<AdObservation[]>;

  saveReport(report: ReportInput): Promise<void>;
  priorReports(category: string, limit?: number): Promise<PriorReport[]>;

  /* Product cache, so a repeat URL never re-pays for unblocking. */
  cacheProduct(facts: ProductFacts, category: string): Promise<void>;
  getProduct(url: string, maxAgeDays?: number): Promise<ProductFacts | null>;

  /*
   * Takedown path.
   *
   * Records retain public usernames and permalinks indefinitely, which is the
   * point of the archive. When a record is deleted at source, or a person asks,
   * it has to be removable here too. Cheap to add now, a data migration later,
   * which is the only reason it is in the interface before anything needs it.
   *
   * Returns the number of rows removed.
   */
  deleteByExternalId(source: SourceId, externalId: string): Promise<number>;

  totals(): Promise<CorpusTotals>;
  close(): Promise<void>;
}
