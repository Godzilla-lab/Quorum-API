/*
 * Vendor rates, in one table so there is exactly one place to correct when an
 * unverified price is confirmed.
 *
 * Every entry carries whether it was actually verified and when. A rate without
 * a date is a number nobody can safely change, because the next reader cannot
 * tell whether it was measured last week or guessed two years ago.
 *
 * Anything marked unverified prints with a warning rather than quietly
 * pretending to be real, and must never be used to price a report.
 */

export interface TokenRate {
  /* USD per million input tokens. */
  in: number;
  /* USD per million output tokens. */
  out: number;
  /*
   * The long context tier, where one exists.
   *
   * This is NOT a surcharge on the excess. Once a prompt crosses the threshold
   * the WHOLE request bills at the higher rate, output included, so a 210k
   * prompt costs roughly double a 199k one rather than a fraction more. That is
   * a cliff worth seeing in the numbers, and it is reachable here: the CLI sends
   * its full evidence set.
   */
  long?: { in: number; out: number };
  verified: boolean;
  /* ISO date the rate was last confirmed against the vendor. */
  asOf: string;
  note?: string;
}

export interface CallRate {
  /* USD per call, flat. */
  perCall: number;
  verified: boolean;
  asOf: string;
  note?: string;
}

export type Rate = TokenRate | CallRate;

export function isCallRate(rate: Rate): rate is CallRate {
  return 'perCall' in rate;
}

/*
 * Prompt size at which the long context tier applies. Applied to the whole
 * request, not to the excess.
 */
export const LONG_CONTEXT_TOKENS = 200_000;

export const RATES: Readonly<Record<string, Rate>> = {
  'claude-opus-5': { in: 5.0, out: 25.0, verified: true, asOf: '2026-08-13' },
  'claude-sonnet-5': { in: 3.0, out: 15.0, verified: true, asOf: '2026-08-13' },
  'claude-haiku-4-5': { in: 1.0, out: 5.0, verified: true, asOf: '2026-08-13' },
  'claude-opus-5:fast': {
    in: 10.0, out: 50.0, verified: true, asOf: '2026-08-13',
    note: 'fast mode is the same model at premium pricing',
  },

  'grok-4.6': { in: 2.0, out: 6.0, long: { in: 4.0, out: 12.0 }, verified: true, asOf: '2026-08-14' },
  'grok-4.5': { in: 2.0, out: 6.0, long: { in: 4.0, out: 12.0 }, verified: true, asOf: '2026-08-14' },
  'grok-4.20-0309-non-reasoning': {
    in: 1.25, out: 2.5, long: { in: 2.5, out: 5.0 }, verified: true, asOf: '2026-08-14',
  },
  'grok-4.20-0309-reasoning': {
    in: 1.25, out: 2.5, long: { in: 2.5, out: 5.0 }, verified: true, asOf: '2026-08-14',
  },

  /*
   * Resellers that publish no rate card, so per token cost is genuinely
   * unknown. These print with a warning and must not be used to price anything.
   */
  'gpt-5.6-sol': {
    in: 0, out: 0, verified: false, asOf: '2026-08-14',
    note: 'reseller publishes no rate card, verify against the account usage page',
  },
  'claude-opus-4-8': {
    in: 5.0, out: 25.0, verified: false, asOf: '2026-08-14',
    note: 'assumed to match first party pricing, unconfirmed',
  },

  /*
   * Apify Meta Ad Library, RE-MEASURED 2026-08-22 and corrected downward by 7.6x.
   *
   * A live 30 ad pull through curious_coder/facebook-ads-library-scraper moved
   * the account's monthly usage from $2.0308 to $2.0536. That is $0.0228 for 30
   * ads, so $0.00076 each. Re-checked several minutes later in case billing
   * lagged: unchanged at $2.0536, so the figure is settled and not partial.
   *
   * The previous entry said $0.0058 per ad, measured 2026-08-13. Both
   * measurements were real; the actor moved to pay per event pricing in
   * between. That is exactly why rates carry the date they were taken, and why
   * a rate older than a few weeks should be re-measured rather than trusted.
   *
   * At $0.00076 a $5 monthly cap is roughly 6,500 ads. At the old figure it
   * looked like 862, so a run that should have been affordable would have been
   * refused by the spend cap. An over estimate is not the safe direction: it
   * silently shrinks what the product can do.
   */
  'apify.fb-ads-item': { perCall: 0.00076, verified: true, asOf: '2026-08-22' },

  /*
   * THE FREE OPENROUTER MODELS THE SYNTHESIS PATH DEFAULTS TO.
   *
   * Zero is entered here rather than left to the unknown key fallback, and the
   * difference is not cosmetic. An unpriced model charges zero AND marks the
   * run unverified, so a self hoster running the default free path would read
   * "? rate not confirmed with the vendor" under a line that is genuinely and
   * verifiably free. That warning exists to stop an estimate being used to
   * price a report, and firing it on a confirmed zero teaches people to ignore
   * it.
   *
   * VERIFIED 2026-08-22 by reading the pricing OpenRouter publishes for each
   * model id: {"prompt":"0","completion":"0"} on all three. Re-measure if the
   * free pool changes, which it does: three of the five models this list was
   * chosen from on the same day were unusable, and the pool is not a contract.
   */
  'nvidia/nemotron-nano-9b-v2:free': { in: 0, out: 0, verified: true, asOf: '2026-08-22' },
  'z-ai/glm-5.2:free': { in: 0, out: 0, verified: true, asOf: '2026-08-22' },
  'liquid/lfm-2.5-2.6b:free': { in: 0, out: 0, verified: true, asOf: '2026-08-22' },

  /*
   * Bright Data. Measured live against a real zone, one request billed $0.0015
   * for a 320KB page: per request, not per byte, so a heavy page costs the same
   * as a light one.
   *
   * Kept in the table although the adapter is NOT ported. The account currently
   * has no Web Unlocker zone, and the ad path was never finished. The rate was
   * real when measured and stays here for if it comes back.
   */
  'brightdata.unlocker': {
    perCall: 0.0015, verified: true, asOf: '2026-08-13',
    note: 'adapter not ported, account has no active zone',
  },
  'brightdata.browser': {
    perCall: 0.006, verified: false, asOf: '2026-08-13',
    note: 'adapter not ported',
  },
};
