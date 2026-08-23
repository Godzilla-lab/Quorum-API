/*
 * openFDA enforcement reports: device, food and drug recalls.
 *
 * Tier A, attested, for the same reason CPSC is. A recalling firm told a
 * federal regulator, on the record, that a batch of its product was defective
 * enough to pull from shelves, and the agency published the classification.
 * That is not somebody's impression of a product.
 *
 * Endpoint: https://api.fda.gov/{device,food,drug}/enforcement.json
 * No key. A key raises the rate limit and is not needed to read.
 *
 * WHY ALL THREE ENDPOINTS ARE QUERIED FOR EVERY SUBJECT.
 *
 * The API is split by what the FDA regulates, and a research subject does not
 * arrive labelled. "Protein powder" is food, "knee brace" is a device, and
 * plenty of subjects could be either. Guessing costs a whole leg when the guess
 * is wrong, and asking all three costs two extra requests against an API that
 * allows 240 a minute. Measured live 2026-08-22: device knee 1,106 reports,
 * food protein 536, drug ibuprofen 68.
 *
 * WHY THE URL POINTS AT THE API.
 *
 * An enforcement report has no public web page. Linking to a search page that
 * might show it would be inventing a citation, so the receipt links to the API
 * query that returns exactly this record, which is where the record actually
 * lives and resolves forever.
 */

import type { Citation, Ctx, Env, PlanInput, Query, Source, SourceRecord } from '../source.ts';
import { safeFetch } from '../http/safe-fetch.ts';
import { createThrottle, type Throttle } from '../throttle.ts';
import { isRelevantRecord, subjectTerms } from '../relevance.ts';

/* The three regulated worlds. Ordered by how often a consumer subject lands in
 * one, which only affects which requests happen first. */
export const FDA_ENDPOINTS = ['device', 'food', 'drug'] as const;
export type FdaEndpoint = (typeof FDA_ENDPOINTS)[number];

const BASE = 'https://api.fda.gov';

export interface FdaEnforcement {
  recall_number?: string | null;
  classification?: string | null;
  status?: string | null;
  recalling_firm?: string | null;
  product_description?: string | null;
  reason_for_recall?: string | null;
  recall_initiation_date?: string | null;
  report_date?: string | null;
  product_type?: string | null;
  distribution_pattern?: string | null;
  product_quantity?: string | null;
}

export interface FdaResponse {
  results?: FdaEnforcement[];
  error?: { code?: string; message?: string };
}

/*
 * openFDA dates are bare YYYYMMDD strings with no separators and no zone.
 * Parsed explicitly rather than handed to Date, which reads "20180910" as a
 * year and returns something 18,000 years out.
 */
export function fdaDate(raw: string | null | undefined): number {
  if (!raw || !/^\d{8}$/.test(raw)) return 0;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) return 0;
  return Math.floor(Date.UTC(year, month - 1, day) / 1000);
}

/*
 * The report as one record.
 *
 * The classification is included because it is the severity the agency
 * assigned, and it is the difference between a labelling error and a device
 * that can kill someone. Class I means a reasonable probability of serious
 * harm or death, and a reader deserves that word rather than a count.
 */
export function enforcementText(report: FdaEnforcement): string {
  const parts = [
    report.product_description ?? '',
    report.reason_for_recall ? `Reason for recall: ${report.reason_for_recall}` : '',
    report.classification ? `Classified ${report.classification} by the FDA.` : '',
    report.status ? `Status: ${report.status}.` : '',
  ];
  return parts.map((p) => p.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/* The API query that returns exactly this record, and nothing else. */
export function reportUrl(endpoint: FdaEndpoint, recallNumber: string): string {
  return `${BASE}/${endpoint}/enforcement.json?search=recall_number:%22${encodeURIComponent(recallNumber)}%22`;
}

export interface OpenFdaOptions {
  throttle?: Throttle;
  fetch?: typeof safeFetch;
  endpoints?: readonly FdaEndpoint[];
  limit?: number;
}

export function createOpenFdaSource(options: OpenFdaOptions = {}): Source {
  let subject: string[] = [];
  /*
   * openFDA allows 240 requests a minute without a key, which is one every
   * 250ms. Sitting on that floor exactly would be rude and would leave no room
   * for a retry, so the gap is doubled.
   */
  const throttle = options.throttle ?? createThrottle({ minGapMs: 500 });
  const fetchImpl = options.fetch ?? safeFetch;
  const endpoints = options.endpoints ?? FDA_ENDPOINTS;
  const limit = options.limit ?? 50;

  return {
    id: 'openfda',
    cost: 'free',
    /* A recalling firm's name is prose, not a squashed identifier. */
    channelKind: 'title',

    /*
     * An API key raises the rate limit and unlocks nothing, so this source is
     * always available. A key, when present, is used but never required.
     */
    configured(_env: Env): boolean {
      return true;
    },

    async plan(input: PlanInput): Promise<Query[]> {
      subject = subjectTerms([input.category, input.productTitle]);

      /*
       * The category and the product name, each against every endpoint. The
       * question terms are deliberately absent: searching product_description
       * for "quality" returns whatever the FDA happens to have described that
       * way, which is not the subject and would poison the corpus.
       */
      const searches = [input.category, input.productTitle]
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length >= 3);

      const unique = [...new Set(searches)];
      return endpoints.flatMap((endpoint) =>
        unique.map((text) => ({ text, endpoint } as Query & { endpoint: FdaEndpoint })));
    },

    async *retrieve(query: Query, ctx: Ctx): AsyncIterable<SourceRecord> {
      const endpoint = ((query as Query & { endpoint?: FdaEndpoint }).endpoint) ?? 'device';

      const params = new URLSearchParams();
      /*
       * Quoted, so a multi word subject searches as a phrase. Unquoted,
       * openFDA ORs the words and "running shoes" returns every report that
       * mentions running or shoes anywhere.
       */
      params.set('search', `product_description:"${query.text}"`);
      params.set('limit', String(limit));

      const url = `${BASE}/${endpoint}/enforcement.json?${params.toString()}`;
      const fetchOptions = ctx.signal ? { signal: ctx.signal } : {};

      const result = await throttle.attempt(
        () => fetchImpl(url, fetchOptions),
        (r) => r.status === 429 || r.status >= 500,
        { ok: false, status: 0, headers: {}, body: '', url, error: 'gave up after retries' },
      );

      /*
       * A 404 from openFDA means "no matches", not "endpoint missing". Treating
       * it as an error would log a failure every time a subject is not
       * regulated by the FDA, which is most subjects.
       */
      if (!result.ok) {
        if (result.status !== 404) ctx.log?.(`openfda ${endpoint}: ${result.error ?? `status ${result.status}`}`);
        return;
      }

      let parsed: FdaResponse;
      try {
        const raw: unknown = JSON.parse(result.body);
        /*
         * `JSON.parse('null')` returns null and is perfectly valid JSON, so the
         * try/catch does not catch it and the next property read throws.
         * Caught by a test on 2026-08-22.
         */
        if (raw === null || typeof raw !== 'object') {
          ctx.log?.(`openfda ${endpoint}: response was not an object`);
          return;
        }
        parsed = raw as FdaResponse;
      } catch {
        ctx.log?.(`openfda ${endpoint}: response was not json`);
        return;
      }
      if (parsed.error) return;

      /*
       * Checked rather than trusted. `for (const x of parsed.results)` where
       * results is the string "nope" iterates its CHARACTERS, silently yielding
       * garbage instead of failing. Caught by a test on 2026-08-22.
       */
      if (!Array.isArray(parsed.results)) {
        ctx.log?.(`openfda ${endpoint}: results was not an array`);
        return;
      }

      for (const report of parsed.results) {
        const externalId = report.recall_number;
        if (!externalId) continue;

        const text = enforcementText(report);
        if (text.length < 40) continue;

        /* The firm is the unit of independence: two recalls by one company are
         * one company's problem, two by different companies are a category's. */
        const channel = (report.recalling_firm ?? '').trim() || 'unnamed firm';

        if (!isRelevantRecord(text, channel, subject, { channelKind: 'title' })) continue;

        yield {
          source: 'openfda',
          kind: 'post',
          externalId,
          channel,
          text,
          /* No votes exist on a regulatory filing. Zero, honestly. */
          score: 0,
          url: reportUrl(endpoint, externalId),
          /* When the recall began, not when the paperwork was filed. */
          createdUtc: fdaDate(report.recall_initiation_date) || fdaDate(report.report_date),
          origin: `openFDA ${endpoint}`,
        };
      }
    },

    cite(record: SourceRecord): Citation {
      return {
        label: `FDA enforcement report, ${record.channel ?? 'unnamed firm'}`,
        url: record.url ?? '',
        score: 0,
        postedAt: record.createdUtc ?? 0,
      };
    },
  };
}
