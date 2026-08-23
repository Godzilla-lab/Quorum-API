/*
 * @quorum/sources
 *
 * One adapter per source, all behind the Source interface. Adding a source
 * touches only its own directory, which is both the extensibility story and a
 * success criterion.
 *
 * Every adapter fetches through safeFetch. An adapter that calls fetch directly
 * is an SSRF hole, because the URLs come from users.
 */

export type {
  Citation, CostMeterLike, Ctx, Env, PlanInput, Query, Source, SourceRecord,
} from './source.ts';

export type { AdQuery, AdRecord, AdSource } from './ad-source.ts';

/* One registry, next to the adapters it names. See registry.ts for why. */
export { AD_SOURCE_IDS, SOURCE_IDS, makeAdSource, makeSource } from './registry.ts';
export type { RegisteredAdSourceId, RegisteredSourceId } from './registry.ts';

export { safeFetch, USER_AGENT as HTTP_USER_AGENT } from './http/safe-fetch.ts';
export type { SafeFetchOptions, SafeFetchResult, Resolver, HopResult } from './http/safe-fetch.ts';
export { checkAddress, checkScheme } from './http/ip-guard.ts';
export type { AddressVerdict } from './http/ip-guard.ts';

export { MAX_GAP_MS, MIN_GAP_MS, createThrottle, isOverloadMessage, resetSharedThrottles, sharedThrottle } from './throttle.ts';
export type { Throttle, ThrottleOptions } from './throttle.ts';

export { isRelevantRecord, matchesSubjectPhrase, scoreHandle, scoreText, subjectTerms } from './relevance.ts';
export type { RelevanceHit, RecordGateOptions } from './relevance.ts';

export { runSourceConformance, fakeCostMeter, makeCtx } from './conformance.ts';
export type { ConformanceCase } from './conformance.ts';

export { createHackerNewsSource, decodeEntities } from './hackernews/index.ts';
export type { HackerNewsOptions, HackerNewsHit } from './hackernews/index.ts';

/* Tier A, attested. A named party stated this on the record to a regulator. */
export { createCpscSource, responsibleFirm, recallText, recallDate, headNoun } from './cpsc/index.ts';
export type { CpscOptions, CpscRecall } from './cpsc/index.ts';
export { createOpenFdaSource, enforcementText, fdaDate, reportUrl, FDA_ENDPOINTS } from './openfda/index.ts';
export type { OpenFdaOptions, FdaEnforcement, FdaEndpoint } from './openfda/index.ts';

export { createNhtsaSource, parseVehicle, nhtsaDate, campaignUrl } from './nhtsa/index.ts';
export type { NhtsaOptions, NhtsaRecall, VehicleSubject } from './nhtsa/index.ts';

export { createEuSafetyGateSource, parseAlerts, alertText, reportUrls, xmlField, reportDate } from './eu-safety-gate/index.ts';
export type { EuSafetyGateOptions, SafetyGateAlert } from './eu-safety-gate/index.ts';

export { createSecEdgarSource, filingUrl, filerName, filingDate, filingText, extractPassage, bestPassage, DEFAULT_FORMS } from './sec-edgar/index.ts';
export type { SecEdgarOptions, EdgarHit, Passage } from './sec-edgar/index.ts';

/* Tier C, voice, from people who bought the thing rather than forum chatter. */
export { createAppStoreSource, reviewRating, reviewText, reviewUrl, DEFAULT_STOREFRONTS } from './appstore/index.ts';
export type { AppStoreOptions, ReviewEntry, AppSearchResult } from './appstore/index.ts';

export { parseJsonObject, parseJsonArray, arrayField } from './http/parse-json.ts';

export { createArcticShiftSource, isBotBoilerplate, isUsableComment } from './reddit-arcticshift/index.ts';
export type { ArcticShiftOptions } from './reddit-arcticshift/index.ts';
export { createArcticShiftClient, permalink, USER_AGENT } from './reddit-arcticshift/client.ts';
export type { ArcticShiftClient, ArcticShiftClientOptions } from './reddit-arcticshift/client.ts';
export { filterRelevant, relevanceScore } from './reddit-arcticshift/relevance.ts';
export type { ScoredSubreddit, SubredditCandidate } from './reddit-arcticshift/relevance.ts';

export { creativeType, hasImage, hasVideo } from './meta-ads/creative.ts';
export { COST_KEY as META_ADS_COST_KEY, adHaystack, createMetaAdsApifySource, normaliseAd } from './meta-ads/apify.ts';
export type { MetaAdsApifyOptions } from './meta-ads/apify.ts';
export type { CreativeType, RawAd } from './meta-ads/creative.ts';

export { extractJsonLdBlocks, extractProductFacts, extractTitleFallback } from './product/jsonld.ts';
export type { ProductFactsExtract } from './product/jsonld.ts';
export { inferCategory, resolveProduct } from './product/resolve.ts';
export type { ResolvedProduct, ResolveStrategy, ResolveOptions, TrailStep, Unblocker } from './product/resolve.ts';
export { brandCandidates } from './product/brands.ts';
export type { BrandCandidate, BrandOptions, BrandRecord } from './product/brands.ts';

export { brandDomains, fetchCatalogue, findProductByName, parseCatalogue, searchCatalogue } from './product/catalogue.ts';
export type { CatalogueOptions, CatalogueProduct, CatalogueResult, NameResolution, ScoredProduct } from './product/catalogue.ts';

export { archivedContentUrl, catalogueHistory, cdxUrl, delistedProducts, listSnapshots, normaliseProductUrl } from './product/cdx.ts';
export type { CatalogueEntry, CdxOptions, CdxResult, CdxSnapshot, DelistedOptions } from './product/cdx.ts';
export { COMMERCIAL_FACT_MAX_AGE_DAYS, commercialFactsUsable, fetchArchived, findSnapshot, parseWaybackTimestamp } from './product/wayback.ts';
export type { WaybackSnapshot, ArchivedPage, WaybackOptions } from './product/wayback.ts';

export { looksLikeUrl, resolveSubject, subjectFromUrlString } from './product/subject.ts';
export type { Subject, ResolveSubjectOptions } from './product/subject.ts';
export { normaliseImageUrl, normaliseImages } from './product/images.ts';
