/*
 * Contract drift detection.
 *
 * WHY THIS EXISTS.
 *
 * `spec/openapi.yaml` is a promise about shapes, and a promise in a separate
 * file from the code that implements it drifts silently. The failure is not
 * theoretical: a field added to `Corroboration` never reaches the spec, an SDK
 * is generated without it, and a customer's integration is missing the number
 * that decides whether a claim may be printed.
 *
 * So the contract is checked against the RUNNING CODE rather than read. Where a
 * shape can be produced by calling the real function, this script calls it and
 * compares the actual keys. Where a value is one of a set, it drives the real
 * function until it has emitted every member and compares that to the enum.
 *
 *   node scripts/check-spec.mjs
 *
 * WHAT IT DELIBERATELY CANNOT CHECK, stated rather than implied:
 *
 *   - Anything about the server, which does not exist yet. Report status
 *     values, rate limit headers, idempotency and coalescing are promises this
 *     script can only check for internal consistency.
 *   - That `findings` and `weakSignals` are disjoint in a real response. That
 *     is server behaviour and belongs in the server's own suite.
 *   - That the YAML is valid OpenAPI. Validating it properly needs a parser we
 *     do not have and will not add for this. The generated SDK is what will
 *     prove that, in the milestone that generates one.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SPEC = readFileSync(join(ROOT, 'spec/openapi.yaml'), 'utf8');
const LINES = SPEC.split('\n');

const results = [];
const ok = (what, detail) => results.push({ status: 'OK', what, detail });
const fail = (what, detail) => results.push({ status: 'FAIL', what, detail });

const setsEqual = (a, b) => a.size === b.size && [...a].every((v) => b.has(v));
const missing = (want, have) => [...want].filter((v) => !have.has(v));

/* ------------------------------------------------------------------ *
 * Minimal extraction. Not a YAML parser, and not pretending to be one.
 * Enums and required lists are written in flow style throughout the spec
 * precisely so this stays a line lookup rather than a parser.
 * ------------------------------------------------------------------ */

function blockAt(startIndex, indent) {
  for (let i = startIndex + 1; i < LINES.length; i++) {
    const line = LINES[i];
    if (!line.trim()) continue;
    if (line.length - line.trimStart().length <= indent) return LINES.slice(startIndex, i);
  }
  return LINES.slice(startIndex);
}

function schemaBlock(name) {
  const start = LINES.indexOf(`    ${name}:`);
  return start === -1 ? null : blockAt(start, 4);
}

function propertyBlock(block, prop) {
  /* A property is either a nested block or a one line flow mapping, and both
   * spellings appear in the spec, so both have to be findable. */
  const start = block.findIndex((l) => l.startsWith(`        ${prop}:`));
  if (start === -1) return null;
  if (block[start].includes('{')) return [block[start]];
  for (let i = start + 1; i < block.length; i++) {
    const line = block[i];
    if (!line.trim()) continue;
    if (line.length - line.trimStart().length <= 8) return block.slice(start, i);
  }
  return block.slice(start);
}

const flowList = (raw) => raw.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);

function enumIn(block) {
  if (!block) return null;
  const line = block.find((l) => /^\s*enum:\s*\[/.test(l));
  if (!line) return null;
  return new Set(flowList(line.slice(line.indexOf('[') + 1, line.lastIndexOf(']'))));
}

function requiredIn(block) {
  if (!block) return null;
  const line = block.find((l) => /^      required:\s*\[/.test(l));
  if (!line) return null;
  return new Set(flowList(line.slice(line.indexOf('[') + 1, line.lastIndexOf(']'))));
}

function patternIn(block, prop) {
  const scope = prop ? propertyBlock(block, prop) : block;
  if (!scope) return null;
  const line = scope.find((l) => /pattern:\s*'/.test(l));
  if (!line) return null;
  return line.slice(line.indexOf("'") + 1, line.lastIndexOf("'"));
}

/* Compare a schema's `required` list to the keys a real call actually produces. */
function checkShape(name, actual, { omit = [], extra = [], why = '' } = {}) {
  const block = schemaBlock(name);
  if (!block) return fail(name, 'no such schema in the spec');
  const declared = requiredIn(block);
  if (!declared) return fail(name, 'no top level required list');

  const produced = new Set([...Object.keys(actual), ...extra]);
  for (const key of omit) produced.delete(key);

  const notInSpec = missing(produced, declared);
  const notInCode = missing(declared, produced);
  if (notInSpec.length) return fail(name, `the code produces ${notInSpec.join(', ')} and the spec does not require it`);
  if (notInCode.length) return fail(name, `the spec requires ${notInCode.join(', ')} and the code never produces it`);
  ok(name, `${declared.size} required fields match the live shape${why ? `, ${why}` : ''}`);
}

function checkEnum(name, prop, actual, why) {
  const block = schemaBlock(name);
  if (!block) return fail(`${name}.${prop ?? ''}`, 'no such schema in the spec');
  const declared = enumIn(prop ? propertyBlock(block, prop) : block);
  const label = prop ? `${name}.${prop}` : name;
  if (!declared) return fail(label, 'no enum found');
  if (!setsEqual(declared, actual)) {
    const a = missing(actual, declared);
    const b = missing(declared, actual);
    return fail(label, [
      a.length ? `the code emits ${a.join(', ')} and the spec omits it` : '',
      b.length ? `the spec allows ${b.join(', ')} and the code never emits it` : '',
    ].filter(Boolean).join('; '));
  }
  ok(label, `${declared.size} values match${why ? `, ${why}` : ''}`);
}

/* ------------------------------------------------------------------ *
 * The real code. Everything below drives it rather than reading it.
 * ------------------------------------------------------------------ */

const { SOURCE_TIER, TIER_LABEL } = await import('@quorum/corpus/tiers');
const { MIN_RECEIPTS, WARM_MIN_DOCS, WARM_MAX_AGE_DAYS } = await import('@quorum/corpus/constants');
const { receiptId, openSqliteCorpus } = await import('@quorum/corpus');
const { RATE_LIMIT_HEADERS } = await import('@quorum/server');
const {
  corroborate, assessSufficiency, fabricationReport, resolveCitations,
  createCostMeter, formatVerdict,
} = await import('@quorum/core');

const doc = (source, externalId, channel) => ({
  receiptId: receiptId(source, externalId),
  source, kind: 'comment', externalId, category: 'test',
  /* Distinct per record: identical text deliberately counts as one voice,
   * so a shared string here would starve the receipt-count basis drive. */
  channel, text: `the sizing runs small and I had to send them back, per ${externalId}`,
  score: 1, url: 'https://example.com/x', createdUtc: 1, harvestedAt: 1,
});

/* --- receipt ids ------------------------------------------------- */
{
  const pattern = patternIn(schemaBlock('ReceiptId'));
  if (!pattern) fail('ReceiptId.pattern', 'no pattern in the spec');
  else {
    const re = new RegExp(pattern);
    const real = receiptId('reddit', 't1_abcdef');
    const cases = [
      [real, true, 'a real minted id'],
      ['rc_8f2a1', false, 'the five character form from the original API sketch'],
      ['rc_8F2A1C4D90B7E365', false, 'uppercase hex'],
      ['rc_8f2a1c4d90b7e3650', false, 'seventeen characters'],
      ['8f2a1c4d90b7e365', false, 'no prefix'],
    ];
    const bad = cases.filter(([value, want]) => re.test(value) !== want);
    if (bad.length) fail('ReceiptId.pattern', bad.map(([v, , why]) => `${why} (${v})`).join(', '));
    else ok('ReceiptId.pattern', `accepts ${real}, rejects the stale five character form`);
  }
}

/* --- sources and tiers ------------------------------------------- */
checkEnum('SourceId', null, new Set(Object.keys(SOURCE_TIER)),
  'every source has a tier, which the build already enforces');
checkEnum('EvidenceTier', null, new Set(Object.keys(TIER_LABEL)));

/* --- corroboration, driven until it has emitted every basis ------- */
{
  const bases = new Set();
  const verdicts = new Set();
  const drive = (docs, options) => {
    const c = corroborate('sizing', docs, options);
    bases.add(c.basis);
    verdicts.add(c.verdict);
    return c;
  };
  /* Three voice records, the original route. */
  const full = drive([doc('reddit', 'a', 'r/one'), doc('reddit', 'b', 'r/two'), doc('hackernews', 'c', 'story')]);
  /* One attested plus one voice: two promoting tiers, one of them A. */
  drive([doc('cpsc', 'r1', 'recall'), doc('reddit', 'a', 'r/one')]);
  /* Two attested, same tier, so nothing crosses and the third route carries it. */
  drive([doc('cpsc', 'r1', 'recall'), doc('nhtsa', 'r2', 'complaint')]);
  /* One record. Not a market pattern. */
  drive([doc('reddit', 'a', 'r/one')]);
  const threeRefuting = [doc('reddit', 'x', 'r/one'), doc('reddit', 'y', 'r/two'), doc('reddit', 'z', 'r/three')];
  /* Both sides past the threshold: divided evidence, no conclusion. */
  drive(
    [doc('reddit', 'a', 'r/one'), doc('reddit', 'b', 'r/two'), doc('hackernews', 'c', 'story')],
    { refuting: threeRefuting },
  );
  /* Only the disagreement past the threshold. */
  drive([doc('reddit', 'a', 'r/one')], { refuting: threeRefuting });

  checkShape('Corroboration', full, { why: 'driven through all four routes' });
  checkEnum('Corroboration', 'basis', bases, 'each one produced by a real call');
  checkEnum('Corroboration', 'verdict', verdicts);

  const declared = requiredIn(schemaBlock('Corroboration'));
  if (declared && !declared.has('threshold')) fail('Corroboration.threshold', 'a report must be able to show its own working');
  if (full.threshold !== MIN_RECEIPTS) fail('Corroboration.threshold', `corroborate applied ${full.threshold}, MIN_RECEIPTS is ${MIN_RECEIPTS}`);
}

/* --- claims, including the one that quotes something nobody said -- */
{
  const real = new Map([['a', doc('reddit', 'a', 'r/one')], ['b', doc('reddit', 'b', 'r/two')], ['c', doc('hackernews', 'c', 'story')]]);
  const byId = new Map([...real.values()].map((d) => [d.receiptId, d]));
  const corpus = { getByReceiptIds: async (ids) => ids.map((id) => byId.get(id)).filter(Boolean) };
  const ids = [...byId.keys()];

  const resolved = await resolveCitations([
    { term: 'sizing', text: 'Sizing runs small.', receiptIds: ids },
    { term: 'comfort', text: 'Comfort is mixed.', receiptIds: [ids[0]] },
    { term: 'durability', text: 'They said "these fell apart after one week".', receiptIds: [ids[0]] },
    { term: 'price', text: 'Price is a complaint.', receiptIds: ['rc_0000000000000000'] },
  ], corpus);

  const verdicts = new Set(resolved.map((c) => c.verdict));
  checkEnum('Claim', 'verdict', verdicts, 'all three produced by the real gate');

  const shape = { ...resolved[0], receipts: [], corroboration: {} };
  checkShape('Claim', shape, { why: 'from resolveCitations' });

  const fabricatedClaim = resolved.find((c) => c.fabricated.length);
  if (!fabricatedClaim) fail('Claim.fabricated', 'a citation to a nonexistent id was not reported as fabricated');
  else if (fabricatedClaim.corroboration.records !== 0) fail('Claim.fabricated', 'a fabricated id contributed to a count');
  else ok('Claim.fabricated', 'an invented id resolves to nothing and counts for nothing');

  checkShape('FabricationReport', fabricationReport(resolved));
}

/* --- sufficiency, driven to all three verdicts -------------------- */
{
  const verdicts = new Set();
  const finding = corroborate('sizing', [doc('reddit', 'a', 'r/one'), doc('reddit', 'b', 'r/two'), doc('hackernews', 'c', 's')]);
  const weak = corroborate('sizing', [doc('reddit', 'a', 'r/one')]);
  const sufficient = assessSufficiency({ retrieval: null, claims: [finding], corpusRecords: 300, subjectResolved: true });
  const thin = assessSufficiency({ retrieval: null, claims: [weak], corpusRecords: 12, subjectResolved: true });
  const none = assessSufficiency({ retrieval: null, claims: [], corpusRecords: 0, subjectResolved: false });
  for (const s of [sufficient, thin, none]) verdicts.add(s.verdict);

  checkShape('Sufficiency', sufficient);
  checkEnum('Sufficiency', 'verdict', verdicts, 'each one produced by a real call');
}

/* --- degradation vocabulary, read out of the retrieval code ------- */
{
  const emitted = new Set();
  for (const file of ['packages/core/src/retrieve.ts', 'packages/core/src/retrieve-ads.ts']) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    /* reason: 'x'  and  reason: cond ? 'x' : 'y'  and  finish(_, _, 'x') */
    /* `reason: 'x'` written inline. */
    for (const m of src.matchAll(/reason:\s*'([a-z_]+)'/g)) emitted.add(m[1]);
    /*
     * `const reason = cond ? 'a' : cond ? 'b' : 'c';`, taken whole and then
     * emptied of its literals. Matching the ternary shape directly missed the
     * outer branch of a nested one, which is how `all_off_topic` went missing
     * from this check on its first run while the code emitted it happily.
     */
    for (const m of src.matchAll(/const reason\s*=([\s\S]*?);/g)) {
      /* A literal inside `.includes('failed')` is a test, not a value the
       * caller will ever see. Left in, it would have the spec promise a reason
       * the code cannot emit, which is the same class of lie in the other
       * direction. */
      const branches = m[1].replace(/\.includes\('[^']*'\)/g, '');
      for (const lit of branches.matchAll(/'([a-z_]+)'/g)) emitted.add(lit[1]);
    }
    /* The ads leg names its degrade reason as the third argument. */
    for (const m of src.matchAll(/finish\(\s*'[^']*',\s*'[^']*',\s*'([a-z_]+)'\s*\)/g)) emitted.add(m[1]);
  }
  checkEnum('Degradation', 'reason', emitted, 'extracted from the retrieval code');
}

/* --- cost, ads, and a real corpus row ----------------------------- */
{
  const meter = createCostMeter({ label: 'check-spec' });
  meter.charge('apify.meta-ads', 3);
  /*
   * `label` is deliberately not in the API shape. It names the meter for a
   * local run and means nothing to a caller, so omitting it is a decision
   * recorded here rather than a field somebody forgot.
   */
  checkShape('Cost', meter.toJSON(), { omit: ['label'], why: 'label is internal to a run' });
  checkShape('CostLine', meter.breakdown()[0]);

  const ads = Array.from({ length: 12 }, (_, i) => ({
    creative: i % 3 === 0 ? 'static' : 'video',
    daysRunning: 40 + i,
    durationConfidence: 'reported',
    platforms: ['facebook'],
  }));
  checkShape('FormatVerdict', formatVerdict(ads));
}

{
  const corpus = openSqliteCorpus({ path: ':memory:' });
  try {
    await corpus.addDocs([{ source: 'reddit', kind: 'comment', externalId: 't1_x', channel: 'r/one', text: 'runs small', score: 4, url: 'https://example.com/x', createdUtc: 1 }], 'test');
    const [row] = await corpus.byCategory('test', { limit: 1 });
    /*
     * `tier` is added by the API and is not stored, because a tier is a property
     * of the source rather than of the row, and storing it would let a migration
     * disagree with the compile time table.
     */
    checkShape('EvidenceRecord', row, { extra: ['tier'], why: 'tier is derived from the source, never stored' });
    checkShape('CategoryStats', await corpus.categoryStats('test'));
  } finally {
    await corpus.close();
  }
}

/* --- numbers quoted in prose must be the real ones ---------------- */
{
  const warm = propertyBlock(schemaBlock('CategoryStats'), 'warm')?.join(' ') ?? '';
  const wrong = [];
  if (!warm.includes(String(WARM_MIN_DOCS))) wrong.push(`WARM_MIN_DOCS is ${WARM_MIN_DOCS}`);
  if (!warm.includes(String(WARM_MAX_AGE_DAYS))) wrong.push(`WARM_MAX_AGE_DAYS is ${WARM_MAX_AGE_DAYS}`);
  if (wrong.length) fail('CategoryStats.warm', `the description does not quote the real thresholds: ${wrong.join(', ')}`);
  else ok('CategoryStats.warm', `quotes the real thresholds, ${WARM_MIN_DOCS} records and ${WARM_MAX_AGE_DAYS} days`);
}

/* --- header names quoted in the spec must be the ones emitted ------ */
{
  /*
   * WHY THIS CHECK EXISTS. The spec declared `RateLimit-Limit`, the server
   * emitted `x-ratelimit-limit`, and the README documented `X-RateLimit-Limit`.
   * Three documents, two behaviours, and nothing that could notice. A caller
   * reading the contract got no rate limit headers at all and no error either,
   * because a header nobody sends is indistinguishable from one nobody looked
   * for. Found 2026-08-23.
   *
   * Compared against the exported constant rather than against a literal, so
   * the server stays the single source of truth and this file cannot drift
   * away from it either.
   */
  const declared = [...SPEC.matchAll(/^ +([A-Za-z-]*[Rr]ate-?[Ll]imit[A-Za-z-]*): \{ \$ref:/gm)]
    .map((m) => m[1].toLowerCase());
  const emitted = Object.values(RATE_LIMIT_HEADERS);
  const missing = emitted.filter((h) => !declared.includes(h));
  const stale = [...new Set(declared)].filter((h) => !emitted.includes(h));

  if (!declared.length) fail('rate limit headers', 'the spec declares none at all');
  else if (missing.length || stale.length) {
    fail('rate limit headers', [
      missing.length ? `the server emits ${missing.join(', ')} and the spec never declares them` : '',
      stale.length ? `the spec declares ${stale.join(', ')} which the server never sends` : '',
    ].filter(Boolean).join('; '));
  } else ok('rate limit headers', `${emitted.length} names, and the spec quotes the ones the server emits`);
}

/* --- internal consistency ----------------------------------------- */
{
  const a = enumIn(propertyBlock(schemaBlock('Report'), 'status'));
  const b = enumIn(propertyBlock(schemaBlock('ReportAccepted'), 'status'));
  if (!a || !b) fail('Report.status', 'a status enum is missing');
  else if (!setsEqual(a, b)) fail('Report.status', 'Report and ReportAccepted disagree about the status values');
  else ok('Report.status', `${a.size} values, consistent across both shapes`);

  const p1 = patternIn(schemaBlock('Report'), 'id');
  const p2 = patternIn(schemaBlock('ReportAccepted'), 'id');
  const p3 = (() => {
    const start = LINES.indexOf('    ReportId:');
    return start === -1 ? null : patternIn(blockAt(start, 4));
  })();
  if (new Set([p1, p2, p3]).size !== 1) fail('report id', `three declarations and they disagree: ${p1}, ${p2}, ${p3}`);
  else ok('report id', `one pattern everywhere, ${p1}`);
}

/* --- every reference resolves, which is this file's own rule ------ */
{
  const refs = [...SPEC.matchAll(/\$ref:\s*'#\/components\/(\w+)\/([\w-]+)'/g)];
  const broken = [];
  for (const [, section, name] of refs) {
    if (!SPEC.includes(`\n  ${section}:\n`)) { broken.push(`${section} section`); continue; }
    if (!SPEC.includes(`\n    ${name}:\n`)) broken.push(`${section}/${name}`);
  }
  if (broken.length) fail('$ref', `unresolved: ${[...new Set(broken)].join(', ')}`);
  else ok('$ref', `${refs.length} references, all resolve`);

  const opIds = [...SPEC.matchAll(/operationId:\s*(\w+)/g)].map((m) => m[1]);
  const dupes = opIds.filter((id, i) => opIds.indexOf(id) !== i);
  if (dupes.length) fail('operationId', `duplicated: ${[...new Set(dupes)].join(', ')}`);
  else ok('operationId', `${opIds.length} operations, all uniquely named`);
}

/* ------------------------------------------------------------------ */

const failures = results.filter((r) => r.status === 'FAIL');
for (const r of results) {
  console.log(`[${r.status.padEnd(4)}] ${r.what.padEnd(28)} ${r.detail}`);
}
console.log(`\n  ${results.length - failures.length} ok, ${failures.length} drifted`);
if (failures.length) {
  console.log('\n  The spec and the code disagree. One of them is wrong, and the code is running.');
  process.exit(1);
}
