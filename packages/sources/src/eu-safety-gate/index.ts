/*
 * EU Safety Gate, the rapid alert system for dangerous non food products.
 *
 * HOW THIS ENDPOINT WAS FOUND, because it is not where anyone would look.
 *
 * The Safety Gate site is an Angular application and its JSON API is not
 * public: every path guessed against it returned 404, and the app bundle only
 * revealed `{core: {base: "/api"}}` with the search living in a lazy chunk.
 *
 * The route that works is published as an OPEN DATA DISTRIBUTION on
 * data.europa.eu rather than as a developer API:
 *
 *   api/download/weeklyReport/list/xml/en     1,112 reports, 2005 to present
 *   api/download/weeklyReport/detail/xml/{id} about 65 alerts per report
 *
 * That is a better route than the one that was being looked for. It is
 * intended for bulk consumption, it is versioned by week, and it goes back
 * twenty years.
 *
 * WHY THIS IS TIER A.
 *
 * Each alert is a national market surveillance authority stating that a named
 * product is dangerous, with the hazard described, the measures ordered and the
 * legal basis. Thirty one countries file into it. That is not an opinion about
 * a product, it is a government acting against one.
 *
 * THERE IS NO SEARCH, AND THAT SHAPES THE ADAPTER.
 *
 * The published route offers no query parameter, so relevance is decided
 * entirely by our own gate over a recent window of weekly reports rather than
 * by asking the upstream a question. That is why this source reads a few weeks
 * by default: it is a firehose to be filtered, not an index to be queried.
 *
 * The right long term shape is a bulk ingest of all 1,112 reports into the
 * corpus once, after which every subject is answered warm with no upstream
 * request at all. That is the same argument as the Arctic Shift dump ingest and
 * it is recorded in the todo rather than built here.
 */

import type { Citation, Ctx, Env, PlanInput, Query, Source, SourceRecord } from '../source.ts';
import { safeFetch } from '../http/safe-fetch.ts';
import { createThrottle, type Throttle } from '../throttle.ts';
import { isRelevantRecord, subjectTerms } from '../relevance.ts';

const LIST = 'https://ec.europa.eu/safety-gate-alerts/api/download/weeklyReport/list/xml/en';

/* A weekly report runs to about 140KB with roughly 65 alerts in it. */
const MAX_REPORT_BYTES = 4 * 1024 * 1024;

/*
 * How many recent weeks to read by default. Eight is about two months and
 * roughly 520 alerts, which is enough for a recent hazard to surface without
 * pulling twenty years of history on every run.
 */
const DEFAULT_WEEKS = 8;

export interface SafetyGateAlert {
  caseNumber: string;
  reference: string;
  category: string;
  product: string;
  brand: string;
  name: string;
  riskType: string;
  danger: string;
  measures: string;
  description: string;
  notifyingCountry: string;
  countryOfOrigin: string;
  level: string;
}

/*
 * A field reader for this one document shape rather than a general XML parser.
 *
 * Every text field arrives wrapped in CDATA, some arrive as self closing tags
 * when empty, and adding an XML dependency for six known field names would be a
 * dependency for the sake of generality we do not need.
 */
export function xmlField(block: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  if (!match) return '';
  return (match[1] ?? '')
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/*
 * The report URLs, unescaped and de-punctuated.
 *
 * The list emits `&amp;` because it is XML, and each URL carries a trailing
 * comma. Using one verbatim returns HTTP 400, which is how this was found.
 */
export function reportUrls(xml: string): string[] {
  return [...xml.matchAll(/<URL>([\s\S]*?)<\/URL>/g)]
    .map((m) => (m[1] ?? '')
      .replace(/^<!\[CDATA\[/, '')
      .replace(/\]\]>$/, '')
      .replace(/&amp;/g, '&')
      .trim()
      .replace(/[,\s]+$/, ''))
    .filter((u) => u.startsWith('https://'));
}

export function parseAlerts(xml: string): SafetyGateAlert[] {
  return [...xml.matchAll(/<notifications[^>]*>([\s\S]*?)<\/notifications>/g)].map((m) => {
    const block = m[1] ?? '';
    return {
      caseNumber: xmlField(block, 'caseNumber'),
      reference: xmlField(block, 'reference'),
      category: xmlField(block, 'category'),
      product: xmlField(block, 'product'),
      brand: xmlField(block, 'brand'),
      name: xmlField(block, 'name'),
      riskType: xmlField(block, 'riskType'),
      danger: xmlField(block, 'danger'),
      measures: xmlField(block, 'measures'),
      description: xmlField(block, 'description'),
      notifyingCountry: xmlField(block, 'notifyingCountry'),
      countryOfOrigin: xmlField(block, 'countryOfOrigin'),
      level: xmlField(block, 'level'),
    };
  });
}

/* The report's own publication date, DD/MM/YYYY, applied to every alert in it.
 * The alerts carry no individual date. */
export function reportDate(xml: string): number {
  const raw = xmlField(xml.slice(0, 2000), 'report_date');
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (!m) return 0;
  return Math.floor(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])) / 1000);
}

/*
 * The alert as prose.
 *
 * `danger` first among the substantive fields, because it is the sentence that
 * answers a research question: what actually goes wrong with this product. The
 * risk level is spelled out rather than left as a field, since "Serious risk"
 * is the agency's own classification and belongs in the quote.
 */
export function alertText(alert: SafetyGateAlert): string {
  const parts = [
    [alert.product, alert.brand, alert.name].filter(Boolean).join(', '),
    alert.description,
    alert.riskType ? `Risk type: ${alert.riskType}.` : '',
    alert.danger,
    alert.level ? `Classified by the notifying authority as: ${alert.level}.` : '',
    alert.measures ? `Measures ordered: ${alert.measures}` : '',
  ];
  return parts.map((p) => p.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

export interface EuSafetyGateOptions {
  throttle?: Throttle;
  fetch?: typeof safeFetch;
  weeks?: number;
}

export function createEuSafetyGateSource(options: EuSafetyGateOptions = {}): Source {
  let subject: string[] = [];
  const throttle = options.throttle ?? createThrottle({ minGapMs: 400 });
  const fetchImpl = options.fetch ?? safeFetch;
  const weeks = options.weeks ?? DEFAULT_WEEKS;

  return {
    id: 'eu-safety-gate',
    cost: 'free',
    /* The channel is a country name, which is prose. */
    channelKind: 'title',

    configured(_env: Env): boolean {
      return true;
    },

    async plan(input: PlanInput): Promise<Query[]> {
      subject = subjectTerms([input.category, input.productTitle]);

      /*
       * One request to learn which reports exist. There is no search, so the
       * plan is a window of recent weeks rather than a set of questions.
       */
      const result = await fetchImpl(LIST, { maxBytes: MAX_REPORT_BYTES });
      if (!result.ok) return [];

      return reportUrls(result.body).slice(0, weeks).map((text) => ({ text }));
    },

    async *retrieve(query: Query, ctx: Ctx): AsyncIterable<SourceRecord> {
      const fetchOptions = ctx.signal
        ? { signal: ctx.signal, maxBytes: MAX_REPORT_BYTES }
        : { maxBytes: MAX_REPORT_BYTES };

      const result = await throttle.attempt(
        () => fetchImpl(query.text, fetchOptions),
        (r) => r.status === 429 || r.status >= 500,
        { ok: false, status: 0, headers: {}, body: '', url: query.text, error: 'gave up after retries' },
      );

      if (!result.ok) {
        ctx.log?.(`eu-safety-gate: ${result.error ?? `status ${result.status}`}`);
        return;
      }

      const published = reportDate(result.body);

      for (const alert of parseAlerts(result.body)) {
        if (!alert.caseNumber) continue;

        const text = alertText(alert);
        if (text.length < 40) continue;

        /*
         * The notifying authority is the unit of independence. Two alerts from
         * Spain are one authority acting twice; Spain and Germany flagging the
         * same category are two governments agreeing, which is what the
         * corroboration count should be able to see.
         */
        const channel = alert.notifyingCountry || 'unnamed authority';

        /*
         * The whole gate, because this source has no search. A recent window of
         * weekly reports is a firehose of every dangerous product in Europe,
         * and only the ones about the subject may be stored.
         */
        if (!isRelevantRecord(text, channel, subject, { channelKind: 'title' })) continue;

        yield {
          source: 'eu-safety-gate',
          kind: 'post',
          externalId: alert.caseNumber,
          channel,
          text,
          /* No votes on a government alert. */
          score: 0,
          url: alert.reference,
          /* The report's publication date. Alerts carry no individual date, and
           * an invented one would be worse than the week it was published in. */
          createdUtc: published,
          origin: `EU Safety Gate, ${alert.notifyingCountry}`,
        };
      }
    },

    cite(record: SourceRecord): Citation {
      return {
        label: `EU Safety Gate alert, notified by ${record.channel ?? 'an authority'}`,
        url: record.url ?? '',
        score: 0,
        postedAt: record.createdUtc ?? 0,
      };
    },
  };
}
