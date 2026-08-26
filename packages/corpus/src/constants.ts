/*
 * Corpus thresholds, defined once.
 *
 * These numbers previously lived in two places: `lib/corpus.mjs` inlined them
 * into its `categoryStats` expression, and `lib/corpus-supabase.mjs` declared
 * WARM_MIN_DOCS and WARM_MAX_AGE_DAYS with the comment "matches corpus.mjs, so
 * warm/cold agrees everywhere".
 *
 * A comment is not a constraint. Two drivers that must agree about whether a
 * category is warm cannot agree by convention, because the moment one is edited
 * the CLI and the hosted path quietly produce different reports for the same
 * product. That is the exact failure the comment was worried about, left
 * unenforced. So they are exported from one module and imported by both.
 */

/*
 * Warm means two things at once: enough material to answer from, and recent
 * enough to trust. Both must hold. Carried over unchanged from the engine so
 * report parity is measurable; if these move, parity has to be re-established
 * rather than assumed.
 */
export const WARM_MIN_DOCS = 150;
export const WARM_MAX_AGE_DAYS = 14;

/*
 * How many independent receipts a claim needs before it is stated as a finding.
 *
 * This is the load bearing number in the entire product. Below it, a claim is
 * printed as a weak signal rather than a finding, and the threshold is enforced
 * at render time independently of whatever the model was told in its prompt.
 * Two loud comments are not a market pattern.
 */
export const MIN_RECEIPTS = 3;

/*
 * How many distinct channels a finding needs on top of the receipt count.
 *
 * The record count measures volume and the channel spread measures breadth,
 * and volume alone lied: the live corpus held a category with 532 records
 * from 2 channels, which is one long conversation, and a single subreddit
 * can put any number of records behind a claim without a second room ever
 * having heard of it. One channel is one room. Chris set this to 2 on
 * 2026-08-26 after an outside evaluation flagged the office chair category;
 * a claim below it prints as a weak signal with its basis preserved, so a
 * report can still show why it came close.
 */
export const MIN_CHANNELS_FOR_FINDING = 2;

const SECONDS_PER_DAY = 86400;

/*
 * Age of the most recent harvest, in days, or null when a category has never
 * been harvested. Null is a real state and not an error: it is what every
 * category looks like before the first run.
 */
export function ageInDays(lastHarvestedUnixSeconds: number | null | undefined, nowUnixSeconds: number): number | null {
  if (!lastHarvestedUnixSeconds) return null;
  return (nowUnixSeconds - lastHarvestedUnixSeconds) / SECONDS_PER_DAY;
}

/*
 * The warm/cold decision. Takes `now` rather than reading the clock so it can
 * be tested at a fixed instant, and so a driver can decide warmth against the
 * same timestamp it used for the rest of a query.
 */
export function isWarm(docs: number, ageDays: number | null): boolean {
  if (ageDays === null) return false;
  return docs >= WARM_MIN_DOCS && ageDays < WARM_MAX_AGE_DAYS;
}


/*
 * The earliest date a record may claim to have been written.
 *
 * 1990-01-01. Generous on purpose: SEC filings genuinely predate every forum we
 * read, so a floor set at the founding of Reddit would silently discard real
 * attested evidence. What it exists to catch is a zero, a null, and the
 * 1970-01-01 that a missing field becomes once it reaches a date function.
 */
export const MIN_CREATED_UTC = 631_152_000;

/*
 * A date after this many seconds in the future is not a date, it is a unit bug.
 * Measured hazard rather than theory: a source reporting milliseconds where we
 * expect seconds lands in the year 55000, and one record there invents a month
 * that then reads as a period when nobody said anything.
 *
 * A day of slack, because clocks disagree and a record posted moments ago in a
 * timezone we did not parse is real.
 */
export const FUTURE_TOLERANCE_SECONDS = 86_400;

/* Whether a record's own date can be believed. */
export function isUsableDate(createdUtc: number | null | undefined, nowUnixSeconds: number): boolean {
  if (!createdUtc) return false;
  return createdUtc >= MIN_CREATED_UTC && createdUtc <= nowUnixSeconds + FUTURE_TOLERANCE_SECONDS;
}
