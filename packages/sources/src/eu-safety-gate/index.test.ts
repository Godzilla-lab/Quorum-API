/*
 * EU Safety Gate, against captured responses: a real report list and a real
 * weekly report with six unedited alerts, taken 2026-08-22.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  alertText, createEuSafetyGateSource, parseAlerts, reportDate, reportUrls, xmlField,
} from './index.ts';
import { runSourceConformance } from '../conformance.ts';
import type { Ctx, SourceRecord } from '../source.ts';

const dir = fileURLToPath(new URL('.', import.meta.url));
const LIST = readFileSync(join(dir, 'fixtures/weekly-report-list.xml'), 'utf8');
const REPORT = readFileSync(join(dir, 'fixtures/weekly-report-detail.xml'), 'utf8');

const ctx = (over: Partial<Ctx> = {}): Ctx =>
  ({ env: {}, cost: { charge: () => 0, canSpend: () => true }, ...over });

const routed = (list = LIST, report = REPORT, status = 200) => (async (url: string) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {},
  body: url.includes('/list/xml/') ? list : report,
  url,
})) as never;

async function run(source: ReturnType<typeof createEuSafetyGateSource>, category: string): Promise<SourceRecord[]> {
  const queries = await source.plan({ category, productTitle: category, productUrl: '', terms: [] });
  const out: SourceRecord[] = [];
  for (const q of queries) for await (const r of source.retrieve(q, ctx())) out.push(r);
  return out;
}

runSourceConformance('eu-safety-gate', () => ({
  source: createEuSafetyGateSource({ fetch: routed(), weeks: 1 }),
  configuredEnv: {},
  planInput: { category: 'fancy dress', productTitle: 'fancy dress', productUrl: 'https://example.com', terms: ['safety'] },
}));

/*
 * A URL taken verbatim from the list returns HTTP 400. The list is XML, so
 * ampersands arrive escaped, and every entry carries a trailing comma. This is
 * how the working route was found.
 */
test('report urls are unescaped and de-punctuated, or they return 400', () => {
  const urls = reportUrls(LIST);
  assert.ok(urls.length > 0);
  for (const url of urls) {
    assert.ok(!url.includes('&amp;'), `escaped ampersand survived: ${url}`);
    assert.ok(!url.endsWith(','), `trailing comma survived: ${url}`);
    assert.match(url, /^https:\/\/ec\.europa\.eu\/safety-gate-alerts\/api\/download\/weeklyReport\/detail\/xml\/\d+/);
  }
});

test('a field wrapped in CDATA reads as plain text', () => {
  assert.equal(xmlField('<danger><![CDATA[Sharp edges &amp; loose parts]]></danger>', 'danger'), 'Sharp edges & loose parts');
  assert.equal(xmlField('<brand><![CDATA[]]></brand>', 'brand'), '');
  assert.equal(xmlField('<companyRecallCode/>', 'companyRecallCode'), '', 'a self closing empty tag is not a value');
  assert.equal(xmlField('<x>a</x>', 'missing'), '');
});

test('the captured report parses into real alerts', () => {
  const alerts = parseAlerts(REPORT);
  assert.equal(alerts.length, 6);
  for (const a of alerts) {
    assert.ok(a.caseNumber, 'the case number is the external id');
    assert.ok(a.notifyingCountry, 'the notifying authority is the unit of independence');
    assert.match(a.reference, /^https:\/\//, 'every alert links to its own page');
  }
});

test('the report date is read as DD slash MM slash YYYY, not the American order', () => {
  /* 21/08/2026 is August, not the twenty first month. */
  assert.equal(reportDate('<report_date>21/08/2026</report_date>'), Math.floor(Date.UTC(2026, 7, 21) / 1000));
  assert.equal(reportDate('<report_date>nonsense</report_date>'), 0);
  assert.equal(reportDate(REPORT) > 0, true);
});

test('the alert text carries the hazard and the authority classification', () => {
  const [alert] = parseAlerts(REPORT);
  assert.ok(alert);
  const text = alertText(alert);
  /* `danger` is the sentence that answers a research question: what actually
   * goes wrong with this product. */
  assert.ok(text.includes(alert.danger.slice(0, 40)), 'the hazard description must survive');
  assert.match(text, /Classified by the notifying authority as/);
});

test('records are attested, unscored, dated and linked', async () => {
  const records = await run(createEuSafetyGateSource({ fetch: routed(), weeks: 1 }), 'fancy dress accessory');
  assert.ok(records.length > 0, 'the fixture contains a fancy dress accessory alert');
  for (const r of records) {
    assert.equal(r.source, 'eu-safety-gate');
    assert.equal(r.kind, 'post');
    assert.equal(r.score, 0);
    assert.ok((r.createdUtc ?? 0) > 0);
    assert.match(r.url ?? '', /^https:\/\//);
  }
});

/*
 * This source has no search parameter, so a weekly report is every dangerous
 * product in Europe that week. The gate is doing all of the work.
 */
test('an unrelated subject keeps nothing from a firehose of alerts', async () => {
  const records = await run(createEuSafetyGateSource({ fetch: routed(), weeks: 1 }), 'postgres connection pooler');
  assert.deepEqual(records, []);
});

test('the notifying country is the channel, so two authorities read as two', async () => {
  const records = await run(createEuSafetyGateSource({ fetch: routed(), weeks: 1 }), 'necklace');
  for (const r of records) assert.ok((r.channel ?? '').length > 0);
});

test('a list that cannot be read plans nothing rather than throwing', async () => {
  const source = createEuSafetyGateSource({ fetch: routed(LIST, REPORT, 500) });
  assert.deepEqual(await source.plan({ category: 'x', productTitle: 'x', productUrl: '', terms: [] }), []);
});

test('a report that is not xml yields nothing rather than throwing', async () => {
  const source = createEuSafetyGateSource({ fetch: routed(LIST, 'not xml at all'), weeks: 1 });
  assert.deepEqual(await run(source, 'necklace'), []);
});

test('it needs no key', () => {
  assert.equal(createEuSafetyGateSource().configured({}), true);
  assert.equal(createEuSafetyGateSource().cost, 'free');
});
