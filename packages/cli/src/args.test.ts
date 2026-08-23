import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  AVAILABLE_SOURCES, DEFAULT_CORPUS_PATH, DEFAULT_TERMS, HELP, VERSION,
  type CliOptions, parseArgs,
} from './args.ts';

function run(argv: string[]): CliOptions {
  const parsed = parseArgs(argv);
  if (!parsed.ok) assert.fail(`expected a run, got usage error: ${parsed.message}`);
  if (parsed.kind !== 'run') assert.fail(`expected a run, got ${parsed.kind}`);
  return parsed.options;
}

function usageError(argv: string[]): string {
  const parsed = parseArgs(argv);
  if (parsed.ok) assert.fail(`expected a usage error, got ${parsed.kind}`);
  return parsed.message;
}

test('VERSION tracks package.json, because a comment is not a constraint', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(VERSION, pkg.version);
});

test('a bare subject is enough, and the defaults are filled in', () => {
  const options = run(['running shoes']);
  assert.equal(options.subject, 'running shoes');
  assert.deepEqual(options.terms, DEFAULT_TERMS);
  assert.deepEqual(options.sources, [...AVAILABLE_SOURCES]);
  assert.equal(options.corpusPath, DEFAULT_CORPUS_PATH);
  assert.equal(options.offline, false);
  assert.equal(options.capUsd, undefined);
});

/* The input is a subject, not a URL, and an unquoted multi word subject is the
 * shape a person actually types. */
test('loose words join into one subject', () => {
  assert.equal(run(['project', 'management', 'software']).subject, 'project management software');
});

test('a URL is just another subject', () => {
  assert.equal(run(['https://allbirds.com/products/mens-wool-runners']).subject, 'https://allbirds.com/products/mens-wool-runners');
});

test('a subject starting with a dash survives after --', () => {
  assert.equal(run(['--', '--weird-brand-name']).subject, '--weird-brand-name');
});

test('flags accept both space and equals forms', () => {
  assert.deepEqual(run(['x', '--terms', 'sizing,comfort']).terms, ['sizing', 'comfort']);
  assert.deepEqual(run(['x', '--terms=sizing,comfort']).terms, ['sizing', 'comfort']);
});

test('list values are trimmed and empty entries dropped', () => {
  assert.deepEqual(run(['x', '--communities', ' running , , runners ']).communities, ['running', 'runners']);
});

test('deadline is given in minutes and stored in milliseconds', () => {
  assert.equal(run(['x', '--deadline', '5']).deadlineMs, 300_000);
});

test('boolean flags are recognised', () => {
  const options = run(['x', '--offline', '--json', '--quiet']);
  assert.equal(options.offline, true);
  assert.equal(options.json, true);
  assert.equal(options.quiet, true);
});

test('help and version short circuit before anything else is parsed', () => {
  assert.deepEqual(parseArgs(['--help']), { ok: true, kind: 'help' });
  assert.deepEqual(parseArgs(['-h']), { ok: true, kind: 'help' });
  assert.deepEqual(parseArgs(['--version']), { ok: true, kind: 'version' });
  assert.deepEqual(parseArgs(['x', '--sources', 'nonsense', '--help']), { ok: true, kind: 'help' });
});

/*
 * Every failure below is a VALUE. Parsing never throws, because a stack trace
 * for a mistyped flag teaches nobody anything.
 */
test('no subject is a usage error, not a crash', () => {
  assert.match(usageError([]), /nothing to research/);
});

test('an unknown option names itself', () => {
  assert.match(usageError(['x', '--sbus', '3']), /--sbus/);
});

/*
 * The important one. Silently skipping a mistyped source is only discovered an
 * hour later, when the report is thin and nothing in it says why.
 */
test('an unknown source is rejected and the available ones are listed', () => {
  const message = usageError(['x', '--sources', 'reddit,twitter']);
  assert.match(message, /twitter/);
  assert.match(message, /reddit, hackernews/);
});

test('numbers that are not numbers are rejected', () => {
  for (const argv of [['x', '--queries', 'abc'], ['x', '--deadline', 'soon'], ['x', '--cap', 'lots']]) {
    assert.equal(parseArgs(argv).ok, false, argv.join(' '));
  }
});

test('zero and negative numbers are rejected, not silently accepted', () => {
  for (const argv of [['x', '--queries', '0'], ['x', '--max-records', '-5'], ['x', '--cap', '0']]) {
    assert.match(usageError(argv), /greater than zero/, argv.join(' '));
  }
});

test('a value flag with nothing after it is a usage error', () => {
  assert.match(usageError(['x', '--terms']), /needs a value/);
});

test('a boolean flag given a value is a usage error rather than a silent ignore', () => {
  assert.match(usageError(['x', '--offline=true']), /does not take a value/);
});

test('empty lists are rejected, since they would plan nothing', () => {
  assert.equal(parseArgs(['x', '--terms', ' , ']).ok, false);
  assert.equal(parseArgs(['x', '--sources', '']).ok, false);
});

/* ------------------------------------------------------------------ */
/* --compare, where each name costs a full run                         */
/* ------------------------------------------------------------------ */

test('rivals are parsed as a list, and no rivals is the default', () => {
  const parsed = parseArgs(['alpha shoes', '--compare', 'beta shoes, gamma shoes']);
  assert.equal(parsed.ok && parsed.kind === 'run' && parsed.options.compare.length, 2);
  assert.deepEqual(
    parsed.ok && parsed.kind === 'run' ? parsed.options.compare : null,
    ['beta shoes', 'gamma shoes'],
  );
  const plain = parseArgs(['alpha shoes']);
  assert.deepEqual(plain.ok && plain.kind === 'run' ? plain.options.compare : null, []);
});

test('COMPARING A SUBJECT AGAINST ITSELF IS A USAGE ERROR, NOT A RESULT', () => {
  /*
   * It would retrieve the same category twice and then compare it against
   * itself, and a table showing 12.4% against 12.4% reads as a real finding
   * about two products.
   */
  assert.match(usageError(['alpha shoes', '--compare', 'alpha shoes']), /names the subject itself/);
  assert.match(usageError(['alpha shoes', '--compare', 'ALPHA SHOES']), /names the subject itself/);
  assert.match(usageError(['alpha shoes', '--compare', 'beta, beta']), /twice/);
});

test('an empty rival list is rejected, since it would pay for nothing', () => {
  assert.equal(parseArgs(['x', '--compare', ' , ']).ok, false);
});

test('help documents every flag the parser accepts', () => {
  for (const flag of ['--terms', '--communities', '--sources', '--corpus', '--queries',
    '--max-records', '--deadline', '--cap', '--offline', '--json', '--quiet', '--compare']) {
    assert.match(HELP, new RegExp(flag.replace(/-/g, '\\-')), `${flag} is undocumented`);
  }
});

test('shipped copy carries no em dash or en dash', () => {
  assert.doesNotMatch(HELP, new RegExp(`${String.fromCodePoint(0x2014)}|${String.fromCodePoint(0x2013)}`));
});
