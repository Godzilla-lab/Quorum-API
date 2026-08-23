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

  const empty = await call('category_warmth', { category: 'garden hoses' });
  assert.match(empty, /Nothing held/);
  assert.match(empty, /minutes of throttled retrieval/);
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
