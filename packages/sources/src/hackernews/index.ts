/*
 * Hacker News, via the Algolia index.
 *
 * The cheapest strong source on the list: full text over every story and
 * comment, filterable by points and date, with no key, no account and no rate
 * limit negotiation. For developer facing and B2B products it is what the
 * Reddit archive is for consumer ones.
 *
 * Endpoint: https://hn.algolia.com/api/v1/search
 * No authentication. See CONTRIBUTING for why that is not optional here.
 */

import type { Citation, Ctx, Env, PlanInput, Query, Source, SourceRecord } from '../source.ts';
import { safeFetch } from '../http/safe-fetch.ts';
import { createThrottle, type Throttle } from '../throttle.ts';
import { isRelevantRecord, subjectTerms } from '../relevance.ts';
import { arrayField, parseJsonObject } from '../http/parse-json.ts';

const BASE = 'https://hn.algolia.com/api/v1/search';

/*
 * Algolia caps a page at 1000 hits and gets slower as the page grows. 100 is
 * comfortably inside that and is roughly one screen of genuinely relevant
 * comments per query, which is the useful unit here.
 */
const HITS_PER_PAGE = 100;

/*
 * HACKER NEWS COMMENTS CARRY NO SCORE. This is not a limitation of our query,
 * it is what the API returns, and it changed how this adapter works.
 *
 * Measured live 2026-08-22. A comment hit has exactly these fields:
 *   objectID, comment_text, author, story_id, story_title, story_url,
 *   parent_id, created_at_i
 *
 * There is no `points` and no `num_comments`. An earlier version of this
 * adapter sent numericFilters=points>=2, which matched ZERO of 6,903 available
 * comments, so it would have returned nothing in production forever. It passed
 * its tests because the fixture was hand written and invented the field.
 * Fixtures here are now captured, never authored.
 *
 * Stories do carry points, but a story is a headline someone submitted, not a
 * customer talking. The comments are the voice, so the trade is deliberate:
 * take the voice and accept that there is no engagement signal attached to it.
 */

export interface HackerNewsHit {
  objectID: string;
  comment_text?: string | null;
  story_text?: string | null;
  title?: string | null;
  story_title?: string | null;
  story_id?: number | null;
  author?: string | null;
  points?: number | null;
  num_comments?: number | null;
  created_at_i?: number | null;
  url?: string | null;
}

export interface HackerNewsResponse {
  hits?: HackerNewsHit[];
}

/*
 * Algolia returns HTML entities inside comment_text, and the text goes straight
 * into a prompt and then in front of a reader. Left alone, a quote reads as
 * "it&#x27;s too small", which looks like a bug in our product rather than in
 * theirs.
 */
export function decodeEntities(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    /* Ampersand last, or a double encoded entity decodes twice. */
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function itemUrl(hit: HackerNewsHit): string {
  return `https://news.ycombinator.com/item?id=${hit.objectID}`;
}

export interface HackerNewsOptions {
  throttle?: Throttle;
  fetch?: typeof safeFetch;
  hitsPerPage?: number;
}

export function createHackerNewsSource(options: HackerNewsOptions = {}): Source {
  /*
   * Captured at plan time and applied at retrieve time.
   *
   * Hacker News is a general forum, so a bare question term means whatever it
   * means to programmers. Measured live 2026-08-22: a running shoes report
   * searching for "sizing" got CSS sizing, font sizing and instruction sizing,
   * and stored 95 unrelated threads which the corroboration line then reported
   * as independent channels.
   */
  let subject: string[] = [];
  /*
   * The subject as written, for phrase mode. Hacker News is a general forum, so
   * scattered subject words prove nothing: a comment about housing economics
   * that says "like buying quality running shoes" is not voice of customer
   * about running shoes. Requiring the phrase took a real sample from 207
   * records to 111, and the 111 are genuinely about the product.
   */
  let subjectPhrases: string[] = [];
  /*
   * One throttle per source instance. Algolia is generous, but a hosted server
   * running many tenants should still look like one polite client rather than
   * many impatient ones.
   */
  const throttle = options.throttle ?? createThrottle({ minGapMs: 100 });
  const fetchImpl = options.fetch ?? safeFetch;
  const hitsPerPage = options.hitsPerPage ?? HITS_PER_PAGE;

  return {
    id: 'hackernews',
    cost: 'free',
    /* The channel is a story headline, which is natural language. */
    channelKind: 'title',

    /* No key exists to be missing, so this is always true. */
    configured(_env: Env): boolean {
      return true;
    },

    async plan(input: PlanInput): Promise<Query[]> {
      /* Gate on the subject, search on the questions. Never the reverse. */
      subject = subjectTerms([input.category, input.productTitle]);
      subjectPhrases = [input.category, input.productTitle].filter((p) => p.trim().length > 0);

      const terms = input.terms.length ? input.terms : [input.category];
      /*
       * Every query carries the category. Measured 2026-08-22, searching
       * Hacker News for the bare term "sizing" returned 13,801 hits, none of
       * them about the product. Scoped to "running shoes sizing" it returned
       * 12, and they were about running. Algolia ranks on the whole phrase, so
       * the category is what pulls the result set toward the subject.
       */
      return terms.map((text) => ({ text: `${input.category} ${text}` }));
    },

    async *retrieve(query: Query, ctx: Ctx): AsyncIterable<SourceRecord> {
      const params = new URLSearchParams({
        query: query.text,
        tags: 'comment',
        hitsPerPage: String(hitsPerPage),
      });
      /*
       * created_at_i is the only numeric field a comment actually has, so it is
       * the only thing worth filtering on. Filtering on points here returns
       * nothing at all, which is exactly the bug this replaced.
       */
      if (query.withinDays && query.withinDays > 0) {
        const after = Math.floor(Date.now() / 1000) - query.withinDays * 86400;
        params.set('numericFilters', `created_at_i>${after}`);
      }

      /* Built conditionally: under exactOptionalPropertyTypes, passing an
       * explicit `signal: undefined` is not the same as omitting it. */
      const fetchOptions = ctx.signal ? { signal: ctx.signal } : {};

      const result = await throttle.attempt(
        () => fetchImpl(`${BASE}?${params.toString()}`, fetchOptions),
        (r) => r.status === 429 || r.status >= 500,
        { ok: false, status: 0, headers: {}, body: '', url: BASE, error: 'gave up after retries' },
      );

      if (!result.ok) {
        /* A source that is down degrades the run. It does not fail it. */
        ctx.log?.(`hackernews: ${result.error ?? `status ${result.status}`}`);
        return;
      }

      /* `JSON.parse('null')` does not throw and the next read crashes the run.
       * Measured 2026-08-22 by feeding this adapter a literal null body. */
      const parsed = parseJsonObject<HackerNewsResponse>(result.body);
      if (!parsed) {
        ctx.log?.('hackernews: response was not a json object');
        return;
      }

      for (const hit of arrayField<HackerNewsHit>(parsed, 'hits')) {
        const raw = hit.comment_text ?? hit.story_text ?? '';
        const text = decodeEntities(raw);
        /* Short fragments carry no market signal and cost prompt tokens. */
        if (text.length < 40) continue;

        const channel = hit.story_title ?? hit.title ?? 'Hacker News';
        /*
         * The gate. Everything stored here is trusted by every later run, so an
         * off topic record is not a bad row, it is permanent corpus poison.
         */
        if (!isRelevantRecord(text, channel, subject, { mode: 'phrase', phrases: subjectPhrases })) continue;

        yield {
          source: 'hackernews',
          kind: 'comment',
          externalId: hit.objectID,
          channel,
          text,
          /*
           * Always zero for a comment, and honestly so. The API returns no
           * score for comments, and inventing one from the parent story's
           * points would be a number nobody voted for appearing under a quote.
           */
          score: hit.points ?? 0,
          url: itemUrl(hit),
          createdUtc: hit.created_at_i ?? 0,
          origin: 'Hacker News',
        };
      }
    },

    cite(record: SourceRecord): Citation {
      /*
       * No score in the label, because comments do not have one. Claiming
       * "0 points" under a quote reads as "nobody agreed", which is a
       * fabricated signal rather than an absent one.
       */
      return {
        label: `Hacker News, on "${record.channel ?? 'a thread'}"`,
        url: record.url ?? '',
        score: record.score ?? 0,
        postedAt: record.createdUtc ?? 0,
      };
    },
  };
}
