/*
 * Expansion is a SEARCH HINT. These tests exist to prove it cannot become
 * evidence, and that a wrong guess costs a request rather than a false claim.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXPANSION_MODELS, expandSubject, expansionConfigured, parseExpansion, type ExpandOptions } from './expand.ts';

const ENV = { OPENROUTER_API_KEY: 'test-key' };
const reply = (content: string) => JSON.stringify({ choices: [{ message: { content } }] });

const deps = (over: Partial<ExpandOptions> = {}): ExpandOptions => ({
  post: async () => ({
    ok: true, status: 200,
    body: reply('{"brands":["Allbirds"],"category":"running shoe","aliases":["wool sneaker"]}'),
  }),
  ...over,
});

test('unconfigured without a key, and it returns an error rather than throwing', async () => {
  assert.equal(expansionConfigured({}), false);
  const result = await expandSubject('wool runner', {}, deps());
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /not configured/);
});

/* Structural. An expansion has no receipt id and no record fields, so it cannot
 * reach the corpus or a corroboration count. */
test('an expansion is marked derived and is not a record', async () => {
  const result = await expandSubject('wool runner', ENV, deps());
  const e = result.expansion!;
  assert.equal(e.derived, true);
  assert.ok(e.model.length > 0, 'a guess with no author is not checkable');
  for (const field of ['receiptId', 'source', 'externalId', 'text']) {
    assert.equal(field in e, false, `${field} would make a guess countable as evidence`);
  }
});

/*
 * Models wrap json in a code fence roughly half the time however firmly they
 * are told not to. Stripping it is cheaper than a retry.
 */
test('a fenced json reply is still parsed', () => {
  const fenced = '```json\n{"brands":["Allbirds"],"category":"shoe","aliases":[]}\n```';
  assert.deepEqual(parseExpansion(fenced, 'm')?.brands, ['Allbirds']);
});

test('prose around the json is tolerated', () => {
  const chatty = 'Sure! Here you go:\n{"brands":[],"category":"toothbrush","aliases":[]}\nHope that helps.';
  assert.equal(parseExpansion(chatty, 'm')?.category, 'toothbrush');
});

test('a reply with no json at all yields nothing', () => {
  assert.equal(parseExpansion('I am not sure what that is.', 'm'), null);
  assert.equal(parseExpansion('', 'm'), null);
});

/* An expansion that suggests nothing is not an expansion, and returning one
 * would make callers handle an empty object that means the same as a failure. */
test('an empty expansion is treated as no answer', () => {
  assert.equal(parseExpansion('{"brands":[],"category":null,"aliases":[]}', 'm'), null);
});

/*
 * Every extra brand is a real request to a stranger's host, so a model that
 * offers twelve gets three.
 */
test('lists are bounded however many the model returns', () => {
  const many = JSON.stringify({
    brands: Array.from({ length: 12 }, (_, i) => `Brand${i}`),
    category: 'shoe',
    aliases: Array.from({ length: 9 }, (_, i) => `Alias${i}`),
  });
  const e = parseExpansion(many, 'm')!;
  assert.equal(e.brands.length, 3);
  assert.equal(e.aliases.length, 3);
});

test('junk entries are dropped rather than passed on as domains to try', () => {
  const junk = '{"brands":["Allbirds", 42, null, "", "x"],"category":"  ","aliases":[]}';
  const e = parseExpansion(junk, 'm')!;
  assert.deepEqual(e.brands, ['Allbirds'], 'a one character brand is not a brand');
  assert.equal(e.category, null, 'whitespace is not a category');
});

/*
 * Measured live 2026-08-22: asked about "wool runner" the model returned no
 * brands at all, which is the prompt working. Restraint has a recall cost and
 * it is the right trade, because an invented brand costs a request to disprove
 * and an invented CLAIM would cost the product its credibility.
 */
test('declining to guess is a valid answer and is not an error', () => {
  const restrained = parseExpansion('{"brands":[],"category":"running shoe","aliases":["wool sneaker"]}', 'm')!;
  assert.deepEqual(restrained.brands, []);
  assert.equal(restrained.category, 'running shoe');
});

/*
 * Seen live 2026-08-24: the first model in the pool had been withdrawn from
 * OpenRouter, every expansion returned "status 404", and the chain never got
 * to models that worked. A missing model is pool drift, not our mistake.
 */
test('a withdrawn model falls over to the next instead of ending the chain', async () => {
  const tried: string[] = [];
  const result = await expandSubject('x', ENV, deps({
    post: async (_u, init) => {
      tried.push((JSON.parse(init.body) as { model: string }).model);
      if (tried.length === 1) return { ok: false, status: 404, body: '' };
      return { ok: true, status: 200, body: reply('{"brands":[],"category":"shoe","aliases":[]}') };
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(tried.length, 2, 'the second model was tried');
});

test('a rate limited model falls over, and the answer names who gave it', async () => {
  const tried: string[] = [];
  const result = await expandSubject('x', ENV, deps({
    post: async (_u, init) => {
      tried.push((JSON.parse(init.body) as { model: string }).model);
      if (tried.length === 1) return { ok: false, status: 429, body: '' };
      return { ok: true, status: 200, body: reply('{"brands":["Allbirds"],"category":"running shoe","aliases":[]}') };
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.expansion?.model, tried[1]);
});

test('a 200 carrying a provider error fails over rather than counting as success', async () => {
  let calls = 0;
  const result = await expandSubject('x', ENV, deps({
    post: async () => {
      calls++;
      if (calls === 1) return { ok: true, status: 200, body: JSON.stringify({ error: { message: 'rate-limited' } }) };
      return { ok: true, status: 200, body: reply('{"brands":["Allbirds"],"category":"running shoe","aliases":[]}') };
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test('when every model refuses, each attempt is named', async () => {
  const result = await expandSubject('x', ENV, deps({
    post: async () => ({ ok: false, status: 429, body: '', error: 'too many requests' }),
  }));
  assert.equal(result.ok, false);
  for (const model of EXPANSION_MODELS) {
    assert.match(result.error ?? '', new RegExp(model.replace(/[/:.]/g, '\\$&')));
  }
});

test('a bad request stops immediately rather than burning the chain', async () => {
  let calls = 0;
  await expandSubject('x', ENV, deps({
    post: async () => { calls++; return { ok: false, status: 400, body: '', error: 'malformed' }; },
  }));
  assert.equal(calls, 1);
});

test('the prompt tells the model not to guess', async () => {
  let sent = '';
  await expandSubject('wool runner', ENV, deps({
    post: async (_u, init) => { sent = init.body; return { ok: true, status: 200, body: reply('{"brands":[],"category":"c","aliases":[]}') }; },
  }));
  assert.match(sent, /Do not guess/);
  assert.match(sent, /wool runner/);
});
