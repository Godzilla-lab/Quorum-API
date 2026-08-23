/*
 * The protocol, without a process or a pipe.
 *
 * `handleMessage` is split out from the transport precisely so this file can
 * exercise the whole of MCP as pure functions. The cases that matter are the
 * ones a client will actually do to us and that are easy to get wrong: a
 * notification that must not be answered, an unknown tool, and a tool that
 * throws.
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  PROTOCOL_VERSION, handleMessage, serveStdio, type ToolDefinition,
} from './protocol.ts';

const INFO = { name: 'quorum', version: '0.0.0' };

const tool = (over: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name: 'echo',
  description: 'echoes',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  run: async (args) => `you said ${String(args['text'])}`,
  ...over,
});

const call = (message: unknown, tools: ToolDefinition[] = [tool()]) =>
  handleMessage(message, tools, INFO);

/* ------------------------------------------------------------------ */
/* the handshake                                                       */
/* ------------------------------------------------------------------ */

test('initialize answers in the client version when we know it', async () => {
  const res = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  const result = res?.['result'] as Record<string, unknown>;
  assert.equal(result['protocolVersion'], '2024-11-05');
  assert.deepEqual(result['serverInfo'], INFO);
});

test('AN UNKNOWN PROTOCOL VERSION GETS OURS, NOT AN ECHO', async () => {
  /* Echoing a version we have never seen claims to speak it. Naming ours lets
   * the client decide whether to continue. */
  const res = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal((res?.['result'] as Record<string, unknown>)['protocolVersion'], PROTOCOL_VERSION);
});

test('WE ADVERTISE ONLY WHAT WE IMPLEMENT', async () => {
  /* A server claiming resources or prompts it does not have is worse than one
   * claiming fewer, because a client will call them. */
  const res = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const caps = (res?.['result'] as Record<string, unknown>)['capabilities'];
  assert.deepEqual(caps, { tools: {} });
});

test('A NOTIFICATION IS NEVER ANSWERED', async () => {
  /* It has no id, and replying puts an unexpected message on the wire that
   * some clients treat as a protocol violation. */
  assert.equal(await call({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await call({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }), null);
  assert.equal(await call({ jsonrpc: '2.0', method: 'who/knows' }), null, 'unknown, and still a notification');
});

test('a request with an id always gets one back, including on failure', async () => {
  const res = await call({ jsonrpc: '2.0', id: 7, method: 'who/knows' });
  assert.equal(res?.['id'], 7);
  assert.match(String((res?.['error'] as Record<string, unknown>)['message']), /unknown method/);
});

test('a malformed envelope is refused rather than guessed at', async () => {
  assert.ok((await call({ id: 1, method: 'initialize' }))?.['error'], 'no jsonrpc field');
  assert.ok((await call('not an object'))?.['error']);
  assert.ok((await call(null))?.['error']);
});

/* ------------------------------------------------------------------ */
/* tools                                                               */
/* ------------------------------------------------------------------ */

test('tools/list returns the schema and nothing executable', async () => {
  const res = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tools = (res?.['result'] as { tools: Record<string, unknown>[] }).tools;
  assert.equal(tools.length, 1);
  assert.deepEqual(Object.keys(tools[0]!).sort(), ['description', 'inputSchema', 'name']);
  assert.equal('run' in tools[0]!, false, 'the function must not be serialised');
});

test('tools/call runs the tool and returns text content', async () => {
  const res = await call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } });
  assert.deepEqual(res?.['result'], { content: [{ type: 'text', text: 'you said hi' }] });
});

test('A TOOL THAT THROWS IS A RESULT WITH isError, NOT A PROTOCOL ERROR', async () => {
  /*
   * The difference decides whether the model can recover. A JSON-RPC error
   * tells the CLIENT the server is broken and the model never sees why; an
   * isError result hands it the reason so it can correct the call.
   */
  const res = await call(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'boom', arguments: {} } },
    [tool({ name: 'boom', run: async () => { throw new Error('the corpus is locked'); } })],
  );
  assert.equal(res?.['error'], undefined);
  const result = res?.['result'] as { isError: boolean; content: { text: string }[] };
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /the corpus is locked/);
});

test('an unknown tool is a method-not-found, because the call was never valid', async () => {
  const res = await call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } });
  assert.match(String((res?.['error'] as Record<string, unknown>)['message']), /no tool named/);
});

test('missing arguments become an empty object rather than a crash', async () => {
  const res = await call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } });
  assert.match((res?.['result'] as { content: { text: string }[] }).content[0]!.text, /undefined/);
});

/* ------------------------------------------------------------------ */
/* the transport                                                       */
/* ------------------------------------------------------------------ */

async function speak(lines: string[], tools: ToolDefinition[] = [tool()]): Promise<string[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
  const done = serveStdio(tools, INFO, { input, output });
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  await done;
  return chunks.join('').split('\n').filter((l) => l.trim());
}

test('the transport speaks newline delimited json and answers in order', async () => {
  const out = await speak([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  ]);
  /* Three messages in, TWO out: the notification is not answered. */
  assert.equal(out.length, 2);
  assert.equal(JSON.parse(out[0]!).id, 1);
  assert.equal(JSON.parse(out[1]!).id, 2);
});

test('BAD JSON DOES NOT KILL THE STREAM', async () => {
  /* A client that writes one broken line must not lose the session. */
  const out = await speak([
    '{ not json',
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
  ]);
  assert.equal(out.length, 2);
  assert.equal(JSON.parse(out[0]!).error.code, -32700);
  assert.deepEqual(JSON.parse(out[1]!).result, {});
});

test('blank lines are ignored rather than answered', async () => {
  const out = await speak(['', '   ', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })]);
  assert.equal(out.length, 1);
});

test('SLOW TOOLS DO NOT INTERLEAVE THEIR REPLIES', async () => {
  /*
   * Answering out of order is legal JSON-RPC, but two handlers writing to one
   * pipe concurrently can interleave partial writes. The first tool here is
   * deliberately slower than the second.
   */
  const slow = tool({
    name: 'slow',
    run: async () => { await new Promise((r) => setTimeout(r, 20)); return 'slow'; },
  });
  const out = await speak([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' } } }),
  ], [slow, tool()]);

  assert.equal(out.length, 2);
  assert.equal(JSON.parse(out[0]!).id, 1, 'the slow one still answered first');
  assert.equal(JSON.parse(out[1]!).id, 2);
});
