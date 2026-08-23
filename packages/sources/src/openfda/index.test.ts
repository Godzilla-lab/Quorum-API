/*
 * openFDA, against a captured response.
 *
 * Five real device enforcement reports, taken unedited from a live call on
 * 2026-08-22.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  createOpenFdaSource, enforcementText, fdaDate, reportUrl, FDA_ENDPOINTS, type FdaResponse,
} from './index.ts';
import { runSourceConformance } from '../conformance.ts';
import type { Ctx, SourceRecord } from '../source.ts';

const FIXTURE = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/device-enforcement.json');
const BODY = readFileSync(FIXTURE, 'utf8');
const PARSED = JSON.parse(BODY) as FdaResponse;

const ctx = (): Ctx => ({ env: {}, cost: { charge: () => 0, canSpend: () => true } });
const respond = (body: string, status = 200) => (async (url: string) => ({
  ok: status >= 200 && status < 300, status, headers: {}, body, url,
})) as never;

async function collect(source: ReturnType<typeof createOpenFdaSource>, text = 'knee'): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for await (const r of source.retrieve({ text }, ctx())) out.push(r);
  return out;
}

runSourceConformance('openfda', () => ({
  source: createOpenFdaSource({ fetch: respond(BODY) }),
  configuredEnv: {},
  planInput: { category: 'knee brace', productTitle: 'Brace X', productUrl: 'https://example.com', terms: ['quality'] },
}));

test('the fixture is a real enforcement payload', () => {
  assert.ok(Array.isArray(PARSED.results));
  assert.equal(PARSED.results?.length, 5);
  for (const r of PARSED.results ?? []) {
    assert.ok(r.recall_number, 'the recall number is the external id');
    assert.ok(r.recalling_firm, 'the firm is the unit of independence');
  }
});

/*
 * openFDA dates are bare YYYYMMDD with no separators. Handing "20180910" to
 * Date reads it as a year and lands roughly eighteen thousand years out.
 */
test('a bare YYYYMMDD date is parsed rather than guessed at', () => {
  assert.equal(fdaDate('20180910'), Math.floor(Date.UTC(2018, 8, 10) / 1000));
  assert.equal(fdaDate(null), 0);
  assert.equal(fdaDate('2018-09-10'), 0, 'a separated date is not this format and must not be half read');
  assert.equal(fdaDate('20181340'), 0, 'month 13 and day 40 are not a date');
  assert.equal(fdaDate('abcdefgh'), 0);
});

test('the record carries the reason and the severity the agency assigned', () => {
  const [report] = PARSED.results ?? [];
  assert.ok(report);
  const text = enforcementText(report);
  assert.match(text, /Reason for recall:/);
  /* Class I means a reasonable probability of serious harm or death. A reader
   * deserves that word, not a count. */
  assert.match(text, /Classified Class II by the FDA/);
});

test('the receipt links to the query that returns exactly this record', () => {
  const url = reportUrl('device', 'Z-0373-2019');
  assert.match(url, /^https:\/\/api\.fda\.gov\/device\/enforcement\.json/);
  assert.match(url, /Z-0373-2019/);
  /* There is no public web page for an enforcement report. Linking to a search
   * page that might show it would be inventing a citation. */
});

test('every regulated world is asked, because a subject does not arrive labelled', async () => {
  const source = createOpenFdaSource({ fetch: respond(BODY) });
  const queries = await source.plan({
    category: 'protein powder', productTitle: 'Brand X', productUrl: '', terms: ['quality', 'taste'],
  });

  const endpoints = new Set(queries.map((q) => (q as { endpoint?: string }).endpoint));
  assert.deepEqual([...endpoints].sort(), [...FDA_ENDPOINTS].sort());

  /* The question terms must never reach the search. Searching product
   * descriptions for "quality" returns whatever the FDA described that way. */
  const texts = queries.map((q) => q.text);
  assert.ok(!texts.includes('quality'));
  assert.ok(!texts.includes('taste'));
});

test('a subject the FDA does not regulate yields nothing, quietly', async () => {
  const logged: string[] = [];
  const source = createOpenFdaSource({ fetch: respond('{"error":{"code":"NOT_FOUND"}}', 404) });
  const out: SourceRecord[] = [];
  for await (const r of source.retrieve({ text: 'running shoes' }, { ...ctx(), log: (l) => logged.push(l) })) out.push(r);

  assert.deepEqual(out, []);
  /* A 404 here means "no matches", and most subjects are not FDA regulated.
   * Logging it as a failure would cry wolf on almost every run. */
  assert.deepEqual(logged, []);
});

test('a real failure is logged, unlike an empty result', async () => {
  const logged: string[] = [];
  const source = createOpenFdaSource({ fetch: respond('', 500) });
  for await (const _ of source.retrieve({ text: 'knee' }, { ...ctx(), log: (l) => logged.push(l) })) { /* drain */ }
  assert.equal(logged.length, 1);
});

test('records are attested, unscored, dated and linked', async () => {
  const source = createOpenFdaSource({ fetch: respond(BODY) });
  await source.plan({ category: 'knee instruments', productTitle: 'knee', productUrl: '', terms: [] });
  const records = await collect(source);

  assert.ok(records.length > 0);
  for (const r of records) {
    assert.equal(r.source, 'openfda');
    assert.equal(r.kind, 'post');
    assert.equal(r.score, 0, 'a regulatory filing carries no votes');
    assert.ok((r.createdUtc ?? 0) > 0);
    assert.match(r.url ?? '', /api\.fda\.gov/);
  }
});

test('a shape change yields nothing rather than throwing', async () => {
  for (const body of ['not json', 'null', '{"results":"nope"}']) {
    const source = createOpenFdaSource({ fetch: respond(body) });
    assert.deepEqual(await collect(source), [], `body ${JSON.stringify(body)}`);
  }
});

test('it needs no key', () => {
  assert.equal(createOpenFdaSource().configured({}), true);
  assert.equal(createOpenFdaSource().cost, 'free');
});
