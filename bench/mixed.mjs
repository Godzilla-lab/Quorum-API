/*
 * A realistic mixed workload against a running server.
 *
 *   node bench/mixed.mjs http://localhost:8787 ./bench.db 10000 100
 *
 * The mix is weighted the way a caller actually behaves rather than evenly:
 * resolving receipts dominates, because that is what happens to a report. One
 * report is read once and then every claim in it gets looked up.
 *
 * Roughly a tenth of the traffic is hostile or malformed, and it is mixed in
 * rather than run as its own pass. That is not tidiness. The NUL that returned
 * HTTP 500 on 2026-08-22 answered 200 when sent on its own, answered 200 when
 * sent two thousand times at concurrency 100, and only failed inside the full
 * mix. A separate hostile pass would not have found it.
 */
import { CATEGORIES, HOSTILE, MALFORMED, ATTR, pick, percentile, query, sampleReceiptIds } from './queries.mjs';

const base = process.argv[2] ?? 'http://localhost:8787';
const corpusPath = process.argv[3] ?? './bench.db';
const total = Number(process.argv[4] ?? 10_000);
const concurrency = Number(process.argv[5] ?? 100);

const IDS = await sampleReceiptIds(corpusPath);
const post = (b) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

const MIX = [
  ['resolve', 40], ['search', 26], ['category', 8], ['batch', 6],
  ['verify', 4], ['adEvidence', 3], ['report', 2], ['malformed', 3], ['hostile', 8],
];
const WEIGHT = MIX.reduce((n, [, w]) => n + w, 0);
function shape() {
  let r = Math.random() * WEIGHT;
  for (const [k, w] of MIX) { if ((r -= w) < 0) return k; }
  return 'resolve';
}

function build(i) {
  const kind = shape();
  switch (kind) {
    case 'resolve': return [kind, `${base}/v1/evidence/${pick(IDS)}`, {}];
    case 'search': return [kind, `${base}/v1/evidence/search`, post({
      query: query(),
      ...(Math.random() < 0.6 ? { category: pick(CATEGORIES) } : {}),
      /* Including limits above the cap, because the cap is the thing under
       * test as much as the query is. */
      limit: pick([10, 20, 50, 200, 500, 9999]),
    })];
    case 'category': return [kind, `${base}/v1/categories/${encodeURIComponent(pick(CATEGORIES))}`, {}];
    case 'batch': return [kind, `${base}/v1/evidence/batch`, post({
      receiptIds: Array.from({ length: 1 + Math.floor(Math.random() * 199) }, () => pick(IDS)),
    })];
    case 'verify': return [kind, `${base}/v1/verify`, post({
      claims: [{
        term: pick(ATTR),
        text: 'Buyers say "the sizing on these is something people mention".',
        /* One id that cannot resolve, every time. A verify that never sees a
         * miss is not testing the thing verify exists for. */
        receiptIds: [pick(IDS), pick(IDS), 'rc_deadbeefdeadbeef'],
      }],
    })];
    case 'adEvidence': return [kind, `${base}/v1/evidence/ads/ad_${i}`, {}];
    case 'report': return [kind, `${base}/v1/reports`, post({
      subject: pick(CATEGORIES), terms: [pick(ATTR)], offline: true,
    })];
    case 'malformed': return [kind, `${base}/v1/evidence/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: pick(MALFORMED),
    }];
    default: return [kind, `${base}/v1/evidence/search`, post({ query: pick(HOSTILE), limit: 20 })];
  }
}

const stats = new Map();
const distinct = new Set();
let next = 0;
const startedAt = performance.now();

await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < total) {
    const i = next++;
    const [kind, url, init] = build(i);
    if (init.body) { try { distinct.add(JSON.parse(init.body).query); } catch { /* malformed on purpose */ } }
    const t0 = performance.now();
    let status = 0;
    let err = null;
    try {
      const res = await fetch(url, init);
      await res.text();
      status = res.status;
    } catch (e) {
      /*
       * `fetch` reports every transport failure as the same "fetch failed", so
       * the cause is what says whether the server dropped a request it had
       * ACCEPTED or the kernel never handed it over. That difference decides
       * whether a run failed, so it is read rather than summarised away.
       */
      err = String(e?.cause?.code ?? e?.message ?? e).slice(0, 60);
    }
    const rec = stats.get(kind) ?? { n: 0, ms: [], status: {}, errs: new Map() };
    rec.n++;
    rec.ms.push(performance.now() - t0);
    rec.status[status] = (rec.status[status] ?? 0) + 1;
    if (err) rec.errs.set(err, (rec.errs.get(err) ?? 0) + 1);
    stats.set(kind, rec);
  }
}));

const wall = (performance.now() - startedAt) / 1000;
distinct.delete(undefined);
console.log(`  ${total} requests, ${concurrency} concurrent, ${wall.toFixed(1)}s, ${(total / wall).toFixed(0)} req/s offered`);
console.log(`  ${distinct.size} distinct query strings sent`);
console.log();
console.log('  shape            n     p50     p95     p99   statuses');

/*
 * A connection the kernel never accepted is not this process failing. The
 * accept queue is 128 deep by default and a run at high concurrency overflows
 * it, where no code in this repo can see the connection or refuse it. Counting
 * those as failures made every run above a few hundred concurrent report FAILED
 * for a reason the server does not own, which is a harness that cries wolf.
 */
const NEVER_ACCEPTED = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EMFILE', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT']);

let failures = 0;
let unaccepted = 0;
for (const [kind, r] of [...stats].sort((a, b) => b[1].n - a[1].n)) {
  r.ms.sort((a, b) => a - b);
  const p = (q) => percentile(r.ms, q).toFixed(0).padStart(5);
  const codes = Object.entries(r.status).sort((a, b) => b[1] - a[1]);
  const kernel = [...r.errs].filter(([e]) => NEVER_ACCEPTED.has(e)).reduce((n, [, c]) => n + c, 0);
  unaccepted += kernel;
  failures += (r.status[500] ?? 0) + Math.max(0, (r.status[0] ?? 0) - kernel);
  console.log(
    `  ${kind.padEnd(13)}${String(r.n).padStart(5)}  ${p(0.5)}ms ${p(0.95)}ms ${p(0.99)}ms  `
    + codes.map(([s, n]) => `${s}:${n}`).join(' '),
  );
  for (const [e, n] of r.errs) console.log(`                 transport: ${e} x${n}`);
}

/*
 * A 500 or a dropped connection is a FAILED RUN, not a line in a table. A 503
 * is not: it is the shedder doing its job, and it is the difference between a
 * caller who knows to retry and one who cannot tell busy from broken.
 */
if (unaccepted) {
  console.log(`\n  ${unaccepted} connection(s) the kernel never accepted, at ${concurrency} concurrent`);
  console.log('  Not scored. See the herd note in the README: a single node cannot refuse');
  console.log('  a connection it was never given.');
}

if (failures) {
  console.log(`\n  FAILED: ${failures} request(s) returned 500 or were dropped after being accepted`);
  process.exitCode = 1;
}
