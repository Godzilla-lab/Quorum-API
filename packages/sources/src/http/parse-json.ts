/*
 * Parsing a response body that came from someone else's server.
 *
 * WHY THIS IS NOT `JSON.parse` IN A TRY BLOCK.
 *
 * Every adapter wrote the same four lines, and three of them had the same bug.
 * `JSON.parse('null')` is VALID JSON: it does not throw, the catch never runs,
 * and the very next property read crashes the run with "Cannot read properties
 * of null". Measured 2026-08-22 by feeding a literal `null` body to each
 * adapter: Hacker News, the Arctic Shift client and the Wayback availability
 * check all threw, and every one of them had a try/catch that looked correct.
 *
 * `JSON.parse('"a string"')` and `JSON.parse('7')` have the same shape of
 * problem, and `for (const x of "nope")` iterates the characters of a string
 * rather than failing, which is how a malformed field becomes silent garbage in
 * the corpus rather than a loud error.
 *
 * A vendor returning something unexpected must degrade a run, never crash it,
 * so this returns null and the caller reports and moves on.
 */

/* An object body, or null when the body was anything else. */
export function parseJsonObject<T>(body: string): T | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as T;
}

/* An array body, or null when the body was anything else. */
export function parseJsonArray<T>(body: string): T[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? (parsed as T[]) : null;
}

/*
 * A field that should be an array, from a body that is an object.
 *
 * Returns an empty array when the field is absent, which is a real and common
 * state, and also when it is present but not an array, which is drift. The
 * caller cannot tell those apart from the return value alone and should not
 * need to: neither one yields records.
 */
export function arrayField<T>(source: unknown, field: string): T[] {
  if (source === null || typeof source !== 'object') return [];
  const value = (source as Record<string, unknown>)[field];
  return Array.isArray(value) ? (value as T[]) : [];
}
