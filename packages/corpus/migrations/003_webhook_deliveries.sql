-- The webhook delivery queue.
--
-- WHY DELIVERIES ARE HELD IN THE DATABASE AT ALL.
--
-- The server's job queue is in memory, and the hosted tier sleeps. A delivery
-- held only in the process is a delivery lost on the next redeploy, which makes
-- a retry schedule decorative: the Standard Webhooks schedule this implements
-- runs out to roughly 75 hours, and nothing in this deployment stays up that
-- long without a restart. Durability is what makes the schedule true.
--
-- THE TENANT BOUNDARY MOVES HERE, and that is deliberate rather than
-- incidental. Before this migration `reports` was the only table carrying a
-- tenant_id, and 002_rls.sql says so in a comment. A row in this table holds a
-- customer's callback url and their rendered report, so it is customer work
-- product by any reading and belongs on the same side of the line. The RLS test
-- that asserted "reports is the only table carrying a tenant id" is extended to
-- assert that every table carrying one also has a policy, which is the property
-- that was actually worth guarding.
--
-- Mirrors the SQLite schema in src/schema.ts table for table and column for
-- column, as 001 does. BIGINT here, INTEGER there, unix seconds in both.

BEGIN;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  -- One report has one delivery, so the report id is the key rather than a
  -- surrogate. It is also the `webhook-id` header the receiver deduplicates on,
  -- which means a retry must carry the same value: it is the same message.
  report_id       TEXT PRIMARY KEY,
  tenant_id       TEXT,
  -- Selects the derived signing secret. Not a credential itself.
  key_label       TEXT NOT NULL,
  -- CREDENTIAL SHAPED. Receivers routinely carry a bearer token in the query
  -- string, so this column holds something closer to a secret than to a url.
  -- Stored because durability requires it, never written to a log.
  url             TEXT NOT NULL,
  -- The exact bytes signed and sent. Stored rather than re-rendered because
  -- after a restart there is nothing left in memory to render from, and because
  -- the bytes signed must be the bytes sent.
  payload         TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  -- OPERATOR ONLY, NEVER RETURNED TO AN API CALLER. The difference between a
  -- connection refused and a timeout reports whether an internal port is open,
  -- so echoing either back to the caller who chose the url turns delivery into
  -- a blind SSRF oracle. If a delivery status endpoint is ever added it returns
  -- a coarse enum and these two columns stay behind it.
  last_status     INTEGER,
  last_error      TEXT,
  created_at      BIGINT NOT NULL,
  delivered_at    BIGINT
);

-- The only query the delivery worker makes: pending rows that are due.
CREATE INDEX IF NOT EXISTS webhook_due_idx
  ON webhook_deliveries (status, next_attempt_at);

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- Same shape as reports_own in 002_rls.sql, and the same setting name, which is
-- part of the schema. current_setting is read with missing_ok so an unset
-- tenant yields NULL and matches nothing, which fails closed.
CREATE POLICY webhook_deliveries_own ON webhook_deliveries
  FOR ALL
  USING (tenant_id = current_setting('quorum.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('quorum.tenant_id', true));

-- The delivery worker drains every tenant's rows, so it cannot run under the
-- tenant policy above. It connects as the table owner, and Postgres exempts an
-- owner from RLS unless FORCE ROW LEVEL SECURITY is set, which is the same way
-- the server already reaches `reports`. The grant below exists so the worker
-- keeps working if it is ever moved off the owner role.
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_deliveries TO service_role;
CREATE POLICY webhook_deliveries_service ON webhook_deliveries
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
