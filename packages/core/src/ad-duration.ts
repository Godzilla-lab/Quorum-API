/*
 * How long has this ad been running.
 *
 * This is the payoff of the append only `ad_observations` table, and until now
 * nothing read it back. Rows without this function are just rows.
 *
 * WHY THIS CANNOT BE ANSWERED ANYWHERE ELSE, AT ANY PRICE.
 *
 * Meta does not archive inactive commercial ads. Once a campaign stops, the
 * record that it ran for 94 days is destroyed, and no amount of money brings it
 * back. So for an ad that reports no start date, the ONLY way anyone will ever
 * know it ran for a month is that somebody was recording on the day, saw it,
 * and saw it again thirty days later. That is what this function reads.
 *
 * The engine could not do this. It wrote ads into the shared docs table, which
 * upserts on (source, external_id, category) with INSERT OR IGNORE, so every
 * observation after the first was silently discarded and the duration froze at
 * first sight. Verified 2026-08-22. The table fixed the write. This fixes the
 * read.
 *
 * THREE RULES, AND EACH ONE IS A HOUSE RULE PAYING OFF.
 *
 *   NEVER SHOW A DURATION THAT WAS INFERRED. A reported duration is a fact the
 *   advertiser stated. An observed one is arithmetic on dates we can point at.
 *   Anything else returns null and the report says nothing, which is a better
 *   answer than a number.
 *
 *   ROUND DOWN, ALWAYS. "At least 29 days" is defensible; 30 would claim a day
 *   nobody watched. Every boundary here floors.
 *
 *   AN AD THAT STOPPED ENDS WHEN IT STOPPED. A live ad reports today's date as
 *   its endDate, which is a read timestamp and not an end date, so an end date
 *   only counts once the ad is actually inactive. Measured 2026-08-13.
 */

import type { AdObservation, DurationConfidence } from '@receipts/corpus';

const SECONDS_PER_DAY = 86_400;

export interface DerivedDuration {
  /* Whole days, floored. Null when nothing evidenced a duration. */
  days: number | null;
  confidence: DurationConfidence;
  /*
   * How the number was arrived at, so a report can show its working and a
   * reader can tell our arithmetic from the advertiser's claim.
   *
   *   reported         the advertiser stated it, or stated a start and a real end
   *   start-date       their start date, measured to when we last saw it running
   *   observation-span our own sightings, and nothing else in the world has this
   *   none             no evidenced duration
   */
  basis: 'reported' | 'start-date' | 'observation-span' | 'none';
  /* How many sightings stand behind this, which is the receipt for a span. */
  observations: number;
  /* Unix seconds. Null when there were no observations at all. */
  firstSeen: number | null;
  lastSeen: number | null;
}

const NOTHING: DerivedDuration = {
  days: null, confidence: 'none', basis: 'none',
  observations: 0, firstSeen: null, lastSeen: null,
};

const floorDays = (fromSeconds: number, toSeconds: number): number | null => {
  const days = Math.floor((toSeconds - fromSeconds) / SECONDS_PER_DAY);
  /* A negative span is corrupt data, not a short ad. Say nothing. */
  return days >= 0 ? days : null;
};

/*
 * Every sighting of one ad, in any order. Ordering is not assumed, because a
 * caller merging two drivers or replaying a backfill can hand these over
 * unsorted and a silently wrong duration is worse than a loud failure.
 */
export function deriveDuration(observations: readonly AdObservation[]): DerivedDuration {
  if (!observations.length) return NOTHING;

  const seen = observations.map((o) => o.observedAt);
  const firstSeen = Math.min(...seen);
  const lastSeen = Math.max(...seen);
  const base = { observations: observations.length, firstSeen, lastSeen };

  /*
   * A reported duration outranks anything we worked out ourselves. Take the
   * largest: an ad seen again later has run longer, and a duration cannot go
   * backwards.
   */
  const reported = observations
    .filter((o) => o.durationConfidence === 'reported' && o.daysRunning != null)
    .map((o) => o.daysRunning as number);
  if (reported.length) {
    return { ...base, days: Math.max(...reported), confidence: 'reported', basis: 'reported' };
  }

  /*
   * The end of the window. An ad that has actually stopped ended when it
   * stopped; one still running is measured to the last time we saw it, never to
   * the current clock, because we cannot claim a day we did not observe.
   */
  const stopped = observations
    .filter((o) => !o.isActive && o.endDate != null)
    .map((o) => o.endDate as number);
  const endsAt = stopped.length ? Math.max(...stopped) : lastSeen;

  const starts = observations
    .filter((o) => o.startDate != null)
    .map((o) => o.startDate as number);

  const fromStart = starts.length ? floorDays(Math.min(...starts), endsAt) : null;
  /*
   * The span that exists only because we were recording. One sighting is a
   * moment and proves no duration at all, so this needs two.
   */
  const fromSightings = observations.length >= 2 ? floorDays(firstSeen, endsAt) : null;

  if (fromStart === null && fromSightings === null) {
    return { ...base, days: null, confidence: 'none', basis: 'none' };
  }

  /*
   * Whichever window is wider is the one more of the ad's life is evidenced by,
   * and a start date normally reaches back further than our first sighting.
   * Ties go to the start date, since it is the stronger provenance.
   */
  if (fromStart !== null && (fromSightings === null || fromStart >= fromSightings)) {
    return { ...base, days: fromStart, confidence: 'observed', basis: 'start-date' };
  }
  return { ...base, days: fromSightings, confidence: 'observed', basis: 'observation-span' };
}

/*
 * The shape the format verdict consumes, built from the observation history
 * rather than from the frozen number on the latest row.
 *
 * This is the join that matters: `latestAdsByCategory` says what the ad IS, the
 * observation history says how long it has RUN, and only the second one is
 * ours.
 */
export interface DurationResolvedAd {
  adId: string;
  advertiser: string;
  creative: AdObservation['creative'];
  platforms: string[];
  daysRunning: number | null;
  durationConfidence: DurationConfidence;
  basis: DerivedDuration['basis'];
  observations: number;
}

export function resolveAdDuration(
  latest: AdObservation,
  history: readonly AdObservation[],
): DurationResolvedAd {
  /*
   * The latest row is itself an observation, so a caller that passes only the
   * history it fetched separately still gets a correct span. Deduped by
   * observedAt so including it twice cannot widen a window.
   */
  const merged = history.some((o) => o.observedAt === latest.observedAt)
    ? history
    : [...history, latest];
  const derived = deriveDuration(merged);

  return {
    adId: latest.adId,
    advertiser: latest.advertiser,
    creative: latest.creative,
    platforms: latest.platforms ?? [],
    daysRunning: derived.days,
    durationConfidence: derived.confidence,
    basis: derived.basis,
    observations: derived.observations,
  };
}
