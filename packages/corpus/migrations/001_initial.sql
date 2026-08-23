-- Receipts corpus, initial schema.
--
-- Mirrors the SQLite schema table for table and column for column, which is why
-- the second driver is a driver rather than a rewrite. The two differences are
-- both forced by Postgres and are noted where they occur:
--
--   1. Full text search is a generated tsvector column plus a GIN index,
--      instead of an FTS5 virtual table with triggers.
--   2. Row level security exists here and has no SQLite equivalent.

BEGIN;

CREATE TABLE IF NOT EXISTS docs (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id    TEXT   NOT NULL,
  source        TEXT   NOT NULL,
  kind          TEXT   NOT NULL,
  external_id   TEXT   NOT NULL,
  category      TEXT   NOT NULL,
  channel       TEXT   NOT NULL DEFAULT '',
  text          TEXT   NOT NULL,
  score         INTEGER NOT NULL DEFAULT 0,
  url           TEXT   NOT NULL DEFAULT '',
  created_utc   BIGINT NOT NULL DEFAULT 0,
  harvested_at  BIGINT NOT NULL,
  embedding     BYTEA,
  -- Generated rather than trigger maintained, so it cannot drift from text.
  text_tsv      TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  UNIQUE (source, external_id, category)
);

-- receipt_id is deliberately NOT unique. The same utterance harvested under two
-- categories is two rows sharing one receipt id, because the id names the
-- human's words rather than the row. Corroboration dedupes by receipt id so one
-- person cannot be counted twice.
CREATE INDEX IF NOT EXISTS docs_receipt_idx  ON docs (receipt_id);
CREATE INDEX IF NOT EXISTS docs_category_idx ON docs (category, source, score DESC);
CREATE INDEX IF NOT EXISTS docs_harvest_idx  ON docs (category, harvested_at DESC);
CREATE INDEX IF NOT EXISTS docs_tsv_idx      ON docs USING GIN (text_tsv);

-- Ad observations: APPEND ONLY.
--
-- Deliberately carries no unique constraint beyond the surrogate key. Two rows
-- for one ad is the evidence that it is still running, not a duplicate. The
-- engine wrote ads into docs, which is unique on (source, external_id,
-- category), so every observation after the first was silently discarded and
-- the day count froze at first sight. Verified 2026-08-22.
CREATE TABLE IF NOT EXISTS ad_observations (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ad_id                TEXT    NOT NULL,
  advertiser           TEXT    NOT NULL DEFAULT '',
  category             TEXT    NOT NULL,
  body                 TEXT    NOT NULL DEFAULT '',
  cta                  TEXT    NOT NULL DEFAULT '',
  url                  TEXT    NOT NULL DEFAULT '',
  creative             TEXT,
  platforms            JSONB   NOT NULL DEFAULT '[]'::jsonb,
  start_date           BIGINT,
  end_date             BIGINT,
  is_active            BOOLEAN NOT NULL DEFAULT FALSE,
  days_running         INTEGER,
  duration_confidence  TEXT    NOT NULL DEFAULT 'none',
  observed_at          BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS ad_obs_ad_idx       ON ad_observations (ad_id, observed_at);
CREATE INDEX IF NOT EXISTS ad_obs_category_idx ON ad_observations (category, observed_at DESC);

CREATE TABLE IF NOT EXISTS categories (
  name           TEXT PRIMARY KEY,
  first_seen     BIGINT NOT NULL,
  last_harvested BIGINT NOT NULL,
  subreddits     JSONB NOT NULL DEFAULT '[]'::jsonb,
  queries        JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS reports (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     TEXT,
  product_url   TEXT NOT NULL,
  product_title TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL,
  markdown      TEXT NOT NULL,
  findings      JSONB NOT NULL DEFAULT '{}'::jsonb,
  cost_usd      NUMERIC(12,6) NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS reports_category_idx ON reports (category, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_tenant_idx   ON reports (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS products (
  url        TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  category   TEXT NOT NULL DEFAULT '',
  facts      JSONB NOT NULL,
  source     TEXT NOT NULL DEFAULT '',
  fetched_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO schema_meta (key, value) VALUES ('version', '1')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

COMMIT;
