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
import { createAppStoreSource } from './appstore/index.ts';
import { createArcticShiftSource } from './reddit-arcticshift/index.ts';
import { createCpscSource } from './cpsc/index.ts';
import { createEuSafetyGateSource } from './eu-safety-gate/index.ts';
import { createGithubIssuesSource } from './github-issues/index.ts';
import { createHackerNewsSource } from './hackernews/index.ts';
import { createMetaAdsApifySource } from './meta-ads/apify.ts';
import { createNhtsaSource } from './nhtsa/index.ts';
import { createOpenFdaSource } from './openfda/index.ts';
import { createSecEdgarSource } from './sec-edgar/index.ts';

/* Every free source, in the order a run should try them. */
export const SOURCE_IDS = [
  'reddit', 'hackernews', 'github', 'appstore', 'cpsc', 'openfda', 'nhtsa', 'sec-edgar', 'eu-safety-gate',
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
    case 'cpsc': return createCpscSource();
    case 'openfda': return createOpenFdaSource();
    case 'nhtsa': return createNhtsaSource();
    case 'appstore': return createAppStoreSource();
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
