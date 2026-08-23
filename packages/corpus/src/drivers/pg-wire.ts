/*
 * A minimal PostgreSQL client, written to VERIFY the Postgres driver.
 *
 * WHY THIS EXISTS AT ALL, GIVEN THE NO DEPENDENCY RULE.
 *
 * The Postgres driver takes an injected executor precisely so this package can
 * ship with zero runtime dependencies. That decision left a hole: with no
 * client anywhere in the repo, the driver's SQL had never been executed by
 * anything, and its own header said so. Its logic was tested against a
 * recording fake, which proves the driver calls the SQL it means to call and
 * proves nothing whatsoever about whether that SQL is valid Postgres.
 *
 * Adding a client library to close that hole would put a dependency into a
 * package whose whole shape was chosen to avoid one. So the test harness speaks
 * the wire protocol itself. It is about 250 lines because the protocol is
 * simple, and it uses only `node:net` and `node:crypto`.
 *
 * THIS IS TEST INFRASTRUCTURE AND MUST NOT BE USED IN PRODUCTION.
 *
 * It is deliberately not exported from the package index. It has no connection
 * pool, no cancellation, no COPY, no reconnection, and it assumes one statement
 * in flight at a time. A hosted deployment uses a real client and passes it to
 * `openPostgresCorpus` unchanged, which is the entire point of the injected
 * executor.
 *
 * IT DOES NOW SPEAK TLS AND SCRAM-SHA-256, added 2026-08-23, and that is a
 * change of reach rather than of purpose. Verification was limited to a local
 * trust-authenticated server, so the driver had never met a HOSTED Postgres:
 * a different major version, a managed extension set, and a connection over
 * the public internet. Those are exactly the differences that break a
 * migration, and the whole reason this client exists is that a fake never
 * rejects invalid SQL. It still must not serve production traffic.
 *
 * TYPE CONVERSION MIMICS node-postgres ON PURPOSE.
 *
 * Returning everything as a string would be easier and would make this harness
 * lie. The driver has to cope with what a real client actually hands back, so
 * int8 arrives as a string here exactly as it does in production, and the
 * driver's `num()` is genuinely exercised rather than bypassed.
 */

import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SqlExecutor } from './postgres.ts';

export interface PgWireOptions {
  host?: string;
  port?: number;
  user: string;
  database: string;
  password?: string;
  /* Prepended to every statement. Used to isolate a test run in its own schema. */
  searchPath?: string;
  /*
   * Negotiate TLS before the startup packet. Required by every hosted provider
   * and off by default, because the local server this was written against does
   * not offer it and a failed negotiation is a worse error than not asking.
   */
  ssl?: boolean;
}

/*
 * A PostgreSQL connection URI, as a hosted provider hands it to you.
 *
 * Parsed here rather than by the caller so a connection string never has to be
 * split up by hand, which is how a password containing a `@` or a `/` ends up
 * silently truncated.
 */
export function parsePgUri(uri: string): PgWireOptions {
  const url = new URL(uri);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`not a postgres uri: ${url.protocol}`);
  }
  const sslmode = url.searchParams.get('sslmode');
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, '') || 'postgres',
    /* `disable` is the only mode that means no. Everything else, including the
     * `require` a hosted provider hands you, means negotiate. */
    ssl: sslmode !== null && sslmode !== 'disable',
  };
}

/* Postgres type OIDs we convert. Everything else stays text, which is what a
 * real client does with a type it has no parser for. */
const OID = {
  BOOL: 16, INT8: 20, INT2: 21, INT4: 23, OID: 26,
  JSON: 114, FLOAT4: 700, FLOAT8: 701, NUMERIC: 1700, JSONB: 3802,
} as const;

function decode(value: string | null, oid: number): unknown {
  if (value === null) return null;
  switch (oid) {
    case OID.BOOL: return value === 't';
    case OID.INT2: case OID.INT4: case OID.OID:
    case OID.FLOAT4: case OID.FLOAT8:
      return Number(value);
    /*
     * INT8 and NUMERIC stay strings, because that is what node-postgres does
     * and changing it here would hide the exact bug the driver's `num()` helper
     * exists to prevent.
     */
    case OID.INT8: case OID.NUMERIC: return value;
    case OID.JSON: case OID.JSONB:
      try { return JSON.parse(value); } catch { return value; }
    default: return value;
  }
}

/*
 * A JS array becomes a Postgres array literal, not JSON. The driver passes an
 * array in exactly one place, `receipt_id = ANY($1)`, and JSON there would be a
 * type error rather than a wrong answer, so this is unambiguous. Values that
 * are already JSON reach us as strings and pass through untouched.
 */
function encodeParam(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (Array.isArray(value)) {
    const items = value.map((v) => {
      if (v === null || v === undefined) return 'NULL';
      return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    });
    return `{${items.join(',')}}`;
  }
  return JSON.stringify(value);
}

interface Field { name: string; oid: number }

class Reader {
  /* Written out longhand rather than as constructor parameter properties,
   * because node strips types rather than compiling them and `erasableSyntaxOnly`
   * rejects any syntax that would need emitting. */
  private buf: Buffer;
  private at: number;
  constructor(buf: Buffer, at = 0) { this.buf = buf; this.at = at; }
  int32(): number { const v = this.buf.readInt32BE(this.at); this.at += 4; return v; }
  int16(): number { const v = this.buf.readInt16BE(this.at); this.at += 2; return v; }
  byte(): number { return this.buf[this.at++] ?? 0; }
  cstring(): string {
    const end = this.buf.indexOf(0, this.at);
    const s = this.buf.subarray(this.at, end).toString('utf8');
    this.at = end + 1;
    return s;
  }
  bytes(n: number): Buffer { const b = this.buf.subarray(this.at, this.at + n); this.at += n; return b; }
  get remaining(): number { return this.buf.length - this.at; }
}

class Writer {
  private chunks: Buffer[] = [];
  int32(v: number): this { const b = Buffer.alloc(4); b.writeInt32BE(v); this.chunks.push(b); return this; }
  int16(v: number): this { const b = Buffer.alloc(2); b.writeInt16BE(v); this.chunks.push(b); return this; }
  cstring(s: string): this { this.chunks.push(Buffer.from(s, 'utf8'), Buffer.from([0])); return this; }
  byte(s: string): this { this.chunks.push(Buffer.from(s, 'latin1')); return this; }
  raw(b: Buffer): this { this.chunks.push(b); return this; }
  /* Frames the payload with its type byte and length, which every client
   * message except the startup packet carries. */
  frame(type: string): Buffer {
    const body = Buffer.concat(this.chunks);
    const head = Buffer.alloc(5);
    head.write(type, 0, 'latin1');
    head.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([head, body]);
  }
  startup(): Buffer {
    const body = Buffer.concat(this.chunks);
    const head = Buffer.alloc(4);
    head.writeInt32BE(body.length + 4);
    return Buffer.concat([head, body]);
  }
}

export interface PgWireClient extends SqlExecutor {
  /* Multi statement SQL through the simple query protocol, for migration files. */
  exec(sql: string): Promise<void>;
  end(): Promise<void>;
}

/*
 * SCRAM-SHA-256, RFC 5802 and RFC 7677.
 *
 * Every hosted provider requires it, and Postgres has defaulted to it since 14,
 * so md5 is now the legacy path rather than the normal one. It is here because
 * the alternative was a dependency in a package whose whole shape exists to
 * avoid one, and because the arithmetic is four HMACs and a PBKDF2, all of
 * which are in `node:crypto`.
 *
 * WITHOUT CHANNEL BINDING, deliberately. `SCRAM-SHA-256-PLUS` binds the
 * exchange to the TLS channel and defends against an attacker who already
 * holds a valid certificate for the server. This client verifies the
 * certificate chain, which closes that door first, and channel binding would
 * add a tls-server-end-point hash for a threat that is out of scope for test
 * infrastructure. The `n,,` prefix below says "I do not support it", which is
 * the honest declaration rather than the `y,,` that claims a downgrade.
 */
export function scramFirstMessage(nonce: string, username = ''): { message: string; bare: string } {
  /*
   * The username is EMPTY for PostgreSQL, which is not an omission. RFC 5802
   * carries it in `n=`, and Postgres ignores that field because the startup
   * packet already named the user; sending it twice invites the two to
   * disagree. It stays a parameter so the RFC 7677 vectors, which do populate
   * it, can be asserted against rather than against this file's own output.
   */
  const bare = `n=${username},r=${nonce}`;
  return { message: `n,,${bare}`, bare };
}

export function scramFinalMessage(
  password: string,
  clientNonce: string,
  clientFirstBare: string,
  serverFirst: string,
): { message: string; serverSignature: Buffer } {
  const fields = new Map(
    serverFirst.split(',').map((part) => [part.slice(0, 1), part.slice(2)] as const),
  );
  const serverNonce = fields.get('r') ?? '';
  const salt = Buffer.from(fields.get('s') ?? '', 'base64');
  const iterations = Number(fields.get('i') ?? 0);

  /* The server must extend OUR nonce, never replace it. A server that returns
   * an unrelated nonce is either broken or replaying somebody else's exchange,
   * and continuing would authenticate against it anyway. */
  if (!serverNonce.startsWith(clientNonce)) {
    throw new Error('scram: the server nonce does not extend the client nonce');
  }
  if (!iterations || !salt.length) throw new Error('scram: the server sent no salt or iteration count');

  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const hmac = (key: Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();

  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const withoutProof = `c=biws,r=${serverNonce}`;
  const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`;

  const clientSignature = hmac(storedKey, authMessage);
  const proof = Buffer.alloc(clientKey.length);
  for (let i = 0; i < clientKey.length; i++) proof[i] = clientKey[i]! ^ clientSignature[i]!;

  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
  const serverSignature = hmac(serverKey, authMessage);

  return { message: `${withoutProof},p=${proof.toString('base64')}`, serverSignature };
}

/*
 * Ask the server to speak TLS, then upgrade the socket.
 *
 * The SSLRequest packet is answered with a SINGLE BYTE and no frame, which is
 * the one message in the protocol that does not follow the type-and-length
 * shape the reader downstream assumes. It has to be read before that reader is
 * attached, or the first byte of the TLS handshake is eaten as a message type.
 */
async function negotiateTls(plain: Socket, host: string): Promise<Socket> {
  const request = Buffer.alloc(8);
  request.writeInt32BE(8, 0);
  request.writeInt32BE(80877103, 4);
  plain.write(request);

  const answer = await new Promise<string>((resolve, reject) => {
    plain.once('data', (chunk: Buffer) => resolve(String.fromCharCode(chunk[0] ?? 0)));
    plain.once('error', reject);
  });
  if (answer !== 'S') {
    throw new Error(`this server refused TLS (answered ${JSON.stringify(answer)}). Connect without ssl, or to a server that offers it.`);
  }

  return await new Promise<Socket>((resolve, reject) => {
    const secure = tlsConnect({ socket: plain, servername: host }, () => resolve(secure));
    secure.once('error', reject);
  });
}

export async function connectPgWire(options: PgWireOptions): Promise<PgWireClient> {
  const { host = '127.0.0.1', port = 5432, user, database, password, searchPath, ssl = false } = options;

  const plain: Socket = createConnection({ host, port });
  plain.setNoDelay(true);
  await new Promise<void>((resolve, reject) => {
    plain.once('connect', resolve);
    plain.once('error', reject);
  });

  const socket: Socket = ssl ? await negotiateTls(plain, host) : plain;
  socket.setNoDelay(true);

  let buffer = Buffer.alloc(0);
  let onMessage: ((type: string, body: Buffer) => void) | null = null;
  let fatal: Error | null = null;
  /* Set when the server reports an aborted transaction. Cleared by the rollback
   * the next statement issues before doing anything else. */
  let needsRollback = false;

  const drain = (): void => {
    /* A message is a type byte plus a length that includes itself. Anything
     * shorter than a full message stays buffered: TCP splits wherever it likes
     * and a parser that assumes otherwise works until it does not. */
    for (;;) {
      if (buffer.length < 5) return;
      const length = buffer.readInt32BE(1);
      if (buffer.length < length + 1) return;
      const type = String.fromCharCode(buffer[0] ?? 0);
      const body = buffer.subarray(5, length + 1);
      buffer = buffer.subarray(length + 1);
      onMessage?.(type, body);
    }
  };

  socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); drain(); });
  socket.on('error', (err) => { fatal = err; });

  const errorFrom = (body: Buffer): Error => {
    const r = new Reader(body);
    const parts: Record<string, string> = {};
    for (;;) {
      const field = r.byte();
      if (field === 0) break;
      parts[String.fromCharCode(field)] = r.cstring();
    }
    return new Error(`${parts['S'] ?? 'ERROR'} ${parts['C'] ?? ''}: ${parts['M'] ?? 'unknown'}`.trim());
  };

  /* Runs until ReadyForQuery, collecting rows. One statement in flight. */
  const collect = (send: Buffer): Promise<Record<string, unknown>[]> =>
    new Promise((resolve, reject) => {
      let fields: Field[] = [];
      const rows: Record<string, unknown>[] = [];
      let failure: Error | null = null;

      onMessage = (type, body) => {
        switch (type) {
          case 'T': {
            const r = new Reader(body);
            const count = r.int16();
            fields = [];
            for (let i = 0; i < count; i++) {
              const name = r.cstring();
              r.int32(); r.int16();
              const oid = r.int32();
              r.int16(); r.int32(); r.int16();
              fields.push({ name, oid });
            }
            break;
          }
          case 'D': {
            const r = new Reader(body);
            const count = r.int16();
            const row: Record<string, unknown> = {};
            for (let i = 0; i < count; i++) {
              const len = r.int32();
              const raw = len === -1 ? null : r.bytes(len).toString('utf8');
              const field = fields[i];
              if (field) row[field.name] = decode(raw, field.oid);
            }
            rows.push(row);
            break;
          }
          case 'E':
            /* Recorded, not thrown here. The server still owes us a
             * ReadyForQuery, and rejecting early leaves the connection in a
             * state the next query cannot use. */
            failure = errorFrom(body);
            break;
          case 'Z': {
            /*
             * ReadyForQuery carries the transaction status, and 'E' means the
             * server has aborted the transaction and will refuse everything
             * until it is rolled back. Ignoring that byte cost a debugging pass:
             * a migration failed on one statement and every later statement
             * then reported 25P02 instead of the real error.
             */
            const status = String.fromCharCode(body[0] ?? 0);
            if (status === 'E') needsRollback = true;
            onMessage = null;
            if (failure) reject(failure);
            else resolve(rows);
            break;
          }
          default:
            break;
        }
      };

      socket.write(send, (err) => { if (err) reject(err); });
    });

  /* --- startup and authentication --- */
  const clientNonce = randomBytes(18).toString('base64');
  let scramBare = '';
  let expectedServerSignature: Buffer | null = null;

  await new Promise<void>((resolve, reject) => {
    onMessage = (type, body) => {
      if (type === 'E') { onMessage = null; reject(errorFrom(body)); return; }
      if (type === 'R') {
        const r = new Reader(body);
        const code = r.int32();
        if (code === 0) return;
        if (code === 3) {
          socket.write(new Writer().cstring(password ?? '').frame('p'));
          return;
        }
        if (code === 5) {
          const salt = r.bytes(4);
          const inner = createHash('md5').update((password ?? '') + user).digest('hex');
          const outer = createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
          socket.write(new Writer().cstring(`md5${outer}`).frame('p'));
          return;
        }
        /* 10: SASL. The body lists the mechanisms the server will accept. */
        if (code === 10) {
          const offered: string[] = [];
          for (;;) {
            const name = r.cstring();
            if (!name) break;
            offered.push(name);
          }
          if (!offered.includes('SCRAM-SHA-256')) {
            onMessage = null;
            reject(new Error(`the server offered SASL mechanisms ${offered.join(', ')} and this client only speaks SCRAM-SHA-256`));
            return;
          }
          const first = scramFirstMessage(clientNonce);
          scramBare = first.bare;
          const payload = Buffer.from(first.message, 'utf8');
          socket.write(
            new Writer().cstring('SCRAM-SHA-256').int32(payload.length).raw(payload).frame('p'),
          );
          return;
        }
        /* 11: SASLContinue, the server's first message. */
        if (code === 11) {
          try {
            const serverFirst = body.subarray(4).toString('utf8');
            const final = scramFinalMessage(password ?? '', clientNonce, scramBare, serverFirst);
            expectedServerSignature = final.serverSignature;
            socket.write(new Writer().raw(Buffer.from(final.message, 'utf8')).frame('p'));
          } catch (err) {
            onMessage = null;
            reject(err instanceof Error ? err : new Error(String(err)));
          }
          return;
        }
        /*
         * 12: SASLFinal. The server proves it knew the stored key too, and that
         * proof is CHECKED. Skipping it would authenticate us to anything that
         * completed the handshake, which is the mutual half of mutual auth and
         * the reason SCRAM is worth more than a password over TLS.
         */
        if (code === 12) {
          const fields = new Map(
            body.subarray(4).toString('utf8').split(',').map((part) => [part.slice(0, 1), part.slice(2)] as const),
          );
          const presented = Buffer.from(fields.get('v') ?? '', 'base64');
          const expected = expectedServerSignature;
          if (!expected || presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
            onMessage = null;
            reject(new Error('scram: the server failed to prove it knows the password'));
          }
          return;
        }
        onMessage = null;
        reject(new Error(`unsupported authentication method ${code}. This harness speaks trust, cleartext, md5 and SCRAM-SHA-256.`));
        return;
      }
      if (type === 'Z') { onMessage = null; resolve(); }
    };

    socket.write(
      new Writer()
        .int32(196608)
        .cstring('user').cstring(user)
        .cstring('database').cstring(database)
        .cstring('client_encoding').cstring('UTF8')
        .cstring('')
        .startup(),
    );
  });

  /* Clears an aborted transaction so one failed statement does not poison every
   * statement after it. */
  const recover = async (): Promise<void> => {
    if (!needsRollback) return;
    needsRollback = false;
    await collect(new Writer().cstring('ROLLBACK').frame('Q')).catch(() => {});
  };

  const client: PgWireClient = {
    async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      if (fatal) throw fatal;
      await recover();

      /*
       * The extended protocol, so parameters are BOUND rather than pasted into
       * the statement. Inlining them would have been fewer lines and would test
       * a different query than the one the driver sends.
       */
      const parse = new Writer().cstring('').cstring(sql).int16(0).frame('P');

      const bind = new Writer();
      bind.cstring('').cstring('').int16(0).int16(params.length);
      for (const param of params) {
        const encoded = encodeParam(param);
        if (encoded === null) bind.int32(-1);
        else {
          const bytes = Buffer.from(encoded, 'utf8');
          bind.int32(bytes.length).raw(bytes);
        }
      }
      bind.int16(0);

      const send = Buffer.concat([
        parse,
        bind.frame('B'),
        new Writer().byte('P').cstring('').frame('D'),
        new Writer().cstring('').int32(0).frame('E'),
        new Writer().frame('S'),
      ]);

      const rows = await collect(send);
      return rows as T[];
    },

    /*
     * Transactions run on this one connection, which is why the driver's atomic
     * path is exercised rather than skipped. A pooled client would have to hold
     * a connection for the callback; that is the caller's problem and is stated
     * in the driver's own interface.
     */
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      await client.exec('BEGIN');
      try {
        const out = await fn(client);
        await client.exec('COMMIT');
        return out;
      } catch (err) {
        await client.exec('ROLLBACK').catch(() => {});
        throw err;
      }
    },

    async exec(sql: string): Promise<void> {
      if (fatal) throw fatal;
      await recover();
      await collect(new Writer().cstring(sql).frame('Q'));
    },

    async end(): Promise<void> {
      socket.write(new Writer().frame('X'));
      await new Promise<void>((resolve) => { socket.end(resolve); });
    },
  };

  if (searchPath) {
    /* Set on the session rather than per statement, so every later query lands
     * in the isolated schema without the driver knowing anything about it. */
    await client.exec(`SET search_path TO ${searchPath}`);
  }

  return client;
}
