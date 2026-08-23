/*
 * SEC EDGAR full text search, plus the filing itself.
 *
 * WHY THIS SOURCE COSTS TWO REQUESTS AND IS WORTH IT.
 *
 * EDGAR's full text search is free and keyless and returns 126 filings for a
 * phrase like "running shoes". It returns METADATA ONLY: company, form type,
 * dates, accession number. There is no snippet and no highlight field.
 *
 * The first version of this adapter was going to stop there and write a record
 * saying "Saucony Inc filed a 10-K that mentions running shoes". That sentence
 * is true and it is OURS, and this renderer prints record text inside quotation
 * marks. Publishing our own summary as a quotation is manufacturing evidence,
 * which is the one thing this product exists to make impossible.
 *
 * So the filing is fetched and the passage around the phrase is extracted. The
 * record then carries the filer's own words. MEASURED 2026-08-22: a 195KB 10-K
 * fetched in 1.1 seconds and yielded three real passages describing the market
 * the company operates in.
 *
 * WHY A FILING OUTRANKS ALMOST ANYTHING ELSE IN THE CORPUS.
 *
 * A 10-K is signed by named officers under penalty of perjury and reviewed by
 * counsel before filing. When a public company describes its market, its
 * competitors or its risks, that is tier A attested evidence about an industry,
 * which no forum can produce at any volume.
 *
 * ONE RECORD PER FILING, NOT ONE PER OCCURRENCE.
 *
 * A 10-K mentioning a phrase three times is one document by one filer, not
 * three independent observations. Yielding three records would inflate the
 * receipt count with one company's repetition, which is exactly the failure the
 * channel exists to prevent, so only the most substantive passage is taken.
 *
 * A CONTACT EMAIL IS REQUIRED, AND ITS ABSENCE DEGRADES RATHER THAN FAILS.
 *
 * The SEC requires a User-Agent naming who is calling and how to reach them,
 * and returns 403 without one. That is a reasonable request from a public
 * archive, so this source reports itself unconfigured until
 * `RECEIPTS_CONTACT_EMAIL` is set, exactly like a missing API key.
 */

import type { Citation, Ctx, Env, PlanInput, Query, Source, SourceRecord } from '../source.ts';
import { safeFetch } from '../http/safe-fetch.ts';
import { createThrottle, type Throttle } from '../throttle.ts';
import { parseJsonObject } from '../http/parse-json.ts';

const SEARCH = 'https://efts.sec.gov/LATEST/search-index';

/*
 * Annual and quarterly reports and registration statements. These are the forms
 * where a company describes its market in prose rather than filing a number.
 */
export const DEFAULT_FORMS = ['10-K', '10-Q', 'S-1'] as const;

/* The SEC asks for no more than ten requests a second. This sits well under. */
const MIN_GAP_MS = 150;

/*
 * Filings run to megabytes and a 10-K is mostly financial tables. Three
 * megabytes covers the narrative sections of essentially every filing while
 * refusing to pull an exhibit heavy monster into memory.
 */
const MAX_FILING_BYTES = 3 * 1024 * 1024;

export interface EdgarHit {
  _id?: string;
  _source?: {
    ciks?: string[];
    display_names?: string[];
    adsh?: string;
    form?: string;
    file_date?: string;
    file_type?: string;
  };
}

export interface EdgarSearchResponse {
  hits?: { hits?: EdgarHit[] };
}

/*
 * The document URL, assembled from the accession number and the file name.
 *
 * EDGAR's search returns an id shaped "0001477932-15-001997:inst_10k.htm". The
 * archive path wants the CIK without leading zeros and the accession number
 * without dashes, which is undocumented in the search response and is the only
 * fiddly part of this adapter.
 */
export function filingUrl(hit: EdgarHit): string | null {
  const id = hit._id ?? '';
  const [adsh, file] = id.split(':');
  const cik = hit._source?.ciks?.[0];
  if (!adsh || !file || !cik) return null;
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${adsh.replace(/-/g, '')}/${file}`;
}

/* A filer's name, with the CIK EDGAR appends to it removed. */
export function filerName(hit: EdgarHit): string {
  const raw = hit._source?.display_names?.[0] ?? '';
  return raw.replace(/\s*\(CIK\s*\d+\)\s*$/i, '').trim() || 'unnamed filer';
}

/* EDGAR file dates are YYYY-MM-DD. */
export function filingDate(raw: string | null | undefined): number {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return 0;
  const parsed = Date.parse(`${raw}T00:00:00Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

/*
 * Markup to readable prose.
 *
 * Scripts and styles first, or their contents survive tag stripping and end up
 * quoted as though a person wrote them.
 */
export function filingText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Passage { text: string; offset: number }

/*
 * The passage around a phrase, snapped to sentence boundaries.
 *
 * Cutting at a fixed character count leaves a quote starting mid word, and a
 * quote that has been cut badly reads as though we mangled it. So the window is
 * widened to the nearest sentence break on each side where one is close by.
 */
export function extractPassage(text: string, phrase: string, radius = 260, from = 0): Passage | null {
  const at = text.toLowerCase().indexOf(phrase.toLowerCase(), from);
  if (at === -1) return null;

  let start = Math.max(0, at - radius);
  let end = Math.min(text.length, at + phrase.length + radius);

  /* Snap left to the sentence that contains the phrase, if one starts nearby. */
  const leftBreak = text.lastIndexOf('. ', at);
  if (leftBreak > start) {
    start = leftBreak + 2;
  } else if (start > 0) {
    /*
     * No sentence break within reach, so snap to a word boundary instead.
     * Without this the window cuts mid word and a live run quoted a Saucony
     * 10-K as `"onsultant, independent contractor or otherwise"`, which reads
     * as though we mangled the filing rather than trimmed it. Found by running
     * it on 2026-08-22.
     */
    const space = text.indexOf(' ', start);
    if (space !== -1 && space < at) start = space + 1;
  }

  /* Snap right to the end of the sentence the phrase sits in. */
  const rightBreak = text.indexOf('. ', at + phrase.length);
  if (rightBreak !== -1 && rightBreak < end + radius) {
    end = rightBreak + 1;
  } else if (end < text.length) {
    /* Same reasoning at the other end: finish the word, then mark the trim. */
    const space = text.lastIndexOf(' ', end);
    if (space > at + phrase.length) end = space;
  }

  return { text: text.slice(start, end).trim(), offset: start };
}

/*
 * Which of several passages to keep. The longest, because in a filing the
 * longest mention is the one in the narrative rather than a heading, a table
 * label or a repeated risk factor boilerplate line.
 */
export function bestPassage(text: string, phrase: string, tries = 4): Passage | null {
  const found: Passage[] = [];
  let from = 0;
  for (let i = 0; i < tries; i++) {
    /*
     * Searched from an offset rather than by slicing the text first. Slicing
     * and re-searching finds the FIRST occurrence in the slice every time, so
     * every attempt returned the same passage and the longest never won.
     * Caught by a test on 2026-08-22.
     */
    const at = text.toLowerCase().indexOf(phrase.toLowerCase(), from);
    if (at === -1) break;
    const passage = extractPassage(text, phrase, 260, from);
    if (passage) found.push(passage);
    from = at + phrase.length;
  }
  if (!found.length) return null;
  return found.sort((a, b) => b.text.length - a.text.length)[0]!;
}

export interface SecEdgarOptions {
  throttle?: Throttle;
  fetch?: typeof safeFetch;
  forms?: readonly string[];
  /* Filings fetched per query. Each one is a second request. */
  maxFilings?: number;
}

export function createSecEdgarSource(options: SecEdgarOptions = {}): Source {
  let phrase = '';
  let contact = '';
  const throttle = options.throttle ?? createThrottle({ minGapMs: MIN_GAP_MS });
  const fetchImpl = options.fetch ?? safeFetch;
  const forms = options.forms ?? DEFAULT_FORMS;
  const maxFilings = options.maxFilings ?? 8;

  const headers = (): Record<string, string> => ({
    /* The format the SEC documents: who is calling and how to reach them. */
    'user-agent': `Receipts ${contact}`,
    accept: 'application/json',
  });

  return {
    id: 'sec-edgar',
    cost: 'free',
    /* A company name is prose. */
    channelKind: 'title',

    /*
     * The SEC requires a contact address and returns 403 without one. A missing
     * one degrades this source to empty, exactly like a missing API key, rather
     * than sending a request the archive has asked us not to send.
     */
    configured(env: Env): boolean {
      return Boolean(env['RECEIPTS_CONTACT_EMAIL']);
    },

    async plan(input: PlanInput): Promise<Query[]> {
      /*
       * The subject as a phrase, quoted. EDGAR's search ORs unquoted words, and
       * a 10-K containing "running" and "shoes" in unrelated paragraphs is not
       * about running shoes.
       */
      phrase = (input.category || input.productTitle).trim();
      if (phrase.length < 3) return [];
      return forms.map((form) => ({ text: phrase, form } as Query & { form: string }));
    },

    async *retrieve(query: Query, ctx: Ctx): AsyncIterable<SourceRecord> {
      contact = ctx.env['RECEIPTS_CONTACT_EMAIL'] ?? '';
      if (!contact) return;

      const form = (query as Query & { form?: string }).form ?? '10-K';
      const params = new URLSearchParams({ q: `"${query.text}"`, forms: form });
      const searchUrl = `${SEARCH}?${params.toString()}`;
      const base = ctx.signal ? { signal: ctx.signal } : {};

      const found = await throttle.attempt(
        () => fetchImpl(searchUrl, { ...base, headers: headers() }),
        (r) => r.status === 429 || r.status >= 500,
        { ok: false, status: 0, headers: {}, body: '', url: searchUrl, error: 'gave up after retries' },
      );
      if (!found.ok) {
        ctx.log?.(`sec-edgar: search ${found.error ?? `status ${found.status}`}`);
        return;
      }

      const parsed = parseJsonObject<EdgarSearchResponse>(found.body);
      const hits = Array.isArray(parsed?.hits?.hits) ? parsed.hits.hits : [];

      for (const hit of hits.slice(0, maxFilings)) {
        if (ctx.signal?.aborted) return;

        const url = filingUrl(hit);
        if (!url) continue;

        /*
         * The second request, and the whole reason this adapter exists. Without
         * it the record would carry our summary rather than the filer's words.
         */
        const doc = await throttle.attempt(
          () => fetchImpl(url, { ...base, maxBytes: MAX_FILING_BYTES, headers: { 'user-agent': `Receipts ${contact}` } }),
          (r) => r.status === 429 || r.status >= 500,
          { ok: false, status: 0, headers: {}, body: '', url, error: 'gave up after retries' },
        );
        if (!doc.ok || !doc.body) continue;

        const prose = filingText(doc.body);
        const passage = bestPassage(prose, phrase);
        /*
         * The phrase matched the search index and not the fetched document,
         * which happens when the filing's narrative lives in an exhibit. No
         * passage means no quote, and no quote means no record.
         */
        if (!passage || passage.text.length < 60) continue;

        const source = hit._source ?? {};
        yield {
          source: 'sec-edgar',
          kind: 'post',
          /* Accession plus file, so a re-read of the same filing is the same
           * receipt rather than a new one. */
          externalId: hit._id ?? `${source.adsh ?? ''}`,
          channel: filerName(hit),
          text: passage.text,
          /* A filing carries no votes. */
          score: 0,
          url,
          createdUtc: filingDate(source.file_date),
          origin: `SEC ${source.form ?? form}`,
        };
      }
    },

    cite(record: SourceRecord): Citation {
      return {
        label: `SEC filing, ${record.channel ?? 'unnamed filer'}`,
        url: record.url ?? '',
        score: 0,
        postedAt: record.createdUtc ?? 0,
      };
    },
  };
}
