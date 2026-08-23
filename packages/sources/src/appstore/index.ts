/*
 * Apple App Store customer reviews.
 *
 * WHY THIS SOURCE MATTERS OUT OF PROPORTION TO ITS SIZE.
 *
 * Every voice source in this repo until now was a forum: people talking to each
 * other about a product. A store review is a different act. It is written by
 * somebody who bought the thing, addressed to other buyers, attached to a star
 * rating and to a version number. That last field is the one nothing else has:
 * a complaint tied to version 1.7.328 can be checked against whether the next
 * release fixed it.
 *
 * It also covers a category the engine could not serve at all. A researcher
 * asking about an app got forum chatter or nothing.
 *
 * Endpoints, both keyless and both public:
 *   https://itunes.apple.com/search              name to numeric app id
 *   https://itunes.apple.com/{cc}/rss/customerreviews/id={id}/...json
 *
 * THE RSS FEED IS CAPPED, AND THAT IS THE ARGUMENT FOR RETAINING IT.
 *
 * Apple serves roughly ten pages of 50, so about 500 reviews per storefront,
 * and older ones fall off the end permanently. A competitor querying this
 * endpoint tomorrow cannot see what fell off today. Every page we store is a
 * page that stops being reachable, which is the same existence argument as the
 * ad archive, on a source that costs nothing.
 */

import type { Citation, Ctx, Env, PlanInput, Query, Source, SourceRecord } from '../source.ts';
import { safeFetch } from '../http/safe-fetch.ts';
import { createThrottle, type Throttle } from '../throttle.ts';
import { isRelevantRecord, subjectTerms } from '../relevance.ts';
import { arrayField, parseJsonObject } from '../http/parse-json.ts';

const SEARCH = 'https://itunes.apple.com/search';

/*
 * Storefronts, and each one is a genuinely independent channel: a complaint in
 * the US store and the same complaint in the UK store are two markets, not one
 * person posting twice. Kept short because each is a request and most products
 * are discussed in one of these.
 */
export const DEFAULT_STOREFRONTS = ['us', 'gb'] as const;

export interface AppSearchResult {
  trackId?: number | null;
  trackName?: string | null;
  sellerName?: string | null;
  averageUserRating?: number | null;
  userRatingCount?: number | null;
  primaryGenreName?: string | null;
}

export interface ReviewLabel { label?: string | null }
export interface ReviewEntry {
  id?: ReviewLabel;
  title?: ReviewLabel;
  content?: ReviewLabel;
  author?: { name?: ReviewLabel } | null;
  'im:rating'?: ReviewLabel;
  'im:version'?: ReviewLabel;
  'im:voteSum'?: ReviewLabel;
  link?: { attributes?: { href?: string } } | { attributes?: { href?: string } }[] | null;
}

const text = (v: ReviewLabel | null | undefined): string => (v?.label ?? '').trim();

/*
 * A star rating, one to five, or zero when Apple did not send one.
 *
 * Zero is not a rating and must never be treated as one. The score kind table
 * marks this source as `stars`, so a renderer prints "3 of 5 stars", and a
 * fabricated zero would read as the worst possible review.
 */
export function reviewRating(entry: ReviewEntry): number {
  const raw = Number(text(entry['im:rating']));
  return Number.isInteger(raw) && raw >= 1 && raw <= 5 ? raw : 0;
}

/*
 * The title and the body together.
 *
 * A review title is not decoration, it is usually the verdict: "Great app, just
 * really buggy!" says more than the paragraph under it. Both are the reviewer's
 * own words, so joining them quotes nobody falsely.
 */
export function reviewText(entry: ReviewEntry): string {
  const title = text(entry.title);
  const body = text(entry.content);
  if (!body) return '';
  const joined = title && !body.startsWith(title) ? `${title}. ${body}` : body;
  return joined.replace(/\s+/g, ' ').trim();
}

export function reviewUrl(entry: ReviewEntry, appId: number, storefront: string): string {
  const link = Array.isArray(entry.link) ? entry.link[0] : entry.link;
  const href = link?.attributes?.href;
  /* Apple's own permalink when it sends one; the app's review page otherwise,
   * which is where the review actually is. */
  return href ?? `https://apps.apple.com/${storefront}/app/id${appId}?see-all=reviews`;
}

export interface AppStoreOptions {
  throttle?: Throttle;
  fetch?: typeof safeFetch;
  storefronts?: readonly string[];
  /* Feed pages per storefront. Apple serves about ten. */
  pages?: number;
}

interface ResolvedApp { id: number; name: string; seller: string }

export function createAppStoreSource(options: AppStoreOptions = {}): Source {
  let subject: string[] = [];
  let app: ResolvedApp | null = null;
  const throttle = options.throttle ?? createThrottle({ minGapMs: 300 });
  const fetchImpl = options.fetch ?? safeFetch;
  const storefronts = options.storefronts ?? DEFAULT_STOREFRONTS;
  const pages = options.pages ?? 2;

  return {
    id: 'appstore',
    cost: 'free',
    /* The channel is an app name plus a storefront, which is prose. */
    channelKind: 'title',

    configured(_env: Env): boolean {
      return true;
    },

    async plan(input: PlanInput): Promise<Query[]> {
      subject = subjectTerms([input.category, input.productTitle]);
      app = null;

      /*
       * The subject has to become a numeric app id before anything can be
       * fetched, and a wrong id returns a confident feed of reviews for the
       * wrong product, which is worse than returning nothing. So the match is
       * checked against the subject rather than trusted because it was first.
       */
      const term = (input.productTitle || input.category).trim();
      if (term.length < 2) return [];

      const params = new URLSearchParams({ term, entity: 'software', limit: '5', country: 'us' });
      const result = await fetchImpl(`${SEARCH}?${params.toString()}`, {});
      if (!result.ok) return [];

      const parsed = parseJsonObject<{ results?: AppSearchResult[] }>(result.body);
      if (!parsed) return [];

      for (const candidate of arrayField<AppSearchResult>(parsed, 'results')) {
        const id = candidate.trackId;
        const name = (candidate.trackName ?? '').trim();
        if (!id || !name) continue;
        /* The app's own name has to look like what was asked for. Apple's
         * search happily returns "To-Do List & Tasks for Notion" for "notion". */
        if (!isRelevantRecord(name, name, subject, { channelKind: 'title' })) continue;
        app = { id, name, seller: (candidate.sellerName ?? '').trim() };
        break;
      }

      if (!app) return [];

      return storefronts.flatMap((storefront) =>
        Array.from({ length: pages }, (_, i) => ({ text: `${storefront}:${i + 1}` })));
    },

    async *retrieve(query: Query, ctx: Ctx): AsyncIterable<SourceRecord> {
      if (!app) return;
      const [storefront = 'us', page = '1'] = query.text.split(':');

      const url = `https://itunes.apple.com/${storefront}/rss/customerreviews/id=${app.id}/sortBy=mostRecent/page=${page}/json`;
      const fetchOptions = ctx.signal ? { signal: ctx.signal } : {};

      const result = await throttle.attempt(
        () => fetchImpl(url, fetchOptions),
        (r) => r.status === 429 || r.status >= 500,
        { ok: false, status: 0, headers: {}, body: '', url, error: 'gave up after retries' },
      );

      if (!result.ok) {
        /* A storefront with no reviews returns 403, which is not an error. */
        if (result.status !== 403 && result.status !== 404) {
          ctx.log?.(`appstore ${storefront}: ${result.error ?? `status ${result.status}`}`);
        }
        return;
      }

      const parsed = parseJsonObject<{ feed?: { entry?: ReviewEntry[] } }>(result.body);
      if (!parsed?.feed) return;

      /*
       * One entry means Apple sent the app itself rather than a list, which it
       * does when a feed has no reviews. Every real feed carries many.
       */
      const entries = arrayField<ReviewEntry>(parsed.feed, 'entry');

      for (const entry of entries) {
        const externalId = text(entry.id);
        const body = reviewText(entry);
        if (!externalId || body.length < 40) continue;

        /* One channel per app per storefront: 50 reviews of one app are 50
         * people in one place, and the concentration measure has to see that. */
        const channel = `${app.name} (${storefront})`;

        /*
         * Gated like everything else. The app was matched against the subject,
         * but a review of the right app can still be about something else
         * entirely, and a subject narrower than the app ("notion databases")
         * should not collect every review of the app.
         */
        if (!isRelevantRecord(body, channel, subject, { channelKind: 'title' })) continue;

        yield {
          source: 'appstore',
          kind: 'comment',
          externalId,
          channel,
          text: body,
          /* STARS, not votes. The score kind table says so, and a renderer
           * prints "2 of 5 stars" rather than "2 points", which would invert
           * what the reviewer said. */
          score: reviewRating(entry),
          url: reviewUrl(entry, app.id, storefront),
          /* The RSS feed carries no usable review timestamp, only a feed level
           * `updated`. Zero is honest: an invented date would be worse. */
          createdUtc: 0,
          origin: `App Store ${storefront}`,
        };
      }
    },

    cite(record: SourceRecord): Citation {
      return {
        label: `App Store review, ${record.score || '?'} of 5 stars, ${record.channel ?? ''}`,
        url: record.url ?? '',
        score: record.score ?? 0,
        postedAt: record.createdUtc ?? 0,
      };
    },
  };
}
