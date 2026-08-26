/*
 * Evidence tiers.
 *
 * WHY WEIGHTING BECAME NECESSARY.
 *
 * A finding used to need three receipts, counted equally, and that was right
 * while everything came from Reddit. Composing twenty sources breaks equal
 * counting in both directions at once: three comments in one thread are one
 * conversation, while a recall notice, a 10-K line and a forum thread saying the
 * same thing are three genuinely independent observations.
 *
 * THE FAILURE MODE IS NOT WEAK SOURCES. IT IS CORRELATED ONES.
 *
 * So the weighting is by INDEPENDENCE, not importance, and it never collapses
 * into a score. A "confidence: 7.3" is unfalsifiable, and an unfalsifiable
 * number is exactly what this product exists to refuse. Tiers are a small
 * ordinal set, every claim still lists its receipt ids, and a reader can always
 * go and look.
 */

import type { SourceId } from './types.ts';

/*
 *   A  ATTESTED       a named party stated this on the record, with
 *                     consequences for lying. A regulator holds it.
 *   B  TRANSACTIONAL  an observable state, not an opinion. A price, a
 *                     catalogue entry, an ad that ran. Cannot be falsified by
 *                     mood.
 *   C  VOICE          what people said. Individually light, and the volume is
 *                     the entire point.
 *   D  CONTEXT        sets the scene. Never promotes a claim by itself, because
 *                     a spike in pageviews is not evidence of anything a buyer
 *                     said.
 */
export type EvidenceTier = 'A' | 'B' | 'C' | 'D';

/*
 * Exhaustive over SourceId ON PURPOSE. `Record<SourceId, EvidenceTier>` means
 * adding a source without deciding what its evidence is worth fails the build,
 * rather than defaulting quietly into whichever tier is most convenient.
 */
export const SOURCE_TIER: Record<SourceId, EvidenceTier> = {
  'sec-edgar': 'A',
  cpsc: 'A',
  nhtsa: 'A',
  openfda: 'A',
  'eu-safety-gate': 'A',

  ad: 'B',
  shopify: 'B',
  woocommerce: 'B',
  wayback: 'B',
  commoncrawl: 'B',
  npm: 'B',
  github: 'B',

  reddit: 'C',
  hackernews: 'C',
  discourse: 'C',
  stackexchange: 'C',
  lobsters: 'C',
  steam: 'C',
  appstore: 'C',
  youtube: 'C',
  amazon: 'C',
  review: 'C',

  wikipedia: 'D',
  gdelt: 'D',
  openalex: 'D',
  producthunt: 'D',
  jobs: 'D',
};

export const tierOf = (source: SourceId): EvidenceTier => SOURCE_TIER[source];

/* Longhand, for a report that has to explain itself to a reader. */
export const TIER_LABEL: Record<EvidenceTier, string> = {
  A: 'attested',
  B: 'transactional',
  C: 'voice',
  D: 'context',
};

/*
 * WHAT A SOURCE'S `score` ACTUALLY MEANS.
 *
 * Every record carries a number called `score`, and it means something
 * different in every source. Reddit and Hacker News count votes. An app store
 * review carries STARS, one to five. A recall carries nothing at all.
 *
 * Printing "2 points" under a two star review is not a rounding error, it
 * inverts the meaning: a reader sees a low number and reads faint agreement,
 * when the person actually said the product was bad. Printing "0 points" under
 * a recall reads as "nobody agreed" with a federal safety notice.
 *
 * Exhaustive over SourceId for the same reason the tier table is: adding a
 * source without deciding what its number means fails the build rather than
 * defaulting into whichever reading is most convenient.
 */
export type ScoreKind = 'points' | 'stars' | 'none';

export const SOURCE_SCORE_KIND: Record<SourceId, ScoreKind> = {
  /* Regulators publish no score, and zero must never render as disagreement. */
  'sec-edgar': 'none',
  cpsc: 'none',
  nhtsa: 'none',
  openfda: 'none',
  'eu-safety-gate': 'none',

  ad: 'none',
  shopify: 'none',
  woocommerce: 'none',
  wayback: 'none',
  commoncrawl: 'none',
  npm: 'points',
  github: 'points',

  reddit: 'points',
  hackernews: 'points',
  discourse: 'points',
  stackexchange: 'points',
  lobsters: 'points',
  /* Steam has no star rating, only a recommended flag and helpful votes. */
  steam: 'points',
  appstore: 'stars',
  youtube: 'points',
  amazon: 'stars',
  review: 'stars',

  wikipedia: 'none',
  gdelt: 'none',
  openalex: 'points',
  producthunt: 'points',
  jobs: 'none',
};

export const scoreKindOf = (source: SourceId): ScoreKind => SOURCE_SCORE_KIND[source];

/*
 * A tier D record can corroborate nothing on its own. Pageviews rising is not
 * somebody saying a shoe runs small, and letting context promote a claim is how
 * a report starts sounding confident about noise.
 */
export const PROMOTING_TIERS: readonly EvidenceTier[] = ['A', 'B', 'C'];
