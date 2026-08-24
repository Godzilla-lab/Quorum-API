/*
 * The remote MCP endpoint, over a real listening server.
 *
 * Same discipline as http.test.ts: no mocked transport. The protocol logic
 * itself is tested in packages/mcp; what this file proves is the HTTP shell:
 * the endpoint answers keyless on a keyed instance, notifications get a
 * bodiless 202, batches mirror their shape, and the tools read the same
 * corpus the /v1 routes serve.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openSqliteCorpus } from '@quorum/corpus';
import { createReceiptsServer, hashKey } from './http.ts';
import { createQuotas } from './quotas.ts';

async function live() {
  const corpus = openSqliteCorpus({ path: ':memory:' });
  await corpus.addDocs([
    { source: 'reddit', kind: 'comment', externalId: 'm1', channel: 'r/running', text: 'the sizing on these runs narrow, order half a size up', score: 5, url: 'https://e.test/m1', createdUtc: 1_700_000_000 },
    { source: 'reddit', kind: 'comment', externalId: 'm2', channel: 'r/shoes', text: 'sizing was fine for me but the toe box is tight', score: 3, url: 'https://e.test/m2', createdUtc: 1_700_000_100 },
    { source: 'hackernews', kind: 'comment', externalId: 'm3', channel: 'Ask HN', text: 'sizing is the whole problem with buying shoes online', score: 0, url: 'https://e.test/m3', createdUtc: 1_700_000_200 },
  ], 'shoes');
  const ids = (await corpus.byCategory('shoes')).map((r) => r.receiptId);

  const server = createReceiptsServer({
    corpus,
    quotas: createQuotas(),
    /* Keyed on purpose: the whole point under test is the /mcp carve out. */
    keyHashes: new Map([[hashKey('secret-key'), 'key-1']]),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  const rpc = (message: unknown) => fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });

  return {
    base: `http://127.0.0.1:${port}`, ids, rpc,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await corpus.close();
    },
  };
}

test('initialize answers keyless on a keyed instance, and /v1 still does not', async () => {
  const s = await live();
  try {
    const res = await s.rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(res.status, 200);
    const body = await res.json() as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: unknown } };
    assert.equal(body.result.protocolVersion, '2025-06-18');
    assert.equal(body.result.serverInfo.name, 'quorum');
    assert.deepEqual(body.result.capabilities, { tools: {} }, 'tools only, stated honestly');

    const keyed = await fetch(`${s.base}/v1/evidence/search`, { method: 'POST', body: '{}' });
    assert.equal(keyed.status, 401, 'the carve out is /mcp alone, not the door');
  } finally { await s.close(); }
});

test('a notification gets a bodiless 202', async () => {
  const s = await live();
  try {
    const res = await s.rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), '', 'the spec wants no body, not a null');
  } finally { await s.close(); }
});

test('tools/list names the four read only tools and never the research tool', async () => {
  const s = await live();
  try {
    const res = await s.rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const body = await res.json() as { result: { tools: { name: string }[] } };
    const names = body.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['category_warmth', 'compare_formats', 'get_receipt', 'search_evidence']);
  } finally { await s.close(); }
});

test('search_evidence answers from the same corpus /v1 serves, receipts included', async () => {
  const s = await live();
  try {
    const res = await s.rpc({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'search_evidence', arguments: { query: 'sizing', category: 'shoes' } },
    });
    const body = await res.json() as { result: { content: { type: string; text: string }[]; isError?: boolean } };
    assert.notEqual(body.result.isError, true);
    const text = body.result.content[0]!.text;
    assert.match(text, /3 independent records|3 records/);
    assert.match(text, new RegExp(s.ids[0]!), 'a quote travels with its receipt id');
  } finally { await s.close(); }
});

test('get_receipt resolves a real id and names a fabricated one loudly', async () => {
  const s = await live();
  try {
    const res = await s.rpc({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'get_receipt', arguments: { receiptIds: [s.ids[0], 'rc_deadbeefdeadbeef'] } },
    });
    const body = await res.json() as { result: { content: { text: string }[] } };
    const text = body.result.content[0]!.text;
    assert.match(text, /1 of 2 ids did not resolve/);
    assert.match(text, /order half a size up/);
  } finally { await s.close(); }
});

test('a 2025-03-26 batch is answered as a batch, notifications elided', async () => {
  const s = await live();
  try {
    const res = await s.rpc([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 5, method: 'ping' },
      { jsonrpc: '2.0', id: 6, method: 'tools/list' },
    ]);
    assert.equal(res.status, 200);
    const body = await res.json() as { id: number }[];
    assert.ok(Array.isArray(body));
    assert.deepEqual(body.map((r) => r.id), [5, 6]);
  } finally { await s.close(); }
});

test('an unknown method is a JSON-RPC error, not an HTTP one', async () => {
  const s = await live();
  try {
    const res = await s.rpc({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
    assert.equal(res.status, 200, 'the transport worked; the protocol says what failed');
    const body = await res.json() as { error: { code: number } };
    assert.equal(body.error.code, -32601);
  } finally { await s.close(); }
});

test('GET /mcp is 405 with the allowed verb named', async () => {
  const s = await live();
  try {
    const res = await fetch(`${s.base}/mcp`);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  } finally { await s.close(); }
});
