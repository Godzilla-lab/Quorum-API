/*
 * The run.
 *
 * A thin client over core, which is the whole job of this package. Anything
 * decided here that a hosted request would also have to decide is in the wrong
 * place: the corroboration threshold, the relevance gate and the cost meter all
 * live upstream so the CLI and the server cannot drift.
 *
 * EVERY DEPENDENCY IS INJECTED. Not for purity. A CLI whose entry point opens a
 * database, reaches the network and reads the clock can only be tested by doing
 * all three, which means it is tested rarely and by hand. Here the whole run is
 * exercised offline against fakes, and `bin.ts` is the only file that touches
 * the real world.
 */

import type { CategoryStats, CorpusDriver, Doc } from '@receipts/corpus';
import {
  brandCandidates, looksLikeUrl, subjectTerms,
  type AdSource, type NameResolution, type Source, type Subject,
} from '@receipts/sources';
import {
  adsForVerdict, assessSufficiency, attestedFindings, attestedSilence, corroborate,
  createCostMeter, formatVerdict, notableGaps, productReviewDocs, retrieveAds, retrieveAll,
  diffReports, discoverThemes, parseSnapshot, reportSnapshot, shareOfVoice,
  synthesiseAndResolve, tierGap, trendFor, withEvidence,
  type AdRetrievalResult, type AskModel, type AttestedFindings, type AttestedSilence,
  type ClaimWithEvidence, type CostLine, type FormatVerdict, type RetrievalResult,
  type ReportDiff, type ShareOfVoice, type Sufficiency, type SynthesisReport, type Theme,
  type TierGap, type Trend,
} from '@receipts/core';
import type { CliOptions } from './args.ts';

/*
 * Shaped here rather than imported, so this package does not depend on the llm
 * package merely to describe an optional hook.
 */
export interface SubjectHints {
  brands: string[];
  category: string | null;
  aliases: string[];
  /* Which model guessed, because a guess with no author is not checkable. */
  model: string;
}

/*
 * A model's reading of an image. Shaped here rather than imported for the same
 * reason as SubjectHints, so this package does not depend on the llm package to
 * describe an optional hook.
 *
 * IT CARRIES NO RECEIPT ID, AND THAT IS THE POINT. Everything else in a run is
 * counted, and a thing that is counted has to be something a human wrote that a
 * reader can go and look at. A sentence generated about a picture is not that.
 * There is no field here that could put one into a corroboration count, so the
 * rule is enforced by the type rather than by remembering.
 */
export interface ImageReading {
  /* The image itself is the receipt. Without this the reading is unfalsifiable. */
  imageUrl: string;
  kind: 'transcription' | 'description';
  text: string;
  /* Which model said it. A claim with no author is not checkable. */
  model: string;
  readAt: number;
  derived: true;
}

export interface RunDeps {
  openCorpus(path: string): CorpusDriver;
  resolveSubject(input: string, options: { timeoutMs?: number; offline?: boolean }): Promise<Subject>;
  /* Ids are already validated by the parser, so an unknown one here is a bug. */
  makeSource(id: string): Source;
  makeAdSource?(id: string): AdSource;
  /* Injected so the second resolution pass is testable with no network. */
  findProductByName?(name: string): Promise<NameResolution>;
  /*
   * Asks a model what a bare product name refers to. A SEARCH HINT and never a
   * claim: it widens where we look, and cannot widen what counts as evidence.
   */
  expandSubject?(subject: string): Promise<SubjectHints | null>;
  /*
   * Reads one image. Returns null rather than throwing when unconfigured or
   * refused, because a vision provider being down degrades a run and a report
   * without image readings is still a good report.
   */
  readImage?(url: string): Promise<ImageReading | null>;
  /*
   * Asks a model to write the findings from the evidence. Injected rather than
   * imported so the whole pipeline, gate included, runs offline against a fake
   * model in a test. Absent means the run is deterministic only, which is a
   * complete report and not a degraded one.
   */
  askModel?: AskModel;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
}

export interface ReceiptCheck {
  cited: number;
  resolved: number;
  /* Ids that were cited and could not be fetched back. Must always be empty. */
  unresolved: string[];
}

export interface RunResult {
  subject: Subject;
  /* True when the subject came out of the product cache and no page was fetched. */
  subjectCached: boolean;
  /*
   * Brands the market named, when we had to ask it. Empty when the subject
   * resolved on its own.
   */
  brandsNamed: { name: string; records: number; channels: number; receiptIds: string[] }[];
  /*
   * What a model guessed this product is, when it had to be asked. Null when
   * the subject resolved on its own, or expansion is not configured.
   */
  hints: SubjectHints | null;
  category: string;
  offline: boolean;
  /* Null in offline mode, where nothing was retrieved by design. */
  retrieval: RetrievalResult | null;
  /* Null when the ads leg did not run: offline, --no-ads, or no adapter. */
  adRetrieval: AdRetrievalResult | null;
  /*
   * Null when there were no ads to read. A verdict object with a null `verdict`
   * inside it is different and means "we looked and there is not enough
   * evidence to call it", which is a real answer.
   */
  formats: FormatVerdict | null;
  /*
   * Where each ad's duration came from. Worth surfacing rather than burying,
   * because `observation-span` is the count that exists ONLY because we were
   * recording, and it is the number no competitor can reproduce.
   */
  durationBasis: { reported: number; startDate: number; observationSpan: number; none: number };
  warmth: CategoryStats;
  /*
   * Each claim carries its counts, a readable sample of what people said, and
   * how concentrated that evidence is. The sample is there because a response
   * made entirely of receipt ids is a census rather than research: measured
   * 2026-08-22, a real run returned 183 ids and not one word anybody wrote.
   */
  claims: ClaimWithEvidence[];
  /*
   * Records a named party put on the record with a regulator, surfaced because
   * they exist rather than because they matched a question.
   *
   * Null when the corpus holds none. Measured 2026-08-22: a knee brace report
   * stored twelve real FDA enforcement reports and then answered "no evidence"
   * to every question, because a recall says "sterile barrier compromised" and
   * the questions said "defects". The strongest evidence in the corpus was held
   * and never shown.
   */
  attested: AttestedFindings | null;
  /*
   * Where the two kinds of evidence disagree.
   *
   * Nobody else can compute this, because every competitor holds one kind: a
   * recall aggregator has regulators and no buyers, a listening tool has buyers
   * and no regulators. Compared on presence, never on sentiment, because a
   * sentiment delta is the unfalsifiable number this product refuses.
   */
  gaps: TierGap[];
  /*
   * WHETHER EACH QUESTION IS GETTING LOUDER, AS A SHARE OF CONVERSATION.
   *
   * The thing only a corpus that retains can answer, and the reason a report is
   * worth running twice. Computed from `createdUtc`, which has been on every
   * record since the first run and which nothing read until now.
   *
   * Share, never raw counts. Measured 2026-08-22: counting records per month
   * reported every term as rising, because retrieval returns far more recent
   * records than old ones, so it was measuring our harvest.
   */
  trends: Trend[];
  /*
   * How loud each question is against everything held for the category.
   * "15 receipts" is unreadable alone: fifteen of two hundred is a footnote and
   * fifteen of forty is the thing to fix first.
   */
  voice: ShareOfVoice[];
  /*
   * WHAT THE CORPUS IS ABOUT, AS OPPOSED TO WHAT IT WAS ASKED ABOUT.
   *
   * The caller's terms are a guess. A knee brace run held twelve real FDA
   * reports about a sterile barrier and answered "no evidence" to every
   * question, because the caller had typed "defects". A report that can only
   * answer the question it was handed is a search box.
   *
   * A CANDIDATE LIST, NOT A SET OF FINDINGS. Produced by counting phrases, so
   * every entry carries its receipts and a reader can disagree in one request.
   */
  themes: Theme[];
  /*
   * The month this report answers as of, or null for now. Carried so a reader
   * of the json can never mistake a historical answer for a current one.
   */
  asOf: string | null;
  /*
   * WHAT CHANGED SINCE THE LAST RUN FOR THIS CATEGORY.
   *
   * Null on the first run, which is honest: there is nothing to compare
   * against and a first report is not an event. This is the only part of the
   * output that gets better purely by existing for longer, and it is the
   * reason to run the same question twice.
   */
  diff: ReportDiff | null;
  /*
   * What a model wrote, with every id it cited already fetched back out of the
   * corpus. Null when --synthesise was not passed, when the run was offline, or
   * when no model transport was supplied.
   *
   * SEPARATE FROM `claims` AND NEVER MERGED INTO THEM. `claims` are arithmetic
   * over the corpus and are true whether or not a model ran. These are
   * sentences somebody's model wrote, gated on receipts that resolve. A reader
   * who cannot tell the two apart has lost the property the product sells.
   */
  synthesis: SynthesisReport | null;
  /*
   * Nothing attested, reported as a result rather than as an absence. Null when
   * something was found, or when no attested source actually answered, because
   * a skipped regulator proves nothing.
   */
  silence: AttestedSilence | null;
  /*
   * What a model read in the product images, when asked with --read-images.
   *
   * SEPARATE FROM `claims` ON PURPOSE, and never merged into them. These are
   * interpretations. They are cited by nothing, counted in nothing, and they
   * cannot reach the corpus, because `addDocs` takes a DocInput and this is not
   * one. A test asserts the corpus never sees them.
   */
  readings: ImageReading[];
  /*
   * Whether this was enough to answer anything, and what would fix it if not.
   * "Not enough evidence" is an answer and it is reported as one.
   */
  sufficiency: Sufficiency;
  receiptCheck: ReceiptCheck;
  cost: { totalUsd: number; lines: CostLine[]; hasUnverified: boolean; overCap: boolean };
  elapsedMs: number;
}

/* How many records back a single claim before we stop counting. Well above the
 * corroboration threshold, and bounded so a warm category cannot pull its whole
 * corpus into memory per term. */
const EVIDENCE_PER_TERM = 500;

/*
 * Which source ids carry attested evidence. Declared here rather than imported
 * from the parser, because a run may be driven by something other than the CLI
 * and silence must mean the same thing wherever it is computed.
 */
const ATTESTED_SOURCE_IDS = new Set(['cpsc', 'openfda', 'nhtsa', 'sec-edgar', 'eu-safety-gate']);

/*
 * How long a cached product page stays usable.
 *
 * Shorter than the corpus warmth window on purpose. A comment someone wrote
 * last year still says what they thought; a price from last year does not.
 * Seven days is the point where a re-fetch is worth its cost for a store that
 * may be blocking us anyway, and a fresh --corpus path bypasses it entirely.
 */
const PRODUCT_CACHE_MAX_AGE_DAYS = 7;

/*
 * A Subject stored as ProductFacts and read back. ProductFacts is an open
 * record so the round trip is lossless, but it arrives back as unknown shaped
 * data, so it is checked rather than trusted: a corpus row is data, and a
 * hand edited or partially written one must degrade to a re-fetch instead of
 * producing a Subject with holes in it.
 */
function subjectFromCache(facts: Record<string, unknown> | null): Subject | null {
  if (!facts) return null;
  const { category, title, source } = facts;
  if (typeof category !== 'string' || !category) return null;
  if (typeof title !== 'string') return null;
  if (source !== 'text' && source !== 'catalogue' && source !== 'page' && source !== 'url-fallback') return null;
  return {
    ...(facts as unknown as Subject),
    category,
    title,
    source,
    images: Array.isArray(facts['images']) ? (facts['images'] as string[]) : [],
    reviews: Array.isArray(facts['reviews']) ? (facts['reviews'] as Subject['reviews']) : [],
  };
}

export async function runResearch(options: CliOptions, deps: RunDeps): Promise<RunResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const log = deps.onProgress ?? (() => {});

  const cost = createCostMeter({
    label: 'receipts-cli',
    ...(options.capUsd === undefined ? {} : { capUsd: options.capUsd }),
    now,
  });

  const corpus = deps.openCorpus(options.corpusPath);

  try {
    /*
     * Resolution is an ENRICHMENT, never a gate. It makes a report better when
     * it works and is skipped when it does not, so a blocked store never costs
     * a run.
     *
     * The cache is consulted first, and only for a URL, because a plain text
     * subject costs nothing to resolve. This is the leg that would otherwise
     * re-pay an unblocker on every repeat run of the same product.
     */
    const isUrl = looksLikeUrl(options.subject);
    const cached = isUrl
      ? subjectFromCache(await corpus.getProduct(options.subject, PRODUCT_CACHE_MAX_AGE_DAYS) as Record<string, unknown> | null)
      : null;

    let subject = cached ?? await deps.resolveSubject(options.subject, {
      timeoutMs: 12_000,
      offline: options.offline,
    });
    const category = subject.category;
    log(`subject: ${JSON.stringify(category)} via ${subject.source}${cached ? ', from cache' : ''}`);
    if (subject.note) log(`note: ${subject.note}`);

    /*
     * EXPANSION, BEFORE RETRIEVAL, BECAUSE IT DECIDES WHERE TO LOOK.
     *
     * A bare name finds nothing: "wool runner" guesses wool.com and matches
     * r/woolworths. Asking a model what the name refers to gives a category and
     * aliases that make community discovery possible, and sometimes a brand
     * that then resolves to a real product.
     *
     * IT CANNOT WIDEN WHAT COUNTS AS EVIDENCE. The hints feed `subredditTerms`,
     * which is WHERE to look, and never the relevance gate, which is WHAT is on
     * topic. If the model decides a wool runner is a sock, sock records are
     * still gated out against the subject as typed.
     */
    let hints: SubjectHints | null = null;
    if (!options.offline && subject.source === 'text' && deps.expandSubject) {
      hints = await deps.expandSubject(options.subject);
      if (hints) {
        log(`hints from ${hints.model}: ${hints.category ?? 'no category'}`);
        /* Every hinted brand is verified against a real catalogue. A
         * hallucinated one fails that and costs exactly one request. */
        if (deps.findProductByName) {
          for (const brand of hints.brands.slice(0, 2)) {
            const found = await deps.findProductByName(`${brand} ${options.subject}`);
            if (!found.match) continue;
            const m = found.match;
            log(`hinted brand ${brand} has this product`);
            subject = {
              ...subject,
              title: m.title,
              source: 'catalogue',
              url: m.url,
              brand: m.vendor ?? brand,
              price: m.price ?? undefined,
              images: m.images,
              note: `brand suggested by ${hints.model}, then verified against the store catalogue`,
            };
            break;
          }
        }
      }
    }

    /* WHERE to look, never what is on topic. See the block above. */
    const discoveryTerms = [...new Set([
      ...options.communities,
      ...(hints?.category ? hints.category.split(/\s+/) : []),
      ...(hints?.aliases ?? []).flatMap((a: string) => a.split(/\s+/)),
    ].map((t) => t.trim().toLowerCase()).filter((t) => t.length > 2))];

    /*
     * Only worth storing when a page was actually read. A url-fallback subject
     * is derived from the URL string with no network, so caching it would save
     * nothing and would keep us from retrying a store that is back up.
     */
    if (isUrl && !cached && subject.source === 'page') {
      await corpus.cacheProduct({ ...subject, url: options.subject }, category);
    }

    let retrieval: RetrievalResult | null = null;

    if (!options.offline) {
      const sources = options.sources.map((id) => deps.makeSource(id));
      retrieval = await retrieveAll({
        sources,
        corpus,
        plan: {
          category,
          productTitle: subject.title || category,
          productUrl: subject.url ?? '',
          terms: options.terms,
          ...(discoveryTerms.length ? { subredditTerms: discoveryTerms } : {}),
        },
        ctx: {
          env: deps.env ?? {},
          cost,
          ...(deps.signal ? { signal: deps.signal } : {}),
          log,
        },
        deadlineMs: options.deadlineMs,
        maxRecordsTotal: options.maxRecordsTotal,
        maxQueriesPerSource: options.maxQueriesPerSource,
        onProgress: (u) => log(`${u.source}: ${u.seen} seen, ${u.written} stored`),
      });

      /*
       * Remember the plan that worked, so a repeat run skips re-planning. Only
       * after a real retrieval: recording a plan an offline run never executed
       * would make the next run believe a route had been proven.
       */
      await corpus.rememberCategory(category, {
        subreddits: options.communities,
        queries: options.terms,
      });
    }

    /*
     * SECOND RESOLUTION PASS: LET THE MARKET NAME THE BRAND.
     *
     * Guessing a domain from a name only works when the brand is the first
     * word. Measured 2026-08-22, five bare names in a row found nothing:
     * "wool runner" guesses wool.com, which is not a strategy.
     *
     * But the records we have just retrieved are full of people naming brands,
     * because that is what people do when they discuss products. So when the
     * subject did not resolve, we ask the corpus who makes this, and try the
     * few names it offers. A wrong guess costs one request that finds nothing,
     * which is why cheap recall plus hard verification beats trying to be right
     * first time.
     */
    let resolvedSubject = subject;
    let brandsNamed: RunResult['brandsNamed'] = [];
    if (!options.offline && subject.source === 'text' && deps.findProductByName) {
      const rows = await corpus.byCategory(category, { limit: 400 });
      const candidates = brandCandidates(rows, {
        exclude: subjectTerms([category, subject.title]),
      });
      /* The receipt ids travel with the candidate. A capitalised word heuristic
       * is allowed to guess; it is not allowed to guess without showing its
       * working, and a reader who can fetch the records sees immediately that
       * "China" was never a brand. */
      brandsNamed = candidates.map((c) => ({
        name: c.name, records: c.records, channels: c.channels, receiptIds: c.receiptIds,
      }));

      /* Three, not all of them. Each is a real request to a stranger's host. */
      for (const candidate of candidates.slice(0, 3)) {
        const found = await deps.findProductByName(`${candidate.name} ${options.subject}`);
        if (!found.match) continue;
        const m = found.match;
        log(`the market named ${candidate.name}, and it has this product`);
        resolvedSubject = {
          ...subject,
          title: m.title,
          source: 'catalogue',
          url: m.url,
          brand: m.vendor ?? candidate.name,
          price: m.price ?? undefined,
          images: m.images,
          note: `brand identified from ${candidate.records} records across ${candidate.channels} channels`,
        };
        break;
      }
    }

    /*
     * The ads leg, after the records leg and never instead of it. It is the only
     * metered thing in a run, so it goes last: if a deadline or a spend cap cuts
     * the run short, the free evidence is already gathered and written.
     */
    let adRetrieval: AdRetrievalResult | null = null;
    if (!options.offline && options.adSources.length && deps.makeAdSource) {
      const makeAdSource = deps.makeAdSource;
      adRetrieval = await retrieveAds({
        sources: options.adSources.map((id) => makeAdSource(id)),
        corpus,
        plan: {
          category,
          productTitle: subject.title || category,
          productUrl: subject.url ?? '',
          terms: options.terms,
        },
        ctx: {
          env: deps.env ?? {},
          cost,
          ...(deps.signal ? { signal: deps.signal } : {}),
          log,
        },
        onProgress: (u) => log(`${u.source}: ${u.observed} ads observed`),
      });
    }

    /*
     * REVIEWS FROM THE PRODUCT PAGE'S OWN MARKUP.
     *
     * These were parsed out of the page during subject resolution and then
     * dropped on the floor: `Subject.reviews` was populated on every run that
     * read a page and consumed by nothing, while the report went off to ask a
     * forum what buyers thought. Found 2026-08-22 by looking for what we
     * already had rather than for what was missing.
     *
     * Written directly rather than through a Source, because a Source fetches
     * and this page is already in hand. Not gated, because a review on a
     * product's own page is about that product by construction, and gating
     * would drop the best ones: "runs small, order a size up" never names the
     * product because the reader already knows what page they are on.
     */
    const reviewDocs = productReviewDocs({
      url: resolvedSubject.url ?? subject.url ?? options.subject,
      reviews: resolvedSubject.reviews.length ? resolvedSubject.reviews : subject.reviews,
    });
    if (reviewDocs.length) {
      const written = await corpus.addDocs(reviewDocs, category);
      log(`${reviewDocs.length} reviews in the page markup, ${written} new`);
    }

    /*
     * IMAGE READING, LAST IN THE PIPELINE AND ONLY WHEN ASKED FOR.
     *
     * Last for the same reason the ads leg is last: it is the slowest thing
     * here by an order of magnitude, measured 2026-08-22 at 151s for the first
     * image and 38.7s for the second, against a whole cold run at 39.9s. If a
     * deadline or a cancellation cuts the run short, every piece of evidence is
     * already gathered and written before this starts.
     *
     * Bounded by --max-images and cancellable between images, because an
     * unbounded loop over a product page with forty photographs is an hour
     * nobody asked for.
     */
    const readings: ImageReading[] = [];
    if (!options.offline && options.readImages && deps.readImage) {
      const images = resolvedSubject.images.slice(0, options.maxImages);
      if (!images.length) {
        log('--read-images was passed and this subject has no images');
      }
      for (const url of images) {
        if (deps.signal?.aborted) break;
        const reading = await deps.readImage(url);
        if (reading) {
          readings.push(reading);
          log(`${reading.model} read an image, ${reading.text.length} characters`);
        } else {
          log(`could not read ${url}`);
        }
      }
    }

    /*
     * Read back from the corpus rather than from what we just retrieved, so a
     * warm category still gets a verdict with no network at all, and so every
     * duration is derived from the FULL observation history rather than from
     * the single sighting this run happened to make.
     */
    const ads = await adsForVerdict(corpus, category);
    const formats = ads.length ? formatVerdict(ads) : null;
    const durationBasis = {
      reported: ads.filter((a) => a.basis === 'reported').length,
      startDate: ads.filter((a) => a.basis === 'start-date').length,
      observationSpan: ads.filter((a) => a.basis === 'observation-span').length,
      none: ads.filter((a) => a.basis === 'none').length,
    };

    const warmth = await corpus.categoryStats(category);

    /*
     * Read once and reused: the attested block is built from everything held
     * for the category rather than from a term search, which is the whole point
     * of it. The limit is generous because tier A sources are low volume by
     * nature, and a recall nobody sees is a recall we may as well not hold.
     */
    /*
     * THE AS-OF WINDOW.
     *
     * An end of month boundary in UTC, so "2026-03" means everything written up
     * to the last second of March. Built by asking for the first of the NEXT
     * month and stepping back one second, which needs no table of month lengths
     * and gets February right in a leap year for free.
     */
    const asOfWindow = ((): { until: number } | null => {
      if (!options.asOf) return null;
      const [year, month] = options.asOf.split('-').map(Number) as [number, number];
      /* Month is 1 based in the flag and 0 based in Date, so `month` alone is
       * already the month after the one asked for. */
      return { until: Math.floor(Date.UTC(year, month, 1) / 1000) - 1 };
    })();
    const window = asOfWindow ?? {};

    const held: Doc[] = await corpus.byCategory(category, { limit: 1000, ...window });
    const attested = attestedFindings(held);

    const claims: ClaimWithEvidence[] = [];
    /* Held, because the gap analysis below needs the same rows the count used.
     * Re-querying would let a gap point at evidence the claim did not use. */
    const claimRecords = new Map<string, Doc[]>();
    for (const term of options.terms) {
      const rows: Doc[] = await corpus.search(term, { category, limit: EVIDENCE_PER_TERM, ...window });
      claimRecords.set(term, rows);
      /* The same rows that produced the count produce the sample, so a quote can
       * never come from a record that was not counted. */
      claims.push(withEvidence(corroborate(term, rows), rows));
    }

    /*
     * Discovered from the records already read for the attested block, so this
     * costs no extra query. Excludes the subject's own words and everything the
     * caller asked about, because offering a term back to the person who typed
     * it is not a discovery.
     */
    const themes = discoverThemes(held, {
      exclude: [category, resolvedSubject.title, ...options.terms],
    });

    /*
     * TREND, FROM DATES WE HAVE ALWAYS STORED AND NEVER READ.
     *
     * Two aggregate queries per term plus one for the denominator, all indexed
     * counts rather than rows: a share of conversation needs the WHOLE
     * denominator, and computing it from a capped page of records would
     * silently measure the cap.
     *
     * Runs offline, because it is arithmetic over what is already held.
     */
    const categoryHistogram = await corpus.dateHistogram({ category, ...window });
    const trends: Trend[] = [];
    for (const term of options.terms) {
      const termHistogram = await corpus.dateHistogram({ category, query: term, ...window });
      /* An as-of run trends against the windows that month implies, not against
       * today, or a historical report would compare March to last week. */
      trends.push(trendFor({
        term, termHistogram, categoryHistogram,
        nowMs: asOfWindow ? asOfWindow.until * 1000 : now(),
      }));
    }

    /*
     * Deliberately built from `claims[].records` rather than from the histogram
     * totals, even though the histogram is uncapped and would be marginally
     * more precise. Two numbers for "how many records mention sizing" in one
     * report is the self contradiction this project keeps finding, and being
     * consistent with the number a reader can check beats being right in the
     * third decimal place.
     */
    /*
     * THE DENOMINATOR IS WINDOWED TOO, and it has to be.
     *
     * `warmth.docs` counts the whole category. Dividing a windowed numerator by
     * it would report March's mentions as a share of everything ever said,
     * which is the exact bug the trend module was built to avoid, in a second
     * place. The histogram already carries the window.
     */
    const windowedRecords = asOfWindow
      ? categoryHistogram.buckets.reduce((n, b) => n + b.records, 0)
      : warmth.docs;
    const voice = shareOfVoice(
      claims.map((c) => ({ term: c.term, records: c.records })),
      windowedRecords,
    );

    /*
     * THE GAP BETWEEN WHAT IS ATTESTED AND WHAT IS SAID.
     *
     * Computed from the same rows that produced each count, so a gap can never
     * point at evidence the claim did not use.
     */
    const gaps = notableGaps(claims.map((c) => tierGap(c, claimRecords.get(c.term) ?? [])));

    /*
     * Which regulators actually answered. A source that was skipped or degraded
     * proves nothing, so silence is only claimed on the ones that completed.
     */
    const attestedRan = (retrieval?.outcomes ?? [])
      .filter((o) => o.status === 'ok' && ATTESTED_SOURCE_IDS.has(o.sourceId))
      .map((o) => o.sourceId);
    const silence = attestedSilence(attestedRan, attested?.records ?? 0);

    /*
     * SYNTHESIS, AND ITS GATE, IN ONE CALL.
     *
     * The records handed to the model are exactly the rows that produced the
     * counts above, deduped by receipt id. Not a fresh query: a model reasoning
     * over evidence the corroboration count never saw could cite a record the
     * report cannot account for, and the two halves of the report would be
     * describing different corpora.
     *
     * It runs after everything deterministic is already computed, so a provider
     * being down costs the prose and nothing else.
     */
    let synthesis: SynthesisReport | null = null;
    if (!options.offline && options.synthesise && deps.askModel) {
      const forModel = [...new Map(
        [...claimRecords.values()].flat().map((r) => [r.receiptId, r]),
      ).values()];
      synthesis = await synthesiseAndResolve(
        {
          subject: resolvedSubject.title || category,
          terms: options.terms,
          records: forModel,
        },
        deps.askModel,
        corpus,
      );
      /*
       * Charged from the tokens the provider reported rather than from an
       * estimate. A free model reports real token counts and charges nothing,
       * which is the honest zero; a paid one charges its rate card.
       */
      if (synthesis.model && synthesis.usage) {
        cost.usage(synthesis.model, {
          input_tokens: synthesis.usage.inputTokens,
          output_tokens: synthesis.usage.outputTokens,
        });
      }
      if (synthesis.error) log(`synthesis degraded: ${synthesis.error}`);
      else log(`${synthesis.model} wrote ${synthesis.claims.length} claims, ${synthesis.fabrication.idsFabricated} invented ids`);
    }

    /*
     * THE DIFF, AND THE SNAPSHOT THAT MAKES THE NEXT ONE POSSIBLE.
     *
     * `saveReport` and `priorReports` have been on the driver and in the
     * conformance suite since M1 and were called by NOTHING. Storage built and
     * never wired is the failure this codebase keeps finding in itself, and it
     * is why a reachability audit runs.
     *
     * The prior snapshot is read BEFORE the new one is written, or a run would
     * diff against itself and report that nothing ever changes.
     */
    const nowSeconds = Math.floor(now() / 1000);
    const snapshot = reportSnapshot({
      category,
      createdAt: nowSeconds,
      corpusRecords: warmth.docs,
      claims,
      attestedRecords: attested?.records ?? 0,
      themes,
      trends,
    });

    let diff: ReportDiff | null = null;
    const [mostRecent] = await corpus.priorReports(category, 1);
    if (mostRecent) {
      const previous = parseSnapshot(mostRecent.findings);
      /* A snapshot written by an older build, or half written by a run that
       * died, degrades to no comparison rather than to a diff full of holes. */
      if (previous) diff = diffReports(previous, snapshot);
    }

    /*
     * Written after the diff and never in offline mode. An offline run answers
     * from the corpus without retrieving, so recording it as a report would
     * make the next run believe the corpus had been refreshed on this date.
     */
    /*
     * An as-of run is a question about the past, so it never becomes the
     * baseline the NEXT run diffs against. Recording one would make tomorrow's
     * report announce that six months of evidence had just arrived.
     */
    if (!options.offline && !options.asOf) {
      await corpus.saveReport({
        productUrl: resolvedSubject.url ?? options.subject,
        productTitle: resolvedSubject.title,
        category,
        /* The rendered report is not available here and rendering is the
         * caller's job, so the row stores the machine readable half. The
         * markdown column stays empty rather than holding a half report. */
        markdown: '',
        findings: snapshot,
        costUsd: cost.total(),
      });
    }

    /*
     * THE ANTI FABRICATION CHECK, IN THE PRODUCTION PATH.
     *
     * Every receipt cited under a finding is fetched back before anything is
     * printed, and a claim whose receipts do not all resolve does not ship.
     *
     * Today this is close to a tautology, because the ids come from corpus rows
     * we just read. It stops being one the moment a model supplies them, which
     * is the next milestone. The check goes in now, while it costs nothing, so
     * that when synthesis lands there is already a wall for it to hit instead of
     * a wall that has to be built under pressure.
     */
    const sufficiency = assessSufficiency({
      retrieval,
      claims,
      corpusRecords: warmth.docs,
      subjectResolved: resolvedSubject.source === 'page' || resolvedSubject.source === 'catalogue',
    });

    /*
     * EVERY RECEIPT THE REPORT PRINTS, not only the ones under a term claim.
     *
     * The attested block quotes records and shows their ids, so those ids are
     * cited in every sense that matters and must be fetched back like any
     * other. Leaving them out reported "0 cited, 0 resolved" on a report that
     * had just printed three quotes, which is the check quietly not running.
     */
    const cited = [...new Set([
      ...claims.filter((c) => c.verdict === 'finding').flatMap((c) => c.receiptIds),
      /* The sample is what was printed; the rest are listed for checking. */
      ...(attested?.evidence.map((e) => e.receiptId) ?? []),
      ...claims.flatMap((c) => c.evidence.map((e) => e.receiptId)),
      /* Everything a printed synthesis claim rests on. The gate already
       * resolved these, so they must all pass here too, and a mismatch means
       * the two checks are looking at different corpora. */
      ...(synthesis?.claims ?? [])
        .filter((c) => c.verdict === 'finding')
        .flatMap((c) => c.receipts.map((r) => r.receiptId)),
    ])];
    const resolved = cited.length ? await corpus.getByReceiptIds(cited) : [];
    const resolvedIds = new Set(resolved.map((r) => r.receiptId));
    const receiptCheck: ReceiptCheck = {
      cited: cited.length,
      resolved: resolvedIds.size,
      unresolved: cited.filter((id) => !resolvedIds.has(id)),
    };

    return {
      subject: resolvedSubject,
      subjectCached: cached !== null,
      brandsNamed,
      hints,
      category,
      offline: options.offline,
      retrieval,
      adRetrieval,
      formats,
      durationBasis,
      warmth,
      claims,
      attested,
      gaps,
      silence,
      trends,
      voice,
      themes,
      asOf: options.asOf ?? null,
      diff,
      synthesis,
      readings,
      sufficiency,
      receiptCheck,
      cost: cost.toJSON(),
      elapsedMs: Math.max(1, now() - startedAt),
    };
  } finally {
    /* The corpus closes whether the run succeeded or threw. A run that dies at
     * minute forty still leaves a readable database behind. */
    await corpus.close();
  }
}
