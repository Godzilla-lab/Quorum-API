/*
 * The assertions that matter here are negative. Vision produces an
 * interpretation, and the tests exist to prove it cannot become evidence.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_VISION_MODEL, VISION_MODELS, readImage, visionConfigured, type VisionOptions } from './vision.ts';

const ENV = { OPENROUTER_API_KEY: 'test-key' };
const IMAGE_BYTES = Buffer.from('fake jpeg bytes').toString('base64');

function deps(over: Partial<VisionOptions> = {}): VisionOptions {
  return {
    now: () => 1_787_000_000,
    fetchImage: async () => ({ ok: true, body: IMAGE_BYTES, headers: { 'content-type': 'image/jpeg' } }),
    post: async () => ({
      ok: true, status: 200,
      body: JSON.stringify({ choices: [{ message: { content: '  SIZE UP HALF A SIZE  ' } }] }),
    }),
    ...over,
  };
}

/* A missing key degrades a run and never fails it. */
test('unconfigured without a key, and reading returns an error rather than throwing', async () => {
  assert.equal(visionConfigured({}), false);
  assert.equal(visionConfigured(ENV), true);

  const result = await readImage('https://cdn.test/a.jpg', {}, deps());
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /not configured/);
});

/*
 * THE RULE. The image travels with the reading, so a reader can open the same
 * picture the model looked at and disagree with it.
 */
test('a reading carries the image it came from, and is marked as derived', async () => {
  const result = await readImage('https://cdn.test/ad.jpg', ENV, deps());
  assert.equal(result.ok, true);
  assert.equal(result.reading?.imageUrl, 'https://cdn.test/ad.jpg');
  assert.equal(result.reading?.derived, true);
  assert.equal(result.reading?.model, DEFAULT_VISION_MODEL);
  assert.equal(result.reading?.readAt, 1_787_000_000);
});

/*
 * Structural, not a convention. A reading has no receiptId, no source and no
 * externalId, so it cannot be passed to addDocs and cannot enter a
 * corroboration count. If this test fails, someone has made model output
 * countable as evidence.
 */
test('a reading is not a record and cannot be counted as one', async () => {
  const result = await readImage('https://cdn.test/ad.jpg', ENV, deps());
  const reading = result.reading!;
  for (const field of ['receiptId', 'source', 'externalId', 'category', 'channel']) {
    assert.equal(field in reading, false, `${field} would make model output countable as evidence`);
  }
});

test('the transcription prompt asks for words, and refuses to describe', async () => {
  let sent = '';
  await readImage('https://cdn.test/a.jpg', ENV, deps({
    post: async (_u, init) => { sent = init.body; return { ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: 'x' } }] }) }; },
  }));
  assert.match(sent, /Transcribe every word/);
  assert.match(sent, /Do not describe the image/);
});

test('a description is marked as a description, so a caller can refuse it', async () => {
  const result = await readImage('https://cdn.test/a.jpg', ENV, deps({ kind: 'description' }));
  assert.equal(result.reading?.kind, 'description');
});

/*
 * A cdn serves webp from a path ending .jpg constantly, so the mime comes from
 * the response and never from the url.
 */
test('the content type decides the mime, not the file extension', async () => {
  let sent = '';
  await readImage('https://cdn.test/photo.jpg', ENV, deps({
    fetchImage: async () => ({ ok: true, body: IMAGE_BYTES, headers: { 'content-type': 'image/webp; charset=binary' } }),
    post: async (_u, init) => { sent = init.body; return { ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: 'x' } }] }) }; },
  }));
  assert.match(sent, /data:image\/webp;base64,/);
  assert.doesNotMatch(sent, /image\/jpeg/);
});

test('something that is not an image is refused before a model is paid to look', async () => {
  let posted = false;
  const result = await readImage('https://cdn.test/a.jpg', ENV, deps({
    fetchImage: async () => ({ ok: true, body: 'PGh0bWw+', headers: { 'content-type': 'text/html' } }),
    post: async () => { posted = true; return { ok: true, status: 200, body: '{}' }; },
  }));
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /not an image/);
  assert.equal(posted, false);
});

test('an image that cannot be fetched degrades rather than throwing', async () => {
  const result = await readImage('https://cdn.test/a.jpg', ENV, deps({
    fetchImage: async () => ({ ok: false, body: '', headers: {}, error: 'request timed out' }),
  }));
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /timed out/);
});

test('a provider error is surfaced, not swallowed', async () => {
  const result = await readImage('https://cdn.test/a.jpg', ENV, deps({
    post: async () => ({ ok: true, status: 200, body: JSON.stringify({ error: { message: 'rate limited' } }) }),
  }));
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /rate limited/);
});

test('a non json response degrades rather than crashing', async () => {
  const result = await readImage('https://cdn.test/a.jpg', ENV, deps({
    post: async () => ({ ok: true, status: 200, body: '<html>502</html>' }),
  }));
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /not json/);
});

/*
 * An image with no text in it is a real answer. Storing an empty string as
 * though the model had said something would put a blank claim in a report.
 */
test('an empty reading is a failure, not an empty fact', async () => {
  const result = await readImage('https://cdn.test/a.jpg', ENV, deps({
    post: async () => ({ ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: '   ' } }] }) }),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.reading, undefined);
});

test('the reading is trimmed, because leading whitespace is not evidence', async () => {
  const result = await readImage('https://cdn.test/a.jpg', ENV, deps());
  assert.equal(result.reading?.text, 'SIZE UP HALF A SIZE');
});

/* The default model must be one that actually accepts images and costs nothing. */
test('the default model is pinned and free', () => {
  assert.match(DEFAULT_VISION_MODEL, /:free$/);
});

test('no em dash or en dash in the prompts we ship', () => {
  const source = readFileSync(new URL('./vision.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, new RegExp(`${String.fromCodePoint(0x2014)}|${String.fromCodePoint(0x2013)}`));
});

/*
 * The free tier is a SHARED POOL. Measured 2026-08-22: the first live call
 * returned 429 "google/gemma-4-31b-it:free is temporarily rate-limited
 * upstream", which is not our key, our quota or our fault. Pinning one model
 * means inheriting everyone else's limit.
 */
test('a rate limited model falls over to the next, and the answer names who gave it', async () => {
  const tried: string[] = [];
  const result = await readImage('https://cdn.test/a.jpg', ENV, deps({
    post: async (_u, init) => {
      const model = (JSON.parse(init.body) as { model: string }).model;
      tried.push(model);
      if (tried.length === 1) return { ok: false, status: 429, body: '' };
      return { ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: 'SALE' } }] }) };
    },
  }));

  assert.equal(result.ok, true);
  assert.equal(tried.length, 2);
  assert.equal(result.reading?.model, tried[1], 'the model that actually answered is the one recorded');
  assert.notEqual(result.reading?.model, VISION_MODELS[0]);
});

/*
 * A 200 carrying an error object is normal here: the gateway accepted the
 * request and the upstream provider refused it. Treating that as success would
 * store an empty reading as though a model had answered.
 */
test('a 200 that carries a provider error is a failure, and fails over', async () => {
  let calls = 0;
  const result = await readImage('https://cdn.test/a.jpg', ENV, deps({
    post: async () => {
      calls++;
      if (calls === 1) {
        return { ok: true, status: 200, body: JSON.stringify({ error: { code: 429, message: 'rate-limited upstream' } }) };
      }
      return { ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: 'BUY NOW' } }] }) };
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.reading?.text, 'BUY NOW');
  assert.equal(calls, 2);
});

test('when every model refuses, the error names each one that was tried', async () => {
  const result = await readImage('https://cdn.test/a.jpg', ENV, deps({
    post: async () => ({ ok: false, status: 429, body: '', error: 'too many requests' }),
  }));
  assert.equal(result.ok, false);
  for (const model of VISION_MODELS) {
    assert.match(result.error ?? '', new RegExp(model.replace(/[/:.]/g, '\\$&')));
  }
});

/* A 400 is our mistake. Retrying it just burns the list. */
test('a bad request stops immediately rather than trying every model', async () => {
  let calls = 0;
  const result = await readImage('https://cdn.test/a.jpg', ENV, deps({
    post: async () => { calls++; return { ok: false, status: 400, body: '', error: 'malformed image' }; },
  }));
  assert.equal(result.ok, false);
  assert.equal(calls, 1, 'our own mistake does not improve on the next model');
});

test('an explicit model is used alone, with no fallback', async () => {
  const tried: string[] = [];
  await readImage('https://cdn.test/a.jpg', ENV, deps({
    model: 'some/specific-model',
    post: async (_u, init) => {
      tried.push((JSON.parse(init.body) as { model: string }).model);
      return { ok: false, status: 429, body: '' };
    },
  }));
  assert.deepEqual(tried, ['some/specific-model']);
});

test('every model in the chain is a free one', () => {
  for (const model of VISION_MODELS) assert.match(model, /:free$/);
});

/*
 * MEASURED LIVE 2026-08-22 on a product photograph carrying no text. The
 * transcription prompt ends "if there is no text, reply with nothing", and the
 * model replied with exactly that word, which became a seven character reading
 * printed under the image as though it were content.
 */
test('a model that answers "nothing" produced no reading, not a reading of the word', async () => {
  for (const answer of ['Nothing', 'nothing.', 'NONE', 'No text', 'n/a', 'there is no text']) {
    const result = await readImage('https://cdn.test/a.jpg', ENV, deps({
      post: async () => ({
        ok: true, status: 200,
        body: JSON.stringify({ choices: [{ message: { content: answer } }] }),
      }),
    }));
    assert.equal(result.ok, false, `${JSON.stringify(answer)} was treated as a transcription`);
    assert.equal(result.reading, undefined);
  }
});

test('a real transcription that merely contains the word nothing still lands', async () => {
  const result = await readImage('https://cdn.test/a.jpg', ENV, deps({
    post: async () => ({
      ok: true, status: 200,
      body: JSON.stringify({ choices: [{ message: { content: 'NOTHING BEATS A WOOL RUNNER' } }] }),
    }),
  }));
  assert.equal(result.ok, true);
  assert.equal(result.reading?.text, 'NOTHING BEATS A WOOL RUNNER');
});
