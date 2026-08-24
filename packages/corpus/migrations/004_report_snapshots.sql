-- Report snapshots: the exact bytes GET /v1/reports/{id} served.
--
-- WHY THIS TABLE EXISTS. The server's job queue is in memory and the hosted
-- tier sleeps, so a finished report 404ed on the restart after it completed.
-- The identical payload was already durably stored in webhook_deliveries, but
-- only for callers who asked for a webhook, and nothing ever read it back.
-- This table stores the payload for every report, keyed by the API's report
-- id, so the GET handler can fall back to it when the queue no longer holds
-- the report.
--
-- The payload is stored rather than re-rendered for the reason 003 gives:
-- after a restart there is nothing left to render from, and the bytes a
-- caller fetches later must be the bytes the report actually said.
--
-- TENANT OWNED, like reports and webhook_deliveries: a snapshot is customer
-- work product.
--
-- Mirrors the SQLite schema in src/schema.ts table for table and column for
-- column. BIGINT here, INTEGER there, unix seconds in both.

BEGIN;

CREATE TABLE IF NOT EXISTS report_snapshots (
  -- The API's report id (rep_ + 16 hex), which is what a caller GETs by.
  report_id  TEXT PRIMARY KEY,
  tenant_id  TEXT,
  category   TEXT NOT NULL,
  -- The terminal status: complete | failed | cancelled.
  status     TEXT NOT NULL,
  -- The exact bytes GET served, two space indentation included.
  payload    TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

-- The only scan besides the primary key: pruning by age.
CREATE INDEX IF NOT EXISTS report_snapshots_prune_idx
  ON report_snapshots (created_at);

ALTER TABLE report_snapshots ENABLE ROW LEVEL SECURITY;

-- Same shape as reports_own in 002_rls.sql and webhook_deliveries_own in 003.
-- current_setting is read with missing_ok so an unset tenant yields NULL and
-- matches nothing, which fails closed.
CREATE POLICY report_snapshots_own ON report_snapshots
  FOR ALL
  USING (tenant_id = current_setting('quorum.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('quorum.tenant_id', true));

-- The server reads and prunes every tenant's snapshots. It connects as the
-- table owner, whom Postgres exempts from RLS unless FORCE ROW LEVEL SECURITY
-- is set; the grant exists so this keeps working if it is ever moved off the
-- owner role. 002 creates service_role when it does not exist.
GRANT SELECT, INSERT, UPDATE, DELETE ON report_snapshots TO service_role;
CREATE POLICY report_snapshots_service ON report_snapshots
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
