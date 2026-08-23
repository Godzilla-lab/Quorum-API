/*
 * The cost meter.
 *
 * Every paid call in the engine charges here, and every run reports what it
 * actually cost. This is non negotiable for a reason with a receipt attached:
 * before the meter recorded providers as well as models, every report priced at
 * $0.00, because the table was being asked for keys that were never used while
 * the ones that were went uncharged. A meter that silently reports zero is
 * worse than no meter, since zero reads as a measurement.
 *
 * Two things here are new relative to the engine, and both exist so the hosted
 * server does not have to retrofit them into every adapter later.
 *
 *   SINK      the server needs per key accounting. Without a sink, metering has
 *             to be threaded back through every call site after the fact.
 *   SPEND CAP enforced in the meter rather than in a route, because a route
 *             guard cannot stop a long running job that is already inside a
 *             retry loop burning vendor credit.
 */

import { LONG_CONTEXT_TOKENS, RATES, type Rate, isCallRate } from './rates.ts';

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface CostEntry {
  key: string;
  kind: 'call' | 'llm';
  usd: number;
  /* Present on llm entries. */
  provider?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  /* True when the long context tier applied to the whole request. */
  longContext?: boolean;
  /* Present on call entries. */
  count?: number;
  verified: boolean;
  at: number;
}

export interface CostLine {
  key: string;
  kind: 'call' | 'llm';
  provider: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  verified: boolean;
}

export interface CostMeterOptions {
  label: string;
  /*
   * Hard ceiling in USD for this meter. Omit for no cap, which is correct for
   * the CLI where the operator is spending their own money knowingly.
   */
  capUsd?: number;
  /*
   * Called for every entry as it is recorded. The server uses this for per key
   * accounting and quota. Errors thrown by a sink are swallowed: a metering
   * failure must never take down a run that is otherwise working.
   */
  sink?: (entry: CostEntry) => void;
  /* Injected in tests. Unix milliseconds. */
  now?: () => number;
}

export interface CostMeter {
  readonly label: string;
  /* A flat per call vendor charge. Returns the USD recorded. */
  charge(key: string, count?: number): number;
  /* An LLM call. Returns the USD recorded. */
  usage(model: string, usage: TokenUsage, provider?: string): number;
  /*
   * Guard for BEFORE an expensive call. The meter cannot prevent a call it does
   * not make, so a caller about to spend must ask first. Always true when no
   * cap is set.
   */
  canSpend(estimateUsd: number): boolean;
  /* USD left under the cap, or Infinity when uncapped. */
  remaining(): number;
  /* True once recorded spend has met or passed the cap. */
  overCap(): boolean;
  total(): number;
  breakdown(): CostLine[];
  hasUnverified(): boolean;
  report(): string;
  toJSON(): { label: string; totalUsd: number; lines: CostLine[]; hasUnverified: boolean; overCap: boolean };
}

/*
 * MONEY IS ACCUMULATED IN INTEGER MICRO DOLLARS, NEVER IN FLOATS.
 *
 * Found by a failing test on 2026-08-22, not by theory. The measured Apify rate
 * is $0.0058 per ad, and 0.0058 * 10 evaluates to 0.057999999999999996, so a
 * $0.058 spend cap compared with >= silently never trips. The same drift
 * accumulates across the thousands of small charges a real run makes.
 *
 * One micro dollar is $0.000001, which is finer than any rate card we bill
 * against, so rounding each entry to micros loses nothing real and makes the
 * cap comparison exact.
 */
const MICROS_PER_USD = 1_000_000;
const toMicros = (usd: number): number => Math.round(usd * MICROS_PER_USD);
const toUsd = (micros: number): number => micros / MICROS_PER_USD;

/*
 * Long context billing is decided by the PROMPT size and then applied to the
 * whole request, output included. Charging the standard rate on a 250k prompt
 * would under report by half.
 */
function tierFor(rate: Rate, inputTokens: number): { in: number; out: number; long: boolean } {
  if (isCallRate(rate)) return { in: 0, out: 0, long: false };
  if (rate.long && inputTokens >= LONG_CONTEXT_TOKENS) {
    return { in: rate.long.in, out: rate.long.out, long: true };
  }
  return { in: rate.in, out: rate.out, long: false };
}

export function createCostMeter(options: CostMeterOptions): CostMeter {
  const { label, capUsd, sink, now = () => Date.now() } = options;

  const entries: CostEntry[] = [];
  let unverifiedSeen = false;
  /* Integer micro dollars. See the note above on why this is not a float. */
  let runningMicros = 0;
  const capMicros = capUsd === undefined ? undefined : toMicros(capUsd);

  const record = (entry: CostEntry): void => {
    entries.push(entry);
    runningMicros += toMicros(entry.usd);
    if (!entry.verified) unverifiedSeen = true;
    if (sink) {
      try {
        sink(entry);
      } catch {
        /* A metering sink failure must not take down a working run. */
      }
    }
  };

  return {
    label,

    charge(key: string, count = 1): number {
      const rate = RATES[key];
      /*
       * An unknown key charges zero and is marked unverified rather than
       * throwing. A vendor we have not priced yet should show up as a visible
       * question mark in the report, not as a crash mid run.
       */
      const usd = rate && isCallRate(rate) ? rate.perCall * count : 0;
      record({
        key,
        kind: 'call',
        count,
        usd,
        verified: rate ? rate.verified : false,
        at: now(),
      });
      return usd;
    },

    usage(model: string, usage: TokenUsage = {}, provider?: string): number {
      const rate = RATES[model];

      /*
       * Cached reads and cache writes are still input tokens and are still
       * billed, at different rates in some rate cards. Counting only
       * input_tokens under reports a cached run substantially.
       */
      const inputTokens =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      const outputTokens = usage.output_tokens ?? 0;

      const tier = rate ? tierFor(rate, inputTokens) : { in: 0, out: 0, long: false };
      const usd = (inputTokens / 1e6) * tier.in + (outputTokens / 1e6) * tier.out;

      record({
        key: model,
        kind: 'llm',
        /*
         * Provider is recorded because a row naming only the model cannot
         * answer "who actually billed us for this". Settling that once took a
         * live report and a hand checked price calculation.
         */
        provider: provider ?? null,
        inputTokens,
        outputTokens,
        longContext: tier.long,
        usd,
        verified: rate ? rate.verified : false,
        at: now(),
      });
      return usd;
    },

    canSpend(estimateUsd: number): boolean {
      if (capMicros === undefined) return true;
      return runningMicros + toMicros(estimateUsd) <= capMicros;
    },

    remaining(): number {
      if (capMicros === undefined) return Infinity;
      return toUsd(Math.max(0, capMicros - runningMicros));
    },

    overCap(): boolean {
      return capMicros !== undefined && runningMicros >= capMicros;
    },

    total(): number {
      return toUsd(runningMicros);
    },

    breakdown(): CostLine[] {
      /*
       * ACCUMULATED IN MICROS, for the same reason the running total is.
       *
       * This summed `line.usd += e.usd` in floating point until 2026-08-22, so
       * two charges of ten ads reported 0.015200000000000002 on the line while
       * `total()` reported 0.0152. Both numbers print in the same cost block,
       * so a report could show line items that did not add up to its own total,
       * which is the one thing a cost report must never do.
       */
      const byKey = new Map<string, CostLine & { micros: number }>();
      for (const e of entries) {
        const line = byKey.get(e.key) ?? {
          key: e.key,
          kind: e.kind,
          provider: e.provider ?? null,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          usd: 0,
          micros: 0,
          verified: e.verified,
        };
        line.calls += e.count ?? 1;
        line.inputTokens += e.inputTokens ?? 0;
        line.outputTokens += e.outputTokens ?? 0;
        line.micros += toMicros(e.usd);
        byKey.set(e.key, line);
      }
      return [...byKey.values()]
        .map(({ micros, ...line }) => ({ ...line, usd: toUsd(micros) }))
        .sort((a, b) => b.usd - a.usd);
    },

    hasUnverified(): boolean {
      return unverifiedSeen;
    },

    report(): string {
      const lines = [`  cost: $${toUsd(runningMicros).toFixed(4)}  (${label})`];
      for (const r of this.breakdown()) {
        const detail = r.kind === 'llm'
          ? `${r.inputTokens.toLocaleString()} in / ${r.outputTokens.toLocaleString()} out`
          : `${r.calls} call${r.calls === 1 ? '' : 's'}`;
        lines.push(`    ${r.verified ? ' ' : '?'} ${r.key.padEnd(24)} ${detail.padEnd(28)} $${r.usd.toFixed(4)}`);
      }
      if (unverifiedSeen) {
        lines.push('    ? = rate not confirmed with the vendor, treat that line as an estimate');
      }
      if (this.overCap()) {
        lines.push(`    ! spend cap of $${(capUsd ?? 0).toFixed(2)} reached`);
      }
      return lines.join('\n');
    },

    toJSON() {
      return {
        label,
        totalUsd: toUsd(runningMicros),
        lines: this.breakdown(),
        hasUnverified: unverifiedSeen,
        overCap: this.overCap(),
      };
    },
  };
}
