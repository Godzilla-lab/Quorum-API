-- Monitors: standing watches that re-run a category on a schedule and send
-- the report, diff included, to a webhook.
--
-- WHY THIS TABLE EXISTS. A report answers the question once. The entire
-- post-GummySearch replacement market is alerting: people want to know when
-- the answer CHANGES. Everything a monitor needs already existed (the queue,
-- per-tenant prior reports, diffReports, signed webhook delivery); this table
-- is the standing instruction that composes them on a clock.
--
-- TENANT OWNED, like reports: a monitor is a customer's standing order, and
-- one customer must never see or fire another's.
--
-- Mirrors the SQLite schema in src/schema.ts table for table and column for
-- column. BIGINT here, INTEGER there, unix seconds in both.

BEGIN;

CREATE TABLE IF NOT EXISTS monitors (
  -- mon_ + 16 hex, minted by the server.
  monitor_id       TEXT PRIMARY KEY,
  tenant_id        TEXT,
  -- The key label that owns the monitor. Fires are submitted under it, so
  -- every fire pays the owner's quota and never anyone else's.
  key_label        TEXT NOT NULL,
  subject          TEXT NOT NULL,
  -- JSON array of question terms, exactly as a report request carries them.
  terms            TEXT NOT NULL DEFAULT '[]',
  webhook_url      TEXT NOT NULL,
  interval_seconds BIGINT NOT NULL,
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       BIGINT NOT NULL,
  -- Zero until the first fire, so a fresh monitor is immediately due.
  last_fired_at    BIGINT NOT NULL DEFAULT 0,
  -- The last submit's outcome, for GET /v1/monitors: a report id when the
  -- queue accepted, or a reason when it refused. Diagnostic, never load
  -- bearing.
  last_result      TEXT
);

-- The scheduler's only scan: enabled monitors ordered by when they last ran.
CREATE INDEX IF NOT EXISTS monitors_due_idx
  ON monitors (enabled, last_fired_at);

ALTER TABLE monitors ENABLE ROW LEVEL SECURITY;

-- Same shape as report_snapshots_own in 004. current_setting is read with
-- missing_ok so an unset tenant yields NULL and matches nothing: fails closed.
CREATE POLICY monitors_own ON monitors
  FOR ALL
  USING (tenant_id = current_setting('quorum.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('quorum.tenant_id', true));

-- The scheduler reads every tenant's monitors. Same service role rationale as
-- 004: the server connects as the table owner today, and the grant keeps this
-- working if it ever moves off the owner role.
GRANT SELECT, INSERT, UPDATE, DELETE ON monitors TO service_role;
CREATE POLICY monitors_service ON monitors
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
