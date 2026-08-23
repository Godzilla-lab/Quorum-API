/*
 * Reddit voice of customer, via the Arctic Shift public archive.
 *
 * Retrieval is three stages and they cannot be collapsed:
 *
 *   1. WHICH SUBREDDITS. Prefix search is the only discovery the archive
 *      offers and it matches on NAME, not topic, so candidates are full of
 *      false friends. The relevance gate runs before anything is harvested,
 *      because every run writes to the corpus and one bad subreddit poisons a
 *      category's memory permanently. Measured: a "men shoes" probe returned
 *      r/mentalhealth, which contributed French language domestic violence
 *      threads to a footwear report.
 *
 *   2. WHICH POSTS. A cross product of subreddits and single concept queries.
 *      Not phrases: multi word queries AND together and go empty fast.
 *
 *   3. WHAT WAS SAID. The comment tree, which is where the real language
 *      lives. The post is the topic; the comments are the opinions.
 *
 * NO AUTHENTICATION, EVER. This is a public archive read logged off, which is
 * the entire legal footing. A session cookie forfeits it.
 */

import type { Citation, Ctx, Env, PlanInput, Query, Source, SourceRecord } from '../source.ts';
import {
  COMMENT_FIELDS, POST_FIELDS, SUB_FIELDS,
  createArcticShiftClient, permalink, type ArcticShiftClient,
} from './client.ts';
import { filterRelevant, type SubredditCandidate } from './relevance.ts';

/* Below this a subreddit is too quiet to be a market signal. */
const MIN_SUBSCRIBERS = 5000;
const SUBREDDITS_PER_TERM = 25;
/* A post nobody replied to has no voice of customer in it. */
const MIN_COMMENTS = 2;
/* Shorter than this is "same" or "+1", which costs prompt tokens and says nothing. */
const MIN_COMMENT_CHARS = 40;
/* Older than this and the product being discussed is usually a different one. */
const DEFAULT_WITHIN_DAYS = 540;

/*
 * Posts newer than this are excluded, and that is deliberate.
 *
 * The archive returns newest first and offers no server side quality filter:
 * min_num_comments and min_score are both rejected as unknown parameters,
 * measured 2026-08-22. So the only lever is the time window.
 *
 * A post published this week has no discussion yet regardless of how good it
 * is, and the discussion IS the voice of customer. The post is the topic, the
 * comments are the opinions.
 *
 * Measured on r/running for "shoes", 25 posts per window, 2026-08-22:
 *   after=540d only            19 of 25 usable (2+ comments)
 *   after=540d, before=30d     23 of 25 usable
 *
 * A 21% better yield for one parameter, and it costs nothing but the freshest
 * month, which had nothing to say yet anyway.
 */
const SETTLE_DAYS = 30;
const POSTS_PER_QUERY = 25;
const COMMENTS_PER_POST = 60;

interface SubredditRow { display_name?: string; subscribers?: number; public_description?: string; over18?: boolean }
interface PostRow { id?: string; title?: string; selftext?: string; score?: number; num_comments?: number; subreddit?: string; created_utc?: number }
interface CommentRow { body?: string; score?: number; author?: string }

/*
 * Automod and bot boilerplate is noise, never signal, and it is high volume
 * enough to crowd out real comments in a ranked sample. It is also usually the
 * TOP comment on a thread, being posted first and pinned, so a naive ranked
 * sample gets it every time.
 *
 * The welcome message patterns were added 2026-08-22 after a live probe: the
 * very first comment the archive returned was "Welcome to r/Running! We have set
 * up a New to the sub...", which the original three patterns did not catch.
 * That is one automod post per thread going straight into the corpus and then
 * into a prompt as though a customer had said it.
 */
const BOT_BOILERPLATE =
  /I am a bot|automatically removed|contact the moderators|^welcome to r\/|(?:this|your)\s+(?:post|submission|comment)\s+(?:on\s+\S+\s+)?(?:was|has been)\s+removed|removed by the|^dear \S+,|please read the (?:rules|wiki|faq)|action was performed automatically/i;

/*
 * MARKDOWN IS FLATTENED BEFORE THE TEST, AND THAT IS THE BUG FIX.
 *
 * The pattern for "your post was removed" has been here since the start and
 * caught nothing, because the real message is "Your [post](/r/running/...) on
 * r/running was removed by the Read The Rules app". A markdown link sits
 * between the two words the pattern needed adjacent.
 *
 * MEASURED 2026-08-22 on a corpus harvested before this fix: 27 moderator
 * removal notices were sitting in a 1,181 record category, every one of them
 * counted as a voice. They were loud enough to become the entire discovered
 * topic list, offering "rules app", "main menu" and "community rules" as what
 * the market keeps returning to. They also inflated every count they appeared
 * in, which is worse and quieter.
 */
const flattenLinks = (text: string): string => text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

/*
 * Exported because a corpus harvested before this fix still holds these rows,
 * and anything reading records back has to be able to recognise them. Fixing it
 * only on the way in would leave every existing corpus permanently polluted.
 */
export function isBotBoilerplate(text: string): boolean {
  return BOT_BOILERPLATE.test(flattenLinks(text).trim());
}

export function isUsableComment(body: string): boolean {
  const b = body.trim();
  if (b.length < MIN_COMMENT_CHARS) return false;
  if (b === '[removed]' || b === '[deleted]') return false;
  if (isBotBoilerplate(b)) return false;
  return true;
}

export interface ArcticShiftOptions {
  client?: ArcticShiftClient;
  minSubscribers?: number;
  maxSubreddits?: number;
}

export function createArcticShiftSource(options: ArcticShiftOptions = {}): Source {
  const client = options.client ?? createArcticShiftClient();
  const minSubscribers = options.minSubscribers ?? MIN_SUBSCRIBERS;
  const maxSubreddits = options.maxSubreddits ?? 10;

  return {
    id: 'reddit',
    cost: 'free',
    /* A subreddit name is a squashed identifier, never prose. */
    channelKind: 'handle',

    /* A public archive with no key. There is nothing to be missing. */
    configured(_env: Env): boolean {
      return true;
    },

    /*
     * Planning does network work, and that is honest rather than surprising:
     * Reddit queries cannot be planned without first knowing which subreddits
     * exist, and the archive is the only way to find out.
     */
    async plan(input: PlanInput): Promise<Query[]> {
      const terms = input.terms.length ? input.terms : [input.category];

      /*
       * Discovery is a NAME prefix search, so it needs community name hints,
       * not question concepts. Searching for a subreddit called "sizing" finds
       * nothing and plans zero queries, which is a silent failure rather than a
       * loud one. Falls back to the words in the category, which is what a
       * community is usually named after.
       */
      const nameHints = input.subredditTerms?.length
        ? input.subredditTerms
        : input.category.split(/\s+/).filter((w) => w.length >= 3);

      const found = new Map<string, SubredditCandidate>();
      for (const term of new Set(nameHints)) {
        const rows = await client.get<SubredditRow>('subreddits/search', {
          subreddit_prefix: term,
          limit: SUBREDDITS_PER_TERM,
          fields: SUB_FIELDS,
        });
        for (const s of rows) {
          const name = s.display_name;
          if (!name || found.has(name)) continue;
          if ((s.subscribers ?? 0) < minSubscribers) continue;
          /* Not a market, and not something to put in front of a customer. */
          if (s.over18) continue;
          found.set(name, {
            name,
            subscribers: s.subscribers ?? 0,
            description: (s.public_description ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
          });
        }
      }

      const candidates = [...found.values()].sort((a, b) => b.subscribers - a.subscribers);
      /*
       * The gate runs here, before anything is harvested or stored. It is the
       * last line of defence and it runs on every path, including when a model
       * did the picking.
       *
       * GATED ON THE SUBJECT, NOT ON THE TERMS WE SEARCHED WITH.
       *
       * This used to pass `[input.category, ...terms]`, which is circular:
       * `terms` are the words used to FIND these communities, so scoring
       * candidates against them passes whatever the search returned. It became
       * visible on 2026-08-22 once a model was allowed to widen discovery. A
       * "wool runner" report was hinted towards "running shoes", matched
       * r/runninglifestyle on the hint word, harvested it, and reported
       * findings from comments about Brooks Glycerin and Road Runner Sports.
       * Only 1 of the 29 records stored mentioned wool at all.
       *
       * Search on the questions. Gate on the subject. Same rule the record
       * gate already followed, applied one layer up.
       */
      const { kept } = filterRelevant(candidates, [input.category, input.productTitle]);

      /*
       * AND WHEN NOTHING PASSES, NOTHING IS HARVESTED.
       *
       * This used to read `kept.length ? kept : candidates`, so a gate that
       * rejected every candidate fell open and harvested all of them. That
       * inverts the gate exactly when it matters: rejecting everything means
       * "no community here is about this subject", which is a real answer, and
       * the run reports it as a source that planned no queries.
       */
      const subreddits = kept.slice(0, maxSubreddits);

      /* The cross product. Narrow single concept queries, run wide. */
      const queries: Query[] = [];
      for (const sub of subreddits) {
        for (const text of terms) {
          queries.push({ text, scope: sub.name, withinDays: DEFAULT_WITHIN_DAYS });
        }
      }
      return queries;
    },

    async *retrieve(query: Query, ctx: Ctx): AsyncIterable<SourceRecord> {
      if (!query.scope) {
        /* The archive refuses an unscoped query outright, so this is not worth
         * a round trip to discover. */
        ctx.log?.('reddit: a query without a subreddit scope is refused by the archive');
        return;
      }

      const params: Record<string, string | number> = {
        subreddit: query.scope,
        query: query.text,
        limit: POSTS_PER_QUERY,
        fields: POST_FIELDS,
      };
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (query.withinDays && query.withinDays > 0) {
        params['after'] = nowSeconds - query.withinDays * 86400;
      }
      /* Let a thread settle before reading it. See SETTLE_DAYS. */
      params['before'] = nowSeconds - SETTLE_DAYS * 86400;

      const posts = await client.get<PostRow>('posts/search', params);

      for (const p of posts) {
        if (!p.id) continue;
        if ((p.num_comments ?? 0) < MIN_COMMENTS) continue;

        const subreddit = p.subreddit ?? query.scope;
        const url = permalink(subreddit, p.id);

        /*
         * The post itself is a record: the title is the topic in the market's
         * own words, which is often the most quotable line in a thread.
         */
        const title = (p.title ?? '').trim();
        if (title) {
          yield {
            source: 'reddit',
            kind: 'post',
            externalId: p.id,
            channel: subreddit,
            text: title,
            score: p.score ?? 0,
            url,
            createdUtc: p.created_utc ?? 0,
            origin: `r/${subreddit}`,
          };
        }

        /* link_id needs the t3_ prefix. Without it the archive returns nothing
         * and reports no error, which is a silent empty rather than a failure. */
        const comments = await client.get<CommentRow>('comments/search', {
          link_id: `t3_${p.id}`,
          limit: COMMENTS_PER_POST,
          fields: COMMENT_FIELDS,
        });

        for (const [i, c] of comments.entries()) {
          const body = (c.body ?? '').replace(/\s+/g, ' ').trim();
          if (!isUsableComment(body)) continue;

          /*
           * The archive does not return a comment id under this field set, so
           * one is derived from the post and the position. Stable for a given
           * thread snapshot, which is what the corpus needs to deduplicate.
           */
          yield {
            source: 'reddit',
            kind: 'comment',
            externalId: `${p.id}_c${i}`,
            channel: subreddit,
            text: body.slice(0, 900),
            score: c.score ?? 0,
            url,
            createdUtc: p.created_utc ?? 0,
            origin: `r/${subreddit}`,
          };
        }
      }
    },

    cite(record: SourceRecord): Citation {
      return {
        label: `r/${record.channel ?? 'reddit'}, ${record.score ?? 0} points`,
        url: record.url ?? '',
        score: record.score ?? 0,
        postedAt: record.createdUtc ?? 0,
      };
    },
  };
}
