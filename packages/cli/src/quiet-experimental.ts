/*
 * Silence exactly one warning, for exactly one audience.
 *
 * Node labels its built-in SQLite experimental and prints two lines saying so
 * on every run. Inside this repo the npm scripts pass a flag that hides it;
 * the PUBLISHED binary runs under whatever node invocation npx produces, where
 * no flag can be smuggled portably through a shebang. So the first thing a
 * stranger sees after `npx quorum-api` would be a warning about our storage
 * engine, which reads as "something is wrong" when nothing is.
 *
 * This intercepts that one warning by name and forwards every other warning
 * untouched, deprecations and futures included. It must be imported before
 * anything that transitively imports node:sqlite, which is why it is the first
 * import in bin.ts and exists as a module at all: ESM hoists imports, so a
 * plain statement in bin.ts would run after the warning had already fired.
 */
const original = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (text.includes('SQLite is an experimental feature')) return;
  (original as (w: string | Error, ...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export {};
