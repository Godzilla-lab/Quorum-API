/*
 * The synthesis transport.
 *
 * Every case here was taken from a live measurement on 2026-08-22 rather than
 * imagined. The free model pool produced all of them within twelve calls: a
 * model that answers in prose, a model that returns 400 on a request two others
 * accepted, a model rate limited upstream, and a model that returns 200 with an
 * error object inside it. A transport written against the happy path would have
 * shipped and then failed on a Tuesday.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RATES, isCallRate } from '@receipts/core';
import { CLAIMS_MODELS, askClaims, claimsConfigured, parseModelJson } from './claims.ts';

const ENV = { OPENROUTER_API_KEY: 'test-key' };

/* A transport that replays canned responses in order and records what was sent. */
function transport(...responses: { ok?: boolean; status?: number; body: string }[]) {
  const sent: { url: string; body: string; headers: Record<string, string>; timeoutMs: number }[] = [];
  let index = 0;
  const post = async (url: string, init: { headers: Record<string, string>; body: string; timeoutMs: number }) => {
    sent.push({ url, ...init });
    const next = responses[index++] ?? { body: '' };
    return { ok: next.ok ?? true, status: next.status ?? 200, body: next.body };
  };
  return { post, sent };
}

const answer = (content: string, usage?: { prompt_tokens: number; completion_tokens: number }): string =>
  JSON.stringify({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) });

const REQUEST = { system: 'you read evidence', prompt: 'Subject: wool runner', schema: { type: 'object' } };

/* ------------------------------------------------------------------ */
/* parseModelJson                                                      */
/* ------------------------------------------------------------------ */

test('a fenced answer is unwrapped', () => {
  assert.deepEqual(parseModelJson('```json\n{"claims":[]}\n```'), { claims: [] });
  assert.deepEqual(parseModelJson('```\n{"claims":[]}\n```'), { claims: [] });
});

test('a preamble before the json is stripped', () => {
  /* Reasoning models narrate before answering. Measured constantly. */
  assert.deepEqual(parseModelJson('Here is the result:\n{"claims":[]}'), { claims: [] });
});

test('an answer in prose is null rather than a throw', () => {
  /* MEASURED 2026-08-22: with no response_format, every free model tested
   * returned markdown with bolded headings instead of json. */
  assert.equal(parseModelJson('**sizing**\n- c0: "they run small"'), null);
  assert.equal(parseModelJson(''), null);
  assert.equal(parseModelJson('{ not json at all'), null);
});

/* ------------------------------------------------------------------ */
/* askClaims                                                           */
/* ------------------------------------------------------------------ */

test('no key is a value on the result, and the wire is never touched', async () => {
  const { post, sent } = transport();
  const result = await askClaims({}, { post })(REQUEST);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /OPENROUTER_API_KEY/);
  assert.equal(sent.length, 0);
  assert.equal(claimsConfigured({}), false);
  assert.equal(claimsConfigured(ENV), true);
});

test('the schema is sent, because without it the models answer in prose', async () => {
  const { post, sent } = transport({ body: answer('{"claims":[]}') });
  await askClaims(ENV, { post })(REQUEST);

  const body = JSON.parse(sent[0]!.body) as {
    model: string;
    messages: { role: string; content: string }[];
    response_format: { type: string; json_schema: { strict: boolean; schema: unknown } };
  };
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema, REQUEST.schema);
  assert.deepEqual(body.messages, [
    { role: 'system', content: REQUEST.system },
    { role: 'user', content: REQUEST.prompt },
  ]);
  assert.match(sent[0]!.headers['authorization'] ?? '', /^Bearer test-key$/);
});

test('A PER MODEL 400 FALLS OVER RATHER THAN ENDING THE RUN', async () => {
  /*
   * MEASURED 2026-08-22: dots-studio/dots-3-note-preview:free returned 400
   * twice on a body that two other models accepted and answered. Treating a
   * 400 as our own mistake, which vision.ts and expand.ts do, would have lost
   * the whole feature to one broken upstream.
   */
  const { post, sent } = transport(
    { ok: false, status: 400, body: '{"error":{"message":"bad request"}}' },
    { body: answer('{"claims":[{"term":"sizing","claim":"Runs small.","evidence_ids":["c0"]}]}') },
  );
  const result = await askClaims(ENV, { post })(REQUEST);

  assert.equal(sent.length, 2, 'it tried the next model');
  assert.equal(result.ok, true);
  assert.equal(result.model, CLAIMS_MODELS[1]);
});

test('a 429 falls over, because the free pool is rate limited upstream', async () => {
  /* MEASURED 2026-08-22: two models returned "temporarily rate-limited
   * upstream" on consecutive calls a second apart. */
  const { post, sent } = transport(
    { ok: false, status: 429, body: '' },
    { ok: false, status: 429, body: '' },
    { body: answer('{"claims":[]}') },
  );
  const result = await askClaims(ENV, { post })(REQUEST);
  assert.equal(sent.length, 3);
  assert.equal(result.ok, true);
});

test('a 200 carrying an error object is a failure, not an answer', async () => {
  const { post } = transport(
    { body: '{"error":{"message":"provider refused"}}' },
    { body: answer('{"claims":[]}') },
  );
  const result = await askClaims(ENV, { post })(REQUEST);
  assert.equal(result.ok, true, 'it moved on to the next model');
  assert.equal(result.model, CLAIMS_MODELS[1]);
});

test('a model answering in prose falls over to the next one', async () => {
  const { post } = transport(
    { body: answer('**sizing**\n- c0: they run small') },
    { body: answer('{"claims":[]}') },
  );
  const result = await askClaims(ENV, { post })(REQUEST);
  assert.equal(result.ok, true);
  assert.equal(result.model, CLAIMS_MODELS[1]);
});

test('every model failing reports every reason, not just the last', async () => {
  const responses = CLAIMS_MODELS.map((_, i) => ({ ok: false, status: 500 + i, body: '' }));
  const { post } = transport(...responses);
  const result = await askClaims(ENV, { post })(REQUEST);

  assert.equal(result.ok, false);
  for (const model of CLAIMS_MODELS) {
    assert.ok(result.error?.includes(model), `${model} is missing from the error`);
  }
});

test('a body that is not json at all does not throw', async () => {
  const { post } = transport({ body: '<html>502 Bad Gateway</html>' });
  const result = await askClaims(ENV, { post: post })(REQUEST);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /response was not json/);
});

test('usage is reported so the meter can charge, and absent means absent', async () => {
  const withUsage = transport({ body: answer('{"claims":[]}', { prompt_tokens: 437, completion_tokens: 1707 }) });
  const a = await askClaims(ENV, { post: withUsage.post })(REQUEST);
  assert.deepEqual(a.usage, { inputTokens: 437, outputTokens: 1707 });

  const without = transport({ body: answer('{"claims":[]}') });
  const b = await askClaims(ENV, { post: without.post })(REQUEST);
  assert.equal(b.usage, undefined, 'a missing count is missing, never zero');
});

test('an explicit model replaces the list entirely', async () => {
  const { post, sent } = transport({ ok: false, status: 500, body: '' });
  await askClaims(ENV, { post, model: 'anthropic/claude-sonnet-5' })(REQUEST);
  assert.equal(sent.length, 1, 'no fallback when a model was named');
  assert.equal((JSON.parse(sent[0]!.body) as { model: string }).model, 'anthropic/claude-sonnet-5');
});

/* ------------------------------------------------------------------ */
/* the list and the rate table must not drift apart                    */
/* ------------------------------------------------------------------ */

test('every default model has a verified rate, so the free path prints no warning', () => {
  /*
   * An unpriced model charges zero AND marks the whole run unverified, which
   * puts "rate not confirmed with the vendor" under a line that is genuinely
   * free. Adding a model to the list without pricing it would train people to
   * ignore the one warning that stops an estimate pricing a report.
   */
  for (const model of CLAIMS_MODELS) {
    const rate = RATES[model];
    assert.ok(rate, `${model} is in the default list with no entry in RATES`);
    assert.equal(rate.verified, true, `${model} has an unverified rate`);
    assert.equal(isCallRate(rate), false, `${model} is priced per call, which is not how tokens bill`);
    if (!isCallRate(rate)) {
      assert.equal(rate.in, 0, `${model} is in the free default list at a non zero rate`);
      assert.equal(rate.out, 0, `${model} is in the free default list at a non zero rate`);
    }
  }
});
