/*
 * The SQLite corpus driver.
 *
 * `node:sqlite` is synchronous (DatabaseSync), and this driver implements an
 * async interface over it. That is deliberate, not an oversight: the hosted
 * driver speaks to a network and a synchronous interface cannot be implemented
 * over one, so the async shape is the common denominator. See driver.ts.
 *
 * Nothing here awaits anything real. The methods are async so that call sites
 * written against this driver work unchanged against Postgres.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { CorpusDriver } from '../driver.ts';
import { SQLITE_SCHEMA } from '../schema.ts';
import { receiptId } from '../receipt-id.ts';
import { toFts5Query, toFts5QueryStrict } from '../terms.ts';
import { storableText } from '../text.ts';
import { FUTURE_TOLERANCE_SECONDS, MIN_CREATED_UTC, WARM_MAX_AGE_DAYS, WARM_MIN_DOCS, ageInDays, isWarm } from '../constants.ts';
import type {
  AdObservation,
  AdObservationInput,
  WebhookAttemptResult,
  WebhookDelivery,
  WebhookDeliveryInput,
  ByCategoryOptions,
  CategoryStats,
  DateHistogram,
  DateHistogramOptions,
  CorpusTotals,
  CreativeType,
  Doc,
  DocHit,
  DocInput,
  DurationConfidence,
  PriorReport,
  ProductFacts,
  RecordKind,
  ReportInput,
  ReportSnapshotInput,
  SearchOptions,
  SourceId,
  StoredReportSnapshot,
} from '../types.ts';

/*
 * The real clock, used when a caller does not supply one.
 *
 * Time is injectable because reading Date.now() inside the driver makes two
 * things untestable and one thing ambiguous. Untestable: whether the product
 * cache actually expires, since a row written now is never old. Ambiguous:
 * which of two observations written in the same second is the later one.
 *
 * Both showed up as real test failures rather than as theory, on 2026-08-22.
 */
const systemClock = (): number => Math.floor(Date.now() / 1000);

/*
 * Term extraction is shared with the Postgres driver so both search the same
 * words. See terms.ts for why OR rather than AND, and why the character class
 * is the union of both engines' operators.
 */
export const ftsQuery = toFts5Query;

interface DocRow {
  receipt_id: string;
  source: string;
  kind: string;
  external_id: string;
  category: string;
  channel: string | null;
  text: string;
  score: number | null;
  url: string | null;
  created_utc: number | null;
  harvested_at: number;
  rank?: number;
}

function toDoc(row: DocRow): Doc {
  return {
    receiptId: row.receipt_id,
    source: row.source as SourceId,
    kind: row.kind as RecordKind,
    externalId: row.external_id,
    category: row.category,
    channel: row.channel ?? '',
    text: row.text,
    score: row.score ?? 0,
    url: row.url ?? '',
    createdUtc: row.created_utc ?? 0,
    harvestedAt: row.harvested_at,
  };
}

interface AdRow {
  ad_id: string;
  advertiser: string;
  category: string;
  body: string;
  cta: string;
  url: string;
  creative: string | null;
  platforms: string;
  start_date: number | null;
  end_date: number | null;
  is_active: number;
  days_running: number | null;
  duration_confidence: string;
  observed_at: number;
}

function toAdObservation(row: AdRow): AdObservation {
  let platforms: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.platforms);
    if (Array.isArray(parsed)) platforms = parsed.map(String);
  } catch {
    /* A malformed platforms blob is not worth failing a read over. */
  }
  return {
    adId: row.ad_id,
    advertiser: row.advertiser,
    category: row.category,
    body: row.body,
    cta: row.cta,
    url: row.url,
    creative: (row.creative ?? null) as CreativeType,
    platforms,
    startDate: row.start_date,
    endDate: row.end_date,
    isActive: row.is_active === 1,
    daysRunning: row.days_running,
    durationConfidence: row.duration_confidence as DurationConfidence,
    observedAt: row.observed_at,
  };
}

export interface SqliteCorpusOptions {
  /* ':memory:' is supported and is what the test suite uses. */
  path: string;
  /* Unix seconds. Defaults to the system clock. Injected by tests. */
  now?: () => number;
}

interface DeliveryRow {
  report_id: string; tenant_id: string | null; key_label: string; url: string;
  payload: string; attempts: number; next_attempt_at: number; status: string;
  last_status: number | null; last_error: string | null;
  created_at: number; delivered_at: number | null;
}

const toDelivery = (r: DeliveryRow): WebhookDelivery => ({
  reportId: r.report_id,
  tenantId: r.tenant_id,
  keyLabel: r.key_label,
  url: r.url,
  payload: r.payload,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  status: r.status as WebhookDelivery['status'],
  lastStatus: r.last_status,
  lastError: r.last_error,
  createdAt: r.created_at,
  deliveredAt: r.delivered_at,
});

export function openSqliteCorpus(options: SqliteCorpusOptions): CorpusDriver {
  const { path, now: nowSeconds = systemClock } = options;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  /*
   * BUSY TIMEOUT FIRST, AND IT HAS TO BE FIRST.
   *
   * MEASURED 2026-08-22. Three processes opened the same corpus at once and
   * TWO OF THEM CRASHED WITH "database is locked", not on a write but on the
   * `journal_mode` pragma below, before either had stored a single row.
   *
   * SQLite's default busy timeout is ZERO, so any contention fails instantly
   * rather than waiting. Switching a database into WAL takes a brief exclusive
   * lock, which is exactly what collided. So the timeout is set before anything
   * that can contend, and a second run now waits its turn instead of dying.
   *
   * Five seconds because these are short writes: a batch of 100 records takes
   * milliseconds, so anything still blocked after five seconds is a real
   * problem worth surfacing rather than hiding behind a longer wait.
   *
   * This makes concurrent readers and one writer safe, which is what WAL gives
   * and what a handful of local CLI runs need. It does NOT make SQLite a
   * multi tenant server database. That is what the Postgres driver is for.
   */
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SQLITE_SCHEMA);

  const insertDoc = db.prepare(`
    INSERT OR IGNORE INTO docs
      (receipt_id, source, kind, external_id, category, channel, text, score, url, created_utc, harvested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  /*
   * No OR IGNORE, no ON CONFLICT, and no unique constraint to trip over. Two
   * rows for one ad is the evidence that it is still running, not a duplicate
   * to be collapsed. This is the whole reason the table is separate from docs.
   */
  const insertAdObservation = db.prepare(`
    INSERT INTO ad_observations
      (ad_id, advertiser, category, body, cta, url, creative, platforms,
       start_date, end_date, is_active, days_running, duration_confidence, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    async addDocs(docs: DocInput[], category: string): Promise<number> {
      if (!docs.length) return 0;
      const harvestedAt = nowSeconds();
      let added = 0;
      db.exec('BEGIN');
      try {
        for (const d of docs) {
          if (!d.text || !d.externalId) continue;
          /*
           * The id is minted from the SANITISED external id, never the raw one,
           * so the id always re-derives from the value actually stored. See
           * text.ts for why a NUL has to go at all.
           */
          const externalId = storableText(String(d.externalId));
          const result = insertDoc.run(
            receiptId(d.source, externalId),
            d.source,
            d.kind,
            externalId,
            storableText(category),
            storableText(d.channel ?? ''),
            storableText(d.text),
            d.score ?? 0,
            storableText(d.url ?? ''),
            d.createdUtc ?? 0,
            harvestedAt,
          );
          added += Number(result.changes);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return added;
    },

    async search(query: string, options: SearchOptions = {}): Promise<DocHit[]> {
      const { category = null, limit = 200, minScore = null, source = null, from, until } = options;
      const loose = ftsQuery(query);
      if (!loose) return [];

      const where = ['docs_fts MATCH ?'];
      const args: (string | number)[] = [];
      if (category) { where.push('d.category = ?'); args.push(category); }
      if (source) { where.push('d.source = ?'); args.push(source); }
      if (minScore != null) { where.push('d.score >= ?'); args.push(minScore); }
      /* An as-of window. A record with no usable date is EXCLUDED rather than
       * assumed recent, because assuming would place undated evidence inside
       * every window it was never shown to belong to. */
      if (from != null) { where.push('d.created_utc >= ?'); args.push(from); }
      if (until != null) { where.push('d.created_utc <= ? AND d.created_utc > 0'); args.push(until); }
      args.push(limit);

      /*
       * CROSS JOIN BELOW, AND IT IS A 23x SPEEDUP RATHER THAN A STYLE CHOICE.
       *
       * MEASURED 2026-08-22 on a 100,000 record corpus. With a plain JOIN and a
       * category filter, SQLite made docs the OUTER loop, driven by the
       * category index, and probed the FTS index ONCE PER ROW IN THE CATEGORY:
       * 190ms for a query that should be single digit. Without a category
       * filter it chose correctly and took 12ms, so the product's hottest query
       * was the one shape the planner got wrong, and every report makes one per
       * term.
       *
       * CROSS JOIN is SQLite's documented way to pin the loop order: the left
       * table is the outer loop and the planner may not reorder it. The FTS
       * scan runs once and its rows are fetched by primary key. Verified
       * identical results, 190ms to 8.4ms.
       *
       * The comment lives out here rather than inside the query, because a
       * backtick in a comment inside a template literal ends the template.
       */
      const statement = db.prepare(`
        SELECT d.receipt_id, d.source, d.kind, d.external_id, d.category, d.channel,
               d.text, d.score, d.url, d.created_utc, d.harvested_at,
               bm25(docs_fts) AS rank
        FROM docs_fts
        CROSS JOIN docs d ON d.id = docs_fts.rowid
        WHERE ${where.join(' AND ')}
        ORDER BY rank, d.score DESC
        LIMIT ?
      `);
      const run = (match: string): DocRow[] =>
        statement.all(match, ...args) as unknown as DocRow[];

      /*
       * AND FIRST, OR AS THE FALLBACK. "battery life" used to count every
       * record that merely said "life". Records carrying every word are the
       * answer when they exist; the measured recall behaviour (see terms.ts)
       * is untouched when they do not. Strict is null for one word queries,
       * where the two searches are identical.
       */
      const strict = toFts5QueryStrict(query);
      const strictRows = strict ? run(strict) : [];
      const rows = strictRows.length ? strictRows : run(loose);

      return rows.map((r) => ({ ...toDoc(r), rank: r.rank ?? 0 }));
    },

    /*
     * The denominator, and the numerator, in one shape. See driver.ts for why
     * this returns counts rather than rows.
     *
     * A record whose date is missing, zero, before the epoch bound or in the
     * future is counted as undated rather than bucketed. Corrupt timestamps are
     * real: a source that reports milliseconds where we expect seconds lands in
     * the year 55000 and would invent a month with one record in it, which then
     * reads as a period where nobody said anything.
     */
    async dateHistogram(options: DateHistogramOptions): Promise<DateHistogram> {
      const {
        category, query,
        from = MIN_CREATED_UTC,
        until = Math.floor(Date.now() / 1000) + FUTURE_TOLERANCE_SECONDS,
      } = options;

      const where = ['d.category = ?'];
      const args: (string | number)[] = [category];
      let joins = false;
      if (query !== undefined) {
        const match = ftsQuery(query);
        /* A query that reduces to nothing matches nothing, which is different
         * from matching everything. */
        if (!match) return { buckets: [], undated: 0 };
        joins = true;
        where.push('docs_fts MATCH ?');
        args.push(match);
      }

      /* Same loop order problem and the same fix as `search`. See the note
       * there: with a plain join the planner probes FTS once per row in the
       * category, and a report calls this once per term. */
      const from_clause = joins
        ? 'FROM docs_fts CROSS JOIN docs d ON d.id = docs_fts.rowid'
        : 'FROM docs d';

      const rows = db.prepare(`
        SELECT CASE
                 WHEN d.created_utc IS NULL OR d.created_utc < ${from} OR d.created_utc > ${until}
                 THEN NULL
                 ELSE strftime('%Y-%m', d.created_utc, 'unixepoch')
               END AS period,
               COUNT(*) AS records
        ${from_clause}
        WHERE ${where.join(' AND ')}
        GROUP BY period
      `).all(...args) as unknown as { period: string | null; records: number }[];

      const buckets = rows
        .filter((r): r is { period: string; records: number } => r.period !== null)
        .map((r) => ({ period: r.period, records: Number(r.records) }))
        .sort((a, b) => a.period.localeCompare(b.period));

      return { buckets, undated: Number(rows.find((r) => r.period === null)?.records ?? 0) };
    },

    async byCategory(category: string, options: ByCategoryOptions = {}): Promise<Doc[]> {
      const { limit = 400, kind = null, from, until } = options;
      const where = ['category = ?'];
      const args: (string | number)[] = [category];
      if (kind) { where.push('kind = ?'); args.push(kind); }
      if (from != null) { where.push('created_utc >= ?'); args.push(from); }
      if (until != null) { where.push('created_utc <= ? AND created_utc > 0'); args.push(until); }
      args.push(limit);

      const rows = db.prepare(`
        SELECT receipt_id, source, kind, external_id, category, channel,
               text, score, url, created_utc, harvested_at
        FROM docs WHERE ${where.join(' AND ')}
        ORDER BY score DESC LIMIT ?
      `).all(...args) as unknown as DocRow[];

      return rows.map(toDoc);
    },

    /*
     * The resolver the entire product rests on. An id that names nothing simply
     * does not come back, which is what makes a fabricated citation impossible
     * rather than merely unlikely.
     */
    async getByReceiptIds(receiptIds: string[]): Promise<Doc[]> {
      if (!receiptIds.length) return [];
      const placeholders = receiptIds.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT receipt_id, source, kind, external_id, category, channel,
               text, score, url, created_utc, harvested_at
        FROM docs WHERE receipt_id IN (${placeholders})
      `).all(...receiptIds) as unknown as DocRow[];

      /*
       * One receipt id can match several rows, because the same utterance
       * harvested under two categories is two rows. Collapse to one record per
       * id, or a caller counting corroboration would count that person twice.
       */
      const byId = new Map<string, Doc>();
      for (const row of rows) {
        if (!byId.has(row.receipt_id)) byId.set(row.receipt_id, toDoc(row));
      }
      return [...byId.values()];
    },

    async categoryStats(category: string): Promise<CategoryStats> {
      const row = db.prepare(`
        SELECT COUNT(*) AS docs,
               SUM(CASE WHEN kind = 'comment' THEN 1 ELSE 0 END) AS comments,
               COUNT(DISTINCT channel) AS channels,
               MAX(harvested_at) AS last_harvested
        FROM docs WHERE category = ?
      `).get(category) as unknown as {
        docs: number | null; comments: number | null;
        channels: number | null; last_harvested: number | null;
      } | undefined;

      const meta = db.prepare('SELECT subreddits, queries FROM categories WHERE name = ?')
        .get(category) as unknown as { subreddits: string | null; queries: string | null } | undefined;

      const docs = row?.docs ?? 0;
      const lastHarvested = row?.last_harvested ?? 0;
      const age = ageInDays(lastHarvested, nowSeconds());

      const parseList = (raw: string | null | undefined): string[] => {
        if (!raw) return [];
        try {
          const parsed: unknown = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch { return []; }
      };

      return {
        category,
        docs,
        comments: row?.comments ?? 0,
        channels: row?.channels ?? 0,
        lastHarvested,
        ageDays: age,
        warm: isWarm(docs, age),
        subreddits: parseList(meta?.subreddits),
        queries: parseList(meta?.queries),
      };
    },

    async rememberCategory(category, plan): Promise<void> {
      const ts = nowSeconds();
      db.prepare(`
        INSERT INTO categories (name, first_seen, last_harvested, subreddits, queries)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          last_harvested = excluded.last_harvested,
          subreddits     = excluded.subreddits,
          queries        = excluded.queries
      `).run(category, ts, ts, JSON.stringify(plan.subreddits ?? []), JSON.stringify(plan.queries ?? []));
    },

    async addAdObservations(observations: AdObservationInput[]): Promise<number> {
      if (!observations.length) return 0;
      const observedAt = nowSeconds();
      let written = 0;
      db.exec('BEGIN');
      try {
        for (const o of observations) {
          if (!o.adId) continue;
          insertAdObservation.run(
            storableText(o.adId),
            storableText(o.advertiser ?? ''),
            storableText(o.category),
            storableText(o.body ?? ''),
            storableText(o.cta ?? ''),
            storableText(o.url ?? ''),
            o.creative,
            JSON.stringify(o.platforms ?? []),
            o.startDate ?? null,
            o.endDate ?? null,
            o.isActive ? 1 : 0,
            o.daysRunning,
            o.durationConfidence,
            observedAt,
          );
          written++;
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return written;
    },

    async adObservations(adId: string): Promise<AdObservation[]> {
      const rows = db.prepare(`
        SELECT * FROM ad_observations WHERE ad_id = ? ORDER BY observed_at ASC, id ASC
      `).all(adId) as unknown as AdRow[];
      return rows.map(toAdObservation);
    },

    async latestAdsByCategory(category: string, limit = 100): Promise<AdObservation[]> {
      /*
       * One row per ad, the most recent sighting.
       *
       * Keyed on MAX(id) rather than MAX(observed_at). Observations written in
       * the same second share a timestamp, so a max over observed_at ties and
       * SQLite is then free to return either row. The surrogate key is
       * monotonic with insertion order, so it cannot tie. This was a real test
       * failure, not a hypothetical.
       *
       * Plain SQL rather than a window function so the Postgres driver mirrors
       * it directly.
       */
      const rows = db.prepare(`
        SELECT * FROM ad_observations
        WHERE id IN (
          SELECT MAX(id) FROM ad_observations WHERE category = ? GROUP BY ad_id
        )
        ORDER BY days_running DESC
        LIMIT ?
      `).all(category, limit) as unknown as AdRow[];
      return rows.map(toAdObservation);
    },

    async saveReport(report: ReportInput): Promise<void> {
      db.prepare(`
        INSERT INTO reports (tenant_id, product_url, product_title, category, markdown, findings, cost_usd, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        report.tenantId ?? null,
        report.productUrl,
        report.productTitle ?? '',
        report.category,
        report.markdown,
        JSON.stringify(report.findings ?? {}),
        report.costUsd ?? 0,
        nowSeconds(),
      );
    },

    async priorReports(category: string, limit = 3, tenantId?: string | null): Promise<PriorReport[]> {
      /* IS NOT DISTINCT FROM, so NULL matches NULL. A plain `=` never matches a
       * null tenant and would silently return nothing for the CLI. */
      const rows = db.prepare(`
        SELECT product_title, product_url, findings, created_at
        FROM reports
        WHERE category = ? AND tenant_id IS NOT DISTINCT FROM ?
        ORDER BY created_at DESC LIMIT ?
      `).all(category, tenantId ?? null, limit) as unknown as {
        product_title: string | null; product_url: string;
        findings: string | null; created_at: number;
      }[];

      return rows.map((r) => {
        let findings: unknown = {};
        try { findings = r.findings ? JSON.parse(r.findings) : {}; } catch { /* keep {} */ }
        return {
          productTitle: r.product_title ?? '',
          productUrl: r.product_url,
          findings,
          createdAt: r.created_at,
        };
      });
    },

    /* Idempotent on the report id. See the driver interface. */
    async saveReportSnapshot(snapshot: ReportSnapshotInput): Promise<void> {
      db.prepare(`
        INSERT INTO report_snapshots (report_id, tenant_id, category, status, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(report_id) DO NOTHING
      `).run(
        snapshot.reportId,
        snapshot.tenantId ?? null,
        snapshot.category,
        snapshot.status,
        snapshot.payload,
        nowSeconds(),
      );
    },

    async getReportSnapshot(reportId: string): Promise<StoredReportSnapshot | null> {
      const row = db.prepare(`
        SELECT report_id, tenant_id, category, status, payload, created_at
        FROM report_snapshots WHERE report_id = ?
      `).get(reportId) as {
        report_id: string; tenant_id: string | null; category: string;
        status: string; payload: string; created_at: number;
      } | undefined;
      if (!row) return null;
      return {
        reportId: row.report_id, tenantId: row.tenant_id, category: row.category,
        status: row.status, payload: row.payload, createdAt: row.created_at,
      };
    },

    async pruneReportSnapshots(before: number): Promise<number> {
      const result = db.prepare('DELETE FROM report_snapshots WHERE created_at < ?').run(before);
      return Number(result.changes);
    },

    /*
     * ON CONFLICT DO NOTHING, because enqueueing must be idempotent. A report
     * reaches a terminal state once, and if that ever happened twice the second
     * must not produce a second delivery to a customer.
     */
    async enqueueDelivery(delivery: WebhookDeliveryInput): Promise<void> {
      db.prepare(`
        INSERT INTO webhook_deliveries
          (report_id, tenant_id, key_label, url, payload, attempts, next_attempt_at, status, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, 'pending', ?)
        ON CONFLICT(report_id) DO NOTHING
      `).run(
        delivery.reportId,
        delivery.tenantId ?? null,
        delivery.keyLabel,
        delivery.url,
        delivery.payload,
        delivery.nextAttemptAt,
        nowSeconds(),
      );
    },

    async dueDeliveries(now: number, limit = 20): Promise<WebhookDelivery[]> {
      const rows = db.prepare(`
        SELECT report_id, tenant_id, key_label, url, payload, attempts, next_attempt_at,
               status, last_status, last_error, created_at, delivered_at
        FROM webhook_deliveries
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC
        LIMIT ?
      `).all(now, limit) as unknown as DeliveryRow[];
      return rows.map(toDelivery);
    },

    async recordDeliveryAttempt(reportId: string, result: WebhookAttemptResult): Promise<void> {
      db.prepare(`
        UPDATE webhook_deliveries
        SET attempts = ?, next_attempt_at = ?, status = ?,
            last_status = ?, last_error = ?, delivered_at = ?
        WHERE report_id = ?
      `).run(
        result.attempts,
        result.nextAttemptAt,
        result.status,
        result.lastStatus ?? null,
        result.lastError ?? null,
        result.deliveredAt ?? null,
        reportId,
      );
    },

    /* Settled rows only. A pending delivery is never pruned, however old: the
     * schedule runs to roughly 75 hours and an instance that slept through most
     * of it must still find its work. */
    async pruneDeliveries(before: number): Promise<number> {
      const result = db.prepare(`
        DELETE FROM webhook_deliveries
        WHERE status != 'pending' AND created_at < ?
      `).run(before);
      return Number(result.changes);
    },

    async cacheProduct(facts: ProductFacts, category: string): Promise<void> {
      db.prepare(`
        INSERT INTO products (url, title, category, facts, source, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET
          title = excluded.title, category = excluded.category,
          facts = excluded.facts, source = excluded.source, fetched_at = excluded.fetched_at
      `).run(
        facts.url,
        facts.title ?? '',
        category,
        JSON.stringify(facts),
        facts.source ?? '',
        nowSeconds(),
      );
    },

    async getProduct(url: string, maxAgeDays = 30): Promise<ProductFacts | null> {
      const row = db.prepare('SELECT facts, fetched_at FROM products WHERE url = ?')
        .get(url) as unknown as { facts: string; fetched_at: number } | undefined;
      if (!row) return null;
      const age = ageInDays(row.fetched_at, nowSeconds());
      if (age === null || age > maxAgeDays) return null;
      try { return JSON.parse(row.facts) as ProductFacts; } catch { return null; }
    },

    async deleteByExternalId(source: SourceId, externalId: string): Promise<number> {
      /* The FTS delete trigger fires on this, so the index stays consistent. */
      const result = db.prepare('DELETE FROM docs WHERE source = ? AND external_id = ?')
        .run(source, externalId);
      return Number(result.changes);
    },

    async totals(): Promise<CorpusTotals> {
      const one = (sql: string): number => {
        const row = db.prepare(sql).get() as unknown as { n: number } | undefined;
        return row?.n ?? 0;
      };
      return {
        docs: one('SELECT COUNT(*) AS n FROM docs'),
        categories: one('SELECT COUNT(*) AS n FROM categories'),
        reports: one('SELECT COUNT(*) AS n FROM reports'),
        adObservations: one('SELECT COUNT(*) AS n FROM ad_observations'),
      };
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}

/* Re-exported so a caller can assert agreement without importing constants. */
export { WARM_MAX_AGE_DAYS, WARM_MIN_DOCS };
