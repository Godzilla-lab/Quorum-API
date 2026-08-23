-- Row level security, and the tenant boundary it enforces.
--
-- THE BOUNDARY, stated explicitly because getting it backwards is silently
-- fatal in either direction:
--
--   docs, categories, ad_observations, products   ARE GLOBAL.
--     Cross tenant warmth is the entire hosted product. A category one tenant
--     paid to harvest answers instantly for the next one, and that is the
--     business. Scoping these per tenant destroys it.
--
--     `products` belongs here and not below, which this comment got wrong until
--     2026-08-22. It is a cache of public product pages keyed by url. It has no
--     tenant_id column, so it cannot be tenant scoped, and the policies below
--     always shared it. A comment claiming otherwise is worse than no comment:
--     it invites someone either to "fix" the policy and break the shared cache,
--     or to write customer data here believing it is isolated. Nothing tenant
--     specific may be stored in this table, and there is a test that says so.
--
--   reports                            ARE TENANT OWNED.
--     Customer work product. Leaking them between tenants is a breach, and
--     `reports` is the only table in this schema that carries a tenant_id.
--
-- The engine's hosted corpus module ran every read and write through the
-- service role with RLS enabled and no policy attached, which means the
-- effective policy was "trust the caller". That is fine for a single tenant
-- background function and is not fine for a hosted API, so this replaces it.

BEGIN;

-- `service_role` is a Supabase provided role. On a stock PostgreSQL it does not
-- exist, and every GRANT below fails with 42704, taking the whole migration
-- with it. Measured 2026-08-22 against PostgreSQL 17.10: 001 applied cleanly
-- and 002 could not run at all, so self hosting was broken on the second
-- migration and nobody had found out because the SQL had never been executed.
--
-- Created here rather than documented as a prerequisite, so the policies below
-- mean the same thing on every provider. On Supabase the role already exists
-- and this is a no op, which is why it is guarded rather than unconditional.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;

ALTER TABLE docs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports         ENABLE ROW LEVEL SECURITY;
ALTER TABLE products        ENABLE ROW LEVEL SECURITY;

-- The corpus is readable by any authenticated caller. It is the shared asset.
CREATE POLICY docs_read_all ON docs
  FOR SELECT USING (true);
CREATE POLICY categories_read_all ON categories
  FOR SELECT USING (true);
CREATE POLICY ad_observations_read_all ON ad_observations
  FOR SELECT USING (true);

-- Writes to the shared corpus go through the service role only. A tenant must
-- not be able to poison a category that every other tenant then reads.
CREATE POLICY docs_write_service ON docs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY categories_write_service ON categories
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY ad_observations_write_service ON ad_observations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Tenant owned tables. current_setting is read with the missing_ok flag so an
-- unset tenant yields NULL and therefore matches nothing, which fails closed.
CREATE POLICY reports_own ON reports
  FOR ALL
  USING (tenant_id = current_setting('receipts.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('receipts.tenant_id', true));

CREATE POLICY products_read_all ON products
  FOR SELECT USING (true);
CREATE POLICY products_write_service ON products
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
