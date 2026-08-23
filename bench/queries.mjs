/*
 * The traffic vocabulary, shared by every harness in here.
 *
 * It lives in one file because `mixed.mjs` and `waves.mjs` were written a day
 * apart with their own copies, and the copies had already drifted: one had
 * dropped the hostile inputs entirely. A load harness that quietly stops
 * sending the dangerous half still prints a healthy looking table.
 *
 * THE QUERIES ARE COMBINATORIAL ON PURPOSE. A run of ten thousand requests
 * drawn from a list of twelve strings measures a warm cache. Drawn from a
 * product of four vocabularies it measures the FTS parser and the query
 * planner, which is where the defects have actually been.
 */

export const ATTR = [
  'sizing', 'comfort', 'durability', 'price', 'quality', 'smell', 'width',
  'arch support', 'toe box', 'sole', 'fit', 'weight', 'waterproof',
  'breathability', 'insole', 'laces', 'heel', 'cushioning', 'grip',
  'stitching', 'colour', 'return policy',
];

export const VERB = [
  'runs small', 'falls apart', 'holds up', 'worth it', 'too narrow',
  'wore out', 'true to size', 'wide feet', 'after 6 months', 'compared to',
];

export const BRAND = [
  'allbirds', 'vessi', 'on cloud', 'hoka', 'brooks', 'asics', 'nobull',
  'vivobarefoot', 'xero', 'altra',
];

export const QUESTION = ['is', 'are', 'do', 'does', 'how', 'why', 'what', 'anyone', 'best', 'worst'];

export const CATEGORIES = Array.from({ length: 20 }, (_, i) => `category ${i}`);

export const pick = (a) => a[Math.floor(Math.random() * a.length)];

/*
 * The ways people phrase one intent. A caller pasting a whole review, an agent
 * emitting two keywords, and somebody shouting in caps all have to work, and
 * the padded and mixed case forms exist because trimming and lowercasing are
 * the kind of thing that gets refactored out by accident.
 */
export function query() {
  switch (Math.floor(Math.random() * 9)) {
    case 0: return pick(ATTR);
    case 1: return `${pick(ATTR)} ${pick(ATTR)}`;
    case 2: return `${pick(BRAND)} ${pick(ATTR)}`;
    case 3: return `${pick(QUESTION)} ${pick(BRAND)} ${pick(VERB)}`;
    case 4: return `${pick(ATTR)} ${pick(VERB)} ${pick(BRAND)}`;
    case 5: return pick(ATTR).toUpperCase();
    case 6: return `  ${pick(ATTR)}   ${pick(VERB)}  `;
    case 7: return `${pick(BRAND)} vs ${pick(BRAND)} ${pick(ATTR)}`;
    default: return Array.from(
      { length: 3 + Math.floor(Math.random() * 8) },
      () => pick([...ATTR, ...VERB, ...BRAND]),
    ).join(' ');
  }
}

/*
 * Inputs that have to be ANSWERED rather than survived.
 *
 * Every one of these is a 200 or a 400. None may reach the engine as syntax and
 * none may throw. The NUL is not decoration: it returned HTTP 500 twelve times
 * out of twelve on 2026-08-22, because SQLite takes a NUL terminated string and
 * the FTS5 match text was truncated to its opening quote. One byte, from any
 * caller. It stays in this list forever.
 */
export const HOSTILE = [
  '"; DROP TABLE docs; --',
  "' OR 1=1 --",
  '*'.repeat(200),
  'NEAR("a" "b", 999999999)',
  String.fromCodePoint(0x1f45f).repeat(300),
  'x'.repeat(5000),
  '../../../etc/passwd',
  '{"$ne":null}',
  'AND OR NOT ( ) " ^ * :',
  `${'a'.repeat(100)}${'\n'.repeat(100)}`,
  'sizing" OR "a',
  'sizing OR (comfort AND',
  '"unclosed',
  'col:sizing',
  `${String.fromCharCode(0)}nul byte`,
  `${String.fromCharCode(0xd800)} lone surrogate`,
  'sizing*'.repeat(50),
  '('.repeat(21),
  '',
  '   ',
];

/* Bodies that are not the shape the route expects. A 400 is the only correct
 * answer to all of them, and a 500 to any of them is a defect. */
export const MALFORMED = [
  'not json', '{', '[]', 'null', '{"query":123}', '{"query":""}',
  '{"receiptIds":"nope"}', '{"receiptIds":[]}', '[1,2,3]', '"a string"',
];

/*
 * Real receipt ids, sampled from the corpus under test.
 *
 * Sampled rather than invented, because an invented id exercises the not found
 * path and nothing else, and the whole point of the resolve route is the hit.
 */
export async function sampleReceiptIds(corpusPath, count = 2000) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(corpusPath, { readOnly: true });
  const rows = db.prepare('SELECT receipt_id FROM docs ORDER BY RANDOM() LIMIT ?').all(count);
  db.close();
  if (!rows.length) throw new Error(`no records in ${corpusPath}. Run bench/seed.mjs first.`);
  return rows.map((r) => r.receipt_id);
}

/* A percentile out of an ALREADY SORTED array. Sorting inside would be quietly
 * quadratic across the five or six calls a report makes. */
export const percentile = (sorted, q) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
