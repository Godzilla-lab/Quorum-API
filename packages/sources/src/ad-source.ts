/*
 * The AdSource interface.
 *
 * Separate from `Source`, and it has to be, because ads do not go where records
 * go. A comment upserts into `docs` on (source, externalId, category), which is
 * correct: the text of a comment does not change, so collapsing duplicates
 * loses nothing.
 *
 * An ad is the opposite. Observing the same ad today and again in thirty days
 * is not a duplicate, it is the ONLY evidence that will ever exist that it ran
 * for thirty days, because Meta deletes inactive commercial ads. Sending ads
 * through the record path is exactly the bug the engine shipped: it wrote them
 * into `docs` with INSERT OR IGNORE, so every observation after the first was
 * silently discarded and the duration froze at first sight. Verified
 * 2026-08-22.
 *
 * So ads have their own interface, their own orchestrator and their own append
 * only table, and the type system keeps them apart.
 */

import type { AdObservationInput } from '@receipts/corpus';
import type { Ctx, Env, PlanInput } from './source.ts';

/*
 * What an adapter yields.
 *
 * The category is deliberately NOT part of this. The orchestrator attaches the
 * run's category, so an adapter cannot file an ad under a category the run was
 * not about, and every ad in a category is comparable by construction.
 */
export type AdRecord = Omit<AdObservationInput, 'category'>;

export interface AdQuery {
  /* An advertiser name, a brand, or a search term. Meaning is source specific. */
  text: string;
  /*
   * One advertiser, when we already know which. This is the precise path and it
   * is the one to prefer.
   *
   * Measured 2026-08-22: a keyword search for "running shoes" returned ads from
   * "Cholesterol Relief Community" and "Arthritis Support Community", and no
   * text threshold separates those from Clarks Shoes, because the
   * discriminating information is not in the ad copy. Scoping to an advertiser
   * is the same instrument the Reddit adapter uses when it gates subreddits
   * before harvesting rather than gating comments afterwards.
   */
  scope?: string;
  /*
   * Two letter country codes. Load bearing rather than cosmetic: Meta's own API
   * returns commercial ads only for the EEA and the UK, and outside that
   * `ad_type=ALL` returns nothing at all.
   */
  countries?: string[];
  /* Only look back this far. Zero or absent means whatever the source defaults to. */
  withinDays?: number;
  /* Hard ceiling on ads to pull for this query. Every one of them may cost money. */
  limit?: number;
}

export interface AdSource {
  readonly id: string;
  /*
   * Metered sources MUST check the cost meter before spending and must be
   * omittable from a free tier. An ads leg is the most expensive thing in a run.
   */
  readonly cost: 'free' | 'metered';

  /* MUST NOT throw on a missing key. An unconfigured source degrades a run. */
  configured(env: Env): boolean;

  plan(input: PlanInput): Promise<AdQuery[]>;

  /*
   * Yields observations for one query. Incremental for the same reason records
   * are: a run that dies halfway still leaves the archive better than it found
   * it, and on a metered source it means the money already spent bought
   * something.
   */
  retrieve(query: AdQuery, ctx: Ctx): AsyncIterable<AdRecord>;

  /* Where a reader can go and look at this ad themselves. */
  cite(record: AdRecord): { label: string; url: string };
}
