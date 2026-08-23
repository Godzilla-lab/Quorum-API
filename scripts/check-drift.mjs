/*
 * Upstream drift detection.
 *
 * WHY THIS IS THE MOST IMPORTANT SCRIPT IN THE REPO.
 *
 * Every fixture here is a photograph of a vendor that has already moved at
 * least once. The Apify rate changed by 7.6x in nine days. Hacker News comments
 * never had the `points` field an adapter filtered on, and that adapter matched
 * ZERO of 6,903 comments in production while its tests stayed green, because
 * the fixture invented the field.
 *
 * A green suite proves the code still does what it did. It cannot prove the
 * world still works the way the fixtures say. This is the only thing that can,
 * and until it existed the suite was green partly because it was asking last
 * month's questions.
 *
 * SO IT CHECKS SHAPES, NOT VALUES. A subreddit's subscriber count changes every
 * minute and that is not drift. `public_description` disappearing IS drift, and
 * it would silently empty the relevance gate that decides what enters the
 * corpus forever.
 *
 *   node scripts/check-drift.mjs              live, against real endpoints
 *   node scripts/check-drift.mjs --fixtures   the same contracts against the
 *                                             stored fixtures, which is how the
 *                                             checker itself is tested
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const UA = 'quorum/0.1 (+https://github.com/quorum)';
const FIXTURES_ONLY = process.argv.includes('--fixtures');

const results = [];
const record = (status, source, detail) => results.push({ status, source, detail });

/*
 * A contract is the fields the PARSER actually reads. It is written out longhand
 * rather than inferred, because inferring it from the code would mean the check
 * and the code agree by construction and could be wrong together.
 */
const has = (row, path) => {
  const parts = path.split('.');
  let value = row;
  for (const part of parts) {
    if (value === null || typeof value !== 'object') return false;
    value = value[part];
  }
  return value !== undefined && value !== null;
};

const anyHas = (rows, path) => rows.some((r) => has(r, path));

function checkContract(source, rows, contract) {
  if (!rows.length) { record('FAIL', source, 'returned no rows at all'); return; }

  const missing = [];
  for (const field of contract.required) {
    if (!anyHas(rows, field)) missing.push(field);
  }
  /* Fields we have MEASURED to be absent. If one appears, an assumption in the
   * adapter may now be wrong in the other direction. */
  const appeared = (contract.absent ?? []).filter((f) => anyHas(rows, f));

  if (missing.length) {
    record('FAIL', source, `no row carries ${missing.join(', ')}, which the parser reads`);
  } else if (appeared.length) {
    record('WARN', source, `${appeared.join(', ')} now present, and the adapter assumes it is absent`);
  } else {
    record('OK', source, `${rows.length} rows, all contract fields present`);
  }
}

async function getText(url) {
  const response = await fetch(url, { headers: { 'user-agent': UA } });
  if (!response.ok) throw new Error(`status ${response.status}`);
  return response.text();
}

async function getJson(url, extraHeaders = {}) {
  /*
   * The SEC returns 403 unless the User-Agent names who is calling and how to
   * reach them, which is a reasonable ask from a public archive, so a check
   * against it overrides the default agent.
   */
  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json', ...extraHeaders },
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  return response.json();
}

/* --------------------------------------------------------------------------
 * The contracts. Each one mirrors what its adapter reads and says where.
 */
const LIVE_CHECKS = [
  {
    source: 'arctic-shift/subreddits',
    /* reddit-arcticshift/relevance.ts scores name plus description. */
    contract: { required: ['display_name', 'subscribers', 'public_description'] },
    fetch: () => getJson('https://arctic-shift.photon-reddit.com/api/subreddits/search?subreddit_prefix=running&limit=5&fields=display_name,subscribers,public_description,over18'),
  },
  {
    source: 'arctic-shift/posts',
    contract: { required: ['id', 'title', 'num_comments', 'subreddit', 'created_utc'] },
    fetch: () => getJson('https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=running&limit=5&fields=id,title,selftext,score,num_comments,subreddit,created_utc'),
  },
  {
    source: 'hackernews',
    /*
     * `points` is listed as ABSENT on purpose. A previous adapter filtered on
     * it, matched 0 of 6,903 comments in production, and passed its tests
     * because a hand written fixture invented it. If it ever appears, that is
     * worth knowing.
     */
    contract: { required: ['objectID', 'comment_text', 'author', 'created_at_i'], absent: ['points'] },
    fetch: async () => (await getJson('https://hn.algolia.com/api/v1/search?query=running%20shoes&tags=comment&hitsPerPage=5')).hits,
  },
  {
    source: 'shopify/products.json',
    contract: { required: ['title', 'handle', 'variants', 'images', 'published_at', 'vendor'] },
    fetch: async () => (await getJson('https://www.allbirds.com/products.json?limit=5')).products,
  },
  {
    source: 'shopify/variant',
    /* catalogue.ts parses price as a STRING and reads availability per variant. */
    contract: { required: ['price', 'available'] },
    fetch: async () => (await getJson('https://www.allbirds.com/products.json?limit=5')).products.flatMap((p) => p.variants),
  },
  {
    source: 'wayback/availability',
    contract: { required: ['archived_snapshots.closest.url', 'archived_snapshots.closest.timestamp'] },
    fetch: async () => [await getJson('https://archive.org/wayback/available?url=allbirds.com')],
  },
  {
    source: 'openfda',
    contract: { required: ['recall_number', 'recalling_firm', 'product_description', 'reason_for_recall', 'classification', 'recall_initiation_date'] },
    fetch: async () => (await getJson('https://api.fda.gov/device/enforcement.json?search=product_description:knee&limit=5')).results,
  },
  {
    source: 'nhtsa',
    contract: { required: ['NHTSACampaignNumber', 'Manufacturer', 'Component', 'Summary', 'Consequence', 'ReportReceivedDate'] },
    fetch: async () => (await getJson('https://api.nhtsa.gov/recalls/recallsByVehicle?make=honda&model=accord&modelYear=2020')).results,
  },
  {
    source: 'eu-safety-gate',
    /*
     * XML rather than JSON, and the only published route: the site's own API is
     * not public and every guessed path returned 404. This one is listed as an
     * open data distribution on data.europa.eu.
     */
    contract: { required: ['caseNumber', 'reference', 'danger', 'notifyingCountry', 'level'] },
    fetch: async () => {
      const list = await getText('https://ec.europa.eu/safety-gate-alerts/api/download/weeklyReport/list/xml/en');
      const url = (list.match(/<URL>([\s\S]*?)<\/URL>/) ?? [])[1];
      if (!url) throw new Error('no report url in the list');
      const report = await getText(url.replace(/&amp;/g, '&').trim().replace(/[,\s]+$/, ''));
      /* Flattened to plain objects so the shared field checker can read them. */
      return [...report.matchAll(/<notifications[^>]*>([\s\S]*?)<\/notifications>/g)].map((m) => {
        const block = m[1];
        const row = {};
        for (const field of ['caseNumber', 'reference', 'danger', 'notifyingCountry', 'level']) {
          const hit = new RegExp(`<${field}>([\\s\\S]*?)</${field}>`).exec(block);
          row[field] = hit ? hit[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim() : undefined;
        }
        return row;
      });
    },
  },
  {
    source: 'sec-edgar',
    /*
     * The search returns metadata only, with no snippet, which is why this
     * adapter fetches the filing itself. `_id` and `ciks` are what the archive
     * url is assembled from, and losing either makes every filing unfetchable.
     */
    contract: { required: ['_id', '_source.ciks', '_source.display_names', '_source.adsh', '_source.file_date'] },
    fetch: async () => (await getJson('https://efts.sec.gov/LATEST/search-index?q=%22running+shoes%22&forms=10-K', { 'user-agent': 'Quorum drift-check@madebyhexa.co' })).hits.hits,
  },
  {
    source: 'appstore',
    /* The parser reads the label of each of these, and `im:rating` is the star
     * rating that the score kind table renders as stars rather than points. */
    contract: { required: ['id.label', 'title.label', 'content.label', 'im:rating.label'] },
    fetch: async () => (await getJson('https://itunes.apple.com/us/rss/customerreviews/id=1232780281/sortBy=mostRecent/page=1/json')).feed.entry,
  },
  {
    source: 'cpsc',
    /*
     * `Manufacturers` is deliberately NOT required. Measured on 36 real
     * recalls, it is populated on only 17, which is why the responsible firm is
     * parsed out of the title instead. Requiring it here would make this check
     * fail on a healthy endpoint.
     */
    contract: { required: ['RecallNumber', 'RecallDate', 'Title', 'Description', 'URL', 'Products', 'Hazards'] },
    fetch: () => getJson('https://www.saferproducts.gov/RestWebServices/Recall?format=json&ProductName=treadmill'),
  },
];

/* --------------------------------------------------------------------------
 * Fixture mode. Runs the same contracts against what is stored, which is how
 * this checker is itself tested: break a fixture and it must go red.
 */
const FIXTURE_CHECKS = [
  {
    source: 'arctic-shift/subreddits',
    contract: { required: ['display_name', 'subscribers', 'public_description'] },
    load: () => JSON.parse(readFileSync(join(ROOT, 'packages/sources/src/reddit-arcticshift/fixtures/subreddits-search.json'), 'utf8')),
  },
  {
    source: 'hackernews',
    contract: { required: ['objectID', 'comment_text', 'author', 'created_at_i'], absent: ['points'] },
    load: () => JSON.parse(readFileSync(join(ROOT, 'packages/sources/src/hackernews/fixtures/search-comments.json'), 'utf8')),
  },
  {
    source: 'cpsc',
    contract: { required: ['RecallNumber', 'RecallDate', 'Title', 'Description', 'URL', 'Products', 'Hazards'] },
    load: () => JSON.parse(readFileSync(join(ROOT, 'packages/sources/src/cpsc/fixtures/recall-search.json'), 'utf8')),
  },
  {
    source: 'openfda',
    contract: { required: ['recall_number', 'recalling_firm', 'product_description', 'reason_for_recall', 'classification', 'recall_initiation_date'] },
    load: () => JSON.parse(readFileSync(join(ROOT, 'packages/sources/src/openfda/fixtures/device-enforcement.json'), 'utf8')).results,
  },
  {
    source: 'nhtsa',
    contract: { required: ['NHTSACampaignNumber', 'Manufacturer', 'Component', 'Summary', 'Consequence', 'ReportReceivedDate'] },
    load: () => JSON.parse(readFileSync(join(ROOT, 'packages/sources/src/nhtsa/fixtures/recalls-by-vehicle.json'), 'utf8')).results,
  },
  {
    source: 'sec-edgar',
    contract: { required: ['_id', '_source.ciks', '_source.display_names', '_source.adsh', '_source.file_date'] },
    load: () => JSON.parse(readFileSync(join(ROOT, 'packages/sources/src/sec-edgar/fixtures/full-text-search.json'), 'utf8')).hits.hits,
  },
  {
    source: 'appstore',
    contract: { required: ['id.label', 'title.label', 'content.label', 'im:rating.label'] },
    load: () => JSON.parse(readFileSync(join(ROOT, 'packages/sources/src/appstore/fixtures/customer-reviews.json'), 'utf8')).feed.entry,
  },
  {
    source: 'meta-ads/apify',
    /* creative.ts reads the media arrays; apify.ts reads the rest. */
    contract: { required: ['ad_archive_id', 'page_name', 'is_active', 'start_date', 'end_date', 'publisher_platform', 'snapshot.body.text'] },
    load: () => JSON.parse(readFileSync(join(ROOT, 'packages/sources/src/meta-ads/fixtures/ad-library-search.json'), 'utf8')),
  },
];

const unwrap = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.hits)) return payload.hits;
  return [payload];
};

console.log(`\ncheck-drift  ${FIXTURES_ONLY ? '(fixtures)' : '(live)'}\n`);

if (FIXTURES_ONLY) {
  for (const check of FIXTURE_CHECKS) {
    try {
      checkContract(check.source, unwrap(check.load()), check.contract);
    } catch (error) {
      record('FAIL', check.source, `fixture could not be read: ${error.message}`);
    }
  }
} else {
  for (const check of LIVE_CHECKS) {
    try {
      checkContract(check.source, unwrap(await check.fetch()), check.contract);
    } catch (error) {
      /*
       * A vendor being down is not drift, and failing the build for it would
       * teach everyone to ignore this job. It is reported and does not fail.
       */
      record('SKIP', check.source, `unreachable: ${error.message}`);
    }
  }
}

const width = Math.max(...results.map((r) => r.source.length));
for (const r of results) {
  const tag = { OK: ' ok ', FAIL: 'FAIL', WARN: 'warn', SKIP: 'skip' }[r.status];
  console.log(`  [${tag}] ${r.source.padEnd(width)}  ${r.detail}`);
}

const failed = results.filter((r) => r.status === 'FAIL').length;
const warned = results.filter((r) => r.status === 'WARN').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;
console.log(`\n  ${results.length - failed - warned - skipped} ok, ${warned} warning(s), ${skipped} unreachable, ${failed} drifted\n`);

if (failed) {
  console.log('  Upstream no longer matches what an adapter reads. Recapture the');
  console.log('  fixture and fix the parser BEFORE trusting any test that uses it.\n');
  process.exitCode = 1;
}
