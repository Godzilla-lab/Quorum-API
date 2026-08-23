/*
 * The same requests, delivered five DIFFERENT WAYS.
 *
 *   node bench/waves.mjs http://localhost:8787 ./bench.db [shape]
 *
 * A steady stream at fixed concurrency is one shape of traffic, and it is the
 * least interesting one, because it is the shape a load generator produces
 * rather than the shape people produce. These are the others, and each one has
 * found something the steady stream did not:
 *
 *   herd    everything at once, cold. A cron fanout, or a launch announcement.
 *   churn   a new TCP connection per request, no keep alive. Curl in a loop, a
 *           serverless caller, anything behind a proxy that will not pool.
 *   agent   sequential dependent chains: ask, then resolve every id cited. The
 *           real usage pattern, and the one with no parallelism to hide behind,
 *           so its p99 is the number a person actually feels.
 *   ramp    concurrency climbing 1 to 256, to find where it bends rather than
 *           assuming.
 *
 * `herd` is why this file exists. Load shedding only protects requests the
 * server ACCEPTS, and a herd overflows the kernel accept queue, where nothing
 * in this codebase can see it or refuse it.
 */
import { Agent, request } from 'node:http';
import { ATTR, CATEGORIES, pick, percentile, query, sampleReceiptIds } from './queries.mjs';

const base = process.argv[2] ?? 'http://localhost:8787';
const corpusPath = process.argv[3] ?? './bench.db';
const only = process.argv[4];

const IDS = await sampleReceiptIds(corpusPath);
const post = (b) => JSON.stringify(b);

/*
 * Raw `http` rather than `fetch`, so pooling is a DECISION rather than a
 * default. fetch pools invisibly, and pooling is the exact variable under test
 * in two of these shapes.
 */
function send(url, { method = 'GET', body = null, agent } = {}) {
  const u = new URL(url);
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
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, ms: performance.now() - t0 }));
    });
    req.on('error', (e) => resolve({ status: 0, ms: performance.now() - t0, err: e.code ?? e.message }));
    if (body) req.write(body);
    req.end();
  });
}

function job() {
  const r = Math.random();
  if (r < 0.55) return [`${base}/v1/evidence/${pick(IDS)}`, {}];
  if (r < 0.80) return [`${base}/v1/evidence/search`, { method: 'POST', body: post({ query: query(), category: pick(CATEGORIES), limit: 20 }) }];
  if (r < 0.90) return [`${base}/v1/categories/${encodeURIComponent(pick(CATEGORIES))}`, {}];
  if (r < 0.97) return [`${base}/v1/evidence/batch`, { method: 'POST', body: post({ receiptIds: Array.from({ length: 50 }, () => pick(IDS)) }) }];
  return [`${base}/v1/verify`, { method: 'POST', body: post({ claims: [{ term: pick(ATTR), text: 'a claim', receiptIds: [pick(IDS), pick(IDS)] }] }) }];
}

let failures = 0;

function report(name, results, wall) {
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const codes = {};
  const errs = new Set();
  for (const r of results) {
    codes[r.status] = (codes[r.status] ?? 0) + 1;
    if (r.err) errs.add(r.err);
  }
  const served = results.filter((r) => r.status >= 200 && r.status < 400).length;
  const dropped = codes[0] ?? 0;
  failures += dropped + (codes[500] ?? 0);
  const p = (q) => percentile(ms, q).toFixed(0).padStart(7);
  console.log(
    `  ${name.padEnd(10)}${String(results.length).padStart(6)}${`${wall.toFixed(1)}s`.padStart(8)}`
    + `${(served / wall).toFixed(0).padStart(10)}${String(dropped).padStart(8)}`
    + `${p(0.5)}${p(0.95)}${p(0.99)}   `
    + Object.entries(codes).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}:${n}`).join(' '),
  );
  if (errs.size) console.log(`              transport: ${[...errs].join(', ')}`);
}

async function pool(n, concurrency, agent) {
  let next = 0;
  const out = [];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next++ < n) {
      const [url, opts] = job();
      out.push(await send(url, { ...opts, agent }));
    }
  }));
  return out;
}

const runs = (name) => !only || only === name;

console.log('  shape       reqs    wall  served/s  dropped     p50     p95     p99   statuses');

if (runs('herd')) {
  /* No concurrency limit at all. maxSockets Infinity is the point: this is what
   * a thousand cron jobs firing on the same minute looks like. */
  const agent = new Agent({ keepAlive: true, maxSockets: Infinity });
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: 3000 }, () => {
    const [url, opts] = job();
    return send(url, { ...opts, agent });
  }));
  report('herd', results, (performance.now() - t0) / 1000);
  agent.destroy();
}

if (runs('churn')) {
  const agent = new Agent({ keepAlive: false, maxSockets: Infinity });
  const t0 = performance.now();
  report('churn', await pool(3000, 100, agent), (performance.now() - t0) / 1000);
  agent.destroy();
}

if (runs('agent')) {
  const agent = new Agent({ keepAlive: true, maxSockets: Infinity });
  const t0 = performance.now();
  const results = (await Promise.all(Array.from({ length: 40 }, async () => {
    const mine = [];
    for (let step = 0; step < 25; step++) {
      mine.push(await send(`${base}/v1/evidence/search`, {
        method: 'POST', body: post({ query: query(), category: pick(CATEGORIES), limit: 10 }), agent,
      }));
      /* Then resolve what that search would have been cited for. Nothing
       * overlaps inside one chain, which is what makes this p99 honest. */
      for (let i = 0; i < 3; i++) mine.push(await send(`${base}/v1/evidence/${pick(IDS)}`, { agent }));
    }
    return mine;
  }))).flat();
  report('agent', results, (performance.now() - t0) / 1000);
  agent.destroy();
}

if (runs('ramp')) {
  const agent = new Agent({ keepAlive: true, maxSockets: Infinity });
  for (const concurrency of [1, 4, 16, 64, 256]) {
    const t0 = performance.now();
    report(`ramp/${concurrency}`, await pool(600, concurrency, agent), (performance.now() - t0) / 1000);
  }
  agent.destroy();
}

if (failures) {
  console.log(`\n  ${failures} request(s) returned 500 or lost the connection. See the herd note above.`);
}
