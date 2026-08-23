/*
 * House style enforcement: no em dashes, no en dashes, anywhere we author.
 *
 * This is a script rather than a review note because models reach for these
 * characters constantly and a human reviewer will not catch every one. The
 * engine already strips them at the render layer for generated report copy;
 * this covers the other half, which is everything a person or an agent writes
 * by hand: docs, comments, error strings, READMEs.
 *
 * Third party text is exempt. LICENSE is canonical Apache 2.0 and is not ours
 * to edit, so it is skipped on principle even though it currently happens to
 * contain neither character.
 *
 * CAPTURED FIXTURE DATA IS EXEMPT FOR A STRONGER REASON THAN CONVENIENCE.
 *
 * A fixture is evidence. It records what a vendor actually returned, and real
 * ad copy and real forum comments are full of em dashes because real people and
 * real marketers write them. Editing a fixture to satisfy our house style would
 * falsify the recording, and the whole project rests on captured payloads being
 * exactly what came back. Measured 2026-08-22: a real 30 ad Meta capture carried
 * 52 of them.
 *
 * So third party TEXT is stripped at the render layer, where it becomes our
 * copy, and never at the point of capture. Only `.json` under a `fixtures/`
 * directory is exempt. A README beside it is ours and is still checked.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.claude']);
const SKIP_FILES = new Set(['LICENSE', 'package-lock.json']);
const CHECK_EXT = /\.(md|ts|mts|mjs|js|json|ya?ml|txt)$/;
/* Captured vendor payloads. Evidence, not copy. See the header. */
const CAPTURED_DATA = /[\\/]fixtures[\\/].*\.json$/;

/*
 * U+2014 em dash, U+2013 en dash.
 *
 * Built from code points rather than written as literals, because a checker
 * that contains the characters it searches for flags itself. That is not a
 * hypothetical: the first version of this file failed its own run, which is a
 * good sign for the checker and a bad property for the source.
 */
const EM_DASH = String.fromCodePoint(0x2014);
const EN_DASH = String.fromCodePoint(0x2013);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || SKIP_FILES.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CHECK_EXT.test(entry) && !CAPTURED_DATA.test(full)) out.push(full);
  }
  return out;
}

const offences = [];

for (const file of walk(ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [name, ch] of [['em dash', EM_DASH], ['en dash', EN_DASH]]) {
      let col = line.indexOf(ch);
      while (col !== -1) {
        offences.push({ file: relative(ROOT, file), line: i + 1, col: col + 1, name, text: line.trim() });
        col = line.indexOf(ch, col + 1);
      }
    }
  });
}

if (offences.length) {
  console.error(`\ncheck-copy: ${offences.length} dash offence(s)\n`);
  for (const o of offences) {
    console.error(`  ${o.file}:${o.line}:${o.col}  ${o.name}`);
    console.error(`    ${o.text.slice(0, 100)}`);
  }
  console.error('\nUse a comma, a colon, parentheses, or two sentences instead.\n');
  process.exit(1);
}

console.log('check-copy: clean, no em dashes or en dashes found');
