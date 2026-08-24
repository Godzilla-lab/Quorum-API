/*
 * The Postgres corpus driver.
 *
 * WHY THIS TAKES AN INJECTED EXECUTOR RATHER THAN OPENING ITS OWN CONNECTION.
 *
 * Node has no built in Postgres client, so a self connecting driver would force
 * a runtime dependency on every consumer of this package, including the CLI
 * users who only ever touch SQLite. Adding a dependency is on the ask first
 * list, and here it is also avoidable: the caller already has a client.
 *
 * So the driver declares the two calls it needs and the caller supplies them.
 * That works with node-postgres, postgres.js, a Supabase client, a serverless
 * HTTP driver, or a connection from a pool inside a transaction, and the
 * package ships with zero runtime dependencies.
 *
 * VERIFICATION STATUS: RUN. All 21 conformance tests pass against PostgreSQL
 * 17.10, measured 2026-08-22, applying the real migrations into a throwaway
 * schema. See `postgres.conformance.test.ts` and `docs/postgres.md`.
 *
 * What that run found was not in this file. The SQL here was correct. The
 * second migration could not execute at all, because it granted to a Supabase
 * role that does not exist on a stock server, so anyone self hosting was
 * blocked on migration two. Nine months of tests against a recording fake could
 * never have caught it, because a fake never rejects invalid SQL.
 */

import type { CorpusDriver } from '../driver.ts';
import { receiptId } from '../receipt-id.ts';
import { toTsQuery, toTsQueryStrict } from '../terms.ts';
import { storableText } from '../text.ts';
import { FUTURE_TOLERANCE_SECONDS, MIN_CREATED_UTC, ageInDays, isWarm } from '../constants.ts';
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
  Monitor,
  MonitorInput,
  DurationConfidence,
  PriorReport,
  ProductFacts,
  RecordKind,
  ReportInput,
  ReportSnapshotInput,
  SearchOptions,
  SourceId,
  SpendByKey,
  StoredReportSnapshot,
} from '../types.ts';

/*
 * The only surface this driver needs from a client. Deliberately minimal so
 * that adapting any real client is a few lines at the call site.
 */
export interface SqlExecutor {
  /* Runs a parameterised statement and returns the rows. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /* Optional. Used to make multi row writes atomic when the client supports it. */
  transaction?<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

export interface PostgresCorpusOptions {
  sql: SqlExecutor;
  /* Unix seconds. Defaults to the system clock. Injected by tests. */
  now?: () => number;
}

const systemClock = (): number => Math.floor(Date.now() / 1000);

/* Postgres returns BIGINT as a string in most clients, so every numeric read
 * that touches a bigint column goes through this rather than trusting a cast. */
const num = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  return 0;
};

const list = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    try { const p: unknown = JSON.parse(v); return Array.isArray(p) ? p.map(String) : []; } catch { return []; }
  }
  return [];
};

interface DocRow {
  receipt_id: string; source: string; kind: string; external_id: string;
  category: string; channel: string | null; text: string;
  score: unknown; url: string | null; created_utc: unknown; harvested_at: unknown;
  rank?: unknown;
}

function toDoc(r: DocRow): Doc {
  return {
    receiptId: r.receipt_id,
    source: r.source as SourceId,
    kind: r.kind as RecordKind,
    externalId: r.external_id,
    category: r.category,
    channel: r.channel ?? '',
    text: r.text,
    score: num(r.score),
    url: r.url ?? '',
    createdUtc: num(r.created_utc),
    harvestedAt: num(r.harvested_at),
  };
}

interface AdRow {
  ad_id: string; advertiser: string; category: string; body: string; cta: string;
  url: string; creative: string | null; platforms: unknown;
  start_date: unknown; end_date: unknown; is_active: boolean;
  days_running: unknown; duration_confidence: string; observed_at: unknown;
}

function toAdObservation(r: AdRow): AdObservation {
  return {
    adId: r.ad_id,
    advertiser: r.advertiser,
    category: r.category,
    body: r.body,
    cta: r.cta,
    url: r.url,
    creative: (r.creative ?? null) as CreativeType,
    platforms: list(r.platforms),
    startDate: r.start_date === null ? null : num(r.start_date),
    endDate: r.end_date === null ? null : num(r.end_date),
    isActive: r.is_active === true,
    daysRunning: r.days_running === null ? null : num(r.days_running),
    durationConfidence: r.duration_confidence as DurationConfidence,
    observedAt: num(r.observed_at),
  };
}

interface PgDeliveryRow {
  report_id: string; tenant_id: string | null; key_label: string; url: string;
  payload: string; attempts: unknown; next_attempt_at: unknown; status: string;
  last_status: unknown; last_error: string | null;
  created_at: unknown; delivered_at: unknown;
}

/* BIGINT arrives as a string from the client, hence num(). See its header. */
const toDelivery = (r: PgDeliveryRow): WebhookDelivery => ({
  reportId: r.report_id,
  tenantId: r.tenant_id,
  keyLabel: r.key_label,
  url: r.url,
  payload: r.payload,
  attempts: num(r.attempts),
  nextAttemptAt: num(r.next_attempt_at),
  status: r.status as WebhookDelivery['status'],
  lastStatus: r.last_status === null ? null : num(r.last_status),
  lastError: r.last_error,
  createdAt: num(r.created_at),
  deliveredAt: r.delivered_at === null ? null : num(r.delivered_at),
});


interface PgMonitorRow {
  monitor_id: string; tenant_id: string | null; key_label: string;
  subject: string; terms: unknown; webhook_url: string;
  interval_seconds: unknown; enabled: boolean; created_at: unknown;
  last_fired_at: unknown; last_result: string | null;
}

const toMonitor = (r: PgMonitorRow): Monitor => ({
  monitorId: r.monitor_id,
  tenantId: r.tenant_id,
  keyLabel: r.key_label,
  subject: r.subject,
  terms: list(r.terms),
  webhookUrl: r.webhook_url,
  intervalSeconds: num(r.interval_seconds),
  enabled: r.enabled === true,
  createdAt: num(r.created_at),
  lastFiredAt: num(r.last_fired_at),
  lastResult: r.last_result,
});

export function openPostgresCorpus(options: PostgresCorpusOptions): CorpusDriver {
  const { sql, now: nowSeconds = systemClock } = options;

  const atomic = async <T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> =>
    sql.transaction ? sql.transaction(fn) : fn(sql);

  return {
    async addDocs(docs: DocInput[], category: string): Promise<number> {
      if (!docs.length) return 0;
      const harvestedAt = nowSeconds();

      /*
       * ONE ROUND TRIP PER CHUNK, NOT PER ROW. This was one INSERT per record
       * until 2026-08-24, and against a managed database that is a disaster
       * dressed as correctness: every statement pays the full round trip, and
       * a warm rerun paid it again for every ON CONFLICT no-op. It is why the
       * hosted runs of 2026-08-24 took 15 to 20 minutes for ~2,900 records.
       *
       * Measured live against Aiven, 2026-08-24, 100 rows from a laptop at
       * ~678ms RTT (Render sits closer, the ratio is the point):
       *
       *   one row per statement   67.8s
       *   one batched call         0.89s   76x
       *   warm rerun, all dupes    0.54s  125x
       *
       * RETURNING id still fires once per row actually inserted, so the
       * "genuinely new" count survives batching exactly.
       *
       * Duplicates WITHIN one call are collapsed here first, keeping the
       * first occurrence, for two reasons: it mirrors the first-write-wins
       * rule the table enforces across calls, and it keeps the statement
       * independent of how the server treats intra-statement conflicts.
       */
      const seen = new Set<string>();
      const rows: DocInput[] = [];
      for (const d of docs) {
        if (!d.text || !d.externalId) continue;
        const identity = `${d.source}\u0000${storableText(String(d.externalId))}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        rows.push(d);
      }
      if (!rows.length) return 0;

      /*
       * 11 parameters per row against the server's 65,535 parameter cap puts
       * the hard ceiling near 5,900 rows. 500 stays an order of magnitude
       * clear of it while still collapsing a retrieval flush (100 rows) into
       * a single statement.
       */
      const CHUNK = 500;

      return atomic(async (tx) => {
        let added = 0;
        for (let start = 0; start < rows.length; start += CHUNK) {
          const chunk = rows.slice(start, start + CHUNK);
          const params: unknown[] = [];
          const values: string[] = [];
          for (const d of chunk) {
            const base = params.length;
            params.push(
              /* Minted from the SANITISED external id so the id always
               * re-derives from the value actually stored. See text.ts. */
              receiptId(d.source, storableText(String(d.externalId))),
              d.source, d.kind, storableText(String(d.externalId)),
              storableText(category), storableText(d.channel ?? ''), storableText(d.text),
              d.score ?? 0, storableText(d.url ?? ''),
              d.createdUtc ?? 0, harvestedAt,
            );
            values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11})`);
          }
          const inserted = await tx.query<{ id: unknown }>(
            `INSERT INTO docs
               (receipt_id, source, kind, external_id, category, channel, text, score, url, created_utc, harvested_at)
             VALUES ${values.join(',')}
             ON CONFLICT (source, external_id, category) DO NOTHING
             RETURNING id`,
            params,
          );
          added += inserted.length;
        }
        return added;
      });
    },

    async search(query: string, options: SearchOptions = {}): Promise<DocHit[]> {
      const { category = null, limit = 200, minScore = null, source = null, from, until } = options;
      const loose = toTsQuery(query);
      if (!loose) return [];

      const where = ['d.text_tsv @@ to_tsquery(\'english\', $1)'];
      const params: unknown[] = [loose];
      if (category) { params.push(category); where.push(`d.category = $${params.length}`); }
      if (source) { params.push(source); where.push(`d.source = $${params.length}`); }
      if (minScore != null) { params.push(minScore); where.push(`d.score >= $${params.length}`); }
      /* Same window rule as the sqlite driver, and conformance asserts they
       * agree. An undated record is excluded rather than assumed recent. */
      if (from != null) { params.push(from); where.push(`d.created_utc >= $${params.length}`); }
      if (until != null) { params.push(until); where.push(`d.created_utc <= $${params.length} AND d.created_utc > 0`); }
      params.push(limit);

      /*
       * Ranking is driver specific and NOT comparable across drivers: SQLite
       * returns bm25, where lower is better, and Postgres returns ts_rank,
       * where higher is better. What conformance guarantees is the ordering and
       * the result set, not the numeric value of `rank`.
       */
      const text =
        `SELECT d.receipt_id, d.source, d.kind, d.external_id, d.category, d.channel,
                d.text, d.score, d.url, d.created_utc, d.harvested_at,
                ts_rank(d.text_tsv, to_tsquery('english', $1)) AS rank
         FROM docs d
         WHERE ${where.join(' AND ')}
         ORDER BY rank DESC, d.score DESC
         LIMIT $${params.length}`;
      const run = (tsquery: string): Promise<DocRow[]> =>
        sql.query<DocRow>(text, [tsquery, ...params.slice(1)]);

      /* AND first, OR as the fallback, same ladder as the sqlite driver and
       * for the reason given in terms.ts. */
      const strict = toTsQueryStrict(query);
      const strictRows = strict ? await run(strict) : [];
      const rows = strictRows.length ? strictRows : await run(loose);
      return rows.map((r) => ({ ...toDoc(r), rank: num(r.rank) }));
    },

    /* The same shape as the sqlite driver, and conformance asserts they agree.
     * See driver.ts for why this returns counts rather than rows. */
    async dateHistogram(options: DateHistogramOptions): Promise<DateHistogram> {
      const {
        category, query,
        from = MIN_CREATED_UTC,
        until = Math.floor(Date.now() / 1000) + FUTURE_TOLERANCE_SECONDS,
      } = options;

      const params: unknown[] = [category];
      const where = ['d.category = $1'];
      if (query !== undefined) {
        const tsquery = toTsQuery(query);
        /* A query that reduces to nothing matches nothing, which is different
         * from matching everything. */
        if (!tsquery) return { buckets: [], undated: 0 };
        params.push(tsquery);
        where.push(`d.text_tsv @@ to_tsquery('english', $${params.length})`);
      }
      params.push(from);
      const fromParam = params.length;
      params.push(until);
      const untilParam = params.length;

      const rows = await sql.query<{ period: string | null; records: string | number }>(
        `SELECT CASE
                  WHEN d.created_utc IS NULL
                    OR d.created_utc < $${fromParam}
                    OR d.created_utc > $${untilParam}
                  THEN NULL
                  ELSE to_char(to_timestamp(d.created_utc) AT TIME ZONE 'UTC', 'YYYY-MM')
                END AS period,
                COUNT(*) AS records
         FROM docs d
         WHERE ${where.join(' AND ')}
         GROUP BY period`,
        params,
      );

      const buckets = rows
        .filter((r): r is { period: string; records: string | number } => r.period !== null)
        .map((r) => ({ period: r.period, records: num(r.records) }))
        .sort((a, b) => a.period.localeCompare(b.period));

      return { buckets, undated: num(rows.find((r) => r.period === null)?.records ?? 0) };
    },

    async byCategory(category: string, options: ByCategoryOptions = {}): Promise<Doc[]> {
      const { limit = 400, kind = null, from, until } = options;
      const params: unknown[] = [category];
      const where = ['category = $1'];
      if (kind) { params.push(kind); where.push(`kind = $${params.length}`); }
      if (from != null) { params.push(from); where.push(`created_utc >= $${params.length}`); }
      if (until != null) { params.push(until); where.push(`created_utc <= $${params.length} AND created_utc > 0`); }
      params.push(limit);

      const rows = await sql.query<DocRow>(
        `SELECT receipt_id, source, kind, external_id, category, channel,
                text, score, url, created_utc, harvested_at
         FROM docs WHERE ${where.join(' AND ')}
         ORDER BY score DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(toDoc);
    },

    async getByReceiptIds(receiptIds: string[]): Promise<Doc[]> {
      if (!receiptIds.length) return [];
      const rows = await sql.query<DocRow>(
        `SELECT receipt_id, source, kind, external_id, category, channel,
                text, score, url, created_utc, harvested_at
         FROM docs WHERE receipt_id = ANY($1)`,
        [receiptIds],
      );
      /* One id can match several rows, one per category it was harvested into.
       * Collapse to one record, or corroboration counts that person twice. */
      const byId = new Map<string, Doc>();
      for (const r of rows) if (!byId.has(r.receipt_id)) byId.set(r.receipt_id, toDoc(r));
      return [...byId.values()];
    },

    async categoryStats(category: string): Promise<CategoryStats> {
      const [agg] = await sql.query<{
        docs: unknown; comments: unknown; channels: unknown; last_harvested: unknown;
      }>(
        `SELECT COUNT(*) AS docs,
                COUNT(*) FILTER (WHERE kind = 'comment') AS comments,
                COUNT(DISTINCT channel) AS channels,
                COALESCE(MAX(harvested_at), 0) AS last_harvested
         FROM docs WHERE category = $1`,
        [category],
      );
      const [meta] = await sql.query<{ subreddits: unknown; queries: unknown }>(
        'SELECT subreddits, queries FROM categories WHERE name = $1',
        [category],
      );

      const docs = num(agg?.docs);
      const lastHarvested = num(agg?.last_harvested);
      const age = ageInDays(lastHarvested, nowSeconds());

      return {
        category,
        docs,
        comments: num(agg?.comments),
        channels: num(agg?.channels),
        lastHarvested,
        ageDays: age,
        warm: isWarm(docs, age),
        subreddits: list(meta?.subreddits),
        queries: list(meta?.queries),
      };
    },

    async rememberCategory(category, plan): Promise<void> {
      const ts = nowSeconds();
      await sql.query(
        `INSERT INTO categories (name, first_seen, last_harvested, subreddits, queries)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)
         ON CONFLICT (name) DO UPDATE SET
           last_harvested = EXCLUDED.last_harvested,
           subreddits     = EXCLUDED.subreddits,
           queries        = EXCLUDED.queries`,
        [category, ts, ts, JSON.stringify(plan.subreddits ?? []), JSON.stringify(plan.queries ?? [])],
      );
    },

    async addAdObservations(observations: AdObservationInput[]): Promise<number> {
      if (!observations.length) return 0;
      const observedAt = nowSeconds();

      return atomic(async (tx) => {
        let written = 0;
        for (const o of observations) {
          if (!o.adId) continue;
          /* No ON CONFLICT. Two rows for one ad is the evidence, not a
           * duplicate. See the migration comment. */
          await tx.query(
            `INSERT INTO ad_observations
               (ad_id, advertiser, category, body, cta, url, creative, platforms,
                start_date, end_date, is_active, days_running, duration_confidence, observed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14)`,
            [
              storableText(o.adId), storableText(o.advertiser ?? ''), storableText(o.category),
              storableText(o.body ?? ''), storableText(o.cta ?? ''), storableText(o.url ?? ''),
              o.creative, JSON.stringify(o.platforms ?? []),
              o.startDate ?? null, o.endDate ?? null, o.isActive,
              o.daysRunning, o.durationConfidence, observedAt,
            ],
          );
          written++;
        }
        return written;
      });
    },

    async adObservations(adId: string): Promise<AdObservation[]> {
      const rows = await sql.query<AdRow>(
        'SELECT * FROM ad_observations WHERE ad_id = $1 ORDER BY observed_at ASC, id ASC',
        [adId],
      );
      return rows.map(toAdObservation);
    },

    async latestAdsByCategory(category: string, limit = 100): Promise<AdObservation[]> {
      /* Keyed on MAX(id), not MAX(observed_at). Observations written in the
       * same second share a timestamp and a max over it ties. Mirrors the
       * SQLite driver exactly. */
      const rows = await sql.query<AdRow>(
        `SELECT * FROM ad_observations
         WHERE id IN (SELECT MAX(id) FROM ad_observations WHERE category = $1 GROUP BY ad_id)
         ORDER BY days_running DESC NULLS LAST
         LIMIT $2`,
        [category, limit],
      );
      return rows.map(toAdObservation);
    },

    async saveReport(report: ReportInput): Promise<void> {
      await sql.query(
        `INSERT INTO reports (tenant_id, product_url, product_title, category, markdown, findings, cost_usd, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [
          report.tenantId ?? null, report.productUrl, report.productTitle ?? '',
          report.category, report.markdown, JSON.stringify(report.findings ?? {}),
          report.costUsd ?? 0, nowSeconds(),
        ],
      );
    },

    async priorReports(category: string, limit = 3, tenantId?: string | null): Promise<PriorReport[]> {
      /* IS NOT DISTINCT FROM, so NULL matches NULL. See the driver interface. */
      const rows = await sql.query<{
        product_title: string | null; product_url: string; findings: unknown; created_at: unknown;
      }>(
        `SELECT product_title, product_url, findings, created_at
         FROM reports
         WHERE category = $1 AND tenant_id IS NOT DISTINCT FROM $2
         ORDER BY created_at DESC LIMIT $3`,
        [category, tenantId ?? null, limit],
      );
      return rows.map((r) => ({
        productTitle: r.product_title ?? '',
        productUrl: r.product_url,
        findings: typeof r.findings === 'string' ? JSON.parse(r.findings) : (r.findings ?? {}),
        createdAt: num(r.created_at),
      }));
    },

    /* Idempotent on the report id. See the driver interface. */
    async saveReportSnapshot(snapshot: ReportSnapshotInput): Promise<void> {
      await sql.query(
        `INSERT INTO report_snapshots (report_id, tenant_id, category, status, payload, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (report_id) DO NOTHING`,
        [
          snapshot.reportId, snapshot.tenantId ?? null, snapshot.category,
          snapshot.status, snapshot.payload, nowSeconds(),
        ],
      );
    },

    async getReportSnapshot(reportId: string): Promise<StoredReportSnapshot | null> {
      const rows = await sql.query<{
        report_id: string; tenant_id: string | null; category: string;
        status: string; payload: string; created_at: unknown;
      }>(
        `SELECT report_id, tenant_id, category, status, payload, created_at
         FROM report_snapshots WHERE report_id = $1`,
        [reportId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        reportId: row.report_id, tenantId: row.tenant_id, category: row.category,
        status: row.status, payload: row.payload, createdAt: num(row.created_at),
      };
    },

    async pruneReportSnapshots(before: number): Promise<number> {
      const rows = await sql.query<{ report_id: string }>(
        'DELETE FROM report_snapshots WHERE created_at < $1 RETURNING report_id',
        [before],
      );
      return rows.length;
    },


    async createMonitor(monitor: MonitorInput): Promise<void> {
      await sql.query(
        `INSERT INTO monitors
           (monitor_id, tenant_id, key_label, subject, terms, webhook_url, interval_seconds, enabled, created_at, last_fired_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, 0)`,
        [
          monitor.monitorId, monitor.tenantId ?? null, monitor.keyLabel,
          monitor.subject, JSON.stringify(monitor.terms), monitor.webhookUrl,
          monitor.intervalSeconds, nowSeconds(),
        ],
      );
    },

    async listMonitors(tenantId?: string | null): Promise<Monitor[]> {
      /* Exact tenant match, undefined meaning the NULL tenant. Same fails
       * closed rule as priorReports, enforced in SQL rather than left to the
       * inert-for-owners RLS policies. */
      const rows = await sql.query<PgMonitorRow>(
        `SELECT monitor_id, tenant_id, key_label, subject, terms, webhook_url,
                interval_seconds, enabled, created_at, last_fired_at, last_result
         FROM monitors WHERE tenant_id IS NOT DISTINCT FROM $1
         ORDER BY created_at`,
        [tenantId ?? null],
      );
      return rows.map(toMonitor);
    },

    async deleteMonitor(monitorId: string, tenantId?: string | null): Promise<number> {
      const rows = await sql.query<{ monitor_id: string }>(
        `DELETE FROM monitors
         WHERE monitor_id = $1 AND tenant_id IS NOT DISTINCT FROM $2
         RETURNING monitor_id`,
        [monitorId, tenantId ?? null],
      );
      return rows.length;
    },

    async dueMonitors(now: number): Promise<Monitor[]> {
      const rows = await sql.query<PgMonitorRow>(
        `SELECT monitor_id, tenant_id, key_label, subject, terms, webhook_url,
                interval_seconds, enabled, created_at, last_fired_at, last_result
         FROM monitors
         WHERE enabled AND last_fired_at + interval_seconds <= $1
         ORDER BY last_fired_at`,
        [now],
      );
      return rows.map(toMonitor);
    },

    async markMonitorFired(monitorId: string, at: number, result: string): Promise<void> {
      await sql.query(
        'UPDATE monitors SET last_fired_at = $1, last_result = $2 WHERE monitor_id = $3',
        [at, result, monitorId],
      );
    },

    async recordSpend(keyLabel: string, amountUsd: number): Promise<void> {
      if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;
      await sql.query(
        'INSERT INTO spend_ledger (key_label, amount_usd, spent_at) VALUES ($1,$2,$3)',
        [keyLabel, amountUsd, nowSeconds()],
      );
    },

    async spendSince(since: number): Promise<SpendByKey[]> {
      const rows = await sql.query<{ key_label: string; total_usd: unknown }>(
        `SELECT key_label, SUM(amount_usd) AS total_usd
         FROM spend_ledger WHERE spent_at >= $1
         GROUP BY key_label`,
        [since],
      );
      return rows.map((r) => ({ keyLabel: r.key_label, totalUsd: num(r.total_usd) }));
    },

    async pruneSpend(before: number): Promise<number> {
      const rows = await sql.query<{ id: unknown }>(
        'DELETE FROM spend_ledger WHERE spent_at < $1 RETURNING id',
        [before],
      );
      return rows.length;
    },

    /* Idempotent on the report id, for the reason given in the SQLite driver. */
    async enqueueDelivery(delivery: WebhookDeliveryInput): Promise<void> {
      await sql.query(
        `INSERT INTO webhook_deliveries
           (report_id, tenant_id, key_label, url, payload, attempts, next_attempt_at, status, created_at)
         VALUES ($1,$2,$3,$4,$5,0,$6,'pending',$7)
         ON CONFLICT (report_id) DO NOTHING`,
        [
          delivery.reportId, delivery.tenantId ?? null, delivery.keyLabel,
          delivery.url, delivery.payload, delivery.nextAttemptAt, nowSeconds(),
        ],
      );
    },

    async dueDeliveries(now: number, limit = 20): Promise<WebhookDelivery[]> {
      const rows = await sql.query<PgDeliveryRow>(
        `SELECT report_id, tenant_id, key_label, url, payload, attempts, next_attempt_at,
                status, last_status, last_error, created_at, delivered_at
         FROM webhook_deliveries
         WHERE status = 'pending' AND next_attempt_at <= $1
         ORDER BY next_attempt_at ASC
         LIMIT $2`,
        [now, limit],
      );
      return rows.map(toDelivery);
    },

    async recordDeliveryAttempt(reportId: string, result: WebhookAttemptResult): Promise<void> {
      await sql.query(
        `UPDATE webhook_deliveries
         SET attempts = $1, next_attempt_at = $2, status = $3,
             last_status = $4, last_error = $5, delivered_at = $6
         WHERE report_id = $7`,
        [
          result.attempts, result.nextAttemptAt, result.status,
          result.lastStatus ?? null, result.lastError ?? null,
          result.deliveredAt ?? null, reportId,
        ],
      );
    },

    /* Settled rows only, for the reason given in the SQLite driver. */
    async pruneDeliveries(before: number): Promise<number> {
      const rows = await sql.query<{ report_id: string }>(
        `DELETE FROM webhook_deliveries
         WHERE status != 'pending' AND created_at < $1
         RETURNING report_id`,
        [before],
      );
      return rows.length;
    },

    async cacheProduct(facts: ProductFacts, category: string): Promise<void> {
      await sql.query(
        `INSERT INTO products (url, title, category, facts, source, fetched_at)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6)
         ON CONFLICT (url) DO UPDATE SET
           title = EXCLUDED.title, category = EXCLUDED.category,
           facts = EXCLUDED.facts, source = EXCLUDED.source, fetched_at = EXCLUDED.fetched_at`,
        [facts.url, facts.title ?? '', category, JSON.stringify(facts), facts.source ?? '', nowSeconds()],
      );
    },

    async getProduct(url: string, maxAgeDays = 30): Promise<ProductFacts | null> {
      const [row] = await sql.query<{ facts: unknown; fetched_at: unknown }>(
        'SELECT facts, fetched_at FROM products WHERE url = $1',
        [url],
      );
      if (!row) return null;
      const age = ageInDays(num(row.fetched_at), nowSeconds());
      if (age === null || age > maxAgeDays) return null;
      return (typeof row.facts === 'string' ? JSON.parse(row.facts) : row.facts) as ProductFacts;
    },

    async deleteByExternalId(source: SourceId, externalId: string): Promise<number> {
      /* text_tsv is a generated column, so the index follows the delete with no
       * trigger to keep in step, unlike the SQLite side. */
      const rows = await sql.query<{ id: unknown }>(
        'DELETE FROM docs WHERE source = $1 AND external_id = $2 RETURNING id',
        [source, externalId],
      );
      return rows.length;
    },

    async totals(): Promise<CorpusTotals> {
      const [row] = await sql.query<Record<string, unknown>>(
        `SELECT (SELECT COUNT(*) FROM docs)            AS docs,
                (SELECT COUNT(*) FROM categories)      AS categories,
                (SELECT COUNT(*) FROM reports)         AS reports,
                (SELECT COUNT(*) FROM ad_observations) AS ad_observations`,
      );
      return {
        docs: num(row?.docs),
        categories: num(row?.categories),
        reports: num(row?.reports),
        adObservations: num(row?.ad_observations),
      };
    },

    async close(): Promise<void> {
      /* The caller owns the connection, so closing it is not this driver's
       * business. Deliberately a no op rather than a surprise disconnect. */
    },
  };
}
