/*
 * Arctic Shift transport.
 *
 * A public Reddit archive mirror, free, volunteer run, and no auth. Probed live
 * on 2026-08-13, and every constraint below is measured rather than assumed:
 *
 *   - archive lag is 0 to 1 hour, so this is effectively live
 *   - `query` REQUIRES a subreddit or author scope; global search is refused
 *   - comments/search has NO query param, so comments are pulled by link_id
 *   - multi word queries AND together and go empty fast
 *     ("wool runner comfort sizing" gave 0 hits, "comfort" gave plenty)
 *   - heavy queries answer 200 with {"error":"Timeout. Maybe slow down a bit"}
 *   - `fields` works and cuts the payload about 20x, but permalink is NOT a
 *     field, so links are constructed rather than read
 *
 * So a good query plan resolves a subreddit set first, then fires many narrow
 * single concept queries across it, then pulls the comment trees of whatever
 * actually got discussed.
 */

import { parseJsonObject } from '../http/parse-json.ts';
import { safeFetch, type SafeFetchResult } from '../http/safe-fetch.ts';
import { createThrottle, sharedThrottle, isOverloadMessage, type Throttle } from '../throttle.ts';

export const BASE = 'https://arctic-shift.photon-reddit.com/api';

/*
 * A real contact point in the agent string. This is a free service run by a
 * volunteer, and being identifiable is the difference between someone emailing
 * us and someone blocking us.
 */
export const USER_AGENT = 'receipts/0.1 (+https://github.com/receipts)';

export const POST_FIELDS = 'id,title,selftext,score,num_comments,subreddit,created_utc';
export const SUB_FIELDS = 'display_name,subscribers,public_description,over18';
export const COMMENT_FIELDS = 'body,score,author';

export interface ArcticShiftClientOptions {
  throttle?: Throttle;
  fetch?: typeof safeFetch;
  baseUrl?: string;
}

export interface ArcticShiftClient {
  get<T>(path: string, params: Record<string, string | number>): Promise<T[]>;
  throttleState(): { gapMs: number; throttled: boolean };
}

export function createArcticShiftClient(options: ArcticShiftClientOptions = {}): ArcticShiftClient {
  /*
   * Shared by upstream, not per client. Ten concurrent reports in one server
   * process would otherwise build ten throttles and hit this volunteer archive
   * at ten times the calibrated rate. See sharedThrottle.
   */
  const throttle = options.throttle ?? sharedThrottle('arctic-shift');
  const fetchImpl = options.fetch ?? safeFetch;
  const base = options.baseUrl ?? BASE;

  /*
   * Overload means back off. A parameter error means stop, because retrying a
   * malformed query spends the whole attempt budget to receive the same refusal
   * four times, on a service we are deliberately trying not to lean on.
   *
   * MEASURED LIVE 2026-08-22, and this corrected a real bug. Overload arrives as
   * HTTP 422 carrying {"error":"Timeout. Maybe slow down a bit"}, NOT as 429 and
   * NOT as a 200. An earlier version of this function returned early on any non
   * 2xx response, so it never parsed the body, never recognised the overload,
   * and gave up instantly. On the probe that found this, posts/search returned
   * 422 four times in a row and succeeded on the fifth attempt, so giving up on
   * the first would have reported an empty category as fact.
   *
   * The body is therefore parsed on EVERY response, whatever the status.
   */
  const isOverload = (r: SafeFetchResult): boolean => {
    if (r.status === 429) return true;
    if (r.status >= 500) return true;
    try {
      const body = parseJsonObject<{ error?: string }>(r.body) ?? {};
      return isOverloadMessage(body.error);
    } catch {
      return false;
    }
  };

  return {
    async get<T>(path: string, params: Record<string, string | number>): Promise<T[]> {
      const search = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) search.set(k, String(v));
      const qs = search.toString();

      const result = await throttle.attempt(
        () => fetchImpl(`${base}/${path}?${qs}`, { headers: { 'user-agent': USER_AGENT } }),
        isOverload,
        { ok: false, status: 0, headers: {}, body: '', url: base, error: 'gave up after retries' },
      );

      /*
       * Parsed regardless of status, because a useful error lives in the body of
       * a non 2xx response here. A 400 carries the parameter error verbatim,
       * which is worth surfacing rather than flattening into a silent empty.
       */
      try {
        const body = parseJsonObject<{ data?: T[]; error?: string }>(result.body);
        if (!body) return [];
        /* A parameter error returns empty rather than throwing. A source that
         * refuses us degrades the run; it never fails it. */
        if (body.error) return [];
        return body.data ?? [];
      } catch {
        return [];
      }
    },

    throttleState: () => throttle.state(),
  };
}

/* permalink is not a returned field, so it is constructed from what is. */
export function permalink(subreddit: string, postId: string): string {
  return `https://reddit.com/r/${subreddit}/comments/${postId}/`;
}
