/*
 * NHTSA, against a captured response: five real 2020 Honda Accord recall
 * campaigns, taken unedited from a live call on 2026-08-22.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { campaignUrl, createNhtsaSource, nhtsaDate, parseVehicle, recallText } from './index.ts';
import { runSourceConformance } from '../conformance.ts';
import type { Ctx, SourceRecord } from '../source.ts';

const FIXTURE = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/recalls-by-vehicle.json');
const BODY = readFileSync(FIXTURE, 'utf8');
const PARSED = JSON.parse(BODY) as { results: Parameters<typeof recallText>[0][] };

const ctx = (over: Partial<Ctx> = {}): Ctx =>
  ({ env: {}, cost: { charge: () => 0, canSpend: () => true }, ...over });
const respond = (body: string, status = 200) => (async (url: string) => ({
  ok: status >= 200 && status < 300, status, headers: {}, body, url,
})) as never;

runSourceConformance('nhtsa', () => ({
  source: createNhtsaSource({ fetch: respond(BODY) }),
  configuredEnv: {},
  planInput: { category: 'sedan', productTitle: '2020 Honda Accord', productUrl: 'https://example.com', terms: ['brakes'] },
}));

/*
 * MEASURED LIVE 2026-08-22: omitting modelYear returns HTTP 400, not a broad
 * result. Every query has to carry all three fields.
 */
test('a subject is parsed into make, model and year in any order', () => {
  assert.deepEqual(parseVehicle('2020 Honda Accord'), { make: 'Honda', model: 'Accord', year: '2020' });
  assert.deepEqual(parseVehicle('Honda Accord 2020'), { make: 'Honda', model: 'Accord', year: '2020' });
  assert.deepEqual(parseVehicle('Honda Accord'), { make: 'Honda', model: 'Accord', year: '' });
  assert.deepEqual(parseVehicle('Ford F 150'), { make: 'Ford', model: 'F 150', year: '' });
});

test('a number that is not a plausible model year is part of the model', () => {
  /* 1500 is a Ram, not a year. 3000 is not a year either. */
  assert.deepEqual(parseVehicle('Ram 1500'), { make: 'Ram', model: '1500', year: '' });
  assert.deepEqual(parseVehicle('Thing 3000'), { make: 'Thing', model: '3000', year: '' });
});

test('a subject that is not a vehicle plans nothing rather than guessing', async () => {
  const source = createNhtsaSource({ fetch: respond(BODY) });
  assert.deepEqual(await source.plan({ category: 'shoes', productTitle: 'shoes', productUrl: '', terms: [] }), []);
  /* Planning no queries makes the run report this source as degraded, which is
   * the honest outcome. A vehicle database has nothing to say about shoes. */
});

test('a subject with no year asks recent years, because the API refuses none', async () => {
  const source = createNhtsaSource({
    fetch: respond(BODY), yearsBack: 2, now: () => new Date('2026-08-22T00:00:00Z'),
  });
  const queries = await source.plan({ category: 'sedan', productTitle: 'Honda Accord', productUrl: '', terms: [] });
  assert.deepEqual(queries.map((q) => q.text), ['2026 Honda Accord', '2025 Honda Accord', '2024 Honda Accord']);
});

test('the record carries the consequence, which is what a researcher asked about', () => {
  const text = recallText(PARSED.results[0]!);
  assert.match(text, /Component:/);
  assert.match(text, /Consequence:/);
});

test('a stop driving advisory is spelled out, not left as a boolean', () => {
  /* `parkIt: true` is invisible inside a quote, and "stop driving this vehicle"
   * is the most important thing the agency can say. */
  const text = recallText({ Summary: 'A long enough summary of the defect to pass the length floor.', parkIt: true, parkOutSide: true });
  assert.match(text, /stop driving this vehicle/i);
  assert.match(text, /not to park this vehicle indoors/i);
});

test('an MM/DD/YYYY date is read explicitly rather than by locale', () => {
  assert.equal(nhtsaDate('10/12/2020'), Math.floor(Date.UTC(2020, 9, 12) / 1000));
  assert.equal(nhtsaDate('2020-10-12'), 0, 'a different format is not half read');
  assert.equal(nhtsaDate(null), 0);
});

test('the receipt links to the campaign on the agency site', () => {
  assert.equal(campaignUrl('20V771000'), 'https://www.nhtsa.gov/recalls?nhtsaId=20V771000');
});

test('records are attested, unscored and dated', async () => {
  const source = createNhtsaSource({ fetch: respond(BODY) });
  await source.plan({ category: 'sedan', productTitle: '2020 Honda Accord', productUrl: '', terms: [] });
  const out: SourceRecord[] = [];
  for await (const r of source.retrieve({ text: '2020 Honda Accord' }, ctx())) out.push(r);

  assert.ok(out.length > 0);
  for (const r of out) {
    assert.equal(r.source, 'nhtsa');
    assert.equal(r.kind, 'post');
    assert.equal(r.score, 0);
    assert.ok((r.createdUtc ?? 0) > 0);
    assert.match(r.url ?? '', /nhtsa\.gov/);
  }
});

test('an unknown make returns nothing and is not logged as a failure', async () => {
  const logged: string[] = [];
  const source = createNhtsaSource({ fetch: respond('', 400) });
  await source.plan({ category: 'sedan', productTitle: '2020 Nonexistent Car', productUrl: '', terms: [] });
  const out: SourceRecord[] = [];
  for await (const r of source.retrieve({ text: '2020 Nonexistent Car' }, ctx({ log: (l) => logged.push(l) }))) out.push(r);

  assert.deepEqual(out, []);
  /* A 400 means NHTSA does not know that make or model, which is the normal
   * outcome for anything that is not a vehicle. Crying wolf here would make the
   * log useless on every non automotive run. */
  assert.deepEqual(logged, []);
});

test('a null body degrades rather than crashing', async () => {
  const source = createNhtsaSource({ fetch: respond('null') });
  const out: SourceRecord[] = [];
  for await (const r of source.retrieve({ text: '2020 Honda Accord' }, ctx())) out.push(r);
  assert.deepEqual(out, []);
});
