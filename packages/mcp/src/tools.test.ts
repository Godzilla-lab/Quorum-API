/*
 * The five tools, against a real SQLite corpus.
 *
 * Not a fake driver: these tools exist to report what is actually held, and a
 * fake would let a wrong query pass by returning whatever the test wanted. The
 * corpus is cheap to build in a temp directory, so there is no excuse.
 *
 * What matters here is not that the strings are pretty. It is that the tools
 * refuse to overstate: a weak signal is labelled, an absence is described as
 * "we hold nothing" rather than "there is no problem", and an id that does not
 * resolve is the loudest thing in the response.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openSqliteCorpus, type CorpusDriver, type DocInput } from '@quorum/corpus';
import { createTools } from './tools.ts';

const scratch = mkdtempSync(join(tmpdir(), 'quorum-mcp-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
const doc = (text: string, channel: string): DocInput => ({
  source: 'reddit',
  kind: 'comment',
  externalId: `m${n++}`,
  channel,
  text,
  score: 4,
  url: `https://example.test/${n}`,
  createdUtc: 1_700_000_000,
});

/* Three channels for sizing so it clears the threshold, one for smell so it
 * does not. The two cases the tools must describe differently. */
async function corpusWith(): Promise<CorpusDriver> {
  const corpus = openSqliteCorpus({ path: join(scratch, `c${n}.db`) });
  await corpus.addDocs([
    doc('the sizing on these running shoes runs small', 'r/running'),
    doc('sizing is off, running shoes came up short', 'r/runningshoegeeks'),
    doc('had to size up, running shoes sizing is wrong', 'r/trailrunning'),
    doc('slight smell out of the box on these running shoes', 'r/running'),
  ], 'running shoes');
  return corpus;
}

const tools = async (research = false) => {
  const corpus = await corpusWith();
  const list = createTools({
    corpus,
    ...(research ? { research: async (s: string) => `report for ${s}` } : {}),
  });
  return {
    corpus,
    call: (name: string, args: Record<string, unknown> = {}) => {
      const tool = list.find((t) => t.name === name);
      if (!tool) throw new Error(`no tool ${name}`);
      return tool.run(args);
    },
    names: list.map((t) => t.name),
  };
};

/* ------------------------------------------------------------------ */
/* the tool surface                                                    */
/* ------------------------------------------------------------------ */

test('FOUR TOOLS BY DEFAULT, AND RESEARCH IS NOT ONE OF THEM', async () => {
  /*
   * A report is minutes of throttled retrieval against volunteer archives. An
   * agent should not be able to start one because it was registered by default.
   */
  const { names, corpus } = await tools();
  assert.deepEqual(names, ['search_evidence', 'get_receipt', 'category_warmth', 'compare_formats']);
  await corpus.close();

  const withResearch = await tools(true);
  assert.equal(withResearch.names[0], 'research_product', 'and it leads when it is on');
  assert.equal(withResearch.names.length, 5);
  await withResearch.corpus.close();
});

test('five tools is the budget, and every schema is small', async () => {
  /* A tool definition costs 100 to 500 tokens on every turn. This is the check
   * that stops the surface growing one endpoint at a time. */
  const { corpus } = await tools(true);
  const list = createTools({ corpus, research: async () => '' });
  assert.ok(list.length <= 5, `${list.length} tools is over the budget`);
  for (const t of list) {
    assert.ok(t.description.length < 400, `${t.name} has a ${t.description.length} char description`);
    assert.equal(typeof t.inputSchema['type'], 'string');
  }
  await corpus.close();
});

/* ------------------------------------------------------------------ */
/* search_evidence                                                     */
/* ------------------------------------------------------------------ */

test('A CORROBORATED TERM IS A FINDING, WITH ITS COUNTS AND ITS RECEIPTS', async () => {
  const { call, corpus } = await tools();
  const out = await call('search_evidence', { query: 'sizing', category: 'running shoes' });

  assert.match(out, /\*\*Finding\.\*\*/);
  assert.match(out, /3 independent records across 3 channels/);
  assert.match(out, /`rc_[0-9a-f]+`/, 'every quote carries an id to check it with');
  await corpus.close();
});

test('A WEAK SIGNAL SAYS SO, AND SAYS NOT TO REPEAT IT', async () => {
  /* One record is real evidence and is not a market pattern. The wording is
   * the whole product: a model reading this must not promote it. */
  const { call, corpus } = await tools();
  const out = await call('search_evidence', { query: 'smell', category: 'running shoes' });

  assert.match(out, /Weak signal, not a finding/);
  assert.match(out, /Do not state this as a market pattern/);
  assert.doesNotMatch(out, /\*\*Finding\.\*\*/);
  await corpus.close();
});

test('THE ANY-WORD FALLBACK CONFESSES INSTEAD OF POSING AS CORROBORATION', async () => {
  /* Measured live 2026-08-25: "pull request commit repository issue" against
   * a shoe category printed a finding on 143 real records that merely
   * contained "issue". The count was true; what it counted was not said. */
  const corpus = openSqliteCorpus({ path: join(scratch, `fallback-${n}.db`) });
  await corpus.addDocs([
    doc('the tongue slipping issue happens even with gusseted shoes', 'r/running'),
    doc('lacing fixed my heel issue on long runs', 'r/trailrunning'),
    doc('sizing issue on the wide fit, went up half', 'r/runningshoegeeks'),
  ], 'running shoes');
  const list = createTools({ corpus });
  const search = list.find((t) => t.name === 'search_evidence')!;

  const out = await search.run({ query: 'pull request commit repository issue', category: 'running shoes' });
  assert.match(out, /No stored record contains every word of this query together/);
  assert.match(out, /vocabulary coverage, not corroboration of the phrase/);

  /* A query the records genuinely answer carries no such caveat. */
  const clean = await search.run({ query: 'issue', category: 'running shoes' });
  assert.doesNotMatch(clean, /vocabulary coverage/);
  await corpus.close();
});

test('DIVIDED EVIDENCE PRINTS AS CONTESTED WITH BOTH COUNTS, NEVER AS A FINDING', async () => {
  /* The evaluator's case: enough records report a problem AND enough say "no
   * problems". Until 2026-08-25 the second group was silently discarded and
   * this printed as a finding. */
  const corpus = openSqliteCorpus({ path: join(scratch, `contested-${n}.db`) });
  await corpus.addDocs([
    doc('the sole fell apart, real problems with the stitching', 'r/running'),
    doc('problems with the heel after a month', 'r/trailrunning'),
    doc('durability problems, seam split on the toe box', 'r/runningshoegeeks'),
    doc('six months in, absolutely no problems with these', 'r/running'),
    doc('no problems at all, holding up great', 'r/sneakers'),
    doc('zero problems, no issues, best pair I have owned', 'r/frugalrunning'),
  ], 'running shoes');
  const list = createTools({ corpus });
  const search = list.find((t) => t.name === 'search_evidence')!;

  const out = await search.run({ query: 'problems', category: 'running shoes' });
  assert.match(out, /\*\*Contested\.\*\*/);
  assert.match(out, /3 records support this and 3 say the opposite/);
  assert.doesNotMatch(out, /\*\*Finding\.\*\*/);
  assert.match(out, /Refuting receipts: `rc_[0-9a-f]+`/,
    '"3 say otherwise" is a claim like any other and ships its receipts');
  await corpus.close();
});

test('HOLDING NOTHING IS NOT EVIDENCE THAT NOTHING IS WRONG', async () => {
  const { call, corpus } = await tools();
  const out = await call('search_evidence', { query: 'battery explosions' });

  assert.match(out, /No records held/);
  assert.match(out, /not evidence that it is fine/);
  await corpus.close();
});

test('the record count is bounded, so a search cannot flood a context window', async () => {
  const { call, corpus } = await tools();
  const out = await call('search_evidence', { query: 'running shoes', limit: 9_999_999 });
  /* Five quoted at most, whatever the caller asks for. */
  assert.ok((out.match(/^> /gm) ?? []).length <= 5 * 3, 'more than five records were quoted');
  await corpus.close();
});

test('THE VERDICT IS INVARIANT UNDER ANYTHING THE CALLER SENDS BESIDE THE QUERY', async () => {
  /*
   * Measured live by an outside tester, 2026-08-24: the retired `limit`
   * parameter fed the corroboration scan, so `limit: 2` printed "weak signal"
   * and `limit: 3` printed "finding" on the identical query and corpus. The
   * count is the product. A caller must not be able to move it, and a caller
   * still sending the old parameter must be ignored rather than errored.
   */
  const { call, corpus } = await tools();
  const outputs = await Promise.all([
    call('search_evidence', { query: 'sizing', category: 'running shoes' }),
    call('search_evidence', { query: 'sizing', category: 'running shoes', limit: 2 }),
    call('search_evidence', { query: 'sizing', category: 'running shoes', limit: 3 }),
    call('search_evidence', { query: 'sizing', category: 'running shoes', limit: 500 }),
  ]);
  const verdictLines = outputs.map((o) => o.split('\n').find((l) => l.startsWith('**'))!);
  for (const line of verdictLines) {
    assert.equal(line, verdictLines[0], 'the verdict moved with a parameter that is not the query');
  }
  assert.match(verdictLines[0]!, /Finding/);
  assert.match(verdictLines[0]!, /3 independent records/);
  await corpus.close();
});

/* ------------------------------------------------------------------ */
/* get_receipt, the tool the whole pitch rests on                      */
/* ------------------------------------------------------------------ */

test('AN ID THAT DOES NOT RESOLVE IS THE LOUDEST THING IN THE RESPONSE', async () => {
  /*
   * This is the anti fabrication rule reaching the agent. If a model cited an
   * id that is not real, this is where it finds out, and burying it under the
   * ones that did resolve is how it gets missed.
   */
  const { call, corpus } = await tools();
  const real = await corpus.search('sizing', { limit: 1 });
  const hit = real[0]!;
  const out = await call('get_receipt', { receiptIds: [hit.receiptId, 'rc_deadbeefdeadbeef'] });

  const firstLine = out.split('\n')[0]!;
  assert.match(firstLine, /did not resolve/);
  assert.match(out, /rc_deadbeefdeadbeef/);
  assert.match(out, /must not be repeated/);
  /* And the real one is still returned, in full. Asserted against the record
   * the corpus actually ranked first rather than against a guess at which one
   * that is, because the ranking is the search's business and not this test's. */
  assert.ok(out.includes(hit.text), 'the resolved record was not returned');
  assert.ok(out.includes(hit.receiptId));
  await corpus.close();
});

test('resolving only real ids says nothing about failures', async () => {
  const { call, corpus } = await tools();
  const real = await corpus.search('sizing', { limit: 2 });
  const out = await call('get_receipt', { receiptIds: real.map((d) => d.receiptId) });
  assert.doesNotMatch(out, /did not resolve/);
  await corpus.close();
});

test('a single id works without being wrapped in an array', async () => {
  const { call, corpus } = await tools();
  const real = await corpus.search('sizing', { limit: 1 });
  const out = await call('get_receipt', { receiptIds: real[0]!.receiptId });
  assert.ok(out.includes(real[0]!.text));
  await corpus.close();
});

/* ------------------------------------------------------------------ */
/* category_warmth and compare_formats                                 */
/* ------------------------------------------------------------------ */

test('warmth tells an agent whether asking is cheap before it asks', async () => {
  const { call, corpus } = await tools();
  const held = await call('category_warmth', { category: 'running shoes' });
  assert.match(held, /4 records across 3 channels/);
  /* Warmth never implied ads, and now it says so instead of letting a caller
   * spend a compare_formats call to find out. */
  assert.match(held, /No ads held/);

  const empty = await call('category_warmth', { category: 'garden hoses' });
  assert.match(empty, /Nothing held/);
  assert.match(empty, /minutes of throttled retrieval/);
  await corpus.close();
});

test('WITH NO CATEGORY, WARMTH LISTS WHAT EXISTS INSTEAD OF MAKING A CALLER GUESS', async () => {
  /* Measured on the live instance 2026-08-24: an outside tester guessed five
   * categories, four returned nothing, and nothing reads as broken. */
  const { call, corpus } = await tools();
  const out = await call('category_warmth', {});
  assert.match(out, /Categories held/);
  assert.match(out, /running shoes: 4 records, 3 channels/);
  await corpus.close();
});

test('A LONG RECORD TRUNCATES WITH NOTICE, AND full RETURNS EVERY CHARACTER', async () => {
  /* The bound search_evidence always had and get_receipt lacked: resolving
   * three dump ids once returned an entire scraped race site. */
  const { call, corpus } = await tools();
  const long = `the sizing story starts here ${'and the details continue at length '.repeat(120)}`;
  await corpus.addDocs([doc(long, 'r/ultrarunning')], 'running shoes');
  const [hit] = await corpus.search('sizing story', { limit: 1 });

  const bounded = await call('get_receipt', { receiptIds: [hit!.receiptId] });
  assert.match(bounded, /\[truncated: \d+ more characters\. Pass full: true to read everything\.\]/);
  assert.ok(!bounded.includes(long), 'the full text must not leak past the bound');

  const complete = await call('get_receipt', { receiptIds: [hit!.receiptId], full: true });
  assert.ok(complete.includes(long.replace(/\s+/g, ' ').trim()), 'full: true returns the whole record');
  assert.doesNotMatch(complete, /truncated:/);
  await corpus.close();
});

test('no ads means nothing to compare, said plainly', async () => {
  const { call, corpus } = await tools();
  assert.match(await call('compare_formats', { category: 'running shoes' }), /No ads held/);
  await corpus.close();
});

/* ------------------------------------------------------------------ */
/* the arguments a model will actually get wrong                       */
/* ------------------------------------------------------------------ */

test('EMPTY AND MISSING ARGUMENTS ANSWER, THEY DO NOT THROW', async () => {
  /*
   * A throw becomes an isError the model has to parse out of a stack. A
   * sentence is something it can act on, and models pass empty strings often.
   */
  const { call, corpus } = await tools(true);
  for (const [name, args] of [
    ['search_evidence', {}],
    ['search_evidence', { query: '   ' }],
    ['get_receipt', { receiptIds: [] }],
    ['get_receipt', {}],
    ['category_warmth', {}],
    ['compare_formats', {}],
    ['research_product', { subject: '' }],
  ] as const) {
    const out = await call(name, args as Record<string, unknown>);
    assert.ok(out.length > 0, `${name} returned nothing`);
    assert.doesNotMatch(out, /undefined|\[object/, `${name} leaked a placeholder: ${out.slice(0, 80)}`);
  }
  await corpus.close();
});

/* ------------------------------------------------------------------ */
/* hedges and concentration, added 2026-08-26                          */
/* ------------------------------------------------------------------ */

test('a full scan window hedges the channel count, not just the record count', async () => {
  const { call, corpus } = await tools();
  /* Fill the scan window: 500 distinct records carrying the query word. */
  const bulk: DocInput[] = [];
  for (let i = 0; i < 520; i++) {
    bulk.push(doc(`the sizing complaint number ${i} about these`, `r/bulk${i % 7}`));
  }
  await corpus.addDocs(bulk, 'running shoes');
  const out = await call('search_evidence', { query: 'sizing', category: 'running shoes' });
  assert.match(out, /at least \d+ independent records across at least \d+ channels/,
    'both counts come from the same truncated window, so both carry the floor');
  await corpus.close();
});

test('a channel floor demotion says one channel is one room, not "below threshold"', async () => {
  const { call, corpus } = await tools();
  await corpus.addDocs([
    doc('the strap creaks after a month', 'r/onlyroom'),
    doc('strap creaks whenever I lift', 'r/onlyroom'),
    doc('another strap that creaks, third one', 'r/onlyroom'),
    doc('my strap also creaks on cold days', 'r/onlyroom'),
  ], 'lifting straps');
  const out = await call('search_evidence', { query: 'creaks', category: 'lifting straps' });
  assert.match(out, /\*\*Weak signal, not a finding\.\*\*/);
  assert.match(out, /clear the threshold/, 'the records did clear the record threshold');
  assert.match(out, /one channel is one room/, 'and the real reason for the demotion is named');
  await corpus.close();
});

test('extreme concentration carries a warning in search and in warmth', async () => {
  const { call, corpus } = await tools();
  const bulk: DocInput[] = [];
  for (let i = 0; i < 120; i++) {
    bulk.push(doc(`the office chair squeaks in a new way, report ${i}`, i === 0 ? 'r/chairtalk' : 'r/onechair'));
  }
  await corpus.addDocs(bulk, 'office chair');
  const search = await call('search_evidence', { query: 'squeaks', category: 'office chair' });
  assert.match(search, /Concentration warning/);
  assert.match(search, /one long conversation/);

  const warmth = await call('category_warmth', { category: 'office chair' });
  assert.match(warmth, /Concentration warning/);

  /* And a healthy spread stays unwarned. */
  const healthy = await call('search_evidence', { query: 'sizing', category: 'running shoes' });
  assert.doesNotMatch(healthy, /Concentration warning/);
  await corpus.close();
});

/* ------------------------------------------------------------------ */
/* phrase mode and filters on search_evidence, added 2026-08-26        */
/* ------------------------------------------------------------------ */

test('phrase mode matches the sequence and never confesses a fallback it cannot take', async () => {
  const { call, corpus } = await tools();
  const exact = await call('search_evidence', { query: 'runs small', category: 'running shoes', phrase: true });
  assert.doesNotMatch(exact, /vocabulary coverage/, 'a phrase result is never an any word fallback');

  const reordered = await call('search_evidence', { query: 'small runs', category: 'running shoes', phrase: true });
  assert.match(reordered, /No records held/, 'the words out of order are not the phrase');
  await corpus.close();
});

test('source filters work and a typo is a refusal naming the mistake', async () => {
  const { call, corpus } = await tools();
  await corpus.addDocs([
    doc('sizing gripes in a filing about running shoes', 'Filer, Inc.'),
  ].map((d) => ({ ...d, source: 'sec-edgar' as const })), 'running shoes');

  const without = await call('search_evidence', { query: 'sizing', category: 'running shoes', excludeSources: ['sec-edgar', 'cpsc'] });
  assert.doesNotMatch(without, /sec-edgar/, 'the excluded source is gone from quotes and ids');

  const voice = await call('search_evidence', { query: 'sizing', category: 'running shoes', sourceClasses: ['consumer_voice'] });
  assert.doesNotMatch(voice, /sec-edgar/);

  const typo = await call('search_evidence', { query: 'sizing', excludeSources: ['sec-edgear'] });
  assert.match(typo, /sec-edgear/, 'the refusal names the typo');
  assert.match(typo, /sec-edgar/, 'and points at the source they meant');

  const badClass = await call('search_evidence', { query: 'sizing', sourceClasses: ['regulatory'] });
  assert.match(badClass, /consumer_voice, practitioner and institutional/);
  await corpus.close();
});

test('date filters take ISO dates and refuse garbage with copy, not a throw', async () => {
  const { call, corpus } = await tools();
  const windowed = await call('search_evidence', { query: 'sizing', category: 'running shoes', after: '2020-01-01' });
  assert.match(windowed, /Finding|records/, 'the fixture docs are dated 2023 era and stay inside');

  const excluded = await call('search_evidence', { query: 'sizing', category: 'running shoes', after: '2030-01-01' });
  assert.match(excluded, /No records held/);

  const garbage = await call('search_evidence', { query: 'sizing', after: 'last march' });
  assert.match(garbage, /ISO date/, 'garbage gets a sentence, not an exception');
  await corpus.close();
});

test('minChannels on search_evidence demands breadth and can only demote', async () => {
  const { call, corpus } = await tools();
  const normal = await call('search_evidence', { query: 'sizing', category: 'running shoes' });
  assert.match(normal, /\*\*Finding\.\*\*/);
  const strict = await call('search_evidence', { query: 'sizing', category: 'running shoes', minChannels: 40 });
  assert.match(strict, /\*\*Weak signal, not a finding\.\*\*/);
  await corpus.close();
});
