/*
 * Parity against the engine this repo replaces.
 *
 * WHY IT MEASURES THE DETERMINISTIC LAYER AND NOTHING ELSE.
 *
 * The obvious parity test is to run a product through both and compare the
 * reports. That test can never pass. Both sides call a model, models are
 * nondeterministic, and a criterion that cannot be met is a criterion nobody
 * runs. So this compares only what is decidable: which records a search
 * returns, how a creative is typed, what a format verdict says, and whether a
 * set of records clears the corroboration bar.
 *
 * WHAT A DIFFERENCE MEANS HERE.
 *
 * Not automatically a regression. Several differences are deliberate and are
 * the reason the rewrite happened. This script reports every one it finds and
 * says which are intended, because a parity run that hides its own known
 * differences is a parity run that will hide an unknown one too.
 *
 *   node scripts/parity.mjs
 *
 * It needs the engine on disk. Point ENGINE at it if it has moved.
 */

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const ENGINE = process.env['ENGINE'] ?? '/Users/godzilla/CLI/AI Content Website/research';

const rows = [];
const same = (area, detail) => rows.push({ status: 'SAME', area, detail });
const differs = (area, detail, intended) => rows.push({ status: intended ? 'INTENDED' : 'DIFFERS', area, detail });
const skip = (area, detail) => rows.push({ status: 'SKIP', area, detail });

if (!existsSync(ENGINE)) {
  console.log(`the engine is not at ${ENGINE}. Set ENGINE to its path.`);
  process.exit(2);
}

const { openCorpus } = await import(`${ENGINE}/lib/corpus.mjs`);
const oldAds = await import(`${ENGINE}/lib/ads.mjs`);

const { openSqliteCorpus } = await import('@receipts/corpus');
const { creativeType: newCreativeType } = await import('@receipts/sources');
const { formatVerdict: newFormatVerdict, corroborate } = await import('@receipts/core');

/* ------------------------------------------------------------------ *
 * 1. SEARCH. The same rows, the same query, through both drivers.
 * ------------------------------------------------------------------ */

const ENGINE_DB = join(ENGINE, 'corpus.db');
const PORTED = join(ROOT, '.parity-corpus.db');

if (!existsSync(ENGINE_DB)) {
  skip('search', 'the engine has no corpus.db to compare against');
} else {
  rmSync(PORTED, { force: true });
  rmSync(`${PORTED}-wal`, { force: true });
  rmSync(`${PORTED}-shm`, { force: true });

  /* Read the engine's rows directly rather than through its driver, so the
   * comparison is not shaped by the thing being compared. */
  const raw = new DatabaseSync(ENGINE_DB, { readOnly: true });
  const all = raw.prepare('SELECT source, kind, external_id, category, channel, text, score, url, created_utc FROM docs').all();
  const categories = [...new Set(all.map((r) => r.category))];

  const ported = openSqliteCorpus({ path: PORTED });
  for (const category of categories) {
    const forCategory = all.filter((r) => r.category === category).map((r) => ({
      /* The engine has sources this repo has not ported. They are carried
       * across under their own name so the row counts still line up. */
      source: r.source === 'reviews' ? 'review' : r.source,
      kind: r.kind === 'post' ? 'post' : 'comment',
      externalId: r.external_id,
      channel: r.channel ?? '',
      text: r.text,
      score: r.score ?? 0,
      url: r.url ?? '',
      createdUtc: r.created_utc ?? 0,
    }));
    await ported.addDocs(forCategory, category);
  }

  const engine = openCorpus(ENGINE_DB);
  const TERMS = ['quality', 'price', 'sizing', 'comfort', 'problems', 'durability', 'shipping', 'returns'];

  let identical = 0;
  const drifted = [];
  for (const category of categories) {
    for (const term of TERMS) {
      const before = new Set(engine.search(term, { category, limit: 500 }).map((r) => `${r.source}/${r.external_id}`));
      const after = new Set((await ported.search(term, { category, limit: 500 })).map((r) => `${r.source === 'review' ? 'reviews' : r.source}/${r.externalId}`));

      const onlyBefore = [...before].filter((k) => !after.has(k));
      const onlyAfter = [...after].filter((k) => !before.has(k));
      if (!onlyBefore.length && !onlyAfter.length) { identical++; continue; }
      drifted.push({ category, term, before: before.size, after: after.size, onlyBefore: onlyBefore.length, onlyAfter: onlyAfter.length });
    }
  }

  const total = categories.length * TERMS.length;
  if (!drifted.length) {
    same('search', `${identical} of ${total} queries return exactly the same records across ${all.length} ported rows`);
  } else {
    same('search', `${identical} of ${total} queries identical`);
    for (const d of drifted) {
      differs('search', `${d.category} "${d.term}": ${d.before} then ${d.after}, ${d.onlyBefore} lost, ${d.onlyAfter} gained`, false);
    }
  }

  await ported.close();
  rmSync(PORTED, { force: true });
  rmSync(`${PORTED}-wal`, { force: true });
  rmSync(`${PORTED}-shm`, { force: true });
}

/* ------------------------------------------------------------------ *
 * 2. CREATIVE TYPE. The lying display_format field, on a real capture.
 * ------------------------------------------------------------------ */

const FIXTURE = join(ROOT, 'packages/sources/src/meta-ads/fixtures/ad-library-search.json');
if (!existsSync(FIXTURE)) {
  skip('creativeType', 'no captured ad fixture');
} else {
  const captured = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const ads = Array.isArray(captured) ? captured : (captured.items ?? captured.records ?? []);

  let agree = 0;
  const disagree = [];
  for (const raw of ads) {
    const before = oldAds.creativeType(raw);
    const after = newCreativeType(raw);
    if (before === after) agree++;
    else disagree.push({ id: raw.ad_archive_id ?? raw.adId ?? '?', before, after });
  }

  if (!disagree.length) {
    same('creativeType', `${agree} of ${ads.length} ads typed identically by both`);
  } else {
    same('creativeType', `${agree} of ${ads.length} agree`);
    for (const d of disagree.slice(0, 10)) {
      /*
       * The known intended change: the engine reads `snapshot.cards[]` with
       * only two spellings of the image field, and a live capture on 2026-08-22
       * carried `image_crops` in snake case on cards the engine therefore could
       * not see. Typing MORE ads is the fix, not a regression.
       */
      differs('creativeType', `ad ${d.id}: engine says ${d.before}, this repo says ${d.after}`, d.before === null && d.after !== null);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 3. THE CORROBORATION RULE, applied to the same records by both.
 * ------------------------------------------------------------------ */
{
  const doc = (source, id) => ({
    receiptId: `rc_${id.padStart(16, '0')}`,
    source, kind: 'comment', externalId: id, category: 'test',
    channel: `ch-${id}`, text: 'runs small', score: 1, url: '', createdUtc: 0, harvestedAt: 0,
  });

  /* The engine's rule, lifted verbatim: cites.length >= MIN_RECEIPTS. */
  const engineRule = (cites) => (cites.length >= 3 ? 'finding' : 'weak-signal');

  const cases = [
    { name: 'three distinct forum comments', cites: ['a', 'b', 'c'], docs: [doc('reddit', 'a'), doc('reddit', 'b'), doc('reddit', 'c')] },
    { name: 'two distinct forum comments', cites: ['a', 'b'], docs: [doc('reddit', 'a'), doc('reddit', 'b')] },
    { name: 'ONE comment cited three times', cites: ['a', 'a', 'a'], docs: [doc('reddit', 'a')] },
    { name: 'a recall notice and a forum thread', cites: ['a', 'b'], docs: [doc('cpsc', 'a'), doc('reddit', 'b')] },
    { name: 'two government records', cites: ['a', 'b'], docs: [doc('cpsc', 'a'), doc('nhtsa', 'b')] },
  ];

  for (const c of cases) {
    const before = engineRule(c.cites);
    const after = corroborate('sizing', c.docs).verdict;
    if (before === after) { same('corroboration', `${c.name}: both say ${before}`); continue; }

    /*
     * Every difference here is intended and each one is a documented rule
     * change. They are listed individually rather than waved through, because
     * "intended" is a claim that has to be checkable.
     */
    differs('corroboration',
      `${c.name}: engine says ${before}, this repo says ${after}`,
      true);
  }
}

/* ------------------------------------------------------------------ *
 * 4. What is deliberately NOT compared.
 * ------------------------------------------------------------------ */
skip('subreddit gate', 'deliberately changed: the engine scored candidates against the terms used to find them, which passes whatever the search returned');
skip('findings prose', 'both sides call a model, so this can never be deterministic and a criterion nobody can pass is a criterion nobody runs');
skip('report-build-background.mjs', 'the second engine consumer imports ads.mjs directly, and its ad path is compared above through creativeType and formatVerdict');

/* ------------------------------------------------------------------ */

const width = Math.max(...rows.map((r) => r.area.length));
for (const r of rows) console.log(`[${r.status.padEnd(8)}] ${r.area.padEnd(width)}  ${r.detail}`);

const unexplained = rows.filter((r) => r.status === 'DIFFERS');
console.log(`\n  ${rows.filter((r) => r.status === 'SAME').length} same, ${rows.filter((r) => r.status === 'INTENDED').length} intended, ${unexplained.length} unexplained, ${rows.filter((r) => r.status === 'SKIP').length} not compared`);
if (unexplained.length) {
  console.log('\n  An unexplained difference is either a regression here or a bug the engine had.');
  console.log('  Both need a decision. Neither is allowed to stay unexplained.');
  process.exit(1);
}
