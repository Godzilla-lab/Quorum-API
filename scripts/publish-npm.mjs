/*
 * Builds publishable tarballs for the five packages behind the CLI, and
 * publishes them when asked.
 *
 * WHY A STAGING PIPELINE EXISTS AT ALL. This repo runs TypeScript source
 * directly: node strips types natively, tsc emits declarations only, and
 * imports name the .ts files that exist on disk. Node deliberately refuses to
 * strip types inside node_modules, so a published package MUST ship compiled
 * JavaScript, while the repo must keep its zero build development flow. The
 * two cannot share a package.json, so each package is staged aside, compiled
 * with rewriteRelativeImportExtensions so `./x.ts` becomes `./x.js` in the
 * output, given a publish shaped package.json, and packed from the staging
 * copy. The repo is never modified.
 *
 * NAMES. The unscoped `quorum` is squatted by a 2017 placeholder, so the CLI
 * publishes as `quorum-api`, which makes the stranger's command
 * `npx quorum-api "running shoes"`. The four libraries ride under the
 * @quorum-api scope. Internal imports say @quorum/x in source; the staged
 * output rewrites them.
 *
 *   node scripts/publish-npm.mjs            stage, compile, pack
 *   node scripts/publish-npm.mjs --publish  the above, then npm publish x5
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAGING = join(ROOT, '.npm-staging');
const TARBALLS = join(STAGING, 'tarballs');
const VERSION = '0.1.0';
const SCOPE = '@quorum-api';
const REPO = 'https://github.com/Godzilla-lab/Quorum-API';

/* Dependency order. Each package may only depend on ones before it. */
const PACKAGES = [
  {
    dir: 'corpus',
    name: `${SCOPE}/corpus`,
    description: 'The evidence corpus behind Quorum: receipt ids, full text retrieval, SQLite and Postgres drivers, zero dependencies.',
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './constants': { types: './dist/constants.d.ts', default: './dist/constants.js' },
      './tiers': { types: './dist/tiers.d.ts', default: './dist/tiers.js' },
    },
  },
  {
    dir: 'sources',
    name: `${SCOPE}/sources`,
    description: 'Nine market evidence sources behind one interface, each degrading rather than failing, all fetching through an SSRF guarded client.',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
  },
  {
    dir: 'core',
    name: `${SCOPE}/core`,
    description: 'The Quorum pipeline: plan, retrieve, gate, corroborate, render. A claim without three independent receipts does not print as a finding.',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
  },
  {
    dir: 'llm',
    name: `${SCOPE}/llm`,
    description: 'Optional model assistance for Quorum. Counts never come from a model, and the deterministic report is identical without it.',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
  },
  {
    dir: 'cli',
    name: 'quorum-api',
    description: 'Market evidence with receipts. Give it a subject, get what a market actually says, every claim resolving to a real stored record.',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    bin: { quorum: './dist/bin.js', 'quorum-api': './dist/bin.js' },
  },
];

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8' });

/* Copy src, excluding tests and fixtures: tests do not ship, and fixtures are
 * test evidence rather than runtime data, verified by grep before this script
 * was written. */
function copySource(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !src.endsWith('.test.ts') && !src.split('/').includes('fixtures'),
  });
}

function rewriteSpecifiers(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { rewriteSpecifiers(p); continue; }
    if (!/\.(js|d\.ts)$/.test(entry.name)) continue;
    const text = readFileSync(p, 'utf8');
    /* Source says @quorum/x; the published scope is @quorum-api. The quote
     * anchors keep this from ever touching prose or comments by accident. */
    const next = text.replaceAll(`'@quorum/`, `'${SCOPE}/`).replaceAll(`"@quorum/`, `"${SCOPE}/`);
    if (next !== text) writeFileSync(p, next);
  }
}

rmSync(STAGING, { recursive: true, force: true });
mkdirSync(TARBALLS, { recursive: true });

const staged = new Map();

for (const pkg of PACKAGES) {
  const stage = join(STAGING, pkg.dir);
  process.stdout.write(`\n== ${pkg.name} ==\n`);

  copySource(join(ROOT, 'packages', pkg.dir, 'src'), join(stage, 'src'));

  /* The staged compiler config. rewriteRelativeImportExtensions is the whole
   * trick: it is what lets source written for direct execution compile into
   * JavaScript whose relative imports name the .js files that will exist. */
  writeFileSync(join(stage, 'tsconfig.json'), JSON.stringify({
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      rootDir: './src', outDir: './dist',
      emitDeclarationOnly: false, rewriteRelativeImportExtensions: true,
      composite: false, incremental: false, declarationMap: false,
    },
    include: ['src/**/*.ts'],
  }, null, 2));

  /* Sibling deps resolve through a local node_modules of ALREADY STAGED
   * packages, under their SOURCE names, so tsc sees the compiled .d.ts rather
   * than pulling sibling .ts files into this program. */
  const original = JSON.parse(readFileSync(join(ROOT, 'packages', pkg.dir, 'package.json'), 'utf8'));
  const internal = Object.keys(original.dependencies ?? {}).filter((d) => d.startsWith('@quorum/'));
  if (internal.length) {
    /*
     * UNDER BOTH NAMES, and the second is load bearing. This package's own
     * source imports @quorum/x, but an already staged dependency's .d.ts has
     * had its imports rewritten to the published scope, so the compiler needs
     * @quorum-api/x resolvable too. Without it, DocInput resolved to nothing
     * and every type extending it silently lost its inherited shape.
     */
    mkdirSync(join(stage, 'node_modules', '@quorum'), { recursive: true });
    mkdirSync(join(stage, 'node_modules', SCOPE), { recursive: true });
    for (const dep of internal) {
      const depDir = dep.replace('@quorum/', '');
      symlinkSync(join(STAGING, depDir), join(stage, 'node_modules', '@quorum', depDir));
      symlinkSync(join(STAGING, depDir), join(stage, 'node_modules', SCOPE, depDir));
    }
  }

  run('npx', ['tsc', '-p', 'tsconfig.json'], stage);
  rewriteSpecifiers(join(stage, 'dist'));

  /* The bin must survive compilation executable: tsc preserves the shebang,
   * and this asserts it rather than trusting it. */
  if (pkg.bin) {
    const bin = readFileSync(join(stage, 'dist', 'bin.js'), 'utf8');
    if (!bin.startsWith('#!/usr/bin/env node')) {
      writeFileSync(join(stage, 'dist', 'bin.js'), `#!/usr/bin/env node\n${bin}`);
    }
  }

  const manifest = {
    name: pkg.name,
    version: VERSION,
    description: pkg.description,
    license: 'Apache-2.0',
    type: 'module',
    /* Honest and load bearing: node:sqlite needs modern node, and the repo's
     * whole no build philosophy is calibrated against this floor. */
    engines: { node: '>=22.18.0' },
    repository: { type: 'git', url: `git+${REPO}.git`, directory: `packages/${pkg.dir}` },
    homepage: `${REPO}#readme`,
    bugs: `${REPO}/issues`,
    keywords: ['market-research', 'evidence', 'receipts', 'voice-of-customer', 'competitive-intelligence'],
    exports: pkg.exports,
    ...(pkg.bin ? { bin: pkg.bin } : {}),
    files: ['dist'],
    ...(Object.keys(original.dependencies ?? {}).some((d) => !d.startsWith('@quorum/'))
      ? (() => { throw new Error(`${pkg.name} has an external dependency, which this tree is not supposed to have`); })()
      : {}),
    ...(internal.length
      ? { dependencies: Object.fromEntries(internal.map((d) => [d.replace('@quorum/', `${SCOPE}/`), VERSION])) }
      : {}),
    publishConfig: { access: 'public' },
  };
  writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

  cpSync(join(ROOT, 'LICENSE'), join(stage, 'LICENSE'));
  writeFileSync(join(stage, 'README.md'), [
    `# ${pkg.name}`,
    '',
    pkg.description,
    '',
    pkg.bin
      ? 'Run it with nothing installed:\n\n```bash\nnpx quorum-api "running shoes" --offline\n```\n'
      : `Part of [Quorum](${REPO}). You probably want the CLI: \`npx quorum-api\`.`,
    '',
    `Docs, spec and source: ${REPO}`,
  ].join('\n'));

  const packed = run('npm', ['pack', '--pack-destination', TARBALLS], stage).trim().split('\n').pop();
  staged.set(pkg.name, { stage, tarball: join(TARBALLS, packed) });
  process.stdout.write(`  packed ${packed}\n`);
}

if (process.argv.includes('--publish')) {
  const who = run('npm', ['whoami'], ROOT).trim();
  process.stdout.write(`\npublishing as ${who}\n`);
  for (const pkg of PACKAGES) {
    run('npm', ['publish', '--access', 'public'], staged.get(pkg.name).stage);
    process.stdout.write(`  published ${pkg.name}@${VERSION}\n`);
  }
} else {
  process.stdout.write('\nDry run complete. Publish with: node scripts/publish-npm.mjs --publish\n');
}
