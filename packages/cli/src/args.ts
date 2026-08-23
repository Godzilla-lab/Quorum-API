/*
 * Argument parsing.
 *
 * PARSING NEVER THROWS. A usage error is a value, printed as one line a person
 * can act on, and it exits 2. Errors as values is a house rule anywhere a
 * vendor can be down; it applies just as well to the human at the keyboard,
 * because a stack trace for a mistyped flag teaches nothing.
 *
 * THE INPUT IS A SUBJECT, NOT A URL. Plain text works, a URL works, and a URL
 * the store refuses still works. Four of four real product pages blocked a
 * server side fetch when this was measured on 2026-08-22, so a CLI that
 * required a fetchable URL would fail on exactly the brands anyone would want
 * to research.
 */

/*
 * Tracks packages/cli/package.json. A test asserts they match, because a
 * comment saying "keep these in sync" is not a constraint.
 */
import { AD_SOURCE_IDS, SOURCE_IDS } from '@quorum/sources';
import { OUTPUT_FORMATS, isOutputFormat, type OutputFormat } from './formats.ts';

export const VERSION = '0.0.0';

/* From the registry beside the adapters, never a second list here. A CLI that
 * kept its own copy would reject a source the server accepts. */
export const AVAILABLE_SOURCES = SOURCE_IDS;

/*
 * Sources that carry attested evidence, listed so a reader of --help can see
 * that they are a different kind of thing. Two attested records are a finding
 * on their own, because a named party stated them to a regulator with
 * consequences for lying, and three forum comments are not the same claim.
 */
export const ATTESTED_SOURCES = ['cpsc', 'openfda', 'nhtsa', 'sec-edgar', 'eu-safety-gate'] as const;

/*
 * Ad sources are separate because they are metered and because their records go
 * to a different table. They run only when configured, so a user with no Apify
 * account never spends anything and gets a report that says the ads leg is
 * missing.
 */
export const AVAILABLE_AD_SOURCES = AD_SOURCE_IDS;

/*
 * Starting points, not an answer. Single concept words, because multi word
 * queries AND together upstream and go empty fast, and generic enough to say
 * something about any product. Anyone researching seriously passes --terms.
 */
export const DEFAULT_TERMS = ['quality', 'price', 'problems'];

/*
 * Beside the working directory by default, so a run is reproducible from where
 * it was started and a second run on the same subject is warm. Never inside the
 * repo tree by accident: a corpus database must never be committed.
 */
export const DEFAULT_CORPUS_PATH = './quorum.db';

export interface CliOptions {
  subject: string;
  terms: string[];
  /* Name hints for finding communities. A different thing from terms, and
   * conflating them plans zero queries in silence. */
  communities: string[];
  sources: string[];
  corpusPath: string;
  maxQueriesPerSource: number;
  maxRecordsTotal: number;
  deadlineMs: number;
  capUsd: number | undefined;
  adSources: string[];
  /* Answer from the corpus alone. Zero upstream requests, zero cost. */
  offline: boolean;
  /*
   * Ask a vision model to read the product images. OFF BY DEFAULT, and it has
   * to be, because it is the slowest thing in the pipeline by an order of
   * magnitude: measured 2026-08-22, 151s for the first image and 38.7s for the
   * second, against a whole cold run at 39.9s. A default that can quadruple a
   * run to produce something that is explicitly not evidence would be a bad
   * trade made on the user's behalf.
   */
  readImages: boolean;
  /* How many images to read. Small on purpose. See above. */
  maxImages: number;
  /*
   * Have a model write the findings, with every id it cites fetched back out of
   * the corpus before anything is printed. OFF BY DEFAULT for the same reason
   * --read-images is: it needs a key, it costs a request, and the report is
   * complete without it. The counts above it are computed from the corpus and
   * do not change when this is on.
   */
  synthesise: boolean;
  /* One model instead of the free fallback list. A paid model charges the
   * meter, which is why it is a flag rather than a default. */
  synthesisModel: string | undefined;
  /*
   * How to print it. `--json` remains as an alias for `--format json` because
   * it is documented and scripts use it, and a flag that has shipped does not
   * get removed to tidy up a newer one.
   */
  format: OutputFormat;
  /*
   * Answer as the market stood at the end of this month, `YYYY-MM`. Undefined
   * means now. Filters on when each record was WRITTEN, never on when we
   * harvested it: the archive is allowed to know more about March than we did
   * in March, and that is the point of keeping one.
   */
  asOf: string | undefined;
  /*
   * Rivals to compare the subject against, each retrieved as A CORPUS OF ITS
   * OWN. Empty for an ordinary run.
   *
   * A second full run per rival, and it has to be. Counting records in the
   * subject's corpus that happen to mention a rival measures co-occurrence: a
   * comment saying "these run smaller than my Brooks" names a rival and a
   * complaint and attributes the complaint to neither.
   */
  compare: string[];
  json: boolean;
  quiet: boolean;
}

export interface VerifyOptions {
  /* The file to check. A dash reads stdin, so this composes in a pipeline. */
  file: string;
  corpusPath: string;
  json: boolean;
}

export type ParseResult =
  | { ok: true; kind: 'run'; options: CliOptions }
  | { ok: true; kind: 'verify'; options: VerifyOptions }
  | { ok: true; kind: 'help' }
  | { ok: true; kind: 'version' }
  | { ok: false; message: string };

const FLAGS_WITH_VALUES = new Set([
  '--terms', '--communities', '--sources', '--corpus',
  '--queries', '--max-records', '--deadline', '--cap', '--max-images',
  '--synthesis-model', '--format', '--as-of', '--compare',
]);

const BOOLEAN_FLAGS = new Set([
  '--offline', '--json', '--quiet', '--no-ads', '--read-images', '--synthesise',
  '--help', '-h', '--version', '-v',
]);

const splitList = (raw: string): string[] =>
  raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);

/* Rejects NaN, negatives and zero as usage errors rather than letting a typo
 * become a run that quietly does nothing. */
function positiveNumber(flag: string, raw: string): number | string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return `${flag} needs a number, got ${JSON.stringify(raw)}`;
  if (value <= 0) return `${flag} must be greater than zero, got ${raw}`;
  return value;
}

export function parseArgs(argv: readonly string[]): ParseResult {
  /*
   * `verify` is a verb rather than a flag, because it does something different
   * from researching rather than researching differently. It is checked before
   * anything else so that `receipts verify` can never be read as a request to
   * research the word "verify".
   */
  if (argv[0] === 'verify') return parseVerify(argv.slice(1));

  const positional: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === '--') {
      /* Everything after this is the subject, so a subject starting with a dash
       * is still expressible. */
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (!arg.startsWith('-')) { positional.push(arg); continue; }

    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);

    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) return { ok: false, message: `${name} does not take a value` };
      flags.add(name);
      continue;
    }

    if (!FLAGS_WITH_VALUES.has(name)) {
      return { ok: false, message: `unknown option ${name}. Run quorum --help for the list.` };
    }

    if (eq !== -1) { values.set(name, arg.slice(eq + 1)); continue; }

    const next = argv[i + 1];
    if (next === undefined) return { ok: false, message: `${name} needs a value` };
    values.set(name, next);
    i++;
  }

  if (flags.has('--help') || flags.has('-h')) return { ok: true, kind: 'help' };
  if (flags.has('--version') || flags.has('-v')) return { ok: true, kind: 'version' };

  const subject = positional.join(' ').trim();
  if (!subject) {
    return { ok: false, message: 'nothing to research. Pass a subject: quorum "running shoes"' };
  }

  const sources = values.has('--sources') ? splitList(values.get('--sources')!) : [...AVAILABLE_SOURCES];
  if (!sources.length) return { ok: false, message: '--sources was empty' };
  /*
   * An unrecognised source name is a usage error and not a silent skip. Losing
   * a leg to a typo is only discovered an hour later, when the report is thin
   * and there is nothing in it saying why.
   */
  for (const id of sources) {
    if (!(AVAILABLE_SOURCES as readonly string[]).includes(id)) {
      return { ok: false, message: `unknown source ${JSON.stringify(id)}. Available: ${AVAILABLE_SOURCES.join(', ')}` };
    }
  }

  const numeric: Record<string, number> = {
    '--queries': 6,
    '--max-records': 20_000,
    '--deadline': 60,
    '--max-images': 2,
  };
  for (const flag of Object.keys(numeric)) {
    const raw = values.get(flag);
    if (raw === undefined) continue;
    const parsed = positiveNumber(flag, raw);
    if (typeof parsed === 'string') return { ok: false, message: parsed };
    numeric[flag] = parsed;
  }

  let capUsd: number | undefined;
  const rawCap = values.get('--cap');
  if (rawCap !== undefined) {
    const parsed = positiveNumber('--cap', rawCap);
    if (typeof parsed === 'string') return { ok: false, message: parsed };
    capUsd = parsed;
  }

  const terms = values.has('--terms') ? splitList(values.get('--terms')!) : [...DEFAULT_TERMS];
  if (!terms.length) return { ok: false, message: '--terms was empty' };

  const rawFormat = values.get('--format');
  if (rawFormat !== undefined && !isOutputFormat(rawFormat)) {
    return { ok: false, message: `unknown format ${JSON.stringify(rawFormat)}. Available: ${OUTPUT_FORMATS.join(', ')}` };
  }
  /* An explicit --format wins, because somebody who typed both meant the one
   * that says what they want rather than the one that says "not text". */
  const format: OutputFormat = rawFormat ?? (flags.has('--json') ? 'json' : 'text');

  /*
   * A rival that is the subject again would retrieve the same category twice
   * and then compare it against itself, which reads as a real result and is
   * not one. Compared case insensitively, because "Brooks" and "brooks" are
   * one subject to every other part of the pipeline.
   */
  const compare = values.has('--compare') ? splitList(values.get('--compare')!) : [];
  if (values.has('--compare') && !compare.length) {
    return { ok: false, message: '--compare was empty' };
  }
  const seen = new Set([subject.toLowerCase()]);
  for (const rival of compare) {
    if (seen.has(rival.toLowerCase())) {
      return { ok: false, message: `--compare names ${JSON.stringify(rival)} twice, or names the subject itself` };
    }
    seen.add(rival.toLowerCase());
  }

  const asOf = values.get('--as-of');
  if (asOf !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(asOf)) {
    return { ok: false, message: `--as-of takes a month as YYYY-MM, got ${JSON.stringify(asOf)}` };
  }

  return {
    ok: true,
    kind: 'run',
    options: {
      subject,
      terms,
      communities: values.has('--communities') ? splitList(values.get('--communities')!) : [],
      sources,
      adSources: flags.has('--no-ads') ? [] : [...AVAILABLE_AD_SOURCES],
      corpusPath: values.get('--corpus') ?? DEFAULT_CORPUS_PATH,
      maxQueriesPerSource: numeric['--queries']!,
      maxRecordsTotal: numeric['--max-records']!,
      deadlineMs: numeric['--deadline']! * 60_000,
      capUsd,
      offline: flags.has('--offline'),
      readImages: flags.has('--read-images'),
      maxImages: numeric['--max-images']!,
      synthesise: flags.has('--synthesise'),
      synthesisModel: values.get('--synthesis-model'),
      format,
      asOf,
      compare,
      json: flags.has('--json'),
      quiet: flags.has('--quiet'),
    },
  };
}

function parseVerify(argv: readonly string[]): ParseResult {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('-') || arg === '-') { positional.push(arg); continue; }

    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);

    if (name === '--json' || name === '--quiet') { flags.add(name); continue; }
    if (name === '--help' || name === '-h') return { ok: true, kind: 'help' };
    if (name !== '--corpus') {
      return { ok: false, message: `unknown option ${name} for verify. Run quorum --help for the list.` };
    }
    if (eq !== -1) { values.set(name, arg.slice(eq + 1)); continue; }
    const next = argv[i + 1];
    if (next === undefined) return { ok: false, message: `${name} needs a value` };
    values.set(name, next);
    i++;
  }

  const file = positional[0];
  if (!file) {
    return { ok: false, message: 'nothing to verify. Pass a report: receipts verify report.json' };
  }

  return {
    ok: true,
    kind: 'verify',
    options: {
      file,
      corpusPath: values.get('--corpus') ?? DEFAULT_CORPUS_PATH,
      json: flags.has('--json'),
    },
  };
}

export const HELP = [
  'quorum <subject> [options]',
  '',
  'Market evidence with a receipt behind every number. The subject can be plain',
  'text ("running shoes"), a product URL, or a product URL the store blocks.',
  '',
  'Options',
  '  --terms a,b,c        what to ask about. Single concepts, not phrases.',
  `                       Default: ${DEFAULT_TERMS.join(', ')}`,
  '  --communities a,b    name hints for finding communities: running, runners.',
  '                       Different from --terms. Optional.',
  `  --sources a,b        Default: ${AVAILABLE_SOURCES.join(', ')}`,
  `                       ${ATTESTED_SOURCES.join(', ')} carry attested evidence: a named`,
  '                       party told a regulator, so two of them are a finding',
  `  --corpus PATH        corpus database. Default: ${DEFAULT_CORPUS_PATH}`,
  '  --queries N          queries per source. Default: 6',
  '  --max-records N      hard cap on records stored. Default: 20000',
  '  --deadline MINUTES   wall clock budget. Default: 60',
  '  --cap USD            spend cap, enforced in the cost meter',
  '  --no-ads             skip the metered competitor ads leg entirely',
  '  --offline            answer from the corpus alone. No network, no cost.',
  '  --read-images        have a vision model read the product images. Slow:',
  '                       measured 151s for the first image, 38.7s for the',
  '                       second. Off by default. What it returns is an',
  '                       interpretation and is never counted as evidence.',
  '  --max-images N       images to read with --read-images. Default: 2',
  '  --synthesise         have a model write the findings from the evidence.',
  '                       Every id it cites is fetched back out of the corpus',
  '                       before anything prints, and an invented one is',
  '                       reported rather than dropped. Needs OPENROUTER_API_KEY.',
  '                       Off by default. The counts do not change when it is on.',
  '  --synthesis-model M  one model instead of the free fallback list',
  `  --format F           ${OUTPUT_FORMATS.join(' | ')}. Default: text`,
  '                       markdown for an agent or a document, ndjson and csv',
  '                       for a warehouse. Every format carries the receipt id.',
  '  --json               alias for --format json',
  '  --as-of YYYY-MM      answer as the market stood at the end of that month.',
  '                       Filters on when each record was written, so the answer',
  '                       includes what we harvested later. Nobody else can do',
  '                       this, because nobody else keeps the records.',
  '  --compare a,b        compare against these rivals, versus what.',
  '                       EACH ONE IS A FULL RUN of its own, with its own',
  '                       retrieval and its own corpus, so it costs what a run',
  '                       costs and the total is on the report. Shares are',
  '                       compared, never counts, and a gap inside the sampling',
  '                       noise is reported as no difference.',
  '  --quiet              suppress progress, keep the result',
  '  -h, --help           this',
  '  -v, --version        version',
  '',
  'Verifying somebody else\'s claims',
  '  receipts verify <file.json> [--corpus PATH] [--json]',
  '',
  '  Checks every cited receipt id against the corpus and every quoted passage',
  '  against the records it cites. Reads our own --json output or any file with',
  '  claims carrying ids. A dash reads stdin. Exits 4 if anything was invented,',
  '  so it can run in a pipeline against output we did not produce.',
  '',
  'Exit codes',
  '  0  the run completed, including when a source degraded',
  '  1  the run could not complete',
  '  2  usage error',
  '  4  a cited receipt did not resolve. This must never happen.',
].join('\n');
