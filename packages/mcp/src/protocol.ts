/*
 * The Model Context Protocol, over stdio, by hand.
 *
 * WHY NOT THE OFFICIAL SDK. Adding a dependency is on the ask first list, and
 * this package would be the first runtime dependency in a repo whose zero is a
 * deliberate property: every dependency in a tool that fetches untrusted text
 * from the internet is another thing that can reach the network on your behalf.
 *
 * The protocol does not justify one. Over stdio it is newline delimited
 * JSON-RPC 2.0, and a server needs exactly three methods: `initialize`,
 * `tools/list` and `tools/call`. That is this file. The same call `pg-wire.ts`
 * made about the PostgreSQL wire protocol, for the same reason.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: resources, prompts, sampling, roots,
 * progress notifications, or the HTTP transport. A server that advertises
 * capabilities it does not implement is worse than one that advertises fewer,
 * because a client will call them.
 */

import { createInterface } from 'node:readline';

/*
 * The version this server speaks. A client asks for one in `initialize` and
 * the spec says to answer with a version we support: if theirs is unknown we
 * name ours and let the client decide whether to continue, rather than
 * pretending to speak a protocol we have never seen.
 */
export const PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_VERSIONS = new Set([PROTOCOL_VERSION, '2025-03-26', '2024-11-05']);

/* JSON-RPC 2.0 error codes. The negative ones are the standard's. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export interface ToolDefinition {
  name: string;
  /* One line. It is read by a model deciding whether to call this, so it says
   * what the tool answers rather than how it works. */
  description: string;
  inputSchema: Record<string, unknown>;
  /*
   * Returns markdown. Not JSON: measured at roughly 60% of the tokens for the
   * same content, and token cost is the dominant cost in an agent loop.
   *
   * A tool that fails returns text explaining why rather than throwing. An
   * exception becomes a protocol error, which the model cannot read and cannot
   * act on; a sentence saying "that category holds nothing" is something it can.
   */
  run(args: Record<string, unknown>): Promise<string>;
}

interface Request {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface ServerInfo {
  name: string;
  version: string;
  /*
   * Optional. Sent as the spec's `instructions` field on initialize, which
   * clients surface as the server's description. One or two sentences a model
   * or a person reads before deciding whether to use these tools.
   */
  instructions?: string;
}

const ok = (id: string | number | null, result: unknown) => ({ jsonrpc: '2.0', id, result });
const fail = (id: string | number | null, code: number, message: string) =>
  ({ jsonrpc: '2.0', id, error: { code, message } });

/*
 * Handle one decoded message and return what to send back, or null when
 * nothing should be sent.
 *
 * Split out from the transport so the whole protocol is testable without
 * spawning a process or touching a pipe, which is what makes the tests in
 * `protocol.test.ts` fast and deterministic.
 */
export async function handleMessage(
  message: unknown,
  tools: readonly ToolDefinition[],
  info: ServerInfo,
): Promise<Record<string, unknown> | null> {
  if (typeof message !== 'object' || message === null) {
    return fail(null, INVALID_REQUEST, 'a request must be an object');
  }
  const req = message as Request;
  const id = req.id ?? null;

  /*
   * A notification has no id and MUST NOT be answered. `notifications/
   * initialized` is the common one, and replying to it puts an unexpected
   * message on the wire that some clients treat as a protocol violation.
   */
  const isNotification = req.id === undefined;

  if (req.jsonrpc !== '2.0') {
    return isNotification ? null : fail(id, INVALID_REQUEST, 'jsonrpc must be "2.0"');
  }

  switch (req.method) {
    case 'initialize': {
      const asked = typeof req.params?.['protocolVersion'] === 'string'
        ? req.params['protocolVersion'] as string
        : PROTOCOL_VERSION;
      return ok(id, {
        /* Answer in their version when we know it, ours when we do not. */
        protocolVersion: SUPPORTED_VERSIONS.has(asked) ? asked : PROTOCOL_VERSION,
        /* Tools only, stated honestly. See the header. */
        capabilities: { tools: {} },
        serverInfo: { name: info.name, version: info.version },
        ...(info.instructions ? { instructions: info.instructions } : {}),
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const name = req.params?.['name'];
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        return fail(id, METHOD_NOT_FOUND, `no tool named ${JSON.stringify(name)}`);
      }
      const args = (req.params?.['arguments'] ?? {}) as Record<string, unknown>;
      try {
        const text = await tool.run(args);
        return ok(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        /*
         * A TOOL FAILURE IS A RESULT, NOT A PROTOCOL ERROR. `isError` tells the
         * model its call failed and hands it the reason, so it can correct
         * itself. A JSON-RPC error tells the client the server is broken, and
         * the model never sees the reason at all.
         */
        const reason = err instanceof Error ? err.message : String(err);
        return ok(id, { content: [{ type: 'text', text: `That call failed: ${reason}` }], isError: true });
      }
    }

    default:
      return isNotification ? null : fail(id, METHOD_NOT_FOUND, `unknown method ${JSON.stringify(req.method)}`);
  }
}

/*
 * Read newline delimited JSON from a stream, answer on another.
 *
 * STDOUT IS THE WIRE AND NOTHING ELSE MAY WRITE TO IT. One stray console.log
 * anywhere in the process corrupts the stream and the client disconnects with
 * a parse error that names this file rather than the line that printed. Every
 * diagnostic goes to stderr.
 */
export function serveStdio(
  tools: readonly ToolDefinition[],
  info: ServerInfo,
  streams: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Promise<void> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  const lines = createInterface({ input, crlfDelay: Infinity });

  return new Promise((resolve) => {
    /*
     * Serialised. Requests arrive faster than a report finishes, and answering
     * out of order is legal in JSON-RPC but interleaves partial writes on one
     * pipe. One at a time costs nothing here and removes the whole class.
     */
    let queue: Promise<void> = Promise.resolve();

    lines.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      queue = queue.then(async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          output.write(`${JSON.stringify(fail(null, PARSE_ERROR, 'invalid json'))}\n`);
          return;
        }
        let response: Record<string, unknown> | null;
        try {
          response = await handleMessage(parsed, tools, info);
        } catch (err) {
          /* The dispatcher itself failing is the only real protocol error. */
          const reason = err instanceof Error ? err.message : String(err);
          response = fail(null, INTERNAL_ERROR, reason);
        }
        if (response) output.write(`${JSON.stringify(response)}\n`);
      });
    });

    lines.on('close', () => { void queue.then(resolve); });
  });
}
