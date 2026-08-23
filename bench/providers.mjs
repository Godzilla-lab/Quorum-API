/*
 * THE PATHS THAT NEED A KEY, ABUSED WITHOUT ONE.
 *
 *   node bench/providers.mjs [iterations] [seed]
 *
 * Every other harness in here is offline and keyless, which means every other
 * harness skips the vision model, the synthesis model and the live sources.
 * Those are the paths that fail in production, because they are the only ones
 * that depend on something we do not control.
 *
 * They are all INJECTED, so they can be abused without a key, without the
 * network and without a cent: `runResearch` takes `readImage`, `askModel` and
 * `makeSource`, and the production binary is the only thing that supplies the
 * real ones. This harness supplies providers that behave the way real ones do
 * on a bad day, hundreds of times in every combination, and checks that the
 * promises this project makes still hold every single time.
 *
 * THE PROMISES UNDER TEST, one per invariant in `check` below:
 *
 *   a provider REFUSING degrades a run and never fails it
 *   a provider THROWING is our own defect and stays loud
 *   a fabricated citation never reaches the report
 *   a reading is an interpretation and never becomes evidence
 *   a claim below the corroboration threshold is never a finding
 *   every paid call charges the cost meter
 *
 * SEEDED. A failing iteration prints the seed that produced it, so a fuzz
 * finding is reproducible rather than a story about something that happened
 * once on somebody's laptop.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteCorpus } from '../packages/corpus/src/index.ts';
import { runResearch } from '../packages/cli/src/run.ts';

const iterations = Number(process.argv[2] ?? 400);
const baseSeed = Number(process.argv[3] ?? 1);

/* Mulberry32. Small, seeded, and good enough to pick from a list. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const scratch = mkdtempSync(join(tmpdir(), 'quorum-providers-'));
let dbn = 0;
const freshDb = () => join(scratch, `c${dbn++}.db`);

const SUBJECT = {
  category: 'running shoes',
  title: 'running shoes',
  source: 'page',
  images: ['https://img.test/1.jpg', 'https://img.test/2.jpg', 'https://img.test/3.jpg'],
  reviews: [],
};

const record = (n, text, channel = 'r/running') => ({
  source: 'reddit', kind: 'comment', externalId: `c${n}`, channel, text,
  score: 5, url: `https://example.test/${n}`, createdUtc: 1_700_000_000, origin: channel,
});

const GOOD_RECORDS = [
  record(1, 'these running shoes have great quality stitching'),
  record(2, 'quality of the running shoes held up for a year', 'r/runningshoegeeks'),
  record(3, 'build quality on my running shoes is excellent', 'r/trailrunning'),
  record(4, 'running shoes gave me problems on long runs'),
  record(5, 'sizing problems with these running shoes', 'r/runningshoegeeks'),
];

const reading = (url, text, kind = 'transcription') => ({
  imageUrl: url, kind, text, model: 'fake/vision', readAt: 1_700_000_000, derived: true,
});

/*
 * WAYS A VISION PROVIDER MISBEHAVES.
 *
 * Every one of these was chosen because a real provider does it: they throw on
 * a rate limit, they return null when a key is missing, they answer with an
 * empty string for a blank swatch, and they will happily read text off a
 * product photo that looks exactly like one of our receipt ids.
 */
const VISION = {
  throws: () => async () => { throw new Error('402 payment required'); },
  rejectsLate: () => async () => { await new Promise((r) => setTimeout(r, 5)); throw new Error('socket hang up'); },
  null: () => async () => null,
  empty: () => async (url) => reading(url, ''),
  huge: () => async (url) => reading(url, 'x'.repeat(200_000)),
  /* The dangerous one. A reading that looks like evidence and quotes an id
   * that does not exist is the exact shape of a fabricated citation. */
  fabricates: () => async (url) => reading(url, 'SIZING RUNS SMALL rc_deadbeefdeadbeef see receipt rc_0000000000000000'),
  /* Bytes that have broken the corpus before. The lone surrogate is built
   * rather than written, so this file stays valid text. */
  control: () => async (url) => reading(
    url,
    `a shoe with ${String.fromCodePoint(0x1f45f)} and a lone ${String.fromCharCode(0xd800)} and a ${String.fromCharCode(0)} nul`,
    'description',
  ),
  /* Lies about which image it read. A reading's only receipt is its url. */
  wrongUrl: () => async () => reading('https://somewhere.else/x.jpg', 'a shoe', 'description'),
};

/*
 * WAYS A SYNTHESIS MODEL MISBEHAVES. The gate exists for the first two, and
 * the whole product rests on them being caught.
 */
const MODEL = {
  throws: () => async () => { throw new Error('upstream 503'); },
  errorValue: () => async () => ({ ok: false, error: 'no key configured' }),
  empty: () => async () => ({ ok: true, model: 'fake/model', json: { claims: [] }, usage: { inputTokens: 1, outputTokens: 1 } }),
  /* Ids that never existed. Nothing citing these may print as a finding. */
  fabricates: () => async () => ({
    ok: true,
    model: 'fake/model',
    json: { claims: [{ term: 'quality', claim: 'Buyers report excellent quality.', evidence_ids: ['rc_deadbeefdeadbeef', 'c99', 'p400'] }] },
    usage: { inputTokens: 400, outputTokens: 900 },
  }),
  /* Real ordinals, but one of them, which is under the corroboration threshold
   * and may never be printed as a finding however good the sentence is. */
  thin: () => async (request) => {
    const ordinals = [...request.prompt.matchAll(/^([cp]\d+) \[/gm)].map((m) => m[1]);
    return {
      ok: true,
      model: 'fake/model',
      json: { claims: [{ term: 'quality', claim: 'Everyone agrees.', evidence_ids: ordinals.slice(0, 1) }] },
      usage: { inputTokens: 400, outputTokens: 900 },
    };
  },
  /* Shapes the schema does not describe. Models return these constantly. */
  garbage: () => async () => ({ ok: true, model: 'fake/model', json: { claims: 'lots' }, usage: { inputTokens: 1, outputTokens: 1 } }),
  nullJson: () => async () => ({ ok: true, model: 'fake/model', json: null, usage: { inputTokens: 1, outputTokens: 1 } }),
  flood: () => async (request) => {
    const ordinals = [...request.prompt.matchAll(/^([cp]\d+) \[/gm)].map((m) => m[1]);
    return {
      ok: true,
      model: 'fake/model',
      json: {
        claims: Array.from({ length: 300 }, (_, i) => ({
          term: `term ${i}`, claim: 'x'.repeat(500), evidence_ids: ordinals.slice(0, 3),
        })),
      },
      usage: { inputTokens: 400, outputTokens: 900 },
    };
  },
};

/* WAYS A SOURCE MISBEHAVES. Every one of these has happened upstream. */
const SOURCE = {
  ok: () => GOOD_RECORDS,
  none: () => [],
  throwsMidway: () => 'throw',
  hugeText: () => [record(1, `running shoes ${'y'.repeat(500_000)}`)],
  duplicateIds: () => Array.from({ length: 20 }, () => record(1, 'quality running shoes here')),
  emptyText: () => [{ ...record(1, 'x'), text: '' }],
  offTopic: () => [record(1, 'unrelated thread about mortgage rates'), record(2, 'the weather today')],
  flood: () => Array.from({ length: 2000 }, (_, i) => record(i, `quality running shoes number ${i}`, `r/p${i % 30}`)),
};

function makeSource(kind, charge) {
  const rows = SOURCE[kind]();
  return {
    id: 'reddit',
    cost: 'free',
    channelKind: 'handle',
    configured: () => true,
    plan: async () => [{ text: 'running shoes' }],
    async *retrieve(_query, ctx) {
      /* Charged before yielding, exactly as a metered adapter does, so the
       * meter is under test even when the source then falls over. */
      if (charge) ctx.cost.charge('apify.fb-ads-item');
      if (rows === 'throw') {
        yield record(1, 'quality running shoes, one record before the fall');
        throw new Error('upstream closed the connection mid page');
      }
      yield* rows;
    },
    cite: (r) => ({ label: r.origin, url: r.url ?? '', score: r.score ?? 0, postedAt: r.createdUtc ?? 0 }),
  };
}

const pick = (r, obj) => {
  const keys = Object.keys(obj);
  return keys[Math.floor(r() * keys.length)];
};

/*
 * THE INVARIANTS. Each pushes a sentence when it is violated, so a failure
 * names itself instead of arriving as an assertion stack.
 */
function check(result, plan) {
  const problems = [];

  /* A fabricated citation never reaches the report. This is the whole pitch. */
  if (result.receiptCheck.unresolved.length) {
    problems.push(`unresolved receipts printed: ${result.receiptCheck.unresolved.slice(0, 3).join(', ')}`);
  }

  /* A reading is an interpretation: never evidence, never counted, never in
   * the corpus, and never attached to a claim. */
  const cited = new Set(result.claims.flatMap((c) => c.receiptIds));
  for (const r of result.readings) {
    if (r.derived !== true) problems.push('a reading lost its derived flag');
    if (cited.has(r.imageUrl)) problems.push('a reading joined a claim');
  }

  /* A claim under the threshold is never a finding, and its counts agree with
   * the receipts it lists. */
  for (const claim of result.claims) {
    if (claim.verdict === 'finding' && claim.basis === 'receipt-count' && claim.records < claim.threshold) {
      problems.push(`${claim.term} is a finding on ${claim.records} records against a threshold of ${claim.threshold}`);
    }
    if (claim.records !== claim.receiptIds.length) {
      problems.push(`${claim.term} counts ${claim.records} records and lists ${claim.receiptIds.length} receipts`);
    }
  }

  /* Synthesis. A printed claim's receipts must resolve, and an invented id
   * must be reported rather than dropped in silence. */
  const s = result.synthesis;
  if (s) {
    for (const claim of s.claims) {
      if (claim.verdict !== 'finding') continue;
      for (const receipt of claim.receipts) {
        if (!receipt.receiptId) problems.push('a printed synthesis claim cited an empty id');
      }
    }
    if (plan.model === 'fabricates' && s.fabrication.idsFabricated === 0 && !s.error) {
      problems.push('the model invented three ids and the gate reported none');
    }
  }

  /* The meter. Never negative, and a charged call is always on the bill. */
  if (result.cost.totalUsd < 0) problems.push('negative cost');
  if (plan.charge && !result.offline && result.cost.totalUsd === 0) {
    problems.push('a paid call was made and the meter says zero');
  }

  return problems;
}

const distinct = new Map();
let failures = 0;
const startedAt = performance.now();

for (let i = 0; i < iterations; i++) {
  const seed = baseSeed + i;
  const r = rng(seed);
  const plan = {
    vision: pick(r, VISION),
    model: pick(r, MODEL),
    source: pick(r, SOURCE),
    charge: r() < 0.4,
    readImages: r() < 0.7,
    synthesise: r() < 0.7,
  };

  const options = {
    subject: 'running shoes',
    terms: ['quality', 'price', 'problems'],
    communities: ['running'],
    sources: ['reddit'],
    adSources: [],
    corpusPath: freshDb(),
    maxQueriesPerSource: 1,
    maxRecordsTotal: 5000,
    deadlineMs: 60_000,
    capUsd: undefined,
    compare: [],
    offline: false,
    readImages: plan.readImages,
    maxImages: 2,
    synthesise: plan.synthesise,
    synthesisModel: undefined,
    format: 'text',
    asOf: undefined,
    json: false,
    quiet: true,
  };

  let problems = [];
  try {
    const result = await runResearch(options, {
      openCorpus: (path) => openSqliteCorpus({ path }),
      resolveSubject: async () => SUBJECT,
      makeSource: () => makeSource(plan.source, plan.charge),
      readImage: VISION[plan.vision](),
      askModel: MODEL[plan.model](),
      env: {},
    });
    problems = check(result, plan);
  } catch (err) {
    /*
     * A THROW IS ONLY A FAILURE WHEN THE PROVIDER DID NOT THROW.
     *
     * This harness first asserted that nothing may ever escape `runResearch`,
     * and reported six violations on the first twenty four runs. It was wrong,
     * and a test in `run.test.ts` had already said so: `synthesise` promises
     * errors as VALUES for anything a vendor can do, and a transport that
     * throws is our own defect that must not be turned into an empty report.
     *
     * The argument for swallowing was that a throw at the last step discards a
     * report that cost minutes of throttled retrieval. It does not. Sources
     * write to the corpus as they yield, so every record survives and the
     * re-run is offline and takes half a second. A cheap re-run is the whole
     * price of keeping our own bugs visible.
     *
     * So a throw is scored only when the injected provider returned normally.
     * The `throws` behaviours below are expected to propagate, and this harness
     * checks that a REFUSAL never does.
     */
    const threw = plan.vision.includes('throws') || plan.vision === 'rejectsLate'
      || plan.model === 'throws' || plan.source === 'throwsMidway';
    problems = threw ? [] : [`THREW with no provider throwing: ${err instanceof Error ? err.message : String(err)}`];
  }

  for (const p of problems) {
    const key = `${p} [vision=${plan.vision} model=${plan.model} source=${plan.source}]`;
    if (!distinct.has(key)) distinct.set(key, seed);
    failures++;
  }
}

const wall = (performance.now() - startedAt) / 1000;
rmSync(scratch, { recursive: true, force: true });

console.log(`  ${iterations} runs against misbehaving providers in ${wall.toFixed(1)}s, seeds ${baseSeed} to ${baseSeed + iterations - 1}`);
console.log(`  ${Object.keys(VISION).length} vision behaviours, ${Object.keys(MODEL).length} model, ${Object.keys(SOURCE).length} source`);
console.log();

if (!distinct.size) {
  console.log('  every invariant held on every run');
} else {
  console.log(`  ${failures} violation(s), ${distinct.size} distinct:`);
  for (const [problem, seed] of distinct) console.log(`    seed ${seed}  ${problem}`);
  process.exitCode = 1;
}
