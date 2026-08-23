/*
 * The README, checked against the repository it describes.
 *
 * WHY THIS EXISTS. Three claims in this README were false at the same time and
 * survived several careful readings: a deployment state that had changed, a
 * feature described as missing that was not, and a test count nobody had
 * recounted. Rereading is not a check. A claim nobody verifies mechanically is
 * the default state of every README by day two hundred.
 *
 * So this asserts the handful of claims that CAN be settled from the repo:
 * every link points at something that exists, every anchor points at a heading
 * that exists, and the three numbers the README advertises match the tools that
 * produce them.
 *
 * It deliberately does not try to judge prose. It catches the class of mistake
 * that actually shipped, which was arithmetic and stale facts, not wording.
 *
 * Follows check-security.mjs: a check with nothing to inspect reports PENDING,
 * never PASS.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(ROOT, 'README.md');
const WITH_TESTS = process.argv.includes('--tests');

const text = readFileSync(README, 'utf8');
const results = [];
const record = (state, name, detail) => results.push({ state, name, detail });

/* 1. Links -----------------------------------------------------------------
 * TRACKED BY GIT, NOT MERELY PRESENT ON DISK, and the difference is the whole
 * check.
 *
 * `existsSync` was the first attempt and it is useless here. `docs/PRD.md` and
 * `SPEC.md` sit in this working tree and are not committed, so a link to either
 * resolves perfectly on the machine of the person who wrote it and 404s for
 * every single reader. That is the exact shape of the bug this file exists to
 * catch, and testing it proved the first version did not catch it.
 *
 * If git cannot answer, the check falls back to disk and says so, because
 * reporting PASS on evidence it does not have is how a check becomes theatre.
 */
const links = [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
const relative = links.filter((l) => !/^(https?:|#|mailto:)/.test(l));

let tracked = null;
try {
  tracked = new Set(
    execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean),
  );
} catch { tracked = null; }

const targets = relative.map((l) => l.split('#')[0].replace(/\/$/, ''));
const missing = tracked
  /* A directory link is fine when git tracks anything beneath it. */
  ? relative.filter((l, i) => !tracked.has(targets[i]) && ![...tracked].some((f) => f.startsWith(`${targets[i]}/`)))
  : relative.filter((l, i) => !existsSync(join(ROOT, targets[i])));

if (!relative.length) record('PENDING', 'links', 'no relative links to check');
else if (missing.length) {
  record('FAIL', 'links', tracked
    ? `not committed, so these 404 for every reader: ${missing.join(', ')}`
    : `missing: ${missing.join(', ')}`);
} else if (!tracked) {
  record('PENDING', 'links', `${relative.length} link(s) exist on disk, but git could not confirm they are committed`);
} else record('PASS', 'links', `${relative.length} relative link(s), all committed`);

/* 2. Anchors ---------------------------------------------------------------
 * A table of contents that points at a heading somebody renamed is worse than
 * no table of contents, because it looks maintained.
 */
const headings = [...text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => m[1]);
const slugs = new Set(headings.map((h) => h
  .toLowerCase()
  .replace(/<[^>]+>/g, '')
  .replace(/[^\w\s-]/g, '')
  .trim()
  .replace(/\s+/g, '-')));

const anchors = links.filter((l) => l.startsWith('#')).map((l) => l.slice(1));
const danglingAnchors = anchors.filter((a) => !slugs.has(a));

if (!anchors.length) record('PENDING', 'anchors', 'no in page links to check');
else if (danglingAnchors.length) record('FAIL', 'anchors', `no such heading: ${danglingAnchors.join(', ')}`);
else record('PASS', 'anchors', `${anchors.length} in page link(s), all resolve`);

/* 3. Runtime dependencies --------------------------------------------------
 * "One runtime dependency" is a claim that quietly stops being true the first
 * time somebody reaches for a convenience, which is exactly when it matters.
 */
const workspaces = readFileSync(join(ROOT, 'package.json'), 'utf8');
const wsDirs = JSON.parse(workspaces).workspaces ?? [];
const deps = new Set();
for (const pattern of wsDirs) {
  const base = pattern.replace(/\/\*$/, '');
  let entries = [];
  try { entries = execFileSync('ls', [join(ROOT, base)], { encoding: 'utf8' }).split('\n').filter(Boolean); }
  catch { /* no such directory */ }
  for (const entry of entries) {
    const pkg = join(ROOT, base, entry, 'package.json');
    if (!existsSync(pkg)) continue;
    for (const d of Object.keys(JSON.parse(readFileSync(pkg, 'utf8')).dependencies ?? {})) {
      if (!d.startsWith('@quorum/')) deps.add(d);
    }
  }
}
for (const d of Object.keys(JSON.parse(workspaces).dependencies ?? {})) deps.add(d);

const claimedDeps = /\*\*one runtime dependency\*\*, `([^`]+)`/.exec(text);
if (!claimedDeps) record('PENDING', 'dependencies', 'the README makes no dependency claim to check');
else if (deps.size !== 1 || !deps.has(claimedDeps[1])) {
  record('FAIL', 'dependencies', `README says one runtime dependency (${claimedDeps[1]}), the workspaces declare ${deps.size}: ${[...deps].join(', ') || 'none'}`);
} else record('PASS', 'dependencies', `one runtime dependency, ${claimedDeps[1]}, as claimed`);

/* 4. Node version ----------------------------------------------------------- */
const engines = JSON.parse(readFileSync(join(ROOT, 'packages/server/package.json'), 'utf8')).engines?.node ?? '';
const claimedNode = /\*\*Node (\d+\.\d+) or newer\*\*/.exec(text);
if (!claimedNode) record('PENDING', 'node version', 'the README makes no node version claim');
else if (!engines.includes(claimedNode[1])) {
  record('FAIL', 'node version', `README says ${claimedNode[1]}, engines says ${engines}`);
} else record('PASS', 'node version', `${claimedNode[1]}, matching engines ${engines}`);

/* 5. Test count -------------------------------------------------------------
 * The expensive one, and the one that was wrong. Run with --tests, which the
 * verify chain does. Without it this reports PENDING rather than PASS, because
 * a number nobody counted is exactly what this file exists to stop.
 */
const claimedCounts = [...text.matchAll(/([\d,]{3,})\s*(?:tests|%2C\d+)/g)]
  .map((m) => Number(m[1].replace(/[,]/g, '')))
  .filter((n) => Number.isFinite(n) && n > 0);
const badgeCount = /tests-([\d%,C]+)-/.exec(text);
if (badgeCount) {
  const n = Number(decodeURIComponent(badgeCount[1]).replace(/,/g, ''));
  if (Number.isFinite(n)) claimedCounts.push(n);
}
const claimed = [...new Set(claimedCounts)];

if (!claimed.length) {
  record('PENDING', 'test count', 'the README advertises no test count');
} else if (claimed.length > 1) {
  record('FAIL', 'test count', `the README advertises ${claimed.length} different counts: ${claimed.join(', ')}`);
} else if (!WITH_TESTS) {
  record('PENDING', 'test count', `README says ${claimed[0]}, pass --tests to count for real`);
} else {
  let actual = null;
  try {
    const out = execFileSync('node', ['--disable-warning=ExperimentalWarning', '--test', 'packages/**/*.test.ts'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    actual = Number(/^# tests (\d+)$/m.exec(out)?.[1]);
  } catch (err) {
    actual = Number(/^# tests (\d+)$/m.exec(err.stdout ?? '')?.[1]);
  }
  if (!Number.isFinite(actual)) record('PENDING', 'test count', 'the suite did not report a count');
  else if (actual !== claimed[0]) record('FAIL', 'test count', `README says ${claimed[0]}, the suite reports ${actual}`);
  else record('PASS', 'test count', `${actual}, as claimed`);
}

/* Report ------------------------------------------------------------------- */
const width = Math.max(...results.map((r) => r.name.length));
process.stdout.write('\ncheck-readme\n\n');
for (const r of results) {
  const tag = r.state === 'PASS' ? '[ ok ]' : r.state === 'PENDING' ? '[ ?? ]' : '[FAIL]';
  process.stdout.write(`  ${tag} ${r.name.padEnd(width)}  ${r.detail}\n`);
}
const failed = results.filter((r) => r.state === 'FAIL').length;
const pending = results.filter((r) => r.state === 'PENDING').length;
process.stdout.write(`\n  ${results.length - failed - pending} passed, ${pending} pending, ${failed} failed\n\n`);
if (failed) {
  process.stdout.write('  The README and the repository disagree. The repository is the one that runs.\n\n');
  process.exit(1);
}
