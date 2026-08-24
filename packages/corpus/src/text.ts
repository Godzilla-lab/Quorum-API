/*
 * Text that is safe to STORE, shared by every driver.
 *
 * This is the write path twin of `extractTerms` in terms.ts, and it exists for
 * the same reason: a rule enforced in one driver and not the other is a rule
 * the two disagree about, and the disagreement only shows up in production.
 *
 * MEASURED 2026-08-22. A record whose text carried a NUL threw on write:
 *
 *   Provided value cannot be bound to SQLite parameter 5
 *
 * `addDocs` wraps a batch in a transaction and rolls back, so ONE poisoned
 * record discarded every good record beside it. Postgres refuses a NUL in a
 * text column outright, so this was never a SQLite quirk the other driver
 * happened to survive.
 *
 * It is reachable from upstream rather than only from a caller: JSON encodes a
 * NUL as \\u0000 perfectly legally, so any source parsing JSON can hand us one.
 * A record we cannot store is a record that is gone, and a batch we cannot
 * store is a harvest that has to be paid for again.
 *
 * ONLY THE NUL IS REMOVED. A newline and a tab are CONTENT here, not noise: a
 * forum comment has paragraphs, and flattening them would damage the evidence
 * on its way into the only copy of it that will exist. The query path collapses
 * whitespace because a query is not evidence; this path must not.
 *
 * It becomes a SPACE rather than nothing, so it cannot weld the words either
 * side of it into one that nobody wrote.
 */
export const storableText = (value: string): string => value.replace(/\u0000/g, ' ');

/*
 * The one spelling of a category, shared by every driver on both the write
 * and the read path.
 *
 * MEASURED LIVE 2026-08-24 by an outside tester: "running shoes" answered
 * with 2,452 records while "Running Shoes" and "running shoe" answered with
 * the cold run message, which is indistinguishable from the category not
 * existing and invites a caller to pay minutes of throttled harvesting for
 * data already held. Case and stray whitespace are not category identity.
 *
 * Case folding and whitespace only. Plural folding is deliberately absent:
 * a stemmer that merges "glass" and "glasses" invents equivalences nobody
 * asked for, and the category listing endpoint is the honest answer to a
 * near miss.
 */
export const normaliseCategory = (value: string): string =>
  value.toLowerCase().replace(/\s+/g, ' ').trim();
