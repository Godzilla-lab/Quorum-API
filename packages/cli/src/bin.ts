#!/usr/bin/env node
/*
 * The entry point, and the ONLY file in this package that touches the real
 * world. Everything below it takes its clock, its database and its network as
 * arguments, which is why the whole run can be tested offline.
 *
 * PROGRESS GOES TO STDERR, THE RESULT GOES TO STDOUT. A run takes minutes and
 * sometimes the better part of an hour, so it has to say what it is doing, and
 * `receipts "x" --json | jq` has to work at the same time. Mixing them would
 * mean choosing one.
 *
 * CTRL C CANCELS COOPERATIVELY. Retrieval writes to the corpus incrementally
 * and checks for cancellation between queries, so an interrupted run keeps
 * everything it had already gathered and stops spending immediately. Killing
 * the process instead would leave the same records written and no summary.
 */

/* First, before anything that touches node:sqlite. See the module header. */
import './quiet-experimental.ts';
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { findProductByName, makeAdSource, makeSource, resolveSubject } from '@quorum/sources';
import { askClaimsLive, expandSubjectLive, readImageLive } from '@quorum/llm';
import { HELP, VERSION, parseArgs } from './args.ts';
import { renderJson, renderText } from './render.ts';
import { renderCsv, renderMarkdown, renderNdjson } from './formats.ts';
import { runWithComparison } from './run.ts';

/* Documented in HELP. Anything that moves here moves there. */
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_UNRESOLVED_RECEIPT = 4;

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (!parsed.ok) {
    process.stderr.write(`quorum: ${parsed.message}\n`);
    return EXIT_USAGE;
  }
  if (parsed.kind === 'help') { process.stdout.write(`${HELP}\n`); return EXIT_OK; }
  if (parsed.kind === 'version') { process.stdout.write(`${VERSION}\n`); return EXIT_OK; }

  if (parsed.kind === 'takedown') {
    const { openSqliteCorpus } = await import('@quorum/corpus');
    const corpus = openSqliteCorpus({ path: parsed.options.corpusPath });
    try {
      const { source, externalId } = parsed.options;
      /*
       * An unknown source deletes zero rows and says so, which is safer than
       * validating against a source list: the corpus can hold records from
       * sources this build no longer ships, and those must stay removable.
       */
      const removed = await corpus.deleteByExternalId(
        source as Parameters<typeof corpus.deleteByExternalId>[0],
        externalId,
      );
      if (parsed.options.json) {
        process.stdout.write(`${JSON.stringify({ source, externalId, removed }, null, 2)}\n`);
      } else {
        process.stdout.write(removed === 0
          ? `nothing held under ${source} ${externalId}, so there was nothing to remove\n`
          : `removed ${removed} row${removed === 1 ? '' : 's'} for ${source} ${externalId}, from every category and from search\n`);
      }
      return EXIT_OK;
    } finally {
      await corpus.close();
    }
  }

  if (parsed.kind === 'verify') {
    const { openSqliteCorpus } = await import('@quorum/corpus');
    const { readClaims, renderVerify, verifyClaims } = await import('./verify.ts');

    let raw: string;
    try {
      /* A dash reads stdin, so this composes with anything that emits json. */
      raw = parsed.options.file === '-'
        ? await new Promise<string>((resolve, reject) => {
          let buffer = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', (chunk) => { buffer += chunk; });
          process.stdin.on('end', () => resolve(buffer));
          process.stdin.on('error', reject);
        })
        : await (await import('node:fs/promises')).readFile(parsed.options.file, 'utf8');
    } catch (err) {
      process.stderr.write(`quorum: cannot read ${parsed.options.file}: ${err instanceof Error ? err.message : 'unknown'}\n`);
      return EXIT_FAILED;
    }

    let claims;
    try {
      claims = readClaims(JSON.parse(raw));
    } catch {
      process.stderr.write('quorum: that file is not json\n');
      return EXIT_USAGE;
    }

    const corpus = openSqliteCorpus({ path: parsed.options.corpusPath });
    try {
      const result = await verifyClaims({ claims, label: parsed.options.file }, corpus);
      process.stdout.write(`${parsed.options.json ? JSON.stringify(result, null, 2) : renderVerify(result)}\n`);
      /*
       * Non zero when something was invented, so this runs in somebody else's
       * pipeline against output we did not produce.
       */
      return result.clean ? EXIT_OK : EXIT_UNRESOLVED_RECEIPT;
    } finally {
      await corpus.close();
    }
  }

  /*
   * Loaded here rather than at the top of the file so that --help and --version
   * do not open the sqlite driver. `node:sqlite` prints an experimental warning
   * the moment it is imported, and a help screen that emits a database warning
   * reads as a broken tool.
   */
  const { openSqliteCorpus } = await import('@quorum/corpus');

  const options = parsed.options;
  const controller = new AbortController();
  const onInterrupt = (): void => {
    process.stderr.write('\ninterrupted, finishing the current query and keeping what was gathered\n');
    controller.abort();
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  try {
    const result = await runWithComparison(options, {
      openCorpus: (path) => openSqliteCorpus({ path }),
      resolveSubject,
      makeSource,
      makeAdSource,
      findProductByName: (name) => findProductByName(name, { timeoutMs: 15_000 }),
      /*
       * Returns null rather than throwing when unconfigured or refused. A
       * missing key degrades a run and never fails it, and a hint is the most
       * optional thing in the pipeline.
       */
      expandSubject: async (subject) => {
        const result = await expandSubjectLive(subject, process.env, { timeoutMs: 30_000 });
        if (!result.ok || !result.expansion) return null;
        const { brands, category, aliases, context, model } = result.expansion;
        return { brands, category, aliases, context, model };
      },
      /*
       * Only ever called when --read-images was passed. Same contract as the
       * expansion hook: null rather than a throw, because an unconfigured or
       * refused vision provider degrades a run and never fails it.
       */
      readImage: async (url) => {
        const result = await readImageLive(url, process.env, {
          timeoutMs: 90_000,
          signal: controller.signal,
        });
        return result.ok && result.reading ? result.reading : null;
      },
      /*
       * Only ever called when --synthesise was passed. Built here rather than
       * inside the run, because this is the only file allowed to touch the real
       * network, and the gate that checks what it returns is not.
       */
      askModel: askClaimsLive(process.env, {
        ...(options.synthesisModel ? { model: options.synthesisModel } : {}),
        signal: controller.signal,
      }),
      env: process.env,
      signal: controller.signal,
      ...(options.quiet || options.format !== 'text'
        ? {}
        : { onProgress: (line: string) => process.stderr.write(`  ${line}\n`) }),
    });

    const rendered = {
      text: renderText,
      json: renderJson,
      markdown: renderMarkdown,
      ndjson: renderNdjson,
      csv: renderCsv,
    }[options.format](result);
    process.stdout.write(`${rendered}\n`);

    /*
     * A cited receipt that does not resolve is not a degraded run, it is a
     * fabricated citation, and the exit code has to say so loudly enough that a
     * script notices. Everything else, including a source that failed
     * completely, is a completed run with a hole the report already declares.
     */
    return result.receiptCheck.unresolved.length ? EXIT_UNRESOLVED_RECEIPT : EXIT_OK;
  } catch (err) {
    /*
     * Only reached when something outside a source failed: the corpus could not
     * be opened, or the disk is full. A source failing never gets here, because
     * retrieval reports degradation as a value rather than throwing.
     */
    process.stderr.write(`quorum: ${err instanceof Error ? err.message : 'run failed'}\n`);
    return EXIT_FAILED;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
  }
}

/*
 * Only when run directly, so importing this file for a test starts nothing.
 *
 * BOTH SIDES ARE RESOLVED THROUGH realpath, AND THAT IS NOT A NICETY.
 *
 * npm installs a bin as a SYMLINK: node_modules/.bin/quorum points at
 * packages/cli/src/bin.ts. So when anybody runs the documented command,
 * `process.argv[1]` is the symlink and `import.meta.filename` is the real file,
 * and comparing them directly never matches. The CLI then started nothing,
 * printed nothing, and exited 0, which looks like success.
 *
 * MEASURED 2026-08-23 by running the README's own quickstart in a clean
 * checkout: `npx quorum "running shoes" --offline` produced zero bytes on both
 * streams. Every `npx quorum` example in the README was broken, and running the
 * file by path worked perfectly, which is why it survived so long: that is how
 * it always got tested.
 */
const sameFile = (a: string, b: string): boolean => {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
};

if (process.argv[1] && sameFile(process.argv[1], import.meta.filename)) {
  process.exitCode = await main(process.argv.slice(2));
}
