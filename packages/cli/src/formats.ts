/*
 * Output formats other than the report.
 *
 * WHY THIS IS NOT A CONVENIENCE.
 *
 * The text report is written to be READ. Two other things consume this output
 * and neither of them reads:
 *
 *   AN AGENT wants the smallest number of tokens that still carries the
 *   receipts. Markdown measured elsewhere at roughly 60% of the tokens of the
 *   equivalent JSON, and token cost is the dominant cost in an agent loop, so
 *   the difference decides whether calling us is affordable inside one.
 *
 *   A WAREHOUSE wants rows. NDJSON and CSV are what every loader takes, and
 *   handing somebody a nested JSON document to flatten themselves is handing
 *   them the job.
 *
 * THE ROW IS ONE RECEIPT, WHICH IS THE ONLY HONEST UNIT.
 *
 * A row per claim would carry a count with the evidence collapsed out of it,
 * and the moment somebody groups by term in their own tool they get a number
 * that disagrees with ours. So the flat formats emit ONE ROW PER RECEIPT with
 * its claim's verdict attached, which regroups to exactly our counts because it
 * is the same set of ids the count was computed over.
 *
 * EVERY FORMAT CARRIES THE RECEIPT ID. No exceptions and no compact mode that
 * drops it, because a row that cannot be fetched back is the thing this product
 * exists to make impossible.
 */

import type { RunResult } from './run.ts';

export type OutputFormat = 'text' | 'json' | 'markdown' | 'ndjson' | 'csv';

export const OUTPUT_FORMATS: readonly OutputFormat[] = ['text', 'json', 'markdown', 'ndjson', 'csv'];

export const isOutputFormat = (value: string): value is OutputFormat =>
  (OUTPUT_FORMATS as readonly string[]).includes(value);

/*
 * RFC 4180. A field containing a quote, a comma, a carriage return or a newline
 * is wrapped, and an internal quote is doubled.
 *
 * This is not boilerplate here, it is the correctness of the format: our
 * excerpts are quotes from forums and they contain all four constantly. A
 * naive join produces a file that opens in a spreadsheet with the columns
 * silently shifted, which is worse than a file that fails to open.
 */
export function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

const csvRow = (cells: readonly (string | number | boolean | null | undefined)[]): string =>
  cells.map(csvField).join(',');

/*
 * The flat rows, shared by NDJSON and CSV so the two cannot drift.
 *
 * `kind` is first because a single stream carries more than one shape, and a
 * consumer has to be able to filter before it parses the rest.
 */
export interface FlatRow {
  kind: 'evidence' | 'claim' | 'theme' | 'trend' | 'attested';
  category: string;
  term: string;
  verdict: string;
  records: number;
  channels: number;
  receiptId: string;
  source: string;
  channel: string;
  tier: string;
  url: string;
  createdUtc: number;
  excerpt: string;
}

/*
 * EVERY ROW IS BUILT HERE, IN ONE FIXED KEY ORDER.
 *
 * Spreading a defaults object first put `kind` and `category` at the END of the
 * claim rows and at the start of the evidence rows, in the same stream. JSON
 * objects are unordered by the spec and every real consumer reads them in file
 * order anyway: a streaming parser filtering on `kind` had to buffer the whole
 * line for some rows and not others. Building each row explicitly costs one
 * function and removes the entire class of problem.
 */
function row(kind: FlatRow['kind'], category: string, over: Partial<FlatRow> = {}): FlatRow {
  return {
    kind,
    category,
    term: over.term ?? '',
    verdict: over.verdict ?? '',
    records: over.records ?? 0,
    channels: over.channels ?? 0,
    receiptId: over.receiptId ?? '',
    source: over.source ?? '',
    channel: over.channel ?? '',
    tier: over.tier ?? '',
    url: over.url ?? '',
    createdUtc: over.createdUtc ?? 0,
    excerpt: over.excerpt ?? '',
  };
}

export function flatRows(result: RunResult): FlatRow[] {
  const rows: FlatRow[] = [];
  const category = result.category;

  for (const claim of result.claims) {
    /* The claim itself, so a consumer that only wants the counts does not have
     * to derive them and risk deriving them differently. */
    rows.push(row('claim', category, {
      term: claim.term, verdict: claim.verdict,
      records: claim.records, channels: claim.channels,
    }));
    /* Then one row per receipt that was actually shown, carrying its claim's
     * verdict so the rows regroup to the counts above. */
    for (const e of claim.evidence) {
      rows.push(row('evidence', category, {
        term: claim.term, verdict: claim.verdict,
        records: claim.records, channels: claim.channels,
        receiptId: e.receiptId, source: e.source, channel: e.channel,
        tier: e.tier, url: e.url, createdUtc: e.createdUtc, excerpt: e.excerpt,
      }));
    }
  }

  for (const e of result.attested?.evidence ?? []) {
    rows.push(row('attested', category, {
      verdict: result.attested?.corroboration.verdict ?? '',
      records: result.attested?.records ?? 0,
      receiptId: e.receiptId, source: e.source, channel: e.channel,
      tier: e.tier, url: e.url, createdUtc: e.createdUtc, excerpt: e.excerpt,
    }));
  }

  for (const theme of result.themes) {
    rows.push(row('theme', category, {
      term: theme.phrase, verdict: theme.corroboration.verdict,
      records: theme.records, channels: theme.channels,
      receiptId: theme.receiptIds[0] ?? '',
    }));
  }

  for (const trend of result.trends) {
    rows.push(row('trend', category, {
      term: trend.term, verdict: trend.direction,
      records: trend.recent.records, channels: trend.recent.total,
      excerpt: trend.reason,
    }));
  }

  return rows;
}

export function renderNdjson(result: RunResult): string {
  return flatRows(result).map((r) => JSON.stringify(r)).join('\n');
}

const CSV_HEADER = [
  'kind', 'category', 'term', 'verdict', 'records', 'channels',
  'receipt_id', 'source', 'channel', 'tier', 'url', 'created_utc', 'excerpt',
] as const;

export function renderCsv(result: RunResult): string {
  const lines = [CSV_HEADER.join(',')];
  for (const r of flatRows(result)) {
    lines.push(csvRow([
      r.kind, r.category, r.term, r.verdict, r.records, r.channels,
      r.receiptId, r.source, r.channel, r.tier, r.url, r.createdUtc, r.excerpt,
    ]));
  }
  /* CRLF, because that is what RFC 4180 says and what Excel expects. Anything
   * reading this with a real csv parser does not care either way. */
  return lines.join('\r\n');
}

/*
 * UNTRUSTED TEXT, FLATTENED TO ONE LINE BEFORE IT REACHES A MARKDOWN DOCUMENT.
 *
 * MEASURED 2026-08-22 by feeding a hostile product title through the renderer.
 * A title is read out of markup on a page WE FETCHED, which makes it untrusted
 * input from the very party the report is about. Interpolated raw it does this:
 *
 *   title: "Wool Runner\n\n## Injected Heading\n\nBuy now"
 *   ->  # Wool Runner
 *       ## Injected Heading        <- our own section styling, their words
 *       Buy now
 *
 * A store could forge a heading that looks like one of ours. The text renderer
 * escapes through JSON.stringify and both flat formats quote or escape by
 * construction, so this was markdown only, and it was a hole.
 *
 * Collapsing whitespace is the structural fix: markdown block structure is
 * decided by line breaks, so text that cannot contain one cannot open a block.
 * Inline syntax that survives, a stray asterisk or backtick, is cosmetic and
 * changes no claim.
 */
const inline = (text: string): string => String(text).replace(/\s+/g, ' ').trim();

/*
 * Markdown, for an agent or for a human pasting into a document.
 *
 * Deliberately NOT the text report with hashes added. The text report has a
 * fixed width layout that exists so columns line up in a terminal, and every
 * one of those padded spaces is a token an agent pays for and a rendering
 * artefact in a document.
 */
export function renderMarkdown(result: RunResult): string {
  const out: string[] = [];
  const subject = inline(result.subject.title || result.category);

  out.push(`# ${subject}`);
  out.push('');
  if (result.asOf) {
    out.push(`**As of ${inline(result.asOf)}.** Every number below is the market as it stood at the end of that month.`);
    out.push('');
  }
  out.push(
    `${result.warmth.docs} records held, ${result.warmth.channels} channels, `
    + `${result.warmth.warm ? 'warm' : 'cold'}. `
    + `A claim needs ${result.claims[0]?.threshold ?? 3} independent receipts to be stated as a finding.`,
  );
  out.push('');

  if (result.diff) {
    const changes = result.diff.claims.filter((c) => c.promoted || c.demoted || c.recordsAdded > 0);
    if (changes.length || result.diff.newThemes.length) {
      out.push('## What changed');
      out.push('');
      for (const c of changes) {
        const what = c.promoted ? 'now a finding' : c.demoted ? 'no longer a finding' : `+${c.recordsAdded} records`;
        out.push(`- **${inline(c.term)}**: ${what} (${c.after.records} records)`);
      }
      if (result.diff.newThemes.length) out.push(`- New topics: ${result.diff.newThemes.map(inline).join(', ')}`);
      out.push('');
    }
  }

  const findings = result.claims.filter((c) => c.verdict === 'finding');
  const weak = result.claims.filter((c) => c.verdict !== 'finding');

  if (findings.length) {
    out.push('## Findings');
    out.push('');
    for (const claim of findings) {
      out.push(`### ${inline(claim.term)}`);
      out.push('');
      out.push(`${claim.records} independent receipts across ${claim.channels} channels.`);
      out.push('');
      for (const e of claim.evidence) {
        /* The quote, then where it came from and its id on the same line, so a
         * reader never has to hold an id in their head to check one. */
        out.push(`> ${inline(e.excerpt)}`);
        out.push('>');
        out.push(`> ${inline(e.source)} ${inline(e.channel)} \`${e.receiptId}\` ${inline(e.url)}`);
        out.push('');
      }
    }
  }

  if (weak.length) {
    out.push('## Weaker signals');
    out.push('');
    out.push('Real evidence, not enough of it. Never present these as market patterns.');
    out.push('');
    for (const claim of weak) {
      out.push(`- **${inline(claim.term)}**: ${claim.records} receipts across ${claim.channels} channels`);
    }
    out.push('');
  }

  if (result.attested) {
    out.push('## Attested');
    out.push('');
    out.push('A named party stated this to a regulator, on the record, with consequences for lying.');
    out.push('');
    for (const e of result.attested.evidence) {
      out.push(`> ${inline(e.excerpt)}`);
      out.push('>');
      out.push(`> ${inline(e.source)} ${inline(e.channel)} \`${e.receiptId}\``);
      out.push('');
    }
  }

  const moving = result.trends.filter((t) => t.direction === 'rising' || t.direction === 'fading' || t.direction === 'new');
  if (moving.length) {
    out.push('## Trends');
    out.push('');
    out.push('Share of what was said in each period, not how many records we hold.');
    out.push('');
    for (const t of moving) out.push(`- **${inline(t.term)}**: ${t.direction}. ${inline(t.reason)}`);
    out.push('');
  }

  if (result.themes.length) {
    out.push('## Topics nobody asked about');
    out.push('');
    out.push('Counted phrases, not claims about the product.');
    out.push('');
    for (const t of result.themes) out.push(`- ${inline(t.phrase)} (${t.records} records, ${t.channels} channels)`);
    out.push('');
  }

  const rc = result.receiptCheck;
  out.push('## Receipts');
  out.push('');
  out.push(`${rc.cited} cited, ${rc.resolved} resolved back to real records.`);
  if (rc.unresolved.length) {
    out.push('');
    out.push(`**${rc.unresolved.length} cited receipts did not resolve. Nothing above can be trusted.**`);
  }
  out.push('');
  out.push(`Cost $${result.cost.totalUsd.toFixed(4)}.`);

  return out.join('\n');
}
