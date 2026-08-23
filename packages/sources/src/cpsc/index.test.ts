/*
 * CPSC, against a captured response.
 *
 * The fixture is six real recalls taken unedited from a live call on
 * 2026-08-22. Fixtures here are captured, never authored: the Hacker News
 * adapter once filtered on a `points` field that a hand written fixture
 * invented, matched zero of 6,903 real comments, and passed its tests anyway.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  createCpscSource, headNoun, recallDate, recallText, responsibleFirm, type CpscRecall,
} from './index.ts';
import type { Ctx, SourceRecord } from '../source.ts';
import { runSourceConformance } from '../conformance.ts';

const FIXTURE = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/recall-search.json');
const RECALLS = JSON.parse(readFileSync(FIXTURE, 'utf8')) as CpscRecall[];

const ctx = (): Ctx => ({ env: {}, cost: { charge: () => 0, canSpend: () => true } });

/* The shared contract every adapter runs through. */
runSourceConformance('cpsc', () => ({
  source: createCpscSource({ fetch: (async () => ({
    ok: true, status: 200, headers: {}, body: readFileSync(FIXTURE, 'utf8'), url: 'https://www.saferproducts.gov/x',
  })) as never }),
  configuredEnv: {},
  planInput: { category: 'running shoes', productTitle: 'Wool Runner', productUrl: 'https://example.com', terms: ['quality'] },
}));

const fakeFetch = (body: string, ok = true) => async () => ({
  ok, status: ok ? 200 : 500, headers: {}, body, url: 'https://www.saferproducts.gov/x',
});

async function collect(source: ReturnType<typeof createCpscSource>, query = { text: 'shoes' }): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for await (const r of source.retrieve(query, ctx())) out.push(r);
  return out;
}

test('the captured fixture is a bare array of real recalls', () => {
  assert.ok(Array.isArray(RECALLS));
  assert.equal(RECALLS.length, 6);
  for (const r of RECALLS) {
    assert.ok(r.RecallNumber, 'every recall carries the number we use as its external id');
    assert.ok(r.Title, 'every recall carries a title');
  }
});

/*
 * MEASURED on 36 real recalls: Manufacturers is populated on 17 and Importers
 * on 18, so the responsible firm has to come from the title, which always names
 * it in one of two grammars.
 */
test('the responsible firm is resolved from both title grammars', () => {
  assert.equal(
    responsibleFirm({ Title: "Clarks Americas Recalls Women's Navy Blue Canvas Shoes Due to Chemical Hazard" }),
    'Clarks Americas',
  );
  assert.equal(
    responsibleFirm({ Title: "Women's Shoes Recalled by Charles David Due to Fall Hazard; Sold Exclusively at X" }),
    'Charles David',
  );
});

test('the firm falls back to a party field, with its address stripped', () => {
  assert.equal(
    responsibleFirm({
      Title: 'Something unparseable',
      Importers: [{ Name: 'C&J Clark America Inc. (subsidiary of Clarks Americas, Inc.), of Needham, Massachusetts' }],
    }),
    'C&J Clark America Inc. (subsidiary of Clarks Americas',
  );
});

test('every fixture record resolves a firm, none falls through to the agency', () => {
  const firms = RECALLS.map(responsibleFirm);
  assert.ok(!firms.includes('CPSC'), `unresolved: ${firms.join(', ')}`);
  assert.ok(new Set(firms).size > 1, 'distinct firms are the unit of independence here');
});

test('the record carries the hazard, which is the part that answers a question', () => {
  const clarks = RECALLS.find((r) => (r.Title ?? '').startsWith('Clarks'));
  assert.ok(clarks);
  const text = recallText(clarks);
  assert.match(text, /benzidine/, 'the hazard lives in Hazards and nowhere else');
  assert.match(text, /Clarks/);
});

test('"none reported" injuries are not reported as injuries', () => {
  const text = recallText({ Title: 'X Recalls Y', Injuries: [{ Name: 'None reported' }] });
  assert.doesNotMatch(text, /Injuries reported/);
});

test('a recall date with no zone is read as UTC rather than as local time', () => {
  assert.equal(recallDate('2022-11-03T00:00:00'), Math.floor(Date.UTC(2022, 10, 3) / 1000));
  assert.equal(recallDate(null), 0);
  assert.equal(recallDate('not a date'), 0);
});

/*
 * MEASURED LIVE 2026-08-22: ProductName=running shoes returned 0 recalls and
 * ProductName=shoes returned 36, because the parameter is a literal substring
 * match against CPSC product names and those never say "running shoes".
 */
test('the plan asks for the head noun, not only the category', async () => {
  const source = createCpscSource();
  const queries = await source.plan({
    category: 'running shoes', productTitle: 'Wool Runner', productUrl: '', terms: ['quality'],
  });
  const texts = queries.map((q) => q.text);
  assert.ok(texts.includes('shoes'), 'without the head noun this source returns nothing at all');
  assert.ok(texts.includes('running shoes'));
});

test('headNoun takes the trailing word, and a single word is its own head', () => {
  assert.equal(headNoun('running shoes'), 'shoes');
  assert.equal(headNoun('treadmill'), 'treadmill');
  assert.equal(headNoun('  electric kettle '), 'kettle');
});

test('an off topic recall is rejected even though the query returned it', async () => {
  const source = createCpscSource({ fetch: fakeFetch(JSON.stringify(RECALLS)) as never });
  await source.plan({ category: 'running shoes', productTitle: 'running shoes', productUrl: '', terms: [] });
  const records = await collect(source);

  /* "shoes" returns snowshoes, safety boots and children's clogs. None of them
   * is evidence about running shoes, and storing one would poison the corpus
   * for every later run. */
  const titles = records.map((r) => r.text.toLowerCase());
  assert.ok(!titles.some((t) => t.includes('snowshoe')), 'a snowshoe recall is not a running shoe recall');
});

test('a record is attested, carries no score, and links to the notice', async () => {
  const source = createCpscSource({ fetch: fakeFetch(JSON.stringify(RECALLS)) as never });
  await source.plan({ category: 'shoes', productTitle: 'shoes', productUrl: '', terms: [] });
  const records = await collect(source);

  assert.ok(records.length > 0, 'a broad subject should keep several of the six');
  for (const r of records) {
    assert.equal(r.source, 'cpsc');
    assert.equal(r.kind, 'post');
    /* A recall has no votes. Inventing a score would put a number under an
     * attested record that the agency never published. */
    assert.equal(r.score, 0);
    assert.match(r.url ?? '', /^https?:\/\//);
    assert.ok((r.createdUtc ?? 0) > 0, 'a recall always has a date');
  }
});

test('a regulator being down degrades the run rather than failing it', async () => {
  const source = createCpscSource({ fetch: fakeFetch('', false) as never });
  await source.plan({ category: 'shoes', productTitle: 'shoes', productUrl: '', terms: [] });
  assert.deepEqual(await collect(source), []);
});

test('a shape change is reported, not crashed on', async () => {
  for (const body of ['{"results":[]}', 'not json at all', 'null']) {
    const source = createCpscSource({ fetch: fakeFetch(body) as never });
    await source.plan({ category: 'shoes', productTitle: 'shoes', productUrl: '', terms: [] });
    assert.deepEqual(await collect(source), [], `body ${JSON.stringify(body)} should yield nothing`);
  }
});

test('it needs no key, so it is always configured', () => {
  assert.equal(createCpscSource().configured({}), true);
});

/*
 * FOUND BY RUNNING IT, NOT BY READING IT.
 *
 * The first live CPSC run printed a channel of "CPSC, Sportcraft Announce".
 * A third title grammar exists, "CPSC, X Announce Recall of Y", and the active
 * pattern matches it too and produces that nonsense. Measured on real data:
 * 6 of 16 treadmill recalls and 7 of 36 shoe recalls use it, so about a fifth
 * of this source was filed under a firm that does not exist.
 */
test('the joint agency grammar names the company, not the agency', () => {
  assert.equal(
    responsibleFirm({ Title: 'CPSC, Sportcraft Announce Recall of Treadmills' }),
    'Sportcraft',
  );
  assert.equal(
    responsibleFirm({ Title: 'CPSC, ICON Health & Fitness, Inc. Announce Recall to Repair Epic T60 Treadmills' }),
    'ICON Health & Fitness, Inc.',
  );
  assert.equal(
    responsibleFirm({ Title: 'U.S. CPSC, Vision Fitness Announces Recall of Consoles' }),
    'Vision Fitness',
  );
});

test('the joint grammar is tried before the active one, or it silently wins', () => {
  /* The active pattern matches this too, and yields "CPSC, Sportcraft Announce". */
  const firm = responsibleFirm({ Title: 'CPSC, Sportcraft Announce Recall of Treadmills' });
  assert.ok(!firm.startsWith('CPSC'), `ordering regression: got ${firm}`);
});
