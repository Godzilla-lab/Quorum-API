/*
 * The adapter registry.
 *
 * Success criterion 4 is that adding a source touches only its own directory.
 * A factory that lived in the CLI broke that quietly: the CLI had one switch
 * statement and the server, needing the same adapters, would have had a second.
 * Two registries drift, and the way they drift is that a source added to one is
 * silently missing from the other, which reads as an upstream outage.
 *
 * So there is one, here, next to the adapters it names. `SOURCE_IDS` is the
 * list every caller validates against, and the factory is exhaustive over it by
 * construction: a new id with no case throws at the point of use rather than
 * returning undefined and failing three stack frames later.
 */

import type { AdSource } from './ad-source.ts';
import type { Source } from './source.ts';
import { createAmazonReviewsSource } from './amazon-reviews/index.ts';
import { createAppStoreSource } from './appstore/index.ts';
import { createArcticShiftSource } from './reddit-arcticshift/index.ts';
import { createCfpbSource } from './cfpb/index.ts';
import { createCpscSource } from './cpsc/index.ts';
import { createEuSafetyGateSource } from './eu-safety-gate/index.ts';
import { createGithubIssuesSource } from './github-issues/index.ts';
import { createHackerNewsSource } from './hackernews/index.ts';
import { createMetaAdsApifySource } from './meta-ads/apify.ts';
import { createNhtsaSource } from './nhtsa/index.ts';
import { createOpenFdaSource } from './openfda/index.ts';
import { createSecEdgarSource } from './sec-edgar/index.ts';
import { createYoutubeSource } from './youtube/index.ts';

/*
 * Every record source a run tries, in order. All free and keyless except
 * two: `youtube` costs nothing but needs a free QUORUM_YOUTUBE_API_KEY for
 * the official Data API, and `amazon` is metered through the Apify account.
 * Both report themselves unconfigured without their key, amazon plans
 * nothing unless the subject is an Amazon product and checks the spend cap
 * before every call, so their presence costs a keyless run exactly nothing.
 *
 * THE ORDER IS FASTEST AND RICHEST FIRST, because sources run one after
 * another and records are searchable the moment they are written, so the
 * order decides how soon a caller polling a running report sees anything.
 * Measured 2026-09-13 over 37 hosted cold runs stored in report_snapshots,
 * average seconds and records written per source: hackernews 4s/66,
 * appstore 2s/22, youtube 12s/415, github 27s/27, reddit 92s/162. Reddit used
 * to run first, so the first useful batch landed at a median 105s; with it
 * fifth, a hundred records exist inside 20s at no extra cost to any archive.
 * The attested tier follows (cpsc 2s/3, sec-edgar 16s/12, openfda 63s/4,
 * nhtsa 9s/0, eu-safety-gate 11s/0): low volume by nature, and openfda is
 * the second slowest source in the run for the fewest records. Amazon last
 * because it plans nothing without an ASIN and costs 0s when it does not.
 * cfpb (added 2026-09-13, one search of about 1.3s per query) sits before
 * reddit for the same reason the others do.
 */
export const SOURCE_IDS = [
  'hackernews', 'appstore', 'youtube', 'github', 'cfpb', 'reddit', 'cpsc', 'sec-edgar', 'openfda', 'nhtsa', 'eu-safety-gate', 'amazon',
] as const;

/*
 * Ad sources are separate because they are metered and because their records go
 * to a different table. They run only when configured, so a caller with no
 * Apify account never spends anything.
 */
export const AD_SOURCE_IDS = ['meta-ads-apify'] as const;

export type RegisteredSourceId = typeof SOURCE_IDS[number];
export type RegisteredAdSourceId = typeof AD_SOURCE_IDS[number];

export function makeSource(id: string): Source {
  switch (id) {
    case 'reddit': return createArcticShiftSource();
    case 'hackernews': return createHackerNewsSource();
    case 'github': return createGithubIssuesSource();
    case 'cfpb': return createCfpbSource();
    case 'cpsc': return createCpscSource();
    case 'openfda': return createOpenFdaSource();
    case 'nhtsa': return createNhtsaSource();
    case 'appstore': return createAppStoreSource();
    case 'youtube': return createYoutubeSource();
    case 'amazon': return createAmazonReviewsSource();
    case 'sec-edgar': return createSecEdgarSource();
    case 'eu-safety-gate': return createEuSafetyGateSource();
    /* Callers validate ids first, so this is unreachable in practice. Kept so
     * that adding a source and forgetting the switch fails loudly rather than
     * producing a run that quietly skipped a leg. */
    default: throw new Error(`no adapter registered for source ${JSON.stringify(id)}`);
  }
}

export function makeAdSource(id: string): AdSource {
  switch (id) {
    case 'meta-ads-apify': return createMetaAdsApifySource();
    default: throw new Error(`no adapter registered for ad source ${JSON.stringify(id)}`);
  }
}
