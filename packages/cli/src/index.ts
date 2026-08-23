/*
 * @quorum/cli
 *
 * A thin client over core. Everything it needs is injected, so the run is
 * testable offline and `bin.ts` is the only file that touches the real world.
 */

export { AVAILABLE_SOURCES, DEFAULT_CORPUS_PATH, DEFAULT_TERMS, HELP, VERSION, parseArgs } from './args.ts';
export type { CliOptions, ParseResult } from './args.ts';
export { runResearch } from './run.ts';
export type { RunDeps, RunResult, ReceiptCheck } from './run.ts';
export { renderJson, renderText } from './render.ts';
/* The other four output formats. `renderMarkdown` in particular is what the MCP
 * server returns, since markdown costs roughly 60% of the tokens JSON does for
 * the same content and an agent pays for every one. */
export { renderCsv, renderMarkdown, renderNdjson, flatRows, isOutputFormat, OUTPUT_FORMATS } from './formats.ts';
export type { FlatRow, OutputFormat } from './formats.ts';
export { runWithComparison } from './run.ts';
