-- Facets: labels a source itself attached to a record, kept beside the text
-- rather than inside it.
--
-- WHY A COLUMN AND NOT THE TEXT. The first source to need this is the CFPB
-- complaint database, 2026-09-13. Every complaint carries the Bureau's own
-- classification: the product, the issue, how the company closed it and
-- whether it answered on time. Those are facts a report can count, and each
-- count can cite its receipts. But the record's text must stay the consumer's
-- words alone: a label written into the narrative would put our words in their
-- mouth, and a label written into the channel would break corroboration, which
-- counts channels as independent voices.
--
-- GENERIC ON PURPOSE. A json object of string labels, null for every source
-- that has none, which today is all but one. A CFPB shaped set of columns
-- would be the second thing to regret; the first would be the text.
--
-- Nullable and additive: no existing row changes, no index, receipt ids are
-- unaffected because they are minted from the text. Mirrors the SQLite schema
-- in src/schema.ts, where the same column is TEXT holding json.

BEGIN;

ALTER TABLE docs ADD COLUMN IF NOT EXISTS facets JSONB;

COMMIT;
