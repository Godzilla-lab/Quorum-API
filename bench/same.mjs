/*
 * TEN THOUSAND OF THE SAME REQUEST, ALL AT ONCE.
 *
 *   node bench/same.mjs http://localhost:8787 ./bench.db 10000 [shape]
 *
 * The opposite of `mixed.mjs`, on purpose. That harness maximises DISTINCT
 * queries, because a run drawn from twelve strings measures a warm cache
 * instead of the FTS parser. This one maximises COLLISION, because the two
 * failure modes are opposites and only one of them shows up per harness:
 *
 *   distinct traffic  finds parser bugs, planner bugs, unbounded inputs
 *   identical traffic finds dogpiles, hot key contention, coalescing that
 *                     does not, and per request work that should have been
 *                     done once
 *
 * A real caller produces the identical shape constantly and nobody designs for
 * it: a cron on ten thousand rows of the same category, an agent retrying the
 * same failed lookup, a launch where every reader asks about one product, a
 * dashboard polling one report id.
 *
 * WHAT COUNTS AS A FAILURE HERE
 *
 * A 500 or a dropped connection AFTER the server accepted it. A connection the
 * kernel never accepted is reported separately and is not scored, because the
 * accept queue is 128 deep by default on this machine and no code in this repo
 * can see a connection it was never handed. That is measured, not excused: see
 * the herd section of the README.
 */
import { Agent, request } from 'node:http';
import { HOSTILE, percentile, sampleReceiptIds } from './queries.mjs';

const base = process.argv[2] ?? 'http://localhost:8787';
const corpusPath = process.argv[3] ?? './bench.db';
const total = Number(process.argv[4] ?? 10_000);
const only = process.argv[5];

const IDS = await sampleReceiptIds(corpusPath, 50);
const HOT_ID = IDS[0];

/*
 * One socket pool, unbounded, shared by every request in a shape. Unbounded
 * because "all at once" is the input under test: capping sockets here would be
 * this harness quietly turning the herd into a queue and then reporting that
 * the herd was fine.
 */
const agent = new Agent({ keepAlive: true, maxSockets: Infinity });

/*
 * `keep` bounds how much of the response is retained. Bounded by default
 * because ten thousand full report bodies is gigabytes of garbage that the
 * harness would spend its own time collecting, and the numbers under test are
 * latency and status. The probes that must parse a whole body ask for it.
 */
function send(path, { method = 'GET', body = null, keep = 4096 } = {}) {
  const u = new URL(base + path);
  const t0 = performance.now();
  return new Promise((resolve) => {
    const req = request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      agent,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (text.length < keep) text += c; });
      res.on('end', () => resolve({ status: res.statusCode, ms: performance.now() - t0, text }));
    });
    req.on('error', (e) => resolve({ status: 0, ms: performance.now() - t0, err: e.code ?? e.message }));
    if (body) req.write(body);
    req.end();
  });
}

const json = (b) => JSON.stringify(b);

/*
 * Every shape sends ONE byte for byte identical request, `total` times. The
 * bodies are built once, outside the loop, so nothing here can accidentally
 * vary and turn a dogpile back into a spread.
 */
const SHAPES = {
  /* One indexed read, the cheapest thing the server does. The control. */
  resolve: () => send(`/v1/evidence/${HOT_ID}`),

  /* The expensive one. An FTS read measured at 8.5ms with no cache in front of
   * it, so ten thousand identical copies are ten thousand reads of an answer
   * that could not have changed. */
  search: (() => {
    const body = json({ query: 'sizing runs small', category: 'category 3', limit: 20 });
    return () => send('/v1/evidence/search', { method: 'POST', body });
  })(),

  /*
   * THE COALESCING SHAPE. Ten thousand callers asking for the same report.
   *
   * The obvious expectation is one run and 9,999 joiners. MEASURED 2026-08-22
   * IT IS NEITHER: every accepted submission got a run of its own, and not one
   * caller was told it had joined. That is not a broken key. A report run
   * occupies the event loop for its whole duration on the sqlite driver, so the
   * second request is not RECEIVED until the first run has finished and
   * unregistered its key, and there is never a moment when two identical
   * requests are in flight together. Coalescing is real, and under this driver
   * it can only fire for callers that were already parsed.
   *
   * So the number below is reported and not asserted on. It becomes an
   * assertion the day the corpus read yields.
   */
  report: (() => {
    const body = json({ subject: 'category 7', terms: ['sizing'], offline: true });
    return () => send('/v1/reports', { method: 'POST', body });
  })(),

  /* The largest legal batch, repeated. One request doing 200 reads, ten
   * thousand times, is the cheapest way for one caller to occupy the process. */
  batch: (() => {
    const body = json({ receiptIds: Array.from({ length: 200 }, (_, i) => IDS[i % IDS.length]) });
    return () => send('/v1/evidence/batch', { method: 'POST', body });
  })(),

  /* The byte that returned 500 twelve times out of twelve, now sent ten
   * thousand times identically rather than sprinkled through a mix. */
  nul: (() => {
    const body = json({ query: HOSTILE.find((h) => h.includes(String.fromCharCode(0))), limit: 20 });
    return () => send('/v1/evidence/search', { method: 'POST', body });
  })(),

  /* A category that does not exist, repeated. The not found path is a path. */
  missing: () => send('/v1/evidence/rc_deadbeefdeadbeef'),
};

/*
 * WHY IDENTICAL REPORTS DO NOT COALESCE, MEASURED RATHER THAN ARGUED.
 *
 * Runs one report and pings `/v1/healthz` throughout. Healthz touches no
 * database and answers in under a millisecond when the process is idle, so its
 * latency during a report IS the time the event loop spent unable to do
 * anything else. Measured 2026-08-22: a 287ms report, healthz max 284ms, six
 * pings served in the window against hundreds when idle.
 */
async function loopProbe() {
  const idle = [];
  for (let i = 0; i < 20; i++) idle.push((await send('/v1/healthz')).ms);
  idle.sort((a, b) => a - b);

  const during = [];
  let stop = false;
  const pinger = (async () => { while (!stop) during.push((await send('/v1/healthz')).ms); })();

  const t0 = performance.now();
  const accepted = await send('/v1/reports', {
    method: 'POST',
    body: json({ subject: 'category 12', terms: ['sizing', 'comfort', 'durability'], offline: true }),
  });
  const id = JSON.parse(accepted.text).id;
  let status = 'queued';
  while (status === 'queued' || status === 'running') {
    const got = await send(`/v1/reports/${id}`, { keep: Infinity });
    /* A shed poll is not a finished report. Reading `status` off a 503 body was
     * reporting the report as `undefined` and leaving the probe early. */
    if (got.status !== 200) continue;
    status = JSON.parse(got.text).status;
  }
  const wall = performance.now() - t0;
  stop = true;
  await pinger;
  during.sort((a, b) => a - b);

  console.log(`  loop         report ${status} in ${wall.toFixed(0)}ms`);
  console.log(`               healthz idle p50 ${percentile(idle, 0.5).toFixed(0)}ms, `
    + `during the report p50 ${percentile(during, 0.5).toFixed(0)}ms max ${(during[during.length - 1] ?? 0).toFixed(0)}ms `
    + `over ${during.length} pings`);
  console.log('               a max close to the report wall time means the loop was held for the whole run');
}

if (only === 'loop') { await loopProbe(); process.exit(0); }

const names = only ? [only] : Object.keys(SHAPES);
console.log(`  ${total} identical requests per shape, all released at once, against ${base}`);
console.log();
console.log('  shape        served  p50     p95     p99     max     statuses / notes');

let failures = 0;
for (const name of names) {
  const fire = SHAPES[name];
  if (!fire) throw new Error(`unknown shape ${name}`);

  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: total }, () => fire()));
  const wall = (performance.now() - t0) / 1000;

  const ms = results.filter((r) => r.status).map((r) => r.ms).sort((a, b) => a - b);
  const status = {};
  const errs = new Map();
  for (const r of results) {
    status[r.status] = (status[r.status] ?? 0) + 1;
    if (r.err) errs.set(r.err, (errs.get(r.err) ?? 0) + 1);
  }
  /* Accepted and then failed is ours. Never accepted is the kernel's, and it is
   * counted apart rather than folded in to make a table look worse or better
   * than the process actually behaved. */
  const neverAccepted = results.filter((r) => r.status === 0).length;
  failures += status[500] ?? 0;

  const p = (q) => percentile(ms, q).toFixed(0).padStart(5);
  const codes = Object.entries(status).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}:${n}`).join(' ');
  console.log(
    `  ${name.padEnd(11)}${String(ms.length).padStart(6)}  ${p(0.5)}ms ${p(0.95)}ms ${p(0.99)}ms `
    + `${(ms[ms.length - 1] ?? 0).toFixed(0).padStart(5)}ms  ${codes}`,
  );
  console.log(`               ${(results.length / wall).toFixed(0)} req/s over ${wall.toFixed(1)}s`);
  for (const [e, n] of errs) console.log(`               never accepted: ${e} x${n}`);
  if (neverAccepted) {
    console.log('               (a connection the kernel never handed us, see the herd note in the README)');
  }

  /*
   * The coalescing assertion, and the reason the report shape exists. Distinct
   * job ids across identical submissions means every caller paid for its own
   * retrieval.
   */
  if (name === 'report') {
    const ids = new Set();
    let coalesced = 0;
    for (const r of results) {
      try {
        const body = JSON.parse(r.text);
        if (body.id) ids.add(body.id);
        if (body.coalesced) coalesced++;
      } catch { /* a shed or errored response is counted in the status line */ }
    }
    console.log(`               ${ids.size} distinct run(s) for one subject, ${coalesced} told they joined an existing run`);
    if (ids.size > 1 && coalesced === 0) {
      console.log('               nothing coalesced: see the note above this shape, and `loop` below');
    }
  }
}

if (!only) await loopProbe();

if (failures) {
  console.log(`\n  FAILED: ${failures} problem(s) the server owns`);
  process.exitCode = 1;
}
