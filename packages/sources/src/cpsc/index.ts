/*
 * CPSC, the US Consumer Product Safety Commission recall database.
 *
 * WHY THIS SOURCE CHANGES WHAT THE PRODUCT CAN ANSWER.
 *
 * Every other source we had was tier C, voice: what people said. A forum
 * comment is one person's impression, which is why three of them are needed
 * before anything may be stated as a finding.
 *
 * A recall is not an impression. A named company told a federal regulator, on
 * the record, with legal consequences for lying, that its product hurts people.
 * That is tier A, attested, and two attested records are a finding on their own
 * by the third corroboration route. So this adapter does not add volume to the
 * existing answers; it adds answers that voice sources cannot produce at all.
 *
 * Endpoint: https://www.saferproducts.gov/RestWebServices/Recall?format=json
 * No key, no account, no authentication. Public data published by the agency.
 *
 * MEASURED LIVE 2026-08-22, and it decided how `plan` works:
 *
 *   ProductName=running shoes   0 recalls
 *   ProductName=shoes          36 recalls
 *   ProductName=treadmill      16 recalls
 *
 * `ProductName` is a literal substring match against CPSC's own product names,
 * and those read "Breeze Ave, Breeze Shore and Breeze Step women's shoes". They
 * never read "running shoes". Querying the category verbatim therefore returns
 * nothing for most subjects, which would look exactly like "no recalls exist"
 * while meaning "we asked the wrong question". So the head noun is queried too,
 * and the relevance gate narrows the result rather than the query doing it.
 */

import type { Citation, Ctx, Env, PlanInput, Query, Source, SourceRecord } from '../source.ts';
import { safeFetch } from '../http/safe-fetch.ts';
import { createThrottle, type Throttle } from '../throttle.ts';
import { isRelevantRecord, subjectTerms } from '../relevance.ts';

const BASE = 'https://www.saferproducts.gov/RestWebServices/Recall';

export interface CpscParty { Name?: string | null }
export interface CpscNamed { Name?: string | null }

export interface CpscRecall {
  RecallID?: number | null;
  RecallNumber?: string | null;
  RecallDate?: string | null;
  Title?: string | null;
  Description?: string | null;
  URL?: string | null;
  Products?: CpscNamed[] | null;
  Hazards?: CpscNamed[] | null;
  Injuries?: CpscNamed[] | null;
  Remedies?: CpscNamed[] | null;
  Manufacturers?: CpscParty[] | null;
  Importers?: CpscParty[] | null;
  Distributors?: CpscParty[] | null;
  Retailers?: CpscParty[] | null;
}

/*
 * WHO IS RESPONSIBLE, WHICH IS THIS SOURCE'S UNIT OF INDEPENDENCE.
 *
 * Two recalls against the same company are one company's problem. Two against
 * different companies are a category problem, and telling those apart is the
 * whole reason a channel exists.
 *
 * MEASURED on 36 real recalls: `Manufacturers` is populated on only 17 and
 * `Importers` on 18, so neither can be the answer. The TITLE always names the
 * firm, in one of two grammars:
 *
 *   active    "Clarks Americas Recalls Women's Navy Blue Canvas Shoes"
 *   passive   "Women's Shoes Recalled by Charles David Due to Fall Hazard"
 *
 * 25 of 36 are active and 11 are passive. Handling both, then falling back to
 * the party fields, resolved 36 of 36 into 33 distinct firms.
 */
const ACTIVE = /^(.{2,60}?)\s+(?:Recalls|Announces Recall|Recall of)\b/i;
const PASSIVE = /\bRecalled by\s+(.{2,60}?)(?:\s+Due to|\s*[;,]|\s*$)/i;
/*
 * A third grammar, found by running the adapter live rather than by reading the
 * fixture: "CPSC, Sportcraft Announce Recall of Treadmills". It has to be tried
 * FIRST, because the active pattern matches it too and yields the useless
 * "CPSC, Sportcraft Announce" as the responsible firm, which is what the first
 * live run actually printed as a channel.
 *
 * MEASURED 2026-08-22: 6 of 16 treadmill recalls and 7 of 36 shoe recalls use
 * it, so roughly a fifth of this source was being filed under a firm that does
 * not exist.
 */
const JOINT = /^\s*(?:U\.?S\.?\s*)?CPSC\s*,\s*(.{2,60}?)\s+Announces?\b/i;

export function responsibleFirm(recall: CpscRecall): string {
  const title = recall.Title ?? '';
  const joint = JOINT.exec(title);
  if (joint?.[1]?.trim()) return joint[1].trim();
  const active = ACTIVE.exec(title);
  if (active?.[1]?.trim()) return active[1].trim();
  const passive = PASSIVE.exec(title);
  if (passive?.[1]?.trim()) return passive[1].trim();

  for (const list of [recall.Manufacturers, recall.Importers, recall.Distributors]) {
    const name = list?.[0]?.Name;
    /* Company names arrive with their address appended: "C&J Clark America
     * Inc. (subsidiary of Clarks Americas, Inc.), of Needham, Massachusetts". */
    if (name) return name.split(',')[0]!.trim();
  }
  return 'CPSC';
}

const names = (list: CpscNamed[] | null | undefined): string[] =>
  (list ?? []).map((n) => n.Name).filter((n): n is string => Boolean(n && n.trim()));

/*
 * The whole notice as one record.
 *
 * Title, product, hazard and injuries together, because the hazard is the part
 * that answers a research question and the title alone rarely names it. A
 * reader asking what goes wrong with a product wants "the plastic material can
 * weaken and break during use", which lives in Hazards and nowhere else.
 */
export function recallText(recall: CpscRecall): string {
  const parts = [
    recall.Title ?? '',
    ...names(recall.Products),
    recall.Description ?? '',
    ...names(recall.Hazards),
  ];
  const injuries = names(recall.Injuries).filter((i) => i.toLowerCase() !== 'none reported');
  if (injuries.length) parts.push(`Injuries reported: ${injuries.join('; ')}`);
  return parts.map((p) => p.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/* CPSC dates arrive as "2022-11-03T00:00:00" with no zone. Treated as UTC,
 * which is accurate to the day and the day is all a recall date means. */
export function recallDate(raw: string | null | undefined): number {
  if (!raw) return 0;
  const parsed = Date.parse(`${raw.replace(/Z?$/, '')}Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

/*
 * The head noun of a subject: the last word of "running shoes" is "shoes".
 *
 * This exists because of the measurement in the header. It is a deliberately
 * dumb rule and it is right for English product categories, where the head noun
 * trails. A subject of one word is already its own head noun.
 */
export function headNoun(category: string): string {
  const words = category.trim().split(/\s+/).filter(Boolean);
  return words[words.length - 1] ?? '';
}

export interface CpscOptions {
  throttle?: Throttle;
  fetch?: typeof safeFetch;
}

export function createCpscSource(options: CpscOptions = {}): Source {
  let subject: string[] = [];
  /* One shared throttle. A federal API is still someone's server. */
  const throttle = options.throttle ?? createThrottle({ minGapMs: 250 });
  const fetchImpl = options.fetch ?? safeFetch;

  return {
    id: 'cpsc',
    cost: 'free',
    /* The channel is a company name, which is prose rather than a squashed
     * identifier, so it cannot prefix match its way into vouching for itself. */
    channelKind: 'title',

    /* No key exists to be missing. */
    configured(_env: Env): boolean {
      return true;
    },

    async plan(input: PlanInput): Promise<Query[]> {
      subject = subjectTerms([input.category, input.productTitle]);

      /*
       * Broad to narrow, deduplicated. The head noun is what actually returns
       * rows; the full category is tried first because when it does hit, it
       * hits precisely. The brand is tried because a recall names the company
       * and "peloton" returned 3 recalls where the category returned none.
       */
      const head = headNoun(input.category);
      const candidates = [input.category, head, input.productTitle]
        .map((c) => c.trim())
        .filter((c) => c.length >= 3);

      return [...new Set(candidates.map((c) => c.toLowerCase()))].map((text) => ({ text }));
    },

    async *retrieve(query: Query, ctx: Ctx): AsyncIterable<SourceRecord> {
      const params = new URLSearchParams({ format: 'json', ProductName: query.text });
      if (query.withinDays && query.withinDays > 0) {
        const since = new Date(Date.now() - query.withinDays * 86_400_000);
        params.set('RecallDateStart', since.toISOString().slice(0, 10));
      }

      const fetchOptions = ctx.signal ? { signal: ctx.signal } : {};
      const result = await throttle.attempt(
        () => fetchImpl(`${BASE}?${params.toString()}`, fetchOptions),
        (r) => r.status === 429 || r.status >= 500,
        { ok: false, status: 0, headers: {}, body: '', url: BASE, error: 'gave up after retries' },
      );

      if (!result.ok) {
        /* A regulator being down degrades the run. It never fails it. */
        ctx.log?.(`cpsc: ${result.error ?? `status ${result.status}`}`);
        return;
      }

      let recalls: CpscRecall[];
      try {
        const parsed: unknown = JSON.parse(result.body);
        /* The endpoint returns a bare array. Anything else is a shape change
         * and is reported rather than crashed on. */
        if (!Array.isArray(parsed)) { ctx.log?.('cpsc: response was not an array'); return; }
        recalls = parsed as CpscRecall[];
      } catch {
        ctx.log?.('cpsc: response was not json');
        return;
      }

      for (const recall of recalls) {
        const externalId = recall.RecallNumber ?? (recall.RecallID != null ? String(recall.RecallID) : '');
        if (!externalId) continue;

        const text = recallText(recall);
        if (text.length < 40) continue;

        const channel = responsibleFirm(recall);

        /*
         * Gated like everything else. `ProductName=shoes` returns snowshoes,
         * children's clogs and safety boots, and a snowshoe recall is not
         * evidence about running shoes. Terms mode rather than phrase mode,
         * because the upstream query already scoped the result set to a product
         * name, which is the same reason a subreddit gets terms mode.
         */
        if (!isRelevantRecord(text, channel, subject, { channelKind: 'title' })) continue;

        yield {
          source: 'cpsc',
          kind: 'post',
          externalId,
          channel,
          text,
          /*
           * Zero, honestly. A recall has no score and nothing here is a vote.
           * Deriving one from the injury count would put a number under an
           * attested record that the agency never published.
           */
          score: 0,
          url: recall.URL ?? `https://www.cpsc.gov/Recalls/${externalId}`,
          createdUtc: recallDate(recall.RecallDate),
          origin: 'CPSC',
        };
      }
    },

    cite(record: SourceRecord): Citation {
      return {
        label: `CPSC recall, ${record.channel ?? 'unnamed firm'}`,
        url: record.url ?? '',
        score: 0,
        postedAt: record.createdUtc ?? 0,
      };
    },
  };
}
