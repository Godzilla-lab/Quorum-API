/*
 * The Source interface.
 *
 * This is the extensibility story and the reason the project is worth open
 * sourcing. In the engine, every source was wired directly into a 961 line
 * orchestrator, so adding one meant editing the file that runs everything. One
 * interface fixes that: contributors add sources, sources feed the corpus, and
 * the corpus is the asset.
 *
 * Success criterion: adding a source touches only its own directory.
 */

import type { DocInput, SourceId } from '@quorum/corpus';

/*
 * Environment, passed rather than read from process.env.
 *
 * An adapter that reaches for process.env directly cannot be tested without
 * mutating global state, and cannot be run twice in one process with different
 * configurations, which is exactly what a hosted server does.
 */
export type Env = Readonly<Record<string, string | undefined>>;

export interface PlanInput {
  /* What the product is, in the words the market would use. */
  category: string;
  productTitle: string;
  productUrl: string;

  /*
   * What to ASK about. Single concept terms: "sizing", "durability", "smell".
   * Multi word queries AND together and go empty fast.
   */
  terms: string[];

  /*
   * Where to LOOK. Name hints for finding communities: "running", "runners",
   * "marathon".
   *
   * These are a different thing from `terms` and conflating them is a real bug,
   * found live on 2026-08-22. Subreddit discovery is a NAME prefix search, so
   * feeding it "sizing" looks for a community literally called sizing, finds
   * nothing, and the source silently plans zero queries. The engine keeps the
   * two apart for exactly this reason.
   *
   * Optional: a source that does not need community discovery ignores it, and
   * one that does falls back to the words in the category.
   */
  subredditTerms?: string[];

  /*
   * The vocabulary a buyer uses when discussing the subject, guessed by the
   * plan time expansion. Consumed by the record gate to demand that a record
   * passing on its container's word alone says something about the subject
   * itself. TIGHTENS ONLY: absent means the gate behaves as it always did,
   * and its presence can never admit a record the gate would have rejected.
   * See isRelevantRecord in relevance.ts.
   */
  contextTerms?: string[];
}

export interface Query {
  /* Free text for the upstream. */
  text: string;
  /* Optional scope, meaning depends on the source: a subreddit, a forum, a page. */
  scope?: string;
  /* Only look back this far, in days. Zero or absent means all time. */
  withinDays?: number;
}

export interface CostMeterLike {
  charge(key: string, count?: number): number;
  canSpend(estimateUsd: number): boolean;
}

export interface Ctx {
  env: Env;
  /* Charged on every paid call. Free sources may ignore it. */
  cost: CostMeterLike;
  /* Cooperative cancellation, so a cancelled report stops spending. */
  signal?: AbortSignal;
  /* Structured progress, so a long retrieval is not a silent spinner. */
  log?: (message: string) => void;
}

/*
 * A retrieved record on its way to the corpus, plus whatever the adapter needs
 * to render it as a citation later.
 */
export interface SourceRecord extends DocInput {
  /* Human readable place this came from: "r/running", "Hacker News". */
  origin: string;
}

export interface Citation {
  /* One line, as a reader would see it under a quote. */
  label: string;
  url: string;
  /* Upvotes, likes, points. Whatever this source counts. */
  score: number;
  /* Unix seconds, or 0 when the source does not report one. */
  postedAt: number;
}

export interface Source {
  readonly id: SourceId | string;
  /*
   * Free sources may be run without asking. Metered ones must check the cost
   * meter before spending, and must be omittable from a free tier.
   */
  readonly cost: 'free' | 'metered';

  /*
   * What `SourceRecord.channel` actually is, which the relevance gate needs and
   * cannot infer.
   *
   *   title   natural language, like a Hacker News story headline
   *   handle  a squashed identifier, like a subreddit name
   *
   * Required rather than optional, so adding a source means deciding. Getting
   * this wrong is not cosmetic: measured 2026-08-22, treating the subreddit
   * name "woolworths" as prose let it prefix match "wool" and vouch for all 73
   * of its own off topic records in a "wool runner" report.
   */
  readonly channelKind: 'title' | 'handle';

  /*
   * Whether this adapter can run. MUST NOT throw on a missing key, and MUST NOT
   * read process.env directly. An unconfigured source degrades a run; it never
   * fails one.
   */
  configured(env: Env): boolean;

  /* Turn a product into the queries this source understands. */
  plan(input: PlanInput): Promise<Query[]>;

  /*
   * Retrieve records for one query.
   *
   * An async iterable rather than an array so the corpus can write as results
   * arrive. A run that dies halfway then still leaves the archive better than
   * it found it, which matters when retrieval takes minutes.
   */
  retrieve(query: Query, ctx: Ctx): AsyncIterable<SourceRecord>;

  /* How one record renders as a receipt. */
  cite(record: SourceRecord): Citation;
}
