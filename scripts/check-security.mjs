/*
 * The security pass. Runs after build and test, because reviewing code that
 * does not yet work reviews the wrong thing.
 *
 * Design rule that matters more than any individual check: a check with nothing
 * to inspect reports PENDING, never PASS. A green board that is green because
 * the code does not exist yet is worse than a red one, since it is read as
 * evidence and it is not. Checks light up as the milestones that own them land.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SELF = 'scripts/check-security.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

const results = [];
const record = (status, name, detail) => results.push({ status, name, detail });

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT).map((f) => relative(ROOT, f));
const sourceFiles = files.filter((f) => /\.(ts|mts|mjs|js)$/.test(f) && f !== SELF);

/* 1. Secrets ---------------------------------------------------------------
 * Vendor prefixes plus the generic shape of an assignment to something named
 * like a credential. The script excludes itself, because a secret scanner that
 * contains secret patterns flags itself, which is the same trap check-copy.mjs
 * fell into on its first run.
 */
const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9]{20,}/, 'openai style key'],
  [/\bxai-[A-Za-z0-9]{20,}/, 'xai key'],
  [/\bsk-ant-[A-Za-z0-9-]{20,}/, 'anthropic key'],
  [/\bghp_[A-Za-z0-9]{30,}/, 'github token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'aws access key id'],
  [/\bapify_api_[A-Za-z0-9]{20,}/, 'apify token'],
  [/(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"]([A-Za-z0-9_\-]{24,})['"]/i, 'credential shaped assignment'],
];

/*
 * A PUBLISHED TEST VECTOR IS NOT A CREDENTIAL.
 *
 * The rule this check enforces is "never commit a secret". A value printed in
 * a public specification so that implementers can prove their signer is
 * correct is the opposite of a secret: it is only useful because everybody has
 * it, and it opens nothing.
 *
 * ALLOWLISTED BY EXACT VALUE, NEVER BY FILE, which is the part that matters. A
 * file exemption would mean any real key later pasted into that test sails
 * through. Pinned to the literal, a second credential shaped string in the same
 * file still fails, which is the case this rule exists for.
 *
 * The alternative was renaming the constant until the pattern stopped matching,
 * which is how a security check quietly becomes decoration.
 */
const PUBLISHED_VECTORS = new Set([
  /*
   * The Standard Webhooks signing vector, from the Svix documentation, used by
   * packages/server/src/webhooks.test.ts to check our signature against
   * somebody else's arithmetic rather than our own.
   */
  'whsec_plJ3nmyCDGBKInavdOK15jsl',
]);

const secretHits = [];
for (const f of files) {
  if (f === SELF || f === 'package-lock.json' || f === 'LICENSE') continue;
  if (!/\.(ts|mts|mjs|js|json|ya?ml|md|env|txt)$/.test(f) && !f.includes('.env')) continue;
  let text;
  try { text = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
  for (const [re, label] of SECRET_PATTERNS) {
    /*
     * Every occurrence, not the first, so one allowlisted vector cannot mask a
     * real credential sitting on the next line.
     */
    const all = [...text.matchAll(new RegExp(re, re.flags.includes('g') ? re.flags : `${re.flags}g`))];
    const real = all.filter((m) => !PUBLISHED_VECTORS.has(m[1] ?? m[0]));
    if (real.length) secretHits.push(`${f}: ${label}`);
  }
}
/*
 * A HIT IN A GITIGNORED FILE IS NOT A FINDING, AND THIS IS THE WHOLE POINT.
 *
 * The rule being enforced is "never COMMIT secrets". A gitignored `.env` is
 * where a working key is supposed to live, so scanning it and failing means
 * this check cannot pass on any correctly configured machine. Measured
 * 2026-08-23, the first time a real `.env` existed: the run went red on an
 * Apify token sitting exactly where it belongs. A security check that is
 * always red is a security check everybody learns to skip, which costs more
 * than the false positive does.
 *
 * So a hit is filtered only when git can confirm the file is ignored. If git
 * is missing or this is not a repo, nothing is filtered and every hit stands,
 * because the failure mode of guessing here is a committed credential.
 *
 * Only the ignore status decides. Any committed file carrying a credential
 * shaped string still fails, which is the case this exists for.
 */
const ignored = new Set();
if (secretHits.length) {
  try {
    const paths = [...new Set(secretHits.map((h) => h.slice(0, h.indexOf(': '))))];
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: ROOT, input: paths.join('\n'), encoding: 'utf8',
      /* git exits 1 when nothing matches, which is not an error here. */
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n')) if (line.trim()) ignored.add(line.trim());
  } catch (err) {
    /* Exit 1 means no path was ignored. Anything else means git could not
     * answer, and then nothing is filtered. */
    if (err.status !== 1) ignored.clear();
  }
}

const committable = secretHits.filter((h) => !ignored.has(h.slice(0, h.indexOf(': '))));
const note = ignored.size ? `, ${ignored.size} hit(s) in gitignored files not counted` : '';

if (committable.length) record('FAIL', 'secrets', committable.join('; '));
else record('PASS', 'secrets', `${files.length} files scanned, nothing credential shaped${note}`);

/* 2. gitignore coverage ----------------------------------------------------
 * A committed corpus or key is unrecoverable once the repo is public, so this
 * is checked as configuration rather than trusted as discipline.
 */
const REQUIRED_IGNORES = ['.env', '*.db', 'out/', 'node_modules/'];
if (!existsSync(join(ROOT, '.gitignore'))) {
  record('FAIL', 'gitignore', 'no .gitignore at repo root');
} else {
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  const missing = REQUIRED_IGNORES.filter((p) => !ignore.split('\n').some((l) => l.trim() === p));
  if (missing.length) record('FAIL', 'gitignore', `missing: ${missing.join(', ')}`);
  else record('PASS', 'gitignore', REQUIRED_IGNORES.join(', '));
}

/* 3. The no auth rule ------------------------------------------------------
 * The entire legal posture rests on logged off public data. A session cookie
 * or an Authorization header sent to a scraped source forfeits it, so this is
 * a test rather than a code review note.
 *
 * Paid APIs we hold accounts with are a different category and may
 * authenticate. We authenticate to Apify. We never authenticate to Meta.
 *
 * THE EXEMPTION IS PER FILE AND NAMES ITS HOST, DELIBERATELY.
 *
 * An earlier version skipped any adapter DIRECTORY whose name matched a
 * metered vendor pattern, which was too blunt in both directions: a directory
 * called anything ending in `-api` was exempt wholesale, while a vendor client
 * living inside an otherwise scraped adapter's directory could not be exempted
 * at all without exempting its neighbours.
 *
 * So each exemption is one line naming the file and the single host it may send
 * a credential to, and the check also asserts that host actually appears in the
 * file. Adding a line here is a visible, reviewable act, which is the point:
 * this rule is what the whole legal posture rests on.
 *
 * IT SCANS EVERY PACKAGE, NOT JUST THE ADAPTERS.
 *
 * It used to scan `packages/sources` alone, on the reasonable assumption that
 * adapters are the only things that talk to the outside. That stopped being
 * true the moment a vision client landed in `packages/llm` and sent an
 * Authorization header the check could not see. A security check with a blind
 * spot is worse than none, because it reports PASS over the gap.
 */
const sourcesDir = join(ROOT, 'packages/sources/src');
const PACKAGES_DIR = join(ROOT, 'packages');
const CREDENTIALLED_VENDORS = new Map([
  ['packages/sources/src/meta-ads/apify.ts', 'api.apify.com'],
  ['packages/llm/src/vision.ts', 'openrouter.ai'],
  ['packages/llm/src/expand.ts', 'openrouter.ai'],
  ['packages/llm/src/claims.ts', 'openrouter.ai'],
  /* The official GitHub REST API used as documented. Keyless works and is the
   * default; a GITHUB_TOKEN only raises the rate limit. Not scraping: the
   * never-authenticate rule protects the logged out posture on scraped
   * sources, and a vendor's documented API is the other category. */
  ['packages/sources/src/github-issues/index.ts', 'api.github.com'],
]);

/*
 * A SECOND CATEGORY, AND IT IS NOT A LOOSER VERSION OF THE FIRST.
 *
 * The rule above exists to stop us authenticating to a source we SCRAPE, which
 * is what the legal posture rests on. A client for OUR OWN API is the opposite
 * situation: the credential is the user's own key, sent to the user's own
 * service, and no scraped source is involved anywhere.
 *
 * These cannot be allowlisted by host, because they have no host. The address
 * comes from the caller, which is exactly what makes them our own client and
 * not a vendor client, so THAT is what is asserted: the file must take its
 * base url as configuration. Hardcode a vendor host into one of these and the
 * exemption stops applying, which is the property worth having.
 */
const OWN_API_CLIENTS = new Set(['packages/sdk-js/src/index.ts']);
if (!existsSync(sourcesDir) || readdirSync(sourcesDir).filter((d) => statSync(join(sourcesDir, d)).isDirectory()).length === 0) {
  record('PENDING', 'no-auth rule', 'no adapters exist yet, lands with M2');
} else {
  const adapterDirs = readdirSync(sourcesDir).filter((d) => statSync(join(sourcesDir, d)).isDirectory());
  const violations = [];
  let exempted = 0;
  const scanRoots = readdirSync(PACKAGES_DIR)
    .map((p) => join(PACKAGES_DIR, p, 'src'))
    .filter((p) => existsSync(p));
  for (const d of scanRoots) {
    for (const f of walk(d).filter((x) => /\.ts$/.test(x) && !/\.test\.ts$/.test(x))) {
      const text = readFileSync(f, 'utf8');
      if (!/['"]?(Authorization|Cookie|set-cookie)['"]?\s*:/i.test(text)) continue;

      const rel = relative(ROOT, f).split(sep).join('/');

      if (OWN_API_CLIENTS.has(rel)) {
        if (!/baseUrl/.test(text)) {
          violations.push(`${rel} is exempt as a client of our own API but does not take a baseUrl`);
        } else {
          exempted++;
        }
        continue;
      }

      const allowedHost = CREDENTIALLED_VENDORS.get(rel);
      if (!allowedHost) {
        violations.push(`${rel} sends a credential header and is not an allowlisted vendor client`);
      } else if (!text.includes(allowedHost)) {
        violations.push(`${rel} is allowlisted for ${allowedHost} but never references it`);
      } else {
        exempted++;
      }
    }
  }
  if (violations.length) record('FAIL', 'no-auth rule', violations.join('; '));
  else {
    record('PASS', 'no-auth rule',
      `${adapterDirs.length} adapter(s) and ${scanRoots.length} package(s) scanned, `
      + `${exempted} allowlisted client(s), no scraped source authenticates`);
  }
}

/* 4. SSRF ------------------------------------------------------------------
 * The core API input is a user supplied URL that the server then fetches, so
 * an unguarded fetch reads cloud instance credentials. Owned by M2.
 */
const safeFetch = join(ROOT, 'packages/sources/src/http/safe-fetch.ts');
if (!existsSync(safeFetch)) {
  record('PENDING', 'ssrf guard', 'safe-fetch.ts does not exist yet, lands with M2');
} else {
  const hasTest = existsSync(join(ROOT, 'packages/sources/src/http/safe-fetch.test.ts'));
  record(hasTest ? 'PASS' : 'FAIL', 'ssrf guard', hasTest ? 'safe-fetch present and tested' : 'safe-fetch present but UNTESTED');
}

/* 5. Prompt injection ------------------------------------------------------
 * A single injected comment must not be able to become a finding. The
 * corroboration gate is the structural defence; this asserts the test for it
 * exists. Owned by M3.
 */
const injectionTest = files.some((f) => /injection.*\.test\.ts$/.test(f) || /anti-fabrication.*\.test\.ts$/.test(f));
record(injectionTest ? 'PASS' : 'PENDING', 'injection and fabrication', injectionTest ? 'suite present' : 'lands with M3');

/* 6. Error message leakage -------------------------------------------------
 * Error strings reach customers through API responses, so an absolute path
 * leaks the server layout and a key leaks everything.
 */
const leaks = [];
for (const f of sourceFiles) {
  const text = readFileSync(join(ROOT, f), 'utf8');
  for (const m of text.matchAll(/(?:throw new Error|Error)\(\s*[`'"]([^`'"]{0,200})/g)) {
    const msg = m[1] ?? '';
    if (/\/(Users|home|var|etc)\//.test(msg)) leaks.push(`${f}: absolute path in error text`);
  }
}
if (leaks.length) record('FAIL', 'error leakage', [...new Set(leaks)].join('; '));
else record('PASS', 'error leakage', `${sourceFiles.length} source file(s), no paths or keys in error text`);

/* 7. Dependencies ----------------------------------------------------------
 * The near zero dependency count is a feature. Noise here usually means
 * something was added without going through the ask first list.
 */
try {
  execFileSync('npm', ['audit', '--audit-level=moderate'], { cwd: ROOT, stdio: 'pipe' });
  record('PASS', 'npm audit', 'no advisories at moderate or above');
} catch (err) {
  const out = String(err.stdout ?? '') + String(err.stderr ?? '');
  record('FAIL', 'npm audit', out.split('\n').filter(Boolean).slice(0, 3).join(' | ') || 'audit reported findings');
}

/* Report ------------------------------------------------------------------- */
const width = Math.max(...results.map((r) => r.name.length));
console.log('\ncheck-security\n');
for (const r of results) {
  const tag = r.status === 'PASS' ? ' ok ' : r.status === 'PENDING' ? 'pend' : 'FAIL';
  console.log(`  [${tag}] ${r.name.padEnd(width)}  ${r.detail}`);
}

const failed = results.filter((r) => r.status === 'FAIL');
const pending = results.filter((r) => r.status === 'PENDING');
console.log(`\n  ${results.length - failed.length - pending.length} passed, ${pending.length} pending, ${failed.length} failed\n`);

if (pending.length) {
  console.log('  Pending checks are NOT passes. They report that the code they');
  console.log('  inspect does not exist yet, and they turn real as their milestone lands.\n');
}

process.exit(failed.length ? 1 : 0);
