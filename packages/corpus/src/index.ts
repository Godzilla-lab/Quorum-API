/*
 * @quorum/corpus
 *
 * The engine's memory. Everything read is written here once and reused forever,
 * which buys three things at the same time: speed (a warm category answers from
 * a local index in milliseconds instead of hundreds of throttled round trips),
 * cost (the second product in a category is nearly free to research), and
 * safety (an upstream going down stops being an outage, because we hold our own
 * copy of what we already read).
 *
 * For three sources it buys a fourth thing that matters more. Meta deletes
 * inactive commercial ads, and delisted products vanish from a Shopify
 * catalogue. For those, this is not a cache. It is the only copy that will ever
 * exist, and it exists only because something was recording on the day.
 */

export { FUTURE_TOLERANCE_SECONDS, MIN_CREATED_UTC, MIN_RECEIPTS, WARM_MAX_AGE_DAYS, WARM_MIN_DOCS, ageInDays, isUsableDate, isWarm } from './constants.ts';
export { isReceiptId, receiptId } from './receipt-id.ts';
export { PROMOTING_TIERS, SOURCE_TIER, TIER_LABEL, tierOf } from './tiers.ts';
export type { EvidenceTier } from './tiers.ts';
export { SCHEMA_VERSION, SQLITE_SCHEMA } from './schema.ts';
export { ftsQuery, openSqliteCorpus } from './drivers/sqlite.ts';
export type { SqliteCorpusOptions } from './drivers/sqlite.ts';
export { openPostgresCorpus } from './drivers/postgres.ts';
export type { PostgresCorpusOptions, SqlExecutor } from './drivers/postgres.ts';
export { extractTerms, toFts5Query, toTsQuery } from './terms.ts';
export { storableText } from './text.ts';
export { runConformanceSuite } from './conformance.ts';
export type { TestClock } from './conformance.ts';
export type { CorpusDriver } from './driver.ts';
export type * from './types.ts';
