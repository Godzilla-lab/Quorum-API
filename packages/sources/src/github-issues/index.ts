/*
 * GitHub issues, via the official search API.
 *
 * WHY THIS IS TIER B. An issue is not an opinion about a product, it is an
 * observable state of one: a filed defect with a number, a timestamp, a
 * reaction count and a lifecycle anyone can audit. "371 people reacted to the
 * report that sync loses data" is transactional evidence in a way a forum
 * comment is not, which is why `github` sits in tier B in the corpus tier map
 * and why this adapter exists: without it the tier held only metered ads, so
 * cross tier corroboration could not fire on a free run.
 *
 * THE OFFICIAL API, NOT SCRAPING. Keyless works: the search endpoint allows
 * 10 requests a minute with no account, which covers a full run's queries.
 * A GITHUB_TOKEN, when present, is used, and that does not breach the never
 * authenticate rule: that rule is about scraped sources, where a credential
 * forfeits the logged out legal footing. This is a vendor's documented API
 * used exactly as documented, the same category as the paid vendor APIs we
 * hold accounts with.
 *
 * ISSUES ONLY, NO COMMENT THREADS, in this version. The search response
 * carries each issue's full body, so a run costs one request per query.
 * Comments would cost one request per issue against a 60 per hour keyless
 * core limit, which is a different design and can be added behind the token.
 *
 * Fixture captured live 2026-08-24 from a keyless search. Captured, never
 * authored: the Hacker News adapter once shipped a filter on a field its
 * hand written fixture had invented, and matched zero real records forever.
 */

import type { Citation, Ctx, Env, PlanInput, Query, Source, SourceRecord } from '../source.ts';
import { safeFetch } from '../http/safe-fetch.ts';
import { createThrottle, type Throttle } from '../throttle.ts';
import { isRelevantRecord, subjectTerms } from '../relevance.ts';
import { arrayField, parseJsonObject } from '../http/parse-json.ts';

const BASE = 'https://api.github.com/search/issues';

/* The API's own page cap. One page per query is the useful unit, as with the
 * Algolia adapter: a screen of the most reacted to issues per question. */
const PER_PAGE = 100;

/*
 * Keyless search allows 10 requests a minute, measured against the documented
 * limit on 2026-08-24. One request every 6.1 seconds keeps a full run of six
 * queries inside it with margin, and a hosted server stays one polite client.
 */
const MIN_GAP_MS = 6_100;

export interface GithubIssueItem {
  number?: number | null;
  title?: string | null;
  body?: string | null;
  html_url?: string | null;
  repository_url?: string | null;
  created_at?: string | null;
  reactions?: { total_count?: number | null } | null;
  /* Present on pull requests, which the search endpoint returns alongside
   * issues however firmly `is:issue` asks it not to. */
  pull_request?: unknown;
}

export interface GithubSearchResponse {
  items?: GithubIssueItem[];
}

/*
 * Issue bodies arrive as markdown written for maintainers: fenced code blocks,
 * stack traces, HTML comments left by issue templates, and embedded images.
 * None of that is a person describing a product problem, and all of it costs
 * prompt tokens and dilutes the relevance gate's focus rule, so it goes.
 */
export function cleanIssueBody(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* "https://api.github.com/repos/microsoft/playwright" -> "microsoft/playwright" */
export function repoFromUrl(repositoryUrl: string): string {
  const marker = '/repos/';
  const at = repositoryUrl.indexOf(marker);
  return at === -1 ? repositoryUrl : repositoryUrl.slice(at + marker.length);
}

export interface GithubIssuesOptions {
  throttle?: Throttle;
  fetch?: typeof safeFetch;
  perPage?: number;
}

export function createGithubIssuesSource(options: GithubIssuesOptions = {}): Source {
  /* Captured at plan time, applied at retrieve time. Same shape as the
   * Hacker News adapter, for the same reason: a general index is gated in
   * phrase mode against the subject, never against the question terms. */
  let subject: string[] = [];
  let subjectPhrases: string[] = [];

  const throttle = options.throttle ?? createThrottle({ minGapMs: MIN_GAP_MS });
  const fetchImpl = options.fetch ?? safeFetch;
  const perPage = options.perPage ?? PER_PAGE;

  return {
    id: 'github',
    cost: 'free',
    /*
     * The channel is a repository name, a squashed identifier. That means the
     * phrase gate requires the subject in the ISSUE TEXT ITSELF and the repo
     * name never vouches for its records. This deliberately loses elliptical
     * issues inside a product's own repo ("crash on startup" in
     * vendor/product), because the same credit would let any repo whose name
     * prefix matches a subject word vouch for everything in it, which is the
     * r/woolworths failure with a different host. A false receipt costs more
     * than a missing one.
     */
    channelKind: 'handle',

    /* Keyless works. A token, when present, only raises the rate limit. */
    configured(_env: Env): boolean {
      return true;
    },

    async plan(input: PlanInput): Promise<Query[]> {
      subject = subjectTerms([input.category, input.productTitle]);
      subjectPhrases = [input.category, input.productTitle].filter((p) => p.trim().length > 0);

      const terms = input.terms.length ? input.terms : [input.category];
      /*
       * The category is quoted so GitHub searches it as a phrase: the bare
       * words of a two word product name match unrelated repos, the exact
       * failure the relevance measurements documented on general indexes.
       */
      return terms.map((text) => ({ text: `"${input.category}" ${text}` }));
    },

    async *retrieve(query: Query, ctx: Ctx): AsyncIterable<SourceRecord> {
      let q = `${query.text} in:title,body is:issue`;
      if (query.withinDays && query.withinDays > 0) {
        const after = new Date(Date.now() - query.withinDays * 86_400_000);
        q += ` created:>=${after.toISOString().slice(0, 10)}`;
      }

      const params = new URLSearchParams({
        q,
        per_page: String(perPage),
        /* Most reacted first: the reaction count is the tier B signal, so the
         * page budget goes to the issues carrying the most of it. */
        sort: 'reactions',
        order: 'desc',
      });

      /* Trimmed for the reason learned three times on 2026-08-24: a pasted
       * key carries a newline, and an untrimmed one dies at the header. */
      const token = ctx.env['GITHUB_TOKEN']?.trim();
      const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      };

      const fetchOptions = { headers, ...(ctx.signal ? { signal: ctx.signal } : {}) };

      const result = await throttle.attempt(
        () => fetchImpl(`${BASE}?${params.toString()}`, fetchOptions),
        (r) => r.status === 403 || r.status === 429 || r.status >= 500,
        { ok: false, status: 0, headers: {}, body: '', url: BASE, error: 'gave up after retries' },
      );

      if (!result.ok) {
        /* A source that is down degrades the run. It does not fail it. */
        ctx.log?.(`github: ${result.error ?? `status ${result.status}`}`);
        return;
      }

      const parsed = parseJsonObject<GithubSearchResponse>(result.body);
      if (!parsed) {
        ctx.log?.('github: response was not a json object');
        return;
      }

      for (const item of arrayField<GithubIssueItem>(parsed, 'items')) {
        /* The endpoint returns pull requests despite `is:issue`. A PR is our
         * code churn, not a user's report, and it is excluded. */
        if (item.pull_request !== undefined) continue;
        if (!item.number || !item.repository_url) continue;

        const repo = repoFromUrl(item.repository_url);
        /*
         * A github.io repo is a hosted website, not a software project, and
         * its issues are where content farms park spam pages for search
         * indexing. Found live 2026-08-24: an entire "Best Running Shoes in
         * America: 2026" affiliate roundup filed as an issue in
         * jacjocker4-netizen/jacjocker4.github.io, 9,337 characters of
         * marketing copy shaped exactly like the buyer voice this product
         * sells. The density gate happens to kill that one, but a farm page
         * written densely enough would beat a ratio, so the host class is
         * excluded outright. Nothing a real user files against real software
         * lives in a github.io repo's tracker.
         */
        if (/\.github\.io$/i.test(repo)) continue;
        const text = [item.title ?? '', cleanIssueBody(item.body ?? '')]
          .join('. ').replace(/\s+/g, ' ').trim();
        if (text.length < 40) continue;

        /* The gate. Everything stored is trusted by every later run. */
        if (!isRelevantRecord(text, repo, subject, {
          mode: 'phrase', phrases: subjectPhrases, channelKind: 'handle',
        })) continue;

        yield {
          source: 'github',
          kind: 'post',
          externalId: `${repo}#${item.number}`,
          channel: repo,
          text,
          score: item.reactions?.total_count ?? 0,
          url: item.html_url ?? `https://github.com/${repo}/issues/${item.number}`,
          createdUtc: item.created_at ? Math.floor(Date.parse(item.created_at) / 1000) || 0 : 0,
          origin: 'GitHub',
        };
      }
    },

    cite(record: SourceRecord): Citation {
      return {
        label: `GitHub, ${record.channel ?? 'an issue tracker'}`,
        url: record.url ?? '',
        score: record.score ?? 0,
        postedAt: record.createdUtc ?? 0,
      };
    },
  };
}
