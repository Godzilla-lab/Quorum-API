/*
 * The wire client's own arithmetic, offline.
 *
 * SCRAM is the part worth testing without a server, because it is the part
 * where being subtly wrong looks exactly like being right: a bad proof is
 * rejected by the server with the same message as a wrong password, and a
 * server signature nobody checks passes every test that only asks "did we
 * connect".
 *
 * The vectors are RFC 7677's, so this asserts against the standard rather
 * than against whatever this implementation happened to produce.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePgUri, scramFinalMessage, scramFirstMessage } from './pg-wire.ts';

/* RFC 7677 section 3. */
const USER_NONCE = 'rOprNGfwEbeRWgbNEkqO';
const SERVER_FIRST = 'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096';

test('SCRAM PRODUCES THE PROOF FROM RFC 7677, BYTE FOR BYTE', () => {
  /* The vector names a user; Postgres sends none, which the next test covers. */
  const first = scramFirstMessage(USER_NONCE, 'user');
  assert.equal(first.message, `n,,n=user,r=${USER_NONCE}`);
  /* `n,,` says this client does not support channel binding. Claiming `y,,`
   * would assert a downgrade it cannot back up. */
  assert.ok(first.message.startsWith('n,,'));

  const final = scramFinalMessage('pencil', USER_NONCE, first.bare, SERVER_FIRST);
  assert.equal(
    final.message,
    'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0'
    + ',p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=',
  );
  assert.equal(
    final.serverSignature.toString('base64'),
    '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=',
  );
});

test('the postgres path sends no username, because the startup packet already did', () => {
  const first = scramFirstMessage(USER_NONCE);
  assert.equal(first.message, `n,,n=,r=${USER_NONCE}`);
  assert.equal(first.bare, `n=,r=${USER_NONCE}`);
});

test('A SERVER NONCE THAT DOES NOT EXTEND OURS IS REFUSED', () => {
  /* A server returning an unrelated nonce is broken or replaying somebody
   * else's exchange, and carrying on would authenticate against it anyway. */
  assert.throws(
    () => scramFinalMessage('pencil', USER_NONCE, `n=,r=${USER_NONCE}`, 's=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,r=somethingelse'),
    /does not extend/,
  );
});

test('a server that sends no salt or iteration count is refused', () => {
  assert.throws(
    () => scramFinalMessage('pencil', USER_NONCE, `n=,r=${USER_NONCE}`, `r=${USER_NONCE}extra`),
    /no salt or iteration count/,
  );
});

test('a wrong password produces a different proof, which is the whole point', () => {
  const first = scramFirstMessage(USER_NONCE);
  const right = scramFinalMessage('pencil', USER_NONCE, first.bare, SERVER_FIRST);
  const wrong = scramFinalMessage('pencil2', USER_NONCE, first.bare, SERVER_FIRST);
  assert.notEqual(right.message, wrong.message);
  assert.notEqual(right.serverSignature.toString('base64'), wrong.serverSignature.toString('base64'));
});

/* ------------------------------------------------------------------ */
/* the connection uri                                                  */
/* ------------------------------------------------------------------ */

test('A URI IS PARSED RATHER THAN SPLIT BY HAND, INCLUDING AN AWKWARD PASSWORD', () => {
  /* A generated password containing `@` or `/` is what breaks hand splitting,
   * and a provider will hand you one without warning. */
  const parsed = parsePgUri('postgres://avnadmin:p%40ss%2Fword@pg-x.aivencloud.com:24909/defaultdb?sslmode=require');
  assert.equal(parsed.host, 'pg-x.aivencloud.com');
  assert.equal(parsed.port, 24909);
  assert.equal(parsed.user, 'avnadmin');
  assert.equal(parsed.password, 'p@ss/word');
  assert.equal(parsed.database, 'defaultdb');
  assert.equal(parsed.ssl, true);
});

test('sslmode=disable is the only value that means no', () => {
  assert.equal(parsePgUri('postgres://u:p@h:5432/d?sslmode=disable').ssl, false);
  assert.equal(parsePgUri('postgres://u:p@h:5432/d?sslmode=verify-full').ssl, true);
  /* Absent means absent, not off: a local server with no TLS is the default
   * this client was written against. */
  assert.equal(parsePgUri('postgres://u:p@h:5432/d').ssl, false);
});

test('a uri that is not postgres is refused rather than half understood', () => {
  assert.throws(() => parsePgUri('mysql://u:p@h:3306/d'), /not a postgres uri/);
  assert.equal(parsePgUri('postgresql://u:p@h:5432/d').host, 'h');
});
