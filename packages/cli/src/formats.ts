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
  kind: 'evidence' | 'claim' | 'theme' | 'trend' | 'attested' | 'comparison';
  category: string;
  /*
   * WHICH SIDE THE ROW IS ABOUT. The subject for every ordinary row, and the
   * rival for a comparison row. Here so a warehouse can union many runs and
   * group by product, which is the first thing anybody does with this.
   */
  subject: string;
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
  /*
   * The denominator behind `records`, so a share is derivable exactly rather
   * than shipped as a second number that can disagree with the first. On a
   * comparison row it is that side's own corpus, which is the only denominator
   * its count means anything against.
   */
  corpusRecords: number;
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
function row(kind: FlatRow['kind'], category: string, subject: string, over: Partial<FlatRow> = {}): FlatRow {
  return {
    kind,
    category: over.category ?? category,
    subject: over.subject ?? subject,
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
    corpusRecords: over.corpusRecords ?? 0,
  };
}

export function flatRows(result: RunResult): FlatRow[] {
  const rows: FlatRow[] = [];
  const category = result.category;
  const subject = result.subject.title || category;
  /* The same denominator the share of voice block used, so a share derived from
   * these rows equals the one the report printed. */
  const corpusRecords = result.voice[0]?.categoryRecords ?? result.warmth.docs;
  const line = (kind: FlatRow['kind'], over: Partial<FlatRow> = {}) =>
    row(kind, category, subject, { corpusRecords, ...over });

  for (const claim of result.claims) {
    /* The claim itself, so a consumer that only wants the counts does not have
     * to derive them and risk deriving them differently. */
    rows.push(line('claim', {
      term: claim.term, verdict: claim.verdict,
      records: claim.records, channels: claim.channels,
    }));
    /* Then one row per receipt that was actually shown, carrying its claim's
     * verdict so the rows regroup to the counts above. */
    for (const e of claim.evidence) {
      rows.push(line('evidence', {
        term: claim.term, verdict: claim.verdict,
        records: claim.records, channels: claim.channels,
        receiptId: e.receiptId, source: e.source, channel: e.channel,
        tier: e.tier, url: e.url, createdUtc: e.createdUtc, excerpt: e.excerpt,
      }));
    }
  }

  for (const e of result.attested?.evidence ?? []) {
    rows.push(line('attested', {
      verdict: result.attested?.corroboration.verdict ?? '',
      records: result.attested?.records ?? 0,
      receiptId: e.receiptId, source: e.source, channel: e.channel,
      tier: e.tier, url: e.url, createdUtc: e.createdUtc, excerpt: e.excerpt,
    }));
  }

  for (const theme of result.themes) {
    rows.push(line('theme', {
      term: theme.phrase, verdict: theme.corroboration.verdict,
      records: theme.records, channels: theme.channels,
      receiptId: theme.receiptIds[0] ?? '',
    }));
  }

  for (const trend of result.trends) {
    rows.push(line('trend', {
      term: trend.term, verdict: trend.direction,
      records: trend.recent.records, channels: trend.recent.total,
      excerpt: trend.reason,
    }));
  }

  /*
   * ONE ROW PER SIDE PER TERM, and the row carries that side's own corpus size
   * rather than the subject's. A consumer dividing a rival's count by the
   * subject's denominator would produce exactly the cross corpus number the
   * comparison refuses to print.
   *
   * `excerpt` carries the reason, including every reason we declined to call a
   * term, so a warehouse row is never a bare pair of numbers waiting to be
   * ranked.
   */
  for (const term of result.comparison?.terms ?? []) {
    for (const side of term.sides) {
      rows.push(line('comparison', {
        subject: side.subject,
        category: side.category,
        term: term.term,
        verdict: side.verdict,
        records: side.records,
        channels: side.channels,
        corpusRecords: side.corpusRecords,
        receiptId: side.sampleReceiptIds[0] ?? '',
        excerpt: term.louder === side.subject ? `louder here: ${term.reason}` : term.reason,
      }));
    }
  }

  return rows;
}

export function renderNdjson(result: RunResult): string {
  return flatRows(result).map((r) => JSON.stringify(r)).join('\n');
}

const CSV_HEADER = [
  'kind', 'category', 'subject', 'term', 'verdict', 'records', 'channels',
  'receipt_id', 'source', 'channel', 'tier', 'url', 'created_utc', 'excerpt',
  'corpus_records',
] as const;

export function renderCsv(result: RunResult): string {
  const lines = [CSV_HEADER.join(',')];
  for (const r of flatRows(result)) {
    lines.push(csvRow([
      r.kind, r.category, r.subject, r.term, r.verdict, r.records, r.channels,
      r.receiptId, r.source, r.channel, r.tier, r.url, r.createdUtc, r.excerpt,
      r.corpusRecords,
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

  /*
   * Versus what, as a table, because that is the one shape a person pastes into
   * a document and an agent reads without prose around it.
   *
   * SHARE IS THE FIRST COLUMN AND THE COUNT IS THE WORKING BESIDE IT. A reader
   * shown two counts side by side compares them whatever the caption says, and
   * across two corpora of different depths that comparison is about us.
   */
  if (result.comparison) {
    const c = result.comparison;
    out.push('## Versus');
    out.push('');
    out.push(
      'Each rival was retrieved as a corpus of its own, so no number here is two '
      + 'words appearing in one comment. Shares are compared, never counts.',
    );
    out.push('');

    for (const term of c.terms) {
      out.push(`### ${inline(term.term)}`);
      out.push('');
      out.push('| | share of its corpus | records | verdict | receipt |');
      out.push('| --- | --- | --- | --- | --- |');
      for (const side of term.sides) {
        const mark = term.louder === side.subject ? ' **louder**' : '';
        const share = side.corpusRecords ? `${side.sharePct.toFixed(1)}%` : 'n/a';
        out.push(
          `| ${inline(side.subject)}${mark} | ${share} | ${side.records} of ${side.corpusRecords} `
          + `| ${side.verdict} | ${side.sampleReceiptIds[0] ? `\`${side.sampleReceiptIds[0]}\`` : 'none'} |`,
        );
      }
      out.push('');
      out.push(term.louder ? inline(term.reason) : `No call: ${inline(term.reason)}`);
      out.push('');
    }

    if (c.thinSides.length) {
      out.push(
        `Too little held to compare at all: ${c.thinSides.map((t) => `${inline(t.subject)} (${t.corpusRecords} records)`).join(', ')}.`,
      );
      out.push('');
    }
    if (c.unavailable.length) {
      out.push(`Asked for and not retrieved: ${c.unavailable.map((u) => `${inline(u.subject)} (${inline(u.reason)})`).join(', ')}.`);
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
  out.push('## Quorum');
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
