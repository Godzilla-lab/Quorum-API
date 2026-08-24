-- The spend ledger: every metered dollar, appended as it is charged.
--
-- WHY MONEY MOVES TO THE DATABASE AND RATE COUNTERS DO NOT. The quota module
-- keeps its counters in memory, which is right for request rates: a one
-- minute window lost on a restart resets a limit early and never enforces one
-- that was not real. Money is different. The daily vendor budget reset every
-- time the free tier slept, so "$2 per day" actually meant "$2 per uptime
-- stretch", and a caller who timed requests around the sleep cycle had no
-- budget at all. On boot the server sums the recent window from this table
-- and seeds its in memory counters, so a restart no longer refills anyone.
--
-- APPEND ONLY. A charge is a fact that happened, like an ad observation.
-- Rows are pruned only once they are older than any window that could need
-- them.
--
-- NOT TENANT SCOPED, deliberately. key_label names the key that spent, but
-- the row is the OPERATOR's accounting against the operator's own vendor
-- balance, not customer work product, so it sits with docs and categories
-- rather than with reports. No caller facing endpoint reads this table.
--
-- Mirrors the SQLite schema in src/schema.ts. BIGINT here, INTEGER there,
-- unix seconds in both. DOUBLE PRECISION for dollars because the ledger
-- carries estimates of vendor charges, not invoices.

BEGIN;

CREATE TABLE IF NOT EXISTS spend_ledger (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key_label  TEXT NOT NULL,
  amount_usd DOUBLE PRECISION NOT NULL,
  spent_at   BIGINT NOT NULL
);

-- The only scans: the boot time window sum and pruning, both by time.
CREATE INDEX IF NOT EXISTS spend_ledger_at_idx ON spend_ledger (spent_at);

COMMIT;
