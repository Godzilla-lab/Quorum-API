/*
 * NHTSA vehicle safety recalls.
 *
 * Tier A, attested, and the strictest example of it in the repo. A recall
 * campaign is a manufacturer telling a federal agency that its vehicles have a
 * defect, what the consequence is, and what it will do about it. `parkIt` and
 * `parkOutSide` are flags the agency sets when the answer is "stop driving it"
 * or "do not park it indoors", which is not a sentiment anybody expressed.
 *
 * Endpoint: https://api.nhtsa.gov/recalls/recallsByVehicle
 * No key, no account.
 *
 * WHY THIS SOURCE IS SHAPED DIFFERENTLY FROM THE OTHER ATTESTED ONES.
 *
 * CPSC and openFDA take a product name. NHTSA does not: it takes make, model
 * and model year, and MEASURED LIVE 2026-08-22, omitting the year returns
 * HTTP 400 rather than a broad result. So a free text subject has to be parsed
 * into those three fields before this source can be asked anything at all.
 *
 * That makes it narrow on purpose. It answers for "2020 Honda Accord" and it
 * answers for nothing else, which is correct: it is a vehicle database, and a
 * source that pretends to have an opinion about running shoes would be worse
 * than one that stays quiet.
 *
 * COMPLAINTS ARE DELIBERATELY NOT INCLUDED. NHTSA also publishes consumer
 * complaints, and they are tempting because there are far more of them. They
 * are one person's report, which is tier C evidence wearing a government URL.
 * Mixing them in here would quietly promote thousands of individual opinions
 * to attested status and break the corroboration rules for every other source.
 */

import type { Citation, Ctx, Env, PlanInput, Query, Source, SourceRecord } from '../source.ts';
import { safeFetch } from '../http/safe-fetch.ts';
import { createThrottle, type Throttle } from '../throttle.ts';
import { isRelevantRecord, subjectTerms } from '../relevance.ts';
import { arrayField, parseJsonObject } from '../http/parse-json.ts';

const BASE = 'https://api.nhtsa.gov/recalls/recallsByVehicle';

export interface NhtsaRecall {
  NHTSACampaignNumber?: string | null;
  Manufacturer?: string | null;
  Component?: string | null;
  Summary?: string | null;
  Consequence?: string | null;
  Remedy?: string | null;
  Notes?: string | null;
  ReportReceivedDate?: string | null;
  Make?: string | null;
  Model?: string | null;
  ModelYear?: string | number | null;
  parkIt?: boolean | null;
  parkOutSide?: boolean | null;
}

export interface VehicleSubject {
  make: string;
  model: string;
  /* Empty when the subject named no year, in which case recent years are tried. */
  year: string;
}

/*
 * Turn a written subject into the three fields the API demands.
 *
 * Deliberately simple, and it fails by returning nothing rather than by
 * guessing. "2020 Honda Accord", "Honda Accord 2020" and "honda accord" all
 * parse; "running shoes" parses to a make of "running" and a model of "shoes",
 * which returns zero recalls and degrades the source cleanly. That is the right
 * failure: a wrong guess costs one request that finds nothing.
 */
export function parseVehicle(subject: string): VehicleSubject | null {
  const words = subject.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;

  const currentYear = new Date().getUTCFullYear();
  let year = '';
  const rest: string[] = [];
  for (const word of words) {
    /* A model year, not any four digits. 1900 is not a car and 2400 is not yet. */
    if (!year && /^(19[5-9]\d|20[0-9]\d)$/.test(word) && Number(word) <= currentYear + 2) {
      year = word;
      continue;
    }
    rest.push(word);
  }
  if (rest.length < 2) return null;

  return { make: rest[0]!, model: rest.slice(1).join(' '), year };
}

/*
 * The campaign as one record.
 *
 * Consequence before remedy, because the consequence is what a researcher is
 * asking about and the remedy is what the manufacturer will do. `parkIt` is
 * spelled out in words: a boolean in a JSON field is invisible in a quote, and
 * "do not drive this vehicle" is the most important thing the agency can say.
 */
export function recallText(recall: NhtsaRecall): string {
  const parts = [
    recall.Component ? `Component: ${recall.Component}.` : '',
    recall.Summary ?? '',
    recall.Consequence ? `Consequence: ${recall.Consequence}` : '',
    recall.Remedy ? `Remedy: ${recall.Remedy}` : '',
  ];
  if (recall.parkIt) parts.push('NHTSA advises owners to stop driving this vehicle.');
  if (recall.parkOutSide) parts.push('NHTSA advises owners not to park this vehicle indoors.');
  return parts.map((p) => p.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/* NHTSA dates are MM/DD/YYYY. Read explicitly, because Date.parse of an
 * ambiguous slash date is locale dependent and silently wrong for half the
 * year in the other reading. */
export function nhtsaDate(raw: string | null | undefined): number {
  if (!raw) return 0;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return 0;
  const [, month, day, year] = m;
  const parsed = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

export function campaignUrl(campaign: string): string {
  return `https://www.nhtsa.gov/recalls?nhtsaId=${encodeURIComponent(campaign)}`;
}

export interface NhtsaOptions {
  throttle?: Throttle;
  fetch?: typeof safeFetch;
  /* How many recent model years to try when the subject names none. */
  yearsBack?: number;
  now?: () => Date;
}

export function createNhtsaSource(options: NhtsaOptions = {}): Source {
  let subject: string[] = [];
  const throttle = options.throttle ?? createThrottle({ minGapMs: 250 });
  const fetchImpl = options.fetch ?? safeFetch;
  const yearsBack = options.yearsBack ?? 4;
  const now = options.now ?? (() => new Date());

  return {
    id: 'nhtsa',
    cost: 'free',
    /* A manufacturer name is prose. */
    channelKind: 'title',

    configured(_env: Env): boolean {
      return true;
    },

    async plan(input: PlanInput): Promise<Query[]> {
      subject = subjectTerms([input.category, input.productTitle]);

      /*
       * The product title first, because "2020 Honda Accord" is more likely to
       * be written there than in a category, and the category as a fallback.
       */
      const vehicle = parseVehicle(input.productTitle) ?? parseVehicle(input.category);
      /* Not a vehicle, so this source has nothing to say. Planning no queries
       * makes the run report it as degraded rather than silently empty. */
      if (!vehicle) return [];

      if (vehicle.year) return [{ text: `${vehicle.year} ${vehicle.make} ${vehicle.model}` }];

      /*
       * No year given, so recent ones are tried. The API refuses a query with
       * no year, and a research subject rarely carries one.
       */
      const currentYear = now().getUTCFullYear();
      return Array.from({ length: yearsBack + 1 }, (_, i) => ({
        text: `${currentYear - i} ${vehicle.make} ${vehicle.model}`,
      }));
    },

    async *retrieve(query: Query, ctx: Ctx): AsyncIterable<SourceRecord> {
      const vehicle = parseVehicle(query.text);
      if (!vehicle?.year) return;

      const params = new URLSearchParams({
        make: vehicle.make, model: vehicle.model, modelYear: vehicle.year,
      });
      const url = `${BASE}?${params.toString()}`;
      const fetchOptions = ctx.signal ? { signal: ctx.signal } : {};

      const result = await throttle.attempt(
        () => fetchImpl(url, fetchOptions),
        (r) => r.status === 429 || r.status >= 500,
        { ok: false, status: 0, headers: {}, body: '', url, error: 'gave up after retries' },
      );

      if (!result.ok) {
        /* A 400 means the make or model is not one NHTSA knows, which is the
         * normal outcome for a subject that is not a vehicle. Not an error. */
        if (result.status !== 400) ctx.log?.(`nhtsa: ${result.error ?? `status ${result.status}`}`);
        return;
      }

      const parsed = parseJsonObject<{ results?: NhtsaRecall[] }>(result.body);
      if (!parsed) {
        ctx.log?.('nhtsa: response was not a json object');
        return;
      }

      for (const recall of arrayField<NhtsaRecall>(parsed, 'results')) {
        const externalId = recall.NHTSACampaignNumber;
        if (!externalId) continue;

        const text = recallText(recall);
        if (text.length < 40) continue;

        const channel = (recall.Manufacturer ?? '').trim() || 'unnamed manufacturer';

        /*
         * Still gated. A query for "2020 Honda Accord" returns recalls for that
         * vehicle, but a subject of "Honda Accord brakes" should not store an
         * airbag campaign as evidence about brakes.
         */
        if (!isRelevantRecord(text, `${channel} ${recall.Make ?? ''} ${recall.Model ?? ''}`, subject, { channelKind: 'title' })) continue;

        yield {
          source: 'nhtsa',
          kind: 'post',
          externalId,
          channel,
          text,
          /* No votes on a recall campaign. */
          score: 0,
          url: campaignUrl(externalId),
          createdUtc: nhtsaDate(recall.ReportReceivedDate),
          origin: 'NHTSA',
        };
      }
    },

    cite(record: SourceRecord): Citation {
      return {
        label: `NHTSA recall, ${record.channel ?? 'unnamed manufacturer'}`,
        url: record.url ?? '',
        score: 0,
        postedAt: record.createdUtc ?? 0,
      };
    },
  };
}
