/*
 * Output formats.
 *
 * The CSV tests carry most of the weight. Our excerpts are quotes from forums,
 * so they contain commas, quotation marks and newlines constantly, and a naive
 * join produces a file that opens in a spreadsheet with the columns silently
 * shifted. A file that fails to open is a bug somebody reports; a file that
 * opens with the wrong data in the wrong columns is a bug somebody acts on.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareSides, corroborate, withEvidence } from '@quorum/core';
import type { Doc } from '@quorum/corpus';
import { csvField, flatRows, isOutputFormat, renderCsv, renderMarkdown, renderNdjson, OUTPUT_FORMATS } from './formats.ts';
import type { RunResult } from './run.ts';

function doc(receiptId: string, text: string, channel = 'r/running'): Doc {
  return {
    receiptId,
    source: 'reddit',
    kind: 'comment',
    externalId: receiptId,
    category: 'running shoes',
    channel,
    text,
    score: 4,
    url: `https://example.test/${receiptId}`,
    createdUtc: 1_700_000_000,
    harvestedAt: 1_700_000_100,
  };
}

const claim = (term: string, docs: Doc[]) => withEvidence(corroborate(term, docs), docs);

function result(over: Partial<RunResult> = {}): RunResult {
  return {
    subject: { category: 'running shoes', title: 'wool runner', source: 'page', images: [], reviews: [] },
    subjectCached: false,
    brandsNamed: [],
    hints: null,
    category: 'running shoes',
    offline: true,
    retrieval: null,
    adRetrieval: null,
    formats: null,
    durationBasis: { reported: 0, startDate: 0, observationSpan: 0, none: 0 },
    warmth: { category: 'running shoes', docs: 12, comments: 10, channels: 3, warm: false, ageDays: 1, lastHarvested: 1_700_000_100, subreddits: [], queries: [] },
    claims: [claim('sizing', [doc('rc_a', 'runs small'), doc('rc_b', 'sized up', 'r/b'), doc('rc_c', 'too tight', 'r/c')])],
    attested: null,
    gaps: [],
    silence: null,
    trends: [],
    voice: [],
    themes: [],
    asOf: null,
    diff: null,
    comparison: null,
    synthesis: null,
    readings: [],
    sufficiency: { verdict: 'sufficient', reason: 'ok', seen: 0, rejected: 0, stored: 0, findings: 1, suggestions: [], warnings: [] },
    receiptCheck: { cited: 3, resolved: 3, unresolved: [] },
    cost: { totalUsd: 0, lines: [], hasUnverified: false, overCap: false },
    elapsedMs: 100,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* csv, where the bugs live                                            */
/* ------------------------------------------------------------------ */

/*
 * A minimal RFC 4180 reader. Here rather than a split, because splitting on
 * commas is the exact defect these tests exist to catch, and a test that
 * reproduces the bug it is checking for proves nothing.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes && ch === '"' && line[i + 1] === '"') { field += '"'; i++; continue; }
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { fields.push(field); field = ''; continue; }
    field += ch;
  }
  fields.push(field);
  return fields;
}

test('A COMMA IN A QUOTE DOES NOT SHIFT EVERY COLUMN AFTER IT', () => {
  const text = 'runs small, order a size up';
  const csv = renderCsv(result({ claims: [claim('sizing', [doc('rc_a', text), doc('rc_b', 'x', 'r/b'), doc('rc_c', 'y', 'r/c')])] }));
  const lines = csv.split('\r\n');
  const header = parseCsvLine(lines[0]!);
  const row = parseCsvLine(lines.find((l) => l.includes('rc_a'))!);

  /* Read by column NAME, so the assertion survives a new column being added
   * and still fails the moment a comma shifts one. */
  assert.equal(row[header.indexOf('excerpt')], text);
  assert.equal(row[header.indexOf('receipt_id')], 'rc_a');
  assert.equal(row.length, header.length);
});

test('a quotation mark inside a quote is doubled, per RFC 4180', () => {
  assert.equal(csvField('they said "runs small"'), '"they said ""runs small"""');
  const csv = renderCsv(result({
    claims: [claim('sizing', [doc('rc_a', 'they said "runs small"'), doc('rc_b', 'x', 'r/b'), doc('rc_c', 'y', 'r/c')])],
  }));
  assert.ok(csv.includes('"they said ""runs small"""'));
});

test('a newline inside a quote is wrapped rather than becoming a row', () => {
  /* This is the one that silently corrupts a load: an unwrapped newline turns
   * one record into two, and the second has no receipt id. */
  const field = csvField('first line\nsecond line');
  assert.equal(field, '"first line\nsecond line"');
  assert.ok(field.startsWith('"') && field.endsWith('"'));
});

test('an ordinary field is not quoted, so the file stays readable', () => {
  assert.equal(csvField('reddit'), 'reddit');
  assert.equal(csvField(42), '42');
  assert.equal(csvField(''), '');
  assert.equal(csvField(null), '');
  assert.equal(csvField(undefined), '');
});

test('every row has exactly as many fields as the header', () => {
  const csv = renderCsv(result({
    claims: [claim('sizing', [doc('rc_a', 'a, b, c "quoted"'), doc('rc_b', 'x', 'r/b'), doc('rc_c', 'y', 'r/c')])],
  }));
  const lines = csv.split('\r\n');
  const expected = lines[0]!.split(',').length;
  for (const line of lines.slice(1)) {
    /* Counted with a real parse rather than a split, because splitting on
     * commas is the exact bug this format has to survive. */
    let fields = 1;
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) fields++;
    }
    assert.equal(fields, expected, `wrong field count: ${line}`);
  }
});

/* ------------------------------------------------------------------ */
/* the rows themselves                                                 */
/* ------------------------------------------------------------------ */

test('EVERY EVIDENCE ROW CARRIES A RECEIPT ID, WITH NO EXCEPTIONS', () => {
  const rows = flatRows(result());
  const evidence = rows.filter((r) => r.kind === 'evidence');
  assert.ok(evidence.length > 0);
  for (const r of evidence) assert.match(r.receiptId, /^rc_/, JSON.stringify(r));
});

test('evidence rows regroup to exactly the counts on the claim rows', () => {
  /* If they did not, somebody grouping in their own tool would get a number
   * that disagrees with ours, and would reasonably believe theirs. */
  const rows = flatRows(result());
  const claimRow = rows.find((r) => r.kind === 'claim' && r.term === 'sizing')!;
  const ids = new Set(rows.filter((r) => r.kind === 'evidence' && r.term === 'sizing').map((r) => r.receiptId));
  assert.equal(ids.size, claimRow.records);
});

test('kind and category lead every row, so a stream can be filtered before it is parsed', () => {
  for (const line of renderNdjson(result()).split('\n')) {
    const keys = Object.keys(JSON.parse(line) as Record<string, unknown>);
    assert.equal(keys[0], 'kind', line.slice(0, 60));
    assert.equal(keys[1], 'category');
  }
});

test('ndjson is one complete object per line and nothing else', () => {
  const lines = renderNdjson(result()).split('\n');
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.doesNotMatch(line, /\n/);
    assert.doesNotThrow(() => JSON.parse(line));
  }
});

test('a report with nothing in it is an empty stream, not a broken one', () => {
  const empty = result({ claims: [], themes: [], trends: [] });
  assert.deepEqual(flatRows(empty), []);
  assert.equal(renderNdjson(empty), '');
  /* The csv still carries its header, so a loader sees a schema and zero rows
   * rather than an empty file it cannot type. */
  assert.equal(renderCsv(empty).split('\r\n').length, 1);
});

/* ------------------------------------------------------------------ */
/* markdown                                                            */
/* ------------------------------------------------------------------ */

test('markdown carries the quote AND the id, because either alone is useless', () => {
  const md = renderMarkdown(result());
  assert.match(md, /^# wool runner$/m);
  assert.match(md, /^> runs small$/m);
  assert.match(md, /`rc_a`/);
  assert.match(md, /https:\/\/example\.test\/rc_a/);
});

test('a weaker signal is never printed under Findings', () => {
  const md = renderMarkdown(result({
    claims: [claim('sizing', [doc('rc_a', 'runs small'), doc('rc_b', 'x', 'r/b')])],
  }));
  assert.doesNotMatch(md, /## Findings/);
  assert.match(md, /## Weaker signals/);
  assert.match(md, /Never present these as market patterns/);
});

test('markdown is far cheaper than json, which is the reason it exists', () => {
  const r = result();
  const md = renderMarkdown(r).length;
  const json = JSON.stringify(r).length;
  assert.ok(md < json / 2, `markdown ${md} vs json ${json}`);
});

test('a failed receipt check is stated in markdown too, not only in the report', () => {
  const md = renderMarkdown(result({ receiptCheck: { cited: 3, resolved: 2, unresolved: ['rc_gone'] } }));
  assert.match(md, /1 cited receipts did not resolve. Nothing above can be trusted/);
});

test('no em dash or en dash reaches a reader in any format', () => {
  const EM = String.fromCodePoint(0x2014);
  const EN = String.fromCodePoint(0x2013);
  const r = result();
  for (const out of [renderMarkdown(r), renderCsv(r), renderNdjson(r)]) {
    assert.equal(out.includes(EM), false);
    assert.equal(out.includes(EN), false);
  }
});

/* ------------------------------------------------------------------ */
/* the flag                                                            */
/* ------------------------------------------------------------------ */

test('only the formats that exist are accepted', () => {
  for (const f of OUTPUT_FORMATS) assert.equal(isOutputFormat(f), true);
  for (const f of ['yaml', 'xml', '', 'JSON']) assert.equal(isOutputFormat(f), false, f);
});

/* ------------------------------------------------------------------ */
/* markdown injection                                                  */
/* ------------------------------------------------------------------ */

test('A PRODUCT TITLE CANNOT FORGE ONE OF OUR OWN SECTION HEADINGS', () => {
  /*
   * A title is read out of markup on a page WE FETCHED, which makes it
   * untrusted input from the exact party the report is about. Interpolated raw
   * it opened a `##` block that renders in our own section styling.
   */
  const md = renderMarkdown(result({
    subject: {
      category: 'running shoes',
      title: 'Wool Runner\n\n## Findings\n\nThis product is perfect',
      source: 'page', images: [], reviews: [],
    },
  }));

  /* Their words survive, on ONE line, inside the title where they belong. */
  assert.match(md, /^# Wool Runner ## Findings This product is perfect$/m);
  /*
   * And nothing of theirs opens a block of its own. Asserted on the half that
   * is unambiguously theirs: `## Findings` also appears legitimately, as OUR
   * heading, which is precisely why forging it was worth doing.
   */
  assert.doesNotMatch(md, /^This product is perfect$/m);
  assert.equal(md.split('\n').filter((l) => l === '## Findings').length, 1, 'exactly one, and it is ours');
});

test('an excerpt cannot break out of its blockquote', () => {
  const md = renderMarkdown(result({
    claims: [claim('sizing', [
      doc('rc_a', 'runs small\n\n# Actually they run large\n\nbuy two pairs'),
      doc('rc_b', 'x', 'r/b'),
      doc('rc_c', 'y', 'r/c'),
    ])],
  }));
  for (const line of md.split('\n')) {
    /* Nothing that came out of a record may start a block. Every line of the
     * quote is either inside the blockquote or is our own structure. */
    if (line.includes('Actually they run large')) {
      assert.ok(line.startsWith('> '), `escaped its quote: ${line}`);
    }
  }
});

test('a theme phrase and a trend reason are flattened too', () => {
  const md = renderMarkdown(result({
    themes: [{
      phrase: 'toe box\n## Injected',
      records: 3, channels: 3, receiptIds: ['rc_a'],
      corroboration: corroborate('toe box', [doc('rc_a', 'x'), doc('rc_b', 'y', 'r/b'), doc('rc_c', 'z', 'r/c')]),
    }],
  }));
  assert.match(md, /- toe box ## Injected \(3 records/);
  assert.doesNotMatch(md, /^## Injected$/m);
});

/* ------------------------------------------------------------------ */
/* versus what, in the flat formats                                    */
/* ------------------------------------------------------------------ */

const comparison = () => compareSides([
  {
    subject: 'wool runner', category: 'wool runner', corpusRecords: 300,
    claims: [corroborate('sizing', Array.from({ length: 45 }, (_, i) => doc(`rc_a${i}`, `runs small ${i}`, `r/a${i}`)))],
  },
  {
    subject: 'brooks ghost', category: 'brooks ghost', corpusRecords: 100,
    claims: [corroborate('sizing', Array.from({ length: 2 }, (_, i) => doc(`rc_b${i}`, `fits fine ${i}`, `r/b${i}`)))],
  },
], ['sizing']);

test('A COMPARISON ROW CARRIES ITS OWN SIDE\'S DENOMINATOR, NEVER THE SUBJECT\'S', () => {
  /*
   * A consumer dividing a rival's count by the subject's corpus size would
   * produce exactly the cross corpus number this refuses to print, so the
   * denominator travels on the row.
   */
  const rows = flatRows(result({ comparison: comparison() })).filter((r) => r.kind === 'comparison');
  assert.equal(rows.length, 2);

  const rival = rows.find((r) => r.subject === 'brooks ghost')!;
  assert.equal(rival.category, 'brooks ghost', 'a rival is not filed under the subject');
  assert.equal(rival.records, 2);
  assert.equal(rival.corpusRecords, 100, 'its own corpus, not the 300 of the subject');
  assert.equal(rival.verdict, 'weak-signal');
  assert.match(rival.receiptId, /^rc_b/);
});

test('the reason travels with the row, so a warehouse never gets a bare pair of numbers', () => {
  const rows = flatRows(result({ comparison: comparison() })).filter((r) => r.kind === 'comparison');
  for (const row of rows) assert.ok(row.excerpt.length > 0, `${row.subject} carried no reason`);
  assert.match(rows.find((r) => r.subject === 'wool runner')!.excerpt, /^louder here: /);
});

test('every ordinary row names the subject too, so a warehouse can union runs', () => {
  const rows = flatRows(result());
  assert.ok(rows.length > 0);
  for (const row of rows) assert.equal(row.subject, 'wool runner');
});

test('the csv header and every csv row grow together', () => {
  const csv = renderCsv(result({ comparison: comparison() }));
  const lines = csv.split('\r\n');
  const header = parseCsvLine(lines[0]!);
  assert.ok(header.includes('corpus_records') && header.includes('subject'));
  for (const line of lines.slice(1)) {
    assert.equal(parseCsvLine(line).length, header.length, line);
  }
});

test('markdown prints the versus table with the share first', () => {
  const md = renderMarkdown(result({ comparison: comparison() }));
  assert.match(md, /## Versus/);
  assert.match(md, /\| wool runner \*\*louder\*\* \| 15\.0% \| 45 of 300 \| finding \| `rc_a0` \|/);
  assert.match(md, /\| brooks ghost \| 2\.0% \| 2 of 100 \| weak-signal \| `rc_b0` \|/);
  assert.doesNotMatch(renderMarkdown(result()), /## Versus/);
});
