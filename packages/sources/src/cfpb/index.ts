/*
 * CFPB Consumer Complaint Database.
 *
 * Every complaint the Consumer Financial Protection Bureau sends to a company,
 * published after the company responds or after fifteen days, with the
 * consumer's account of what happened in their own words once personal
 * details are removed. Measured 2026-09-13: 17,729,722 complaints, CC0, updated
 * daily, and a public search API with no key.
 *
 * WHY THIS IS TIER C, VOICE, AND NOT TIER A.
 *
 * Tier A is a named party stating something on the record: a regulator
 * ordering a recall, a company filing with the SEC. A complaint narrative is
 * the consumer talking, filed with a regulator and published after the
 * company was given the chance to answer. That is a first person account with
 * unusually good provenance, and it is still one person's account. So it sits
 * beside Reddit and Hacker News as voice, and it counts toward corroboration
 * the same way: three independent complaints clear the threshold, one does
 * not.
 *
 * WHAT IT FILLS. Anything financial. Ask about a bank, a card, a lender, a
 * buy now pay later app, a debt collector or a credit bureau and the forums
 * are thin; the Bureau holds tens of thousands of first person accounts per
 * company, each with an exact date and a permalink a reader can open.
 *
 * THE ENDPOINT, AND THREE THINGS FOUND THE HARD WAY, 2026-09-13.
 *
 *   https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/
 *
 * The trailing slash is load bearing: without it the site serves its HTML
 * search page with a 200. `format=json` returns a 404, so the format is left
 * unstated and json is what comes back. And a browser user agent is refused
 * by the edge with a 403 while a plain one is served; this client sends its
 * own name, as it does everywhere.
 *
 * The response is Elasticsearch shaped: `hits.hits[]._source` carries the
 * complaint, `hits.total.value` the count, `_meta` the licence and the record
 * total. `no_aggs=true` drops the facet aggregations, which are two thirds of
 * the bytes and nothing this adapter reads.
 *
 * WHAT IS DELIBERATELY NOT STORED YET. Each complaint also carries the
 * product, the issue, the company's response category and whether it answered
 * on time. Those are facts a report could use, and they are on the permalink,
 * but the corpus has no column for them and the narrative must stay the
 * consumer's words alone. A facets column is a schema change and a decision
 * for later; the company name is the channel, which the corpus does hold.
 *
 * ONE COMPANY IS ONE CHANNEL, AND THAT IS THE HONEST READING. Corroboration
 * counts independent channels, and every complaint against Chime shares the
 * channel "Chime Financial Inc" however many consumers filed them. So on a
 * company subject this source can never clear the two channel floor alone;
 * measured 2026-09-13 on a live "Chime" run it supplied 44 of 90 receipts for
 * "quality" and the report said "67% of these receipts come from cfpb/Chime
 * Financial Inc", which is exactly the warning a reader needs. On a product
 * subject ("credit card") the channels are the companies complained about,
 * and it corroborates across them as any forum does across communities.
 */

import type { Citation, Ctx, Env, PlanInput, Query, Source, SourceRecord } from '../source.ts';
import { safeFetch } from '../http/safe-fetch.ts';
import { createThrottle, type Throttle } from '../throttle.ts';
import { isRelevantRecord, subjectTerms } from '../relevance.ts';
import { arrayField, parseJsonObject } from '../http/parse-json.ts';

const BASE = 'https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/';
const DETAIL = 'https://www.consumerfinance.gov/data-research/consumer-complaints/search/detail/';

/* One page per query. A hundred narratives is a lot of reading for one
 * question, and the relevance sort puts the best of them first. */
const PAGE_SIZE = 100;

/* The fields read. Everything else in `_source` is ignored on purpose. */
export interface CfpbComplaint {
  complaint_id?: string | number | null;
  date_received?: string | null;
  company?: string | null;
  product?: string | null;
  sub_product?: string | null;
  issue?: string | null;
  sub_issue?: string | null;
  complaint_what_happened?: string | null;
  company_response?: string | null;
  timely?: string | null;
  has_narrative?: boolean | null;
}

export interface CfpbResponse {
  hits?: { total?: { value?: number }; hits?: { _id?: string; _source?: CfpbComplaint }[] };
}

/*
 * Narratives are published with names and dates replaced by runs of X, and
 * money written as `{$600.00}`. The redactions stay: they are the Bureau's,
 * they are honest, and a reader knows what XXXX means. The braces go, because
 * "{$600.00}" under a quote reads as our markup rather than theirs.
 */
export function cleanNarrative(raw: string): string {
  return raw
    .replace(/\{\$([0-9.,]+)\}/g, '$$$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/*
 * A RAW CONTROL CHARACTER INSIDE A JSON STRING IS INVALID JSON, and consumer
 * narratives are typed by consumers. `JSON.parse` refuses the whole page over
 * one stray byte in one complaint. Structural whitespace between tokens is
 * still whitespace after this, so the scrub cannot break a page that was
 * valid, and it saves the pages that were not.
 *
 * Built from code points rather than written as escapes, the same way the
 * copy checker builds the characters it hunts, so this file never carries the
 * bytes it removes.
 */
const CONTROL_CHARACTERS = new RegExp(`[${String.fromCodePoint(0)}-${String.fromCodePoint(31)}]`, 'g');

export function scrubControlCharacters(body: string): string {
  return body.replace(CONTROL_CHARACTERS, ' ');
}

/* `date_received` is an ISO timestamp. Unix seconds, or null when it is not. */
export function receivedAt(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function complaintUrl(id: string): string {
  return `${DETAIL}${id}`;
}

export interface CfpbOptions {
  throttle?: Throttle;
  fetch?: typeof safeFetch;
  pageSize?: number;
}

export function createCfpbSource(options: CfpbOptions = {}): Source {
  let subject: string[] = [];
  /*
   * Phrase mode, as on Hacker News, because this is a general index too: the
   * Bureau holds complaints about every financial product there is, and the
   * scattered words of a subject prove nothing. A complaint about a mortgage
   * that mentions "the card" in passing is not voice of customer about a card.
   */
  let subjectPhrases: string[] = [];
  /* A public agency serving 17 million rows deserves one polite client. */
  const throttle = options.throttle ?? createThrottle({ minGapMs: 250 });
  const fetchImpl = options.fetch ?? safeFetch;
  const pageSize = options.pageSize ?? PAGE_SIZE;

  return {
    id: 'cfpb',
    cost: 'free',
    /* The channel is the company the complaint was sent to, which is a name
     * in prose ("Chime Financial Inc"), so it may vouch for its own records:
     * a complaint filed against a company is about that company. */
    channelKind: 'title',
    configured(_env: Env): boolean {
      return true;
    },
    async plan(input: PlanInput): Promise<Query[]> {
      subject = subjectTerms([input.category, input.productTitle]);
      subjectPhrases = [input.category, input.productTitle].filter((p) => p.trim().length > 0);
      const terms = input.terms.length ? input.terms : [input.category];
      /* Every query carries the subject, for the same reason Hacker News
       * does: the bare word "fees" matches most of the database. */
      return terms.map((text) => ({ text: `${input.category} ${text}` }));
    },
    async *retrieve(query: Query, ctx: Ctx): AsyncIterable<SourceRecord> {
      const params = new URLSearchParams({
        search_term: query.text,
        field: 'complaint_what_happened',
        has_narrative: 'true',
        no_aggs: 'true',
        size: String(pageSize),
        sort: 'relevance_desc',
      });
      if (query.withinDays && query.withinDays > 0) {
        const since = new Date(Date.now() - query.withinDays * 86_400_000);
        params.set('date_received_min', since.toISOString().slice(0, 10));
      }
      const fetchOptions = ctx.signal ? { signal: ctx.signal } : {};
      const result = await throttle.attempt(
        () => fetchImpl(`${BASE}?${params.toString()}`, fetchOptions),
        (r) => r.status === 429 || r.status >= 500,
        { ok: false, status: 0, headers: {}, body: '', url: BASE, error: 'gave up after retries' },
      );
      if (!result.ok) {
        /* Down degrades the run. It does not fail it. */
        ctx.log?.(`cfpb: ${result.error ?? `status ${result.status}`}`);
        return;
      }
      const parsed = parseJsonObject<CfpbResponse>(scrubControlCharacters(result.body));
      if (!parsed) {
        ctx.log?.('cfpb: response was not a json object');
        return;
      }
      for (const hit of arrayField<{ _source?: CfpbComplaint }>(parsed.hits ?? {}, 'hits')) {
        const c = hit._source;
        if (!c) continue;
        const id = c.complaint_id === null || c.complaint_id === undefined ? '' : String(c.complaint_id);
        if (!id) continue;
        const text = cleanNarrative(c.complaint_what_happened ?? '');
        /* No narrative means the consumer did not consent to publication.
         * The row exists and nobody is speaking in it, so it is not a record. */
        if (text.length < 40) continue;
        /*
         * A complaint without a receipt date is not a published complaint,
         * and the dates doctrine is that a record with no date is not stored
         * as if it had one. Never seen in a captured page; guarded anyway.
         */
        const createdUtc = receivedAt(c.date_received);
        if (createdUtc === null) continue;
        const channel = (c.company ?? '').trim() || 'CFPB';
        if (!isRelevantRecord(text, channel, subject, { mode: 'phrase', phrases: subjectPhrases })) continue;
        yield {
          source: 'cfpb',
          kind: 'post',
          externalId: id,
          channel,
          text,
          /* The Bureau counts nothing. Zero is the honest number, and the score
           * kind for this source says so, so it never renders as "no one agreed". */
          score: 0,
          url: complaintUrl(id),
          createdUtc,
          origin: 'CFPB complaint',
        };
      }
    },
    cite(record: SourceRecord): Citation {
      return {
        label: `CFPB complaint to ${record.channel ?? 'a company'}`,
        url: record.url ?? '',
        score: 0,
        postedAt: record.createdUtc ?? 0,
      };
    },
  };
}
