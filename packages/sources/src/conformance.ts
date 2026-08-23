/*
 * The Source conformance suite.
 *
 * Every adapter runs through this. The rules it enforces are not style
 * preferences: each one is a property the pipeline relies on, and an adapter
 * that breaks one degrades or breaks every report that uses it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Ctx, Env, Source } from './source.ts';

/* A cost meter that records rather than charging, so a suite can assert on it. */
export function fakeCostMeter(budgetUsd = Infinity) {
  const charges: { key: string; count: number }[] = [];
  return {
    charges,
    charge(key: string, count = 1): number { charges.push({ key, count }); return 0; },
    canSpend(estimateUsd: number): boolean { return estimateUsd <= budgetUsd; },
  };
}

export function makeCtx(over: Partial<Ctx> = {}): Ctx {
  return { env: {}, cost: fakeCostMeter(), ...over };
}

export interface ConformanceCase {
  source: Source;
  /* An env in which the adapter should report itself configured. */
  configuredEnv: Env;
  /* A plan input that should produce at least one query. */
  planInput: Parameters<Source['plan']>[0];
}

export function runSourceConformance(name: string, makeCase: () => ConformanceCase): void {
  test(`${name}: reports whether it is configured without throwing`, () => {
    const { source, configuredEnv } = makeCase();
    /*
     * The empty env is the important one. A fresh clone with no keys must still
     * produce a report, so every adapter has to answer this question rather
     * than blowing up on a missing variable.
     */
    assert.doesNotThrow(() => source.configured({}));
    assert.doesNotThrow(() => source.configured({ SOMETHING_IRRELEVANT: 'x' }));
    assert.equal(typeof source.configured({}), 'boolean');
    assert.equal(source.configured(configuredEnv), true, 'it must recognise its own configuration');
  });

  test(`${name}: declares a cost class`, () => {
    const { source } = makeCase();
    assert.ok(source.cost === 'free' || source.cost === 'metered');
    assert.ok(source.id.length > 0);
  });

  test(`${name}: plans at least one query from a product`, async () => {
    const { source, planInput } = makeCase();
    const queries = await source.plan(planInput);
    assert.ok(Array.isArray(queries));
    assert.ok(queries.length > 0, 'a source that plans nothing can never retrieve anything');
    for (const q of queries) {
      assert.equal(typeof q.text, 'string');
      assert.ok(q.text.length > 0);
    }
  });

  /*
   * The load bearing rule. An unconfigured source returns empty; it does not
   * throw, and it does not reach the network to find out. A missing key
   * degrades a run and never fails it.
   */
  test(`${name}: yields nothing when unconfigured, rather than throwing`, async () => {
    const { source, planInput } = makeCase();
    if (source.configured({})) return; // nothing to prove for a keyless source

    const queries = await source.plan(planInput);
    const first = queries[0];
    assert.ok(first);

    const out = [];
    for await (const record of source.retrieve(first, makeCtx({ env: {} }))) out.push(record);
    assert.deepEqual(out, [], 'an unconfigured source is silent, not fatal');
  });

  test(`${name}: renders a record as a citation`, async () => {
    const { source, planInput } = makeCase();
    const queries = await source.plan(planInput);
    void queries;

    const citation = source.cite({
      source: 'reddit', kind: 'comment', externalId: 'x',
      text: 'a thing somebody said', origin: 'somewhere',
      score: 4, url: 'https://example.com/thing', createdUtc: 1_700_000_000,
    });
    assert.equal(typeof citation.label, 'string');
    assert.ok(citation.label.length > 0, 'a receipt with no label cannot be shown to a reader');
    assert.equal(typeof citation.url, 'string');
    assert.equal(typeof citation.score, 'number');
    assert.equal(typeof citation.postedAt, 'number');
  });
}
