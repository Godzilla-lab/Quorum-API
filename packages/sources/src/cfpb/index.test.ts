/*
 * CFPB complaints, against a captured response: 25 narratives for "Chime
 * account closed", taken unedited from the public search API on 2026-09-13
 * with no key. The page carries no raw control characters; the scrub is
 * exercised by injecting one, because the day it matters is the day a
 * consumer pastes one into a narrative.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cleanNarrative, createCfpbSource, receivedAt, scrubControlCharacters } from './index.ts';
import { runSourceConformance } from '../conformance.ts';
import { createThrottle } from '../throttle.ts';
import type { Ctx, SourceRecord } from '../source.ts';

const dir = fileURLToPath(new URL('.', import.meta.url));
const SEARCH = readFileSync(join(dir, 'fixtures/search.json'), 'utf8');

const ctx = (over: Partial<Ctx> = {}): Ctx => ({
  env: {},
  cost: { charge: () => 0, canSpend: () => true },
  ...over,
});
const throttle = () => createThrottle({ minGapMs: 0, sleep: async () => {} });

function routed(body = SEARCH, status = 200) {
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(url);
    return status === 200
      ? { ok: true as const, status: 200, body, headers: {} }
      : { ok: false as const, status, body, error: `status ${status}`, headers: {} };
  }) as never;
  return { fetch, calls };
}

const PLAN = {
  category: 'Chime',
  productTitle: 'Chime',
  productUrl: '',
  terms: ['account closed'],
};

runSourceConformance('cfpb', () => ({
  source: createCfpbSource({ fetch: routed().fetch, throttle: throttle() }),
  configuredEnv: {},
  planInput: PLAN,
}));

async function run(source = createCfpbSource({ fetch: routed().fetch, throttle: throttle() }), plan = PLAN): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for (const q of await source.plan(plan)) for await (const r of source.retrieve(q, ctx())) out.push(r);
  return out;
}

test('every query carries the subject, and the request asks for narratives only', async () => {
  const { fetch, calls } = routed();
  const source = createCfpbSource({ fetch, throttle: throttle() });
  const queries = await source.plan({ ...PLAN, terms: ['fees', 'support'] });
  assert.deepEqual(queries.map((q) => q.text), ['Chime fees', 'Chime support']);
  for await (const _ of source.retrieve(queries[0]!, ctx())) { /* drain */ }
  const url = new URL(calls[0]!);
  assert.equal(url.pathname.endsWith('/api/v1/'), true, 'the trailing slash is load bearing');
  assert.equal(url.searchParams.get('has_narrative'), 'true');
  assert.equal(url.searchParams.get('no_aggs'), 'true');
  assert.equal(url.searchParams.get('field'), 'complaint_what_happened');
  assert.equal(url.searchParams.get('format'), null, 'format=json is a 404 on this API');
});

test('records are the consumer speaking, dated exactly, with a permalink to the complaint', async () => {
  const records = await run();
  assert.ok(records.length >= 15, `only ${records.length} of 25 narratives survived the gate`);
  for (const r of records) {
    assert.equal(r.source, 'cfpb');
    assert.equal(r.kind, 'post');
    assert.match(r.url ?? '', /^https:\/\/www\.consumerfinance\.gov\/data-research\/consumer-complaints\/search\/detail\/\d+$/);
    assert.ok((r.createdUtc ?? 0) > 1_600_000_000, `date missing or implausible: ${r.createdUtc}`);
    assert.equal(r.score, 0, 'the Bureau counts nothing');
    assert.match(r.channel ?? '', /Chime/, 'the channel is the company the complaint went to');
    assert.doesNotMatch(r.text, /\{\$/, 'money markup is unwrapped');
    assert.ok(r.text.length >= 40);
  }
  assert.ok(new Set(records.map((r) => r.createdUtc)).size > 1, 'dates are per complaint');
  assert.ok(new Set(records.map((r) => r.externalId)).size === records.length, 'ids are per complaint');
});

test('a raw control character inside a narrative does not cost the page', async () => {
  /* Inject just inside the first narrative string, whatever the page's spacing. */
  const key = SEARCH.indexOf('"complaint_what_happened"');
  const open = SEARCH.indexOf('"', SEARCH.indexOf(':', key) + 1) + 1;
  const broken = SEARCH.slice(0, open) + String.fromCodePoint(7) + SEARCH.slice(open);
  assert.throws(() => JSON.parse(broken), 'the injected byte really is invalid json');
  const source = createCfpbSource({ fetch: routed(broken).fetch, throttle: throttle() });
  const records = await run(source);
  assert.ok(records.length >= 15, `the scrub should have saved the page, got ${records.length}`);
  assert.equal(scrubControlCharacters('a\tb'), 'a b');
});

test('an off topic subject is gated, not stored', async () => {
  const records = await run(undefined, { category: 'running shoes', productTitle: 'running shoes', productUrl: '', terms: ['sizing'] });
  assert.equal(records.length, 0, 'bank complaints are not evidence about shoes');
});

test('a source that is down logs and yields nothing, and a non json body does the same', async () => {
  for (const [body, status, pattern] of [['', 500, /status 500|gave up/], ['<html>', 200, /not a json object/]] as const) {
    const source = createCfpbSource({ fetch: routed(body, status).fetch, throttle: throttle() });
    const logged: string[] = [];
    const out: SourceRecord[] = [];
    for (const q of await source.plan(PLAN)) {
      for await (const r of source.retrieve(q, ctx({ log: (l) => logged.push(l) }))) out.push(r);
    }
    assert.equal(out.length, 0);
    assert.match(logged.join(' '), pattern);
  }
});

test('withinDays becomes a date floor on the request', async () => {
  const { fetch, calls } = routed();
  const source = createCfpbSource({ fetch, throttle: throttle() });
  await source.plan(PLAN);
  for await (const _ of source.retrieve({ text: 'Chime fees', withinDays: 30 }, ctx())) { /* drain */ }
  const floor = new URL(calls[0]!).searchParams.get('date_received_min');
  assert.match(floor ?? '', /^\d{4}-\d{2}-\d{2}$/);
});

test('narratives are cleaned without touching the redactions', () => {
  assert.equal(cleanNarrative('Chime kept my {$600.00} on XX/XX/XXXX.\n\n  I called  twice.'), 'Chime kept my $600.00 on XX/XX/XXXX. I called twice.');
  assert.equal(receivedAt('2024-12-29T09:43:01.000Z'), 1_735_465_381);
  assert.equal(receivedAt('yesterday'), null);
  assert.equal(receivedAt(null), null);
});
