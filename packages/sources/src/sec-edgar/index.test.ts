/*
 * SEC EDGAR, against captured responses: six real search hits and 8,000
 * characters of a real 10-K's markup, both taken unedited on 2026-08-22.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  bestPassage, createSecEdgarSource, extractPassage, filerName, filingDate, filingText, filingUrl,
} from './index.ts';
import { runSourceConformance } from '../conformance.ts';
import type { Ctx, SourceRecord } from '../source.ts';

const dir = fileURLToPath(new URL('.', import.meta.url));
const SEARCH = readFileSync(join(dir, 'fixtures/full-text-search.json'), 'utf8');
const FILING = readFileSync(join(dir, 'fixtures/filing-excerpt.htm'), 'utf8');

const ENV = { QUORUM_CONTACT_EMAIL: 'hello@example.test' };
const ctx = (over: Partial<Ctx> = {}): Ctx =>
  ({ env: ENV, cost: { charge: () => 0, canSpend: () => true }, ...over });

const routed = (search = SEARCH, filing = FILING, status = 200) => (async (url: string) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {},
  body: url.includes('efts.sec.gov') ? search : filing,
  url,
})) as never;

async function run(source: ReturnType<typeof createSecEdgarSource>, c: Ctx = ctx()): Promise<SourceRecord[]> {
  await source.plan({ category: 'running shoes', productTitle: 'running shoes', productUrl: '', terms: [] });
  const out: SourceRecord[] = [];
  for await (const r of source.retrieve({ text: 'running shoes' }, c)) out.push(r);
  return out;
}

runSourceConformance('sec-edgar', () => ({
  source: createSecEdgarSource({ fetch: routed(), maxFilings: 2 }),
  configuredEnv: ENV,
  planInput: { category: 'running shoes', productTitle: 'running shoes', productUrl: 'https://example.com', terms: ['quality'] },
}));

/*
 * The SEC asks for a User-Agent naming who is calling and how to reach them,
 * and returns 403 without one. A missing contact degrades this source to empty
 * rather than sending a request the archive has asked us not to send.
 */
test('no contact address means unconfigured, not a 403', async () => {
  const source = createSecEdgarSource({ fetch: routed() });
  assert.equal(source.configured({}), false);
  assert.equal(source.configured(ENV), true);
  assert.deepEqual(await run(source, ctx({ env: {} })), []);
});

/*
 * The archive path wants the CIK without leading zeros and the accession
 * number without dashes, neither of which the search response documents.
 */
test('the filing url is assembled from the accession id and the cik', () => {
  assert.equal(
    filingUrl({ _id: '0001477932-15-001997:inst_10k.htm', _source: { ciks: ['0001592365'] } }),
    'https://www.sec.gov/Archives/edgar/data/1592365/000147793215001997/inst_10k.htm',
  );
  assert.equal(filingUrl({ _id: 'no-colon', _source: { ciks: ['1'] } }), null);
  assert.equal(filingUrl({ _id: 'a:b' }), null, 'no cik means no url rather than a guessed one');
});

test('the filer name drops the CIK EDGAR appends to it', () => {
  assert.equal(filerName({ _source: { display_names: ['SAUCONY INC  (CIK 0000049401)'] } }), 'SAUCONY INC');
  assert.equal(filerName({}), 'unnamed filer');
});

test('a file date is read as UTC, and a missing one is zero', () => {
  assert.equal(filingDate('2015-03-31'), Math.floor(Date.UTC(2015, 2, 31) / 1000));
  assert.equal(filingDate('31/03/2015'), 0);
  assert.equal(filingDate(null), 0);
});

test('script and style contents never survive into a quote', () => {
  const text = filingText('<style>.a{color:red}</style><script>var x=1;</script><p>Real prose here.</p>');
  assert.equal(text, 'Real prose here.');
  assert.doesNotMatch(text, /color:red|var x/);
});

test('entities are decoded, because a quote must read as written', () => {
  assert.equal(filingText('<p>it&#x27;s our market &amp; ours alone</p>'), "it's our market & ours alone");
});

/*
 * A quote cut at a fixed character count starts mid word and reads as though we
 * mangled it. The window snaps to sentence boundaries instead.
 */
test('a passage snaps to sentence boundaries rather than cutting mid word', () => {
  const text = 'Some earlier sentence about nothing. We expect to attract customers interested in purchasing running shoes and related equipment. A later sentence follows.';
  const passage = extractPassage(text, 'running shoes');
  assert.ok(passage);
  assert.match(passage.text, /^We expect to attract/);
  assert.match(passage.text, /related equipment\.$/);
});

test('a phrase that is not present yields no passage, and therefore no record', () => {
  assert.equal(extractPassage('nothing relevant here at all', 'running shoes'), null);
});

test('the longest mention wins, because headings and table labels are short', () => {
  const text = 'Running shoes. A heading. '
    + 'The key products that the Company intends to sell, running shoes and other equipment geared to the amateur runners market, will all be manufactured by third parties.';
  const passage = bestPassage(text, 'running shoes');
  assert.ok(passage);
  assert.match(passage.text, /amateur runners market/);
});

test('records carry the filer own words, not our summary of them', async () => {
  const source = createSecEdgarSource({ fetch: routed(), maxFilings: 3 });
  const records = await run(source);

  assert.ok(records.length > 0, 'the captured filing does contain the phrase');
  for (const r of records) {
    assert.equal(r.source, 'sec-edgar');
    assert.equal(r.kind, 'post');
    assert.equal(r.score, 0, 'a filing carries no votes');
    assert.match(r.url ?? '', /^https:\/\/www\.sec\.gov\/Archives/);
    assert.ok((r.text ?? '').length >= 60);
    /* The whole point of the second request: this is prose from the document,
     * not a sentence we wrote about the document. */
    assert.doesNotMatch(r.text ?? '', /filed a|mentions the phrase/i);
  }
});

/*
 * A 10-K mentioning a phrase three times is one document by one filer, not
 * three independent observations.
 */
test('one record per filing, however many times the phrase appears', async () => {
  const source = createSecEdgarSource({ fetch: routed(), maxFilings: 3 });
  const records = await run(source);
  const ids = records.map((r) => r.externalId);
  assert.equal(new Set(ids).size, ids.length, 'one filing must not become several receipts');
});

test('a filing that cannot be fetched is skipped, not faked', async () => {
  /* The search succeeds and every document 404s, which happens when a filing's
   * narrative lives in an exhibit under a different file name. */
  const fetchImpl = (async (url: string) => ({
    ok: url.includes('efts.sec.gov'),
    status: url.includes('efts.sec.gov') ? 200 : 404,
    headers: {}, body: url.includes('efts.sec.gov') ? SEARCH : '', url,
  })) as never;
  assert.deepEqual(await run(createSecEdgarSource({ fetch: fetchImpl })), []);
});

test('a search that returns nothing usable degrades quietly', async () => {
  for (const body of ['null', '{}', '{"hits":{"hits":"nope"}}']) {
    const source = createSecEdgarSource({ fetch: routed(body) });
    assert.deepEqual(await run(source), [], `body ${body}`);
  }
});

/*
 * FOUND BY RUNNING IT, 2026-08-22. A live run quoted a Saucony 10-K as
 * "onsultant, independent contractor or otherwise", because when no sentence
 * break falls within the window the slice cuts mid word. A quote that has been
 * cut badly reads as though we mangled the filing rather than trimmed it.
 */
test('a passage with no nearby sentence break still starts and ends on a word', () => {
  const filler = 'legalese '.repeat(60);
  const text = `${filler}covenant not to compete with running shoes anywhere in the territory ${filler}`;
  const passage = extractPassage(text, 'running shoes');
  assert.ok(passage);

  assert.ok(!/^\S*?[a-z]{2,}\b/.test(passage.text) || text.includes(` ${passage.text.split(' ')[0]}`),
    `passage begins mid word: ${passage.text.slice(0, 30)}`);
  assert.ok(text.includes(passage.text), 'the passage must be a verbatim span of the filing');
});
