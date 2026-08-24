/*
 * The monitor routes, over a real listening server.
 *
 * The scheduler itself lives in bin.ts, the wiring file, and is exercised
 * through the pieces it composes: dueMonitors and markMonitorFired are
 * conformance tested in the corpus package, and submission goes through the
 * same queue the report tests cover. What this file proves is the HTTP
 * contract: validation, the per key cap, and that tenancy holds in every
 * direction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openSqliteCorpus } from '@quorum/corpus';
import { createReceiptsServer, hashKey } from './http.ts';
import { createQuotas } from './quotas.ts';

async function live() {
  const corpus = openSqliteCorpus({ path: ':memory:' });
  const server = createReceiptsServer({
    corpus,
    quotas: createQuotas(),
    keyHashes: new Map([[hashKey('key-one'), 'key-1'], [hashKey('key-two'), 'key-2']]),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const call = (method: string, path: string, key: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  return {
    call, corpus,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await corpus.close();
    },
  };
}

const GOOD = { subject: 'running shoes', terms: ['sizing'], webhookUrl: 'https://example.com/hook', intervalHours: 24 };

test('a monitor is created, listed and deleted by its own key alone', async () => {
  const s = await live();
  try {
    const created = await s.call('POST', '/v1/monitors', 'key-one', GOOD);
    assert.equal(created.status, 201);
    const body = await created.json() as { id: string; intervalHours: number };
    assert.match(body.id, /^mon_[0-9a-f]{16}$/);
    assert.equal(body.intervalHours, 24);

    const mine = await (await s.call('GET', '/v1/monitors', 'key-one')).json() as { monitors: { id: string; lastFiredAt: null }[] };
    assert.equal(mine.monitors.length, 1);
    assert.equal(mine.monitors[0]?.lastFiredAt, null, 'null before the first fire, not a fake epoch');

    const theirs = await (await s.call('GET', '/v1/monitors', 'key-two')).json() as { monitors: unknown[] };
    assert.deepEqual(theirs.monitors, [], 'another key sees nothing');

    const wrongKey = await s.call('DELETE', `/v1/monitors/${body.id}`, 'key-two');
    assert.equal(wrongKey.status, 404, 'another key cannot delete it, and learns nothing from the refusal');

    const removed = await s.call('DELETE', `/v1/monitors/${body.id}`, 'key-one');
    assert.equal(removed.status, 200);
  } finally { await s.close(); }
});

test('a monitor without a webhook is refused, because nobody would hear it', async () => {
  const s = await live();
  try {
    const res = await s.call('POST', '/v1/monitors', 'key-one', { subject: 'shoes' });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: { message: string } };
    assert.match(body.error.message, /webhookUrl is required/);
  } finally { await s.close(); }
});

test('an http webhook and a silly interval are both refused with reasons', async () => {
  const s = await live();
  try {
    const insecure = await s.call('POST', '/v1/monitors', 'key-one', { ...GOOD, webhookUrl: 'http://example.com/hook' });
    assert.equal(insecure.status, 400);
    assert.match((await insecure.json() as { error: { message: string } }).error.message, /https/);

    const tooOften = await s.call('POST', '/v1/monitors', 'key-one', { ...GOOD, intervalHours: 1 });
    assert.equal(tooOften.status, 400);
    assert.match((await tooOften.json() as { error: { message: string } }).error.message, /between 6 and 720/);
  } finally { await s.close(); }
});

test('the sixth monitor is refused and the refusal says what to do', async () => {
  const s = await live();
  try {
    for (let i = 0; i < 5; i++) {
      const res = await s.call('POST', '/v1/monitors', 'key-one', { ...GOOD, subject: `subject ${i}` });
      assert.equal(res.status, 201);
    }
    const sixth = await s.call('POST', '/v1/monitors', 'key-one', { ...GOOD, subject: 'one too many' });
    assert.equal(sixth.status, 400);
    assert.match((await sixth.json() as { error: { message: string } }).error.message, /at most 5 monitors/);

    /* The cap is per key, not per instance. */
    const other = await s.call('POST', '/v1/monitors', 'key-two', GOOD);
    assert.equal(other.status, 201);
  } finally { await s.close(); }
});

test('monitors require a key on a keyed instance, like every /v1 surface', async () => {
  const s = await live();
  try {
    const bare = await s.call('GET', '/v1/monitors', 'not-a-real-key');
    assert.equal(bare.status, 401);
  } finally { await s.close(); }
});
