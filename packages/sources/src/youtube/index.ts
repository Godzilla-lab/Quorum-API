/*
 * YouTube comments, via the official Data API v3.
 *
 * WHY THE OFFICIAL API AND NOTHING ELSE, decided by research on 2026-08-26.
 * The keyless InnerTube path the browser uses is gated by PO tokens, draws
 * bot checks on datacenter addresses (which is where the hosted instance
 * lives), and reports only relative dates ("2 weeks ago"), which fails the
 * dates doctrine. Invidious is down to a handful of blocked instances and
 * Piped proxies YouTube through third party infrastructure, which is the
 * laundering shape the doctrine refuses. The official API needs a free key,
 * returns exact timestamps, and works from anywhere. A held key on a
 * vendor's documented API is the GitHub adapter category, not a scraped
 * source credential; a missing key degrades the run, never fails it.
 *
 * THE QUOTA IS THE BUDGET, NOT MONEY. Every project key gets 10,000 free
 * units a day (checked 2026-08-26): a search costs 100, a page of up to 100
 * comment threads costs 1. The per run budget below keeps one run to a
 * couple of percent of a day, so the meter has nothing to charge and the
 * key's quota cannot be exhausted by one report.
 */

import type { Citation, Ctx, Env, PlanInput, Query, Source, SourceRecord } from '../source.ts';
import { safeFetch } from '../http/safe-fetch.ts';
import { createThrottle, type Throttle } from '../throttle.ts';
import { isRelevantRecord, subjectTerms } from '../relevance.ts';

const API = 'https://www.googleapis.com/youtube/v3';

/*
 * Unit prices from the published quota table, checked 2026-08-26, and the
 * per run ceiling. Two searches plus their comment pages land near 220
 * units, so the ceiling is generous headroom rather than a target.
 */
const UNITS_SEARCH = 100;
const UNITS_THREAD_PAGE = 1;
const UNIT_BUDGET_PER_RUN = 500;

/* Videos read per query, and comment pages read per video. Review videos
 * concentrate their signal in the first page of top level comments. */
const VIDEOS_PER_QUERY = 8;
const PAGES_PER_VIDEO = 2;

interface RawSearchItem {
  id?: { videoId?: unknown } | null;
  snippet?: { title?: unknown; channelTitle?: unknown } | null;
}

interface RawThread {
  id?: unknown;
  snippet?: {
    topLevelComment?: {
      snippet?: {
        textOriginal?: unknown;
        textDisplay?: unknown;
        authorDisplayName?: unknown;
        likeCount?: unknown;
        publishedAt?: unknown;
        videoId?: unknown;
      } | null;
    } | null;
  } | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/* Exact ISO timestamps from the payload; zero stays the honest unknown. */
export function commentDate(publishedAt: unknown): number {
  const parsed = Date.parse(str(publishedAt));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : 0;
}

export interface YoutubeOptions {
  fetch?: typeof safeFetch;
  throttle?: Throttle;
  videosPerQuery?: number;
  pagesPerVideo?: number;
}

export function createYoutubeSource(options: YoutubeOptions = {}): Source {
  const doFetch = options.fetch ?? safeFetch;
  const throttle = options.throttle ?? createThrottle({ minGapMs: 200 });
  const videosPerQuery = options.videosPerQuery ?? VIDEOS_PER_QUERY;
  const pagesPerVideo = options.pagesPerVideo ?? PAGES_PER_VIDEO;

  /* Captured at plan time, applied at retrieve time, as every adapter does. */
  let subject: string[] = [];

  return {
    id: 'youtube',
    cost: 'free',
    /* The channel is the video's own title, natural language. */
    channelKind: 'title',

    configured(env: Env): boolean {
      return Boolean(env['QUORUM_YOUTUBE_API_KEY']);
    },

    async plan(input: PlanInput): Promise<Query[]> {
      subject = subjectTerms([input.category, input.productTitle]);
      /*
       * Review intent is the whole reason this source earns its quota:
       * comments under review and comparison videos are buyers talking.
       * One query per distinct name, not one per question term, because a
       * search costs 100 units and the comments for a category's review
       * videos do not change with the question.
       */
      const names = [...new Set([input.category, input.productTitle]
        .map((n) => (n ?? '').trim().toLowerCase())
        .filter((n) => n.length >= 2))];
      return names.map((name) => ({ text: `${name} review` }));
    },

    async *retrieve(query: Query, ctx: Ctx): AsyncIterable<SourceRecord> {
      /* Trimmed for the reason every key here is: three pasted keys have
       * now died at the header or the query string on a stray character. */
      const key = ctx.env['QUORUM_YOUTUBE_API_KEY']?.trim();
      if (!key) return;

      let unitsSpent = 0;
      const spend = (units: number): boolean => {
        if (unitsSpent + units > UNIT_BUDGET_PER_RUN) return false;
        unitsSpent += units;
        return true;
      };

      /* The URL carries the key, so no failure path may ever log a URL. */
      const get = async (path: string, params: Record<string, string>) => {
        const search = new URLSearchParams({ ...params, key });
        return throttle.attempt(
          () => doFetch(`${API}/${path}?${search.toString()}`, {
            timeoutMs: 30_000,
            headers: { accept: 'application/json' },
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
          (r) => !r.ok && (r.status === 429 || r.status >= 500),
          { ok: false as const, status: 0, body: '', error: 'gave up after retries', headers: {}, url: '' },
        );
      };

      if (!spend(UNITS_SEARCH)) return;
      const searched = await get('search', {
        part: 'snippet', type: 'video', order: 'relevance',
        maxResults: String(videosPerQuery), q: query.text,
      });
      if (!searched.ok) {
        ctx.log?.(`youtube: search failed, status ${searched.status}`);
        return;
      }

      let parsed: unknown;
      try { parsed = JSON.parse(searched.body); } catch { return; }
      const items = (parsed as { items?: RawSearchItem[] })?.items;
      if (!Array.isArray(items)) return;

      /* Sliced here as well as asked for via maxResults, because upstream
       * shapes drift and a page that ignores the parameter must not multiply
       * the comment page reads behind it. */
      for (const item of items.slice(0, videosPerQuery)) {
        if (ctx.signal?.aborted) return;
        const videoId = str(item.id?.videoId);
        const videoTitle = str(item.snippet?.title);
        if (!videoId || !videoTitle) continue;

        let pageToken = '';
        for (let page = 0; page < pagesPerVideo; page++) {
          if (!spend(UNITS_THREAD_PAGE)) {
            ctx.log?.(`youtube: unit budget reached after ${unitsSpent} units, stopping cleanly`);
            return;
          }
          const res = await get('commentThreads', {
            part: 'snippet', videoId, maxResults: '100',
            order: 'relevance', textFormat: 'plainText',
            ...(pageToken ? { pageToken } : {}),
          });
          if (!res.ok) {
            /*
             * A 403 here usually means comments are off for this video
             * (made for kids, or the uploader's choice), captured live in
             * the fixture beside this file. That is absence, not failure:
             * the video yields nothing and the run moves on. Anything else
             * is logged and skipped the same way, errors as values.
             */
            if (res.status !== 403) ctx.log?.(`youtube: comments failed, status ${res.status}`);
            break;
          }

          let body: unknown;
          try { body = JSON.parse(res.body); } catch { break; }
          const threads = (body as { items?: RawThread[]; nextPageToken?: unknown })?.items;
          if (!Array.isArray(threads)) break;

          for (const thread of threads) {
            const s = thread.snippet?.topLevelComment?.snippet;
            const externalId = str(thread.id);
            const text = (str(s?.textOriginal) || str(s?.textDisplay)).replace(/\s+/g, ' ').trim();
            if (!externalId || !text) continue;
            /* The gate every voice source applies: a comment section under
             * a review video still holds plenty that is not about the
             * subject, and the corpus stores voices, not scrollback. */
            if (!isRelevantRecord(text, videoTitle, subject, { channelKind: 'title' })) continue;

            const likes = typeof s?.likeCount === 'number' ? s.likeCount : 0;
            yield {
              source: 'youtube',
              kind: 'comment',
              externalId,
              channel: videoTitle,
              text,
              score: likes,
              /* The lc parameter opens the watch page with this exact
               * comment focused, so a receipt blind resolves in a browser. */
              url: `https://www.youtube.com/watch?v=${videoId}&lc=${externalId}`,
              createdUtc: commentDate(s?.publishedAt),
              origin: `YouTube: ${videoTitle}`,
            };
          }

          pageToken = str((body as { nextPageToken?: unknown }).nextPageToken);
          if (!pageToken) break;
        }
      }
    },

    cite(record: SourceRecord): Citation {
      return {
        label: `YouTube comment, ${record.score ?? 0} likes, under ${record.channel ?? ''}`,
        url: record.url ?? '',
        score: record.score ?? 0,
        postedAt: record.createdUtc ?? 0,
      };
    },
  };
}
