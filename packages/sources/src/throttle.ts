/*
 * Self throttling with backoff, one instance per upstream.
 *
 * The curve is ported from the engine, where it was measured rather than
 * guessed. Against the free archive on 2026-08-13: firing about 60 queries at
 * concurrency 6 earns a sustained rate limit that takes minutes to clear, and
 * every request inside that window silently returns nothing. So the client
 * throttles itself rather than discovering the limit the hard way.
 *
 * WHAT CHANGED IN THE PORT, and why it had to.
 *
 * The engine kept `currentGap` and `sendChain` as module level mutable state.
 * That is correct behaviour for a CLI, where one process makes all the
 * requests, and it is the right behaviour for the server too: hosted tenants
 * should share one polite client rather than each getting their own and
 * multiplying load on a volunteer run service.
 *
 * But module globals cannot be reset between tests, cannot be given per
 * upstream instances, and cannot be inspected. So the state moves into an
 * object, and the sharing becomes a deliberate choice at the call site rather
 * than an accident of module scope.
 */

export interface ThrottleOptions {
  /* Floor between sends, in milliseconds. */
  minGapMs?: number;
  /* Ceiling the gap can widen to under sustained pressure. */
  maxGapMs?: number;
  /* How many times a single request is retried before giving up. */
  maxAttempts?: number;
  /* Injected in tests so a suite does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /* Injected in tests to make jitter deterministic. */
  random?: () => number;
}

/* Measured defaults. Changing these changes how hard we lean on a free service. */
export const MIN_GAP_MS = 220;
export const MAX_GAP_MS = 4000;
const MAX_ATTEMPTS = 4;
/*
 * The floor a penalty jumps to. Doubling 220 gives 440, which is not enough of
 * a step back once a service has started refusing, so the first penalty lands
 * at 600 regardless.
 */
const PENALTY_FLOOR_MS = 600;
const RELAX_FACTOR = 0.8;
const JITTER_MS = 400;

export interface Throttle {
  /*
   * Run `fn` on the shared send schedule. Sends are serialised and spaced by
   * the current gap, so concurrency above this controls how many are queued,
   * not how many go out at once.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /* Retry loop around `run`, backing off whenever `isOverload` says to. */
  attempt<T>(fn: () => Promise<T>, isOverload: (result: T) => boolean, empty: T): Promise<T>;
  penalise(): void;
  relax(): void;
  /* Exposed so a run can report whether it got throttled. */
  state(): { gapMs: number; throttled: boolean };
}

export function createThrottle(options: ThrottleOptions = {}): Throttle {
  const minGap = options.minGapMs ?? MIN_GAP_MS;
  const maxGap = options.maxGapMs ?? MAX_GAP_MS;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;

  let currentGap = minGap;
  /*
   * A promise chain, not a queue. Each send waits for the previous one to be
   * scheduled, which is what actually serialises them. The chain is replaced
   * with a settled continuation every time so a rejection cannot poison it.
   */
  let sendChain: Promise<void> = Promise.resolve();

  const throttle: Throttle = {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const scheduled = sendChain.then(async () => {
        await sleep(currentGap);
        return fn();
      });
      sendChain = scheduled.then(() => {}, () => {});
      return scheduled;
    },

    penalise(): void {
      currentGap = Math.min(maxGap, Math.max(currentGap * 2, PENALTY_FLOOR_MS));
    },

    relax(): void {
      currentGap = Math.max(minGap, currentGap * RELAX_FACTOR);
    },

    async attempt<T>(fn: () => Promise<T>, isOverload: (result: T) => boolean, empty: T): Promise<T> {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const result = await throttle.run(fn);
        if (!isOverload(result)) {
          throttle.relax();
          return result;
        }
        throttle.penalise();
        /*
         * Jitter so parallel workers do not all come back at the same instant
         * and re-trigger the limit together.
         */
        await sleep(currentGap * (attempt + 1) + random() * JITTER_MS);
      }
      /*
       * Out of attempts. Returns the caller's empty value rather than throwing,
       * because a source that is refusing us must degrade a run, never fail it.
       */
      return empty;
    },

    state(): { gapMs: number; throttled: boolean } {
      return { gapMs: Math.round(currentGap), throttled: currentGap > minGap };
    },
  };

  return throttle;
}

/*
 * Overload has three spellings on the archive we read most, and all three mean
 * back off: HTTP 429, a 200 body of {"error":"Timeout. Maybe slow down a bit"},
 * and {"error":"Too many requests"}.
 *
 * A parameter error means STOP, not retry. Retrying a malformed query just
 * spends the budget four times to get the same refusal.
 */
export function isOverloadMessage(message: string | null | undefined): boolean {
  return /timeout|slow down|too many requests|rate limit/i.test(message ?? '');
}


/*
 * ONE THROTTLE PER UPSTREAM, PER PROCESS.
 *
 * A throttle instance only slows down the calls that go through it. The CLI
 * runs one report per process, so a per client throttle is the same thing as a
 * per upstream one and nothing was wrong. A server is different: every
 * concurrent report builds its own client, so ten tenants researching at once
 * would create ten throttles and hit Arctic Shift at TEN TIMES the rate the
 * curve was calibrated for, each one politely convinced it was behaving.
 *
 * Arctic Shift is a volunteer archive. Multiplying load on it by tenant count
 * is how a free source becomes a blocked one, and it is the single easiest way
 * to lose the thing this whole product is built on.
 *
 * So throttles are shared by upstream key. Two callers asking for
 * `shared('arctic-shift')` get the same instance and queue behind each other.
 *
 * What this does NOT solve, stated plainly: it is per PROCESS. Several server
 * instances still multiply load by instance count, and fixing that needs a
 * coordinator the processes share rather than a module global. That is a real
 * gap and it belongs to the hosted server, not here.
 */
const SHARED = new Map<string, Throttle>();

export function sharedThrottle(upstream: string, options: ThrottleOptions = {}): Throttle {
  const existing = SHARED.get(upstream);
  if (existing) return existing;
  const created = createThrottle(options);
  SHARED.set(upstream, created);
  return created;
}

/* Tests only. Module global state that cannot be reset is untestable state. */
export function resetSharedThrottles(): void {
  SHARED.clear();
}
