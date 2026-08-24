/*
 * The SQLite schema.
 *
 * Deliberately Postgres shaped so the second driver is a driver and not a
 * rewrite: same tables, same columns, and `docs_fts` becomes a tsvector column
 * plus a GIN index rather than a virtual table.
 *
 * Vectors are deliberately absent. `embedding` is reserved on `docs` so adding
 * pgvector later is a migration and not a redesign, and semantic matching does
 * not get built until full text retrieval demonstrably fails to earn it.
 */

export const SCHEMA_VERSION = 1;

export const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  id            INTEGER PRIMARY KEY,
  receipt_id    TEXT NOT NULL,          -- rc_ + 16 hex, content addressed
  source        TEXT NOT NULL,          -- reddit | youtube | review | hackernews | ...
  kind          TEXT NOT NULL,          -- post | comment
  external_id   TEXT NOT NULL,
  category      TEXT NOT NULL,
  channel       TEXT,                   -- subreddit, video title, forum name
  text          TEXT NOT NULL,
  score         INTEGER DEFAULT 0,
  url           TEXT,
  created_utc   INTEGER DEFAULT 0,
  harvested_at  INTEGER NOT NULL,
  embedding     BLOB,                   -- reserved: pgvector lands here later
  UNIQUE (source, external_id, category)
);

/*
 * receipt_id is NOT unique. The same utterance harvested under two categories
 * is two rows carrying one receipt id, on purpose: the id names the human's
 * words, not the row. Corroboration counting dedupes by receipt id so that one
 * person cannot be counted twice.
 */
CREATE INDEX IF NOT EXISTS docs_receipt_idx  ON docs (receipt_id);
CREATE INDEX IF NOT EXISTS docs_category_idx ON docs (category, source, score DESC);
CREATE INDEX IF NOT EXISTS docs_harvest_idx  ON docs (category, harvested_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts
  USING fts5(text, content='docs', content_rowid='id', tokenize='porter unicode61');

CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO docs_fts(rowid, text) VALUES (new.id, new.text);
END;

/*
 * Ad observations: APPEND ONLY, and the reason this table exists separately.
 *
 * The engine wrote ads into docs, which is unique on
 * (source, external_id, category) and written with INSERT OR IGNORE. So the
 * second sighting of an ad was silently discarded and its day count froze at
 * first sight, while the comment above the writing function promised the
 * opposite: that snapshots accumulate into the dated history Meta does not keep
 * for commercial ads. Verified 2026-08-22.
 *
 * There is no unique constraint here beyond the surrogate key, and that is the
 * design. Two rows for one ad is the evidence, not a duplicate.
 */
CREATE TABLE IF NOT EXISTS ad_observations (
  id                   INTEGER PRIMARY KEY,
  ad_id                TEXT NOT NULL,
  advertiser           TEXT NOT NULL DEFAULT '',
  category             TEXT NOT NULL,
  body                 TEXT NOT NULL DEFAULT '',
  cta                  TEXT NOT NULL DEFAULT '',
  url                  TEXT NOT NULL DEFAULT '',
  creative             TEXT,            -- video | static | NULL when untypeable
  platforms            TEXT NOT NULL DEFAULT '[]',
  start_date           INTEGER,
  end_date             INTEGER,         -- only set once the ad has STOPPED
  is_active            INTEGER NOT NULL DEFAULT 0,
  days_running         INTEGER,
  duration_confidence  TEXT NOT NULL DEFAULT 'none',
  observed_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ad_obs_ad_idx       ON ad_observations (ad_id, observed_at);
CREATE INDEX IF NOT EXISTS ad_obs_category_idx ON ad_observations (category, observed_at DESC);

-- One row per category we have ever looked at: the warm/cold signal.
CREATE TABLE IF NOT EXISTS categories (
  name           TEXT PRIMARY KEY,
  first_seen     INTEGER NOT NULL,
  last_harvested INTEGER NOT NULL,
  subreddits     TEXT,                  -- JSON array, the picked set worth reusing
  queries        TEXT                   -- JSON array, the query plan worth reusing
);

/*
 * Reports are memory too: the second report in a category starts from the first.
 *
 * TENANT BOUNDARY. Reports are tenant owned; docs and categories are global.
 * Scoping records per tenant would destroy cross tenant warmth, which is the
 * entire hosted product. Scoping nothing would leak reports between customers.
 * Both mistakes are silent, so the boundary is stated here rather than assumed.
 */
CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY,
  tenant_id     TEXT,
  product_url   TEXT NOT NULL,
  product_title TEXT,
  category      TEXT NOT NULL,
  markdown      TEXT NOT NULL,
  findings      TEXT,                   -- JSON
  cost_usd      REAL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_category_idx ON reports (category, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_tenant_idx   ON reports (tenant_id, created_at DESC);

/*
 * Webhook deliveries: TENANT OWNED, like reports and unlike everything else.
 *
 * One report has one delivery, so the report id is the key and is also the
 * webhook-id header the receiver deduplicates on. The payload is stored rather
 * than re-rendered because the job queue is in memory: after a restart there is
 * nothing left to render from, which is the entire reason this table exists.
 *
 * last_status and last_error are for an operator reading the table. They must
 * never be returned to an API caller, because the difference between "refused"
 * and "timed out" reports whether an internal port is open.
 */
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  report_id       TEXT PRIMARY KEY,      -- also the webhook-id header
  tenant_id       TEXT,
  key_label       TEXT NOT NULL,         -- selects the derived signing secret
  url             TEXT NOT NULL,         -- credential shaped, never logged
  payload         TEXT NOT NULL,         -- the exact bytes signed and sent
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  last_status     INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  delivered_at    INTEGER
);

-- The only query the delivery worker makes.
CREATE INDEX IF NOT EXISTS webhook_due_idx ON webhook_deliveries (status, next_attempt_at);

-- Product resolution cache, so re-running a URL never re-pays the unlocker.
CREATE TABLE IF NOT EXISTS products (
  url        TEXT PRIMARY KEY,
  title      TEXT,
  category   TEXT,
  facts      TEXT NOT NULL,             -- JSON
  source     TEXT,
  fetched_at INTEGER NOT NULL
);

/*
 * Report snapshots: TENANT OWNED, the exact bytes the API served.
 *
 * The job queue is in memory and the hosted tier sleeps, so a finished report
 * used to 404 on the restart after it completed. The payload is stored rather
 * than re-rendered for the same reason webhook_deliveries stores its payload:
 * after a restart there is nothing left to render from, and the bytes a
 * caller fetches later must be the bytes the report actually said.
 */
CREATE TABLE IF NOT EXISTS report_snapshots (
  report_id  TEXT PRIMARY KEY,
  tenant_id  TEXT,
  category   TEXT NOT NULL,
  status     TEXT NOT NULL,             -- complete | failed | cancelled
  payload    TEXT NOT NULL,             -- the exact bytes GET served
  created_at INTEGER NOT NULL
);

-- The only scan besides the primary key: pruning by age.
CREATE INDEX IF NOT EXISTS report_snapshots_prune_idx ON report_snapshots (created_at);

/*
 * Monitors: standing watches that re-run a category on a schedule and send
 * the report, diff included, to a webhook. Tenant owned, like reports: a
 * monitor is a customer's standing order. Fires are submitted under the
 * owning key label, so every fire pays the owner's quota.
 */
CREATE TABLE IF NOT EXISTS monitors (
  monitor_id       TEXT PRIMARY KEY,   -- mon_ + 16 hex, minted by the server
  tenant_id        TEXT,
  key_label        TEXT NOT NULL,
  subject          TEXT NOT NULL,
  terms            TEXT NOT NULL DEFAULT '[]',  -- JSON array of question terms
  webhook_url      TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  last_fired_at    INTEGER NOT NULL DEFAULT 0,  -- zero: immediately due
  last_result      TEXT                          -- diagnostic, never load bearing
);

-- The scheduler's only scan: enabled monitors ordered by when they last ran.
CREATE INDEX IF NOT EXISTS monitors_due_idx ON monitors (enabled, last_fired_at);

/*
 * The spend ledger: every metered dollar, appended as it is charged.
 *
 * The quota module keeps its counters in memory, which is right for request
 * rates (a one minute window lost on restart is harmless) and wrong for
 * money: the daily vendor budget reset every time the free tier slept, so
 * "$2 per day" actually meant "$2 per uptime stretch". On boot the server
 * sums the recent window from here and seeds the in memory counters, so a
 * restart no longer refills anyone's budget. Append only; a charge is a fact
 * that happened.
 */
CREATE TABLE IF NOT EXISTS spend_ledger (
  id         INTEGER PRIMARY KEY,
  key_label  TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  spent_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS spend_ledger_at_idx ON spend_ledger (spent_at);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
