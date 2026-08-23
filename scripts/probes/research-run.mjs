/*
 * A real research run, end to end, through the orchestrator, against live
 * upstreams.
 *
 * Runs COLD (empty corpus, real network) then WARM (same question, no network),
 * because the gap between those two numbers is the entire speed argument.
 *
 * Costs real requests, so it lives in probes and is run on purpose.
 *   node scripts/probes/research-run.mjs "running shoes" running,runningshoes
 */
import { rmSync } from 'node:fs';
import { openSqliteCorpus } from '../../packages/corpus/src/index.ts';
import { createArcticShiftSource, createArcticShiftClient, createHackerNewsSource, resolveSubject } from '../../packages/sources/src/index.ts';
import { createCostMeter, retrieveAll } from '../../packages/core/src/index.ts';

const input = process.argv[2] ?? 'running shoes';
const nameHints = (process.argv[3] ?? '').split(',').filter(Boolean);
const DB = '/tmp/quorum-research-run.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });

const corpus = openSqliteCorpus({ path: DB });
const cost = createCostMeter({ label: 'research-run' });
const ctx = { env: {}, cost, log: (m) => console.log(`      ! ${m}`) };

/*
 * The input is a SUBJECT, not a url. Plain text works, a url works, and a url
 * the store refuses still works: four of four real stores blocked us, so
 * resolution is an enrichment and never a gate.
 */
const subject = await resolveSubject(input, { timeoutMs: 12000 });
const category = subject.category;

const plan = {
  category,
  productTitle: subject.title || category,
  productUrl: subject.url ?? '',
  terms: ['sizing', 'quality', 'comfort'],
  ...(nameHints.length ? { subredditTerms: nameHints } : {}),
};

console.log(`\nRESEARCH RUN: ${JSON.stringify(input)}\n${'='.repeat(64)}`);
console.log(`\nSUBJECT  resolved via ${subject.source}`);
console.log(`  category: ${JSON.stringify(subject.category)}`);
console.log(`  title   : ${JSON.stringify(subject.title)}`);
if (subject.brand) console.log(`  brand   : ${subject.brand}`);
if (subject.note) console.log(`  note    : ${subject.note}`);
console.log('\nCOLD  (empty corpus, live network, through the orchestrator)\n');

const result = await retrieveAll({
  sources: [createArcticShiftSource({ client: createArcticShiftClient() }), createHackerNewsSource()],
  corpus, plan, ctx,
  maxQueriesPerSource: 6,
  onProgress: (u) => process.stdout.write(`\r      ${u.source}: ${u.seen} seen, ${u.written} written   `),
});
process.stdout.write('\r' + ' '.repeat(60) + '\r');

for (const o of result.outcomes) {
  console.log(`  ${o.sourceId.padEnd(12)} ${o.status.padEnd(9)} ${String(o.recordsSeen).padStart(5)} seen  ${String(o.recordsGated).padStart(5)} gated off topic  ${String(o.recordsWritten).padStart(5)} stored  ${(o.elapsedMs / 1000).toFixed(1)}s`);
  if (o.reason) console.log(`  ${''.padEnd(12)} reason: ${o.reason}`);
}
console.log(`\n  cold total: ${(result.elapsedMs / 1000).toFixed(1)}s, ${result.totalSeen} seen, ${result.totalWritten} stored`);
if (result.degraded.length) {
  console.log('  degraded  :');
  for (const d of result.degraded) console.log(`    ${d.source}: ${d.reason} -> ${d.impact}`);
} else {
  console.log('  degraded  : none, every source contributed');
}
if (result.stoppedEarly) console.log(`  stopped early: ${result.stoppedEarly}`);

await corpus.rememberCategory(category, { subreddits: nameHints, queries: plan.terms });
const stats = await corpus.categoryStats(category);
console.log(`  corpus    : ${stats.docs} docs, ${stats.comments} comments, ${stats.channels} channels, warm=${stats.warm}`);

console.log('\nWARM  (same question, zero network)\n');
const warmStart = Date.now();
const hits = new Map();
for (const term of plan.terms) {
  for (const row of await corpus.search(term, { category, limit: 200 })) hits.set(row.receiptId, row);
}
for (const row of await corpus.byCategory(category, { limit: 600 })) hits.set(row.receiptId, row);
const warmMs = Math.max(1, Date.now() - warmStart);
console.log(`  warm total: ${warmMs}ms, 0 upstream requests, ${hits.size} records from memory`);
console.log(`  speedup   : ${Math.round(result.elapsedMs / warmMs)}x, at zero cost`);

console.log('\nRECEIPTS  (can a reader check a claim?)\n');
const sample = [...hits.values()].filter((r) => r.kind === 'comment').slice(0, 3);
const resolved = await corpus.getByReceiptIds(sample.map((r) => r.receiptId));
console.log(`  cited ${sample.length}, resolved ${resolved.length}`);
for (const r of resolved) {
  console.log(`    ${r.receiptId}  ${r.source}/${r.channel}`);
  console.log(`      "${r.text.slice(0, 84).replace(/\s+/g, ' ')}..."`);
}
console.log(`  invented id resolved to ${(await corpus.getByReceiptIds(['rc_deadbeefdeadbeef'])).length} records (must be 0)`);

console.log('\nCORROBORATION  (independent voices, counted per source)\n');
for (const term of plan.terms) {
  const rows = await corpus.search(term, { category, limit: 500 });
  const bySource = new Map();
  for (const r of rows) {
    const e = bySource.get(r.source) ?? { records: new Set(), channels: new Set() };
    e.records.add(r.receiptId); e.channels.add(r.channel); bySource.set(r.source, e);
  }
  const parts = [...bySource].map(([src, e]) => `${src} ${e.records.size} recs / ${e.channels.size} ch`);
  const total = [...bySource.values()].reduce((n, e) => n + e.records.size, 0);
  console.log(`  ${term.padEnd(9)} ${String(total).padStart(4)} records  ->  ${parts.join(',  ')}  ${total >= 3 ? '[finding]' : '[weak signal]'}`);
}

console.log(`\n  cost: $${cost.total().toFixed(4)}\n`);
await corpus.close();
