/*
 * Query term extraction, shared by every driver.
 *
 * This exists because the two drivers would otherwise silently disagree about
 * what a search means, and conformance would pass on shape while failing on
 * results.
 *
 * The engine's hosted module used `websearch_to_tsquery`, noting correctly that
 * it takes plain phrasing and cannot throw on stray punctuation. But it ANDs its
 * terms, while the SQLite path ORs them. Given the same query, Postgres would
 * have returned a small fraction of the rows SQLite returned, and the CLI and
 * the hosted API would quietly produce different reports for the same product.
 *
 * OR is the correct semantic here, and it is not a matter of taste. Measured
 * against the archive on 2026-08-13: a four word phrase returned zero hits
 * where a single word from it returned plenty. Narrow AND queries go empty
 * fast, and recall is what a corroboration count needs.
 *
 * AND FIRST, THEN OR, since 2026-08-24. The recall argument above is real and
 * so is its cost: a search for "battery life" OR-matched every record that
 * merely said "life", and the corroboration line counted them. So both
 * drivers now try the AND form first and fall back to OR only when AND finds
 * nothing. When records exist that carry every word, they are the answer;
 * when none do, the measured recall behaviour is exactly what it always was.
 * The fallback lives in the drivers, and conformance asserts they agree.
 */

/*
 * Words of two characters or fewer are dropped. They are almost always stop
 * words, and OR-ing them in blows up the result set without adding signal.
 */
const MIN_TERM_LENGTH = 3;

export function extractTerms(raw: string): string[] {
  return String(raw)
    .toLowerCase()
    /*
     * Strip anything that is query syntax in either engine. FTS5 treats
     * quotes, carets, asterisks, parentheses and colons as operators;
     * to_tsquery adds ampersand, pipe, bang and angle brackets. Removing the
     * union of both keeps one term list valid for both drivers.
     */
    .replace(/["^*():&|!<>~'\\-]/g, ' ')
    /*
     * CONTROL CHARACTERS, AND A NUL IS A CRASH RATHER THAN A CURIOSITY.
     *
     * MEASURED 2026-08-22 during a 10,000 request load run: a query of
     * "\0nul byte" returned HTTP 500 twelve times out of twelve. SQLite's C
     * API takes a NUL terminated string, so the match text it actually parsed
     * was the single opening quote of the first term and it failed with
     * "unterminated string". One byte from any caller, and the endpoint throws.
     *
     * Postgres refuses a NUL in text outright, so this is not an FTS5 quirk
     * that the other driver happens to survive. Stripping here rather than in
     * either driver is what keeps the two agreeing about what a search means.
     */
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= MIN_TERM_LENGTH);
}

/* FTS5: each term quoted, OR-ed. Null when nothing survives extraction. */
export function toFts5Query(raw: string): string | null {
  const terms = extractTerms(raw);
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"`).join(' OR ');
}

/*
 * Postgres: terms OR-ed for to_tsquery. Terms are already stripped of every
 * character to_tsquery treats as an operator, so this cannot produce a syntax
 * error and does not need a further escape pass.
 */
export function toTsQuery(raw: string): string | null {
  const terms = extractTerms(raw);
  if (!terms.length) return null;
  return terms.join(' | ');
}

/*
 * The AND forms, tried before the OR forms above. Null for a single term
 * query, where strict and loose are the same search and running it twice
 * would be a wasted round trip.
 */
export function toFts5QueryStrict(raw: string): string | null {
  const terms = extractTerms(raw);
  if (terms.length < 2) return null;
  return terms.map((t) => `"${t}"`).join(' AND ');
}

export function toTsQueryStrict(raw: string): string | null {
  const terms = extractTerms(raw);
  if (terms.length < 2) return null;
  return terms.join(' & ');
}

/*
 * The FTS5 phrase form: every word, in order, inside one quoted phrase. A
 * phrase either occurs or it does not, so short words are KEPT here rather
 * than dropped: "out of stock" quoted without its "of" is a different phrase.
 * The postgres side needs no builder because the driver hands the raw text to
 * phraseto_tsquery, whose own parser cannot be broken by punctuation. The two
 * engines differ on stop words by construction: FTS5's porter tokenizer
 * indexes every word, while the english tsquery config drops stop words and
 * keeps positions, so a phrase made only of stop words matches nothing on one
 * and everything-adjacent on the other. Conformance pins the behaviour both
 * drivers share; the spec says not to build phrases out of stop words.
 */
export function toFts5Phrase(raw: string): string | null {
  const words = String(raw)
    .toLowerCase()
    .replace(/["^*():&|!<>~'\\-]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (!words.length) return null;
  return `"${words.join(' ')}"`;
}
