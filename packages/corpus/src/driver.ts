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
  CategoryListing,
  CategoryStats,
  CorpusTotals,
  Doc,
  DocHit,
  DocInput,
  Monitor,
  MonitorInput,
  PriorReport,
  ProductFacts,
  ReportInput,
  ReportSnapshotInput,
  SpendByKey,
  StoredReportSnapshot,
  DateHistogram,
  DateHistogramOptions,
  SearchOptions,
  SourceId,
  WebhookAttemptResult,
  WebhookDelivery,
  WebhookDeliveryInput,
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
   * Every category holding at least one record, most records first. The
   * discovery path: a caller who does not know any slug orients here instead
   * of guessing, and a guess that misses can be answered with what exists.
   * Derived entirely from docs rows, so an empty corpus returns an empty
   * list rather than an error.
   */
  listCategories(): Promise<CategoryListing[]>;

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

  /*
   * Report snapshots: the exact bytes the API served, keyed by the API's
   * report id, so GET /v1/reports/{id} survives a restart. Idempotent on the
   * report id, like webhook deliveries and for the same reason: a report
   * reaches a terminal state once, and if that ever happened twice the second
   * write must not replace what a caller may have already fetched.
   */
  saveReportSnapshot(snapshot: ReportSnapshotInput): Promise<void>;
  getReportSnapshot(reportId: string): Promise<StoredReportSnapshot | null>;
  /* Snapshots are all settled by definition, so age is the only criterion.
   * Returns the number removed. */
  pruneReportSnapshots(before: number): Promise<number>;

  /*
   * Monitors: standing watches that re-run a subject on a schedule.
   *
   * List and delete are TENANT SCOPED with the same exact-match rule as
   * priorReports: undefined means the NULL tenant, never every tenant, so
   * forgetting fails closed. `dueMonitors` is the one operator-scope read,
   * because the scheduler serves every tenant's standing orders; it returns
   * enabled monitors whose interval has elapsed since their last fire.
   */
  createMonitor(monitor: MonitorInput): Promise<void>;
  listMonitors(tenantId?: string | null): Promise<Monitor[]>;
  /* Returns rows removed: 0 means no such monitor in this tenant's view. */
  deleteMonitor(monitorId: string, tenantId?: string | null): Promise<number>;
  dueMonitors(now: number): Promise<Monitor[]>;
  markMonitorFired(monitorId: string, at: number, result: string): Promise<void>;

  /*
   * The spend ledger. Money is the one quota counter that must survive a
   * restart: a daily budget that resets whenever a free tier sleeps is a
   * budget per uptime stretch, which is not what the operator agreed to.
   * `recordSpend` appends; `spendSince` sums per key from a cutoff so the
   * server can seed its in memory counters on boot; `pruneSpend` drops rows
   * old enough that no window can ever need them again.
   */
  recordSpend(keyLabel: string, amountUsd: number): Promise<void>;
  spendSince(since: number): Promise<SpendByKey[]>;
  pruneSpend(before: number): Promise<number>;

  /*
   * Prior reports for a category, SCOPED TO ONE TENANT.
   *
   * `tenantId` is matched exactly, and undefined means the NULL tenant rather
   * than every tenant. That choice is the whole security property: a caller who
   * forgets to pass one sees the single user rows, never somebody else's, so
   * forgetting fails closed instead of leaking.
   *
   * WHY THIS IS ENFORCED IN SQL AND NOT LEFT TO ROW LEVEL SECURITY. The
   * policies in 002_rls.sql are real and they are also inert in production:
   * measured 2026-08-23, the server connects as the table OWNER, and Postgres
   * exempts an owner from RLS unless FORCE ROW LEVEL SECURITY is set, which it
   * is not. SQLite has no equivalent at all. A boundary that depends on which
   * role happens to connect is not a boundary, so the driver enforces it.
   */
  priorReports(category: string, limit?: number, tenantId?: string | null): Promise<PriorReport[]>;

  /*
   * The webhook delivery queue.
   *
   * WHY IT IS HERE AND NOT IN THE SERVER. The server's job queue is in memory,
   * and a free tier instance sleeps. A delivery held only in the process is a
   * delivery lost on the next redeploy, which makes a retry schedule
   * decorative. `reports` already set the precedent that tenant owned server
   * state lives in the corpus.
   *
   * Enqueueing is idempotent on the report id: a report reaches a terminal
   * state once, and if that ever happened twice the second must not produce a
   * second delivery.
   */
  enqueueDelivery(delivery: WebhookDeliveryInput): Promise<void>;

  /* Pending rows whose next attempt is due, oldest first. The only query the
   * delivery worker makes, and the reason for the (status, next_attempt_at)
   * index. */
  dueDeliveries(now: number, limit?: number): Promise<WebhookDelivery[]>;

  /* Write back the outcome of one attempt. */
  recordDeliveryAttempt(reportId: string, result: WebhookAttemptResult): Promise<void>;

  /* Drop settled rows older than a cutoff, so the table does not grow without
   * limit. Pending rows are never pruned. Returns the number removed. */
  pruneDeliveries(before: number): Promise<number>;

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
