/*
 * Per key quotas, and the usage they are counted from.
 *
 * ONE LEDGER, TWO QUESTIONS. "Has this key had too much in the last minute" and
 * "what has this key used this month" are the same counter read two ways.
 * Building them separately gives you two numbers that disagree, which is the
 * failure this codebase keeps finding in itself.
 *
 * TWO QUOTAS, NOT ONE, and `spec/openapi.yaml` says why before this file
 * existed: a report is a minutes long job and a denial of service vector, an
 * evidence lookup is one indexed read. A single shared limit either starves
 * lookups or leaves jobs unprotected. Concurrency is a third ceiling again,
 * because a request rate does not bound work that is already running: without
 * it one key holds the whole job queue with requests it made slowly.
 *
 * IN MEMORY, DELIBERATELY, FOR NOW.
 *
 * This is correct for one instance, which is what the hosted tier is today,
 * and it needs no corpus schema change to ship. What it costs is honest and
 * bounded: a restart forgets the current window, which resets a limit early
 * and never enforces one that was not real. It becomes wrong the day a second
 * instance exists, because two processes would each allow the full quota, and
 * at that point this moves behind the corpus driver. The interface below is
 * the shape that move needs, so the call sites will not change.
 *
 * A FIXED WINDOW RATHER THAN A TOKEN BUCKET. A bucket smooths bursts, which
 * sounds better and is worse here: the thing being protected is a 0.1 CPU
 * instance where a burst is exactly what hurts, and a fixed window is something
 * a caller can reason about from the headers without reading an algorithm.
 */

export interface QuotaState {
  used: number;
  limit: number;
  remaining: number;
}

export interface UsageSnapshot {
  keyPrefix: string;
  periodStart: number;
  periodEnd: number;
  reports: QuotaState;
  lookups: QuotaState;
  concurrentReports: { running: number; limit: number };
  spendUsd: number;
}

/* Why a spend request was refused, so the caller is told which ceiling it hit
 * rather than a generic no. */
export type SpendRefusal = 'per-key' | 'instance' | 'disabled' | null;

export interface QuotaLimits {
  /* Reports started per window. Small: each one is minutes of upstream work. */
  reportsPerWindow: number;
  /* Everything else per window. Large: each one is an indexed read. */
  lookupsPerWindow: number;
  /* Reports in flight at once for one key. Enforced by the job queue, reported
   * here so a caller sees all three ceilings in one place. */
  concurrentReports: number;
  windowMs: number;
  /*
   * METERED SPEND, IN DOLLARS, AND THE ONLY LIMIT HERE THAT BOUNDS A BILL.
   *
   * A rate limit bounds how OFTEN, never how MUCH. Twenty reports a minute
   * with the ads leg on is twenty metered vendor runs a minute, which a rate
   * limit permits happily and at a measured pace. These two are what stop a
   * balance disappearing.
   *
   * `spendPerKeyUsd` bounds one caller. `spendTotalUsd` bounds EVERY caller
   * together, and it is the one that matters when the ads leg is open to
   * everyone: without it, the ceiling is the per key figure multiplied by
   * however many keys exist, which is not a ceiling.
   *
   * BOTH DEFAULT TO ZERO, WHICH DISABLES METERED WORK. An operator who has not
   * thought about a budget has one of zero, so the failure mode of forgetting
   * is a report without ads rather than a bill.
   */
  spendPerKeyUsd: number;
  spendTotalUsd: number;
  /* The spend window, separate from the request window: nobody budgets by the
   * minute, and a day is how a vendor bills. */
  spendWindowMs: number;
}

export const DEFAULT_LIMITS: QuotaLimits = {
  /*
   * Twenty reports an hour is generous for a human and stops a loop. The
   * binding constraint is not this number, it is that two reports run at a
   * time and each is minutes of throttled retrieval against volunteer
   * archives, so a key that asks for a hundred is queueing them regardless.
   */
  reportsPerWindow: 20,
  /*
   * Measured 2026-08-22: evidence resolves at about 7,400 a second on eight
   * cores and search at 124, and Render's free tier is 0.1 CPU. 600 a minute
   * is 10 a second, which is a comfortable interactive pace for one caller and
   * roughly a tenth of what the smallest instance can serve, so one key
   * cannot take the machine from the rest.
   */
  lookupsPerWindow: 600,
  concurrentReports: 3,
  windowMs: 60_000,
  /* Zero until an operator says otherwise. See the field comments. */
  spendPerKeyUsd: 0,
  spendTotalUsd: 0,
  spendWindowMs: 24 * 60 * 60_000,
};

/* What a request counts against. A report is expensive, everything else is
 * not, and healthz is neither. */
export type Meter = 'reports' | 'lookups' | 'exempt';

interface KeyRecord {
  windowStart: number;
  /* Rolls on its own schedule, because a budget is daily and a rate is per
   * minute. Sharing one window would reset the budget every minute. */
  spendWindowStart: number;
  spendInWindow: number;
  reports: number;
  lookups: number;
  /* Lifetime, not windowed. This is the "what did they use" half. */
  totalReports: number;
  totalLookups: number;
  spendUsd: number;
  firstSeen: number;
  lastSeen: number;
}

export interface Decision {
  allowed: boolean;
  /* Seconds until the window rolls. Sent as Retry-After on a refusal, and as
   * an X-RateLimit header on every answer, so a caller can pace itself before
   * being refused rather than after. */
  retryAfterSeconds: number;
  state: QuotaState;
}

export interface SpendDecision {
  allowed: boolean;
  refusedBy: SpendRefusal;
  /* What this key may still spend in the window, and what everyone may. The
   * smaller of the two is the real ceiling for the next call. */
  keyRemainingUsd: number;
  instanceRemainingUsd: number;
  reason: string;
}

export interface Quotas {
  /* Count one request and say whether it may proceed. */
  check(keyLabel: string, meter: Meter, now?: number): Decision;
  /*
   * May this key start metered work, and for how much.
   *
   * Asked BEFORE the work rather than after, because a charge that arrives
   * after the money is gone is an audit trail rather than a limit.
   */
  canSpend(keyLabel: string, now?: number): SpendDecision;
  /* Charge money to a key, so usage reports what a caller actually cost. */
  charge(keyLabel: string, usd: number, now?: number): void;
  /* What `GET /v1/usage` returns. */
  snapshot(keyLabel: string, running: number, now?: number): UsageSnapshot;
  /* Every key seen since start, for an operator. Never includes a key itself. */
  keys(): string[];
}

export function createQuotas(limits: QuotaLimits = DEFAULT_LIMITS): Quotas {
  const keys = new Map<string, KeyRecord>();
  /* The instance total, tracked apart from any key, because the thing it
   * protects is a single vendor balance shared by all of them. */
  let instanceWindowStart = 0;
  let instanceSpend = 0;

  const record = (keyLabel: string, now: number): KeyRecord => {
    let rec = keys.get(keyLabel);
    if (!rec) {
      rec = {
        windowStart: now, spendWindowStart: now, spendInWindow: 0,
        reports: 0, lookups: 0,
        totalReports: 0, totalLookups: 0, spendUsd: 0,
        firstSeen: now, lastSeen: now,
      };
      keys.set(keyLabel, rec);
    }
    /*
     * Rolled on read rather than on a timer. A timer in a library is a handle
     * that keeps a process alive and surprises whoever embeds it, which is the
     * same reasoning the idempotency sweep in jobs.ts uses.
     */
    if (now - rec.windowStart >= limits.windowMs) {
      rec.windowStart = now;
      rec.reports = 0;
      rec.lookups = 0;
    }
    if (now - rec.spendWindowStart >= limits.spendWindowMs) {
      rec.spendWindowStart = now;
      rec.spendInWindow = 0;
    }
    rec.lastSeen = now;
    return rec;
  };

  const stateOf = (used: number, limit: number): QuotaState =>
    ({ used, limit, remaining: Math.max(0, limit - used) });

  return {
    check(keyLabel, meter, now = Date.now()) {
      const rec = record(keyLabel, now);
      const retryAfterSeconds = Math.max(1, Math.ceil((rec.windowStart + limits.windowMs - now) / 1000));

      if (meter === 'exempt') {
        /* Healthz is how a load balancer decides this process is alive.
         * Rate limiting it means a busy instance gets taken out of rotation
         * for being busy, which is the opposite of what should happen. */
        return { allowed: true, retryAfterSeconds, state: stateOf(0, 0) };
      }

      const limit = meter === 'reports' ? limits.reportsPerWindow : limits.lookupsPerWindow;
      const used = meter === 'reports' ? rec.reports : rec.lookups;

      if (used >= limit) {
        /*
         * A REFUSED REQUEST IS NOT COUNTED. Counting it would extend the
         * window every time a caller retried, so a client in a tight retry
         * loop could never get back in. That turns a rate limit into a ban.
         */
        return { allowed: false, retryAfterSeconds, state: stateOf(used, limit) };
      }

      if (meter === 'reports') { rec.reports++; rec.totalReports++; } else { rec.lookups++; rec.totalLookups++; }
      return {
        allowed: true,
        retryAfterSeconds,
        state: stateOf(meter === 'reports' ? rec.reports : rec.lookups, limit),
      };
    },

    canSpend(keyLabel, now = Date.now()) {
      const rec = record(keyLabel, now);
      if (now - instanceWindowStart >= limits.spendWindowMs) {
        instanceWindowStart = now;
        instanceSpend = 0;
      }

      const keyRemainingUsd = Math.max(0, limits.spendPerKeyUsd - rec.spendInWindow);
      const instanceRemainingUsd = Math.max(0, limits.spendTotalUsd - instanceSpend);

      if (limits.spendPerKeyUsd <= 0 || limits.spendTotalUsd <= 0) {
        return {
          allowed: false, refusedBy: 'disabled', keyRemainingUsd: 0, instanceRemainingUsd: 0,
          reason: 'metered sources are disabled on this instance, so the report ran without them',
        };
      }
      if (keyRemainingUsd <= 0) {
        return {
          allowed: false, refusedBy: 'per-key', keyRemainingUsd, instanceRemainingUsd,
          reason: `this key has spent its $${limits.spendPerKeyUsd} allowance for the period`,
        };
      }
      if (instanceRemainingUsd <= 0) {
        /* Named separately from the per key case on purpose: "you are out" and
         * "everybody is out" are different problems and only one of them is
         * the caller's to solve. */
        return {
          allowed: false, refusedBy: 'instance', keyRemainingUsd, instanceRemainingUsd,
          reason: `this instance has spent its $${limits.spendTotalUsd} budget for the period`,
        };
      }
      return {
        allowed: true, refusedBy: null, keyRemainingUsd, instanceRemainingUsd,
        reason: `up to $${Math.min(keyRemainingUsd, instanceRemainingUsd).toFixed(4)} available`,
      };
    },

    charge(keyLabel, usd, now = Date.now()) {
      if (!Number.isFinite(usd) || usd <= 0) return;
      const rec = record(keyLabel, now);
      if (now - instanceWindowStart >= limits.spendWindowMs) {
        instanceWindowStart = now;
        instanceSpend = 0;
      }
      /* Lifetime and windowed, both. The first answers "what did this caller
       * cost", the second enforces the budget. */
      rec.spendUsd += usd;
      rec.spendInWindow += usd;
      instanceSpend += usd;
    },

    snapshot(keyLabel, running, now = Date.now()) {
      const rec = record(keyLabel, now);
      return {
        /*
         * A LABEL, NEVER A KEY. The server only ever holds a hash and a
         * display label, so there is nothing here to leak even by accident.
         */
        keyPrefix: keyLabel,
        periodStart: Math.floor(rec.windowStart / 1000),
        periodEnd: Math.floor((rec.windowStart + limits.windowMs) / 1000),
        reports: stateOf(rec.reports, limits.reportsPerWindow),
        lookups: stateOf(rec.lookups, limits.lookupsPerWindow),
        concurrentReports: { running, limit: limits.concurrentReports },
        spendUsd: Number(rec.spendUsd.toFixed(6)),
      };
    },

    keys: () => [...keys.keys()],
  };
}

/* Which meter a route counts against, decided by path rather than by handler
 * so a new route cannot be added without landing in one of the two. */
export function meterFor(method: string, pathname: string): Meter {
  if (pathname === '/v1/healthz') return 'exempt';
  if (pathname === '/v1/reports' && method === 'POST') return 'reports';
  return 'lookups';
}
