import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runSourceConformance, makeCtx } from '../conformance.ts';
import { cleanIssueBody, createGithubIssuesSource, repoFromUrl } from './index.ts';
import { createThrottle } from '../throttle.ts';
import type { SafeFetchResult } from '../http/safe-fetch.ts';

/* Captured live 2026-08-24 from a keyless search for '"playwright" flaky'.
 * Captured, never authored. See the adapter header for why that matters. */
const FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures/search-issues.json'), 'utf8');

const instantThrottle = () => createThrottle({ sleep: async () => {}, random: () => 0 });

const respond = (body: string, status = 200): typeof import('../http/safe-fetch.ts').safeFetch =>
  async (url, opts) => {
    void opts;
    return { ok: status >= 200 && status < 300, status, headers: {}, body, url } as SafeFetchResult;
  };

const PLAN = {
  category: 'playwright', productTitle: 'Playwright', productUrl: 'https://example.com',
  terms: ['flaky', 'timeout'],
};

runSourceConformance('github', () => ({
  source: createGithubIssuesSource({ throttle: instantThrottle(), fetch: respond(FIXTURE) }),
  configuredEnv: {},
  planInput: PLAN,
}));

test('github needs no key at all', () => {
  const s = createGithubIssuesSource();
  assert.equal(s.configured({}), true, 'a fresh clone with no keys must still get this source');
  assert.equal(s.cost, 'free');
  assert.equal(s.channelKind, 'handle', 'a repo name is an identifier, not prose');
});

test('the category is quoted as a phrase in every query', async () => {
  const s = createGithubIssuesSource();
  const queries = await s.plan(PLAN);
  assert.deepEqual(queries.map((q) => q.text), ['"playwright" flaky', '"playwright" timeout']);
});

test('real captured issues come back as records with reactions as the score', async () => {
  const s = createGithubIssuesSource({ throttle: instantThrottle(), fetch: respond(FIXTURE) });
  await s.plan(PLAN);
  const out = [];
  for await (const r of s.retrieve({ text: '"playwright" flaky' }, makeCtx())) out.push(r);

  assert.ok(out.length > 0, 'the captured page holds real playwright issues');
  const first = out[0]!;
  assert.equal(first.source, 'github');
  assert.equal(first.kind, 'post');
  assert.match(first.externalId, /^[^/]+\/[^#]+#\d+$/, 'owner/repo#number, stable and human readable');
  assert.match(first.channel ?? '', /playwright/i);
  assert.ok((first.score ?? 0) > 0, 'the fixture was sorted by reactions, so the top item has some');
  assert.match(first.url ?? '', /^https:\/\/github\.com\//);
  assert.ok((first.createdUtc ?? 0) > 1_500_000_000, 'created_at parses to unix seconds');
});

test('a pull request in the results is not a record, whatever the query asked', async () => {
  const item = (over: Record<string, unknown>) => ({
    number: 7, title: 'Playwright timeout when the suite is flaky and slow on CI runners',
    body: 'Playwright keeps timing out on our flaky suite and the retries make it worse.',
    html_url: 'https://github.com/o/r/issues/7',
    repository_url: 'https://api.github.com/repos/o/playwright-helpers',
    created_at: '2026-01-01T00:00:00Z', reactions: { total_count: 3 },
    ...over,
  });
  const body = JSON.stringify({ items: [item({}), item({ number: 8, pull_request: { url: 'x' } })] });
  const s = createGithubIssuesSource({ throttle: instantThrottle(), fetch: respond(body) });
  await s.plan(PLAN);
  const out = [];
  for await (const r of s.retrieve({ text: '"playwright" flaky' }, makeCtx())) out.push(r);
  assert.deepEqual(out.map((r) => r.externalId), ['o/playwright-helpers#7'],
    'the PR is our code churn, not a user report');
});

/*
 * The repo name never vouches for its records: the subject has to appear in
 * the issue text itself. Same reasoning as the r/woolworths failure, and the
 * price is stated in the adapter: elliptical issues inside a product's own
 * repo are lost, because a false receipt costs more than a missing one.
 */
test('an issue that never names the subject is gated out even inside a matching repo', async () => {
  const body = JSON.stringify({
    items: [{
      number: 9, title: 'Crash on startup after upgrading the runner image to the latest tag',
      body: 'The process exits immediately with code 137 and nothing in the logs.',
      html_url: 'https://github.com/microsoft/playwright/issues/9',
      repository_url: 'https://api.github.com/repos/microsoft/playwright',
      created_at: '2026-01-01T00:00:00Z', reactions: { total_count: 40 },
    }],
  });
  const s = createGithubIssuesSource({ throttle: instantThrottle(), fetch: respond(body) });
  await s.plan(PLAN);
  const out = [];
  for await (const r of s.retrieve({ text: '"playwright" flaky' }, makeCtx())) out.push(r);
  assert.deepEqual(out, []);
});

test('code fences, template comments and images do not reach the corpus', () => {
  const cleaned = cleanIssueBody(
    'The sync fails.\n```js\nconst x = 1;\nawait sync();\n```\n<!-- template: fill this in -->'
    + '\n![screenshot](https://example.com/a.png)\nEvery time.',
  );
  assert.equal(cleaned, 'The sync fails. Every time.');
});

test('the repo name derives from the api url', () => {
  assert.equal(repoFromUrl('https://api.github.com/repos/microsoft/playwright'), 'microsoft/playwright');
});

test('a token is sent when present, trimmed, and absent when keyless', async () => {
  const seen: (string | undefined)[] = [];
  const capture: typeof import('../http/safe-fetch.ts').safeFetch = async (url, opts) => {
    seen.push((opts?.headers as Record<string, string> | undefined)?.['authorization']);
    return { ok: true, status: 200, headers: {}, body: '{"items":[]}', url } as SafeFetchResult;
  };
  const s = createGithubIssuesSource({ throttle: instantThrottle(), fetch: capture });
  await s.plan(PLAN);
  for await (const r of s.retrieve({ text: 'x' }, makeCtx({ env: {} }))) void r;
  for await (const r of s.retrieve({ text: 'x' }, makeCtx({ env: { GITHUB_TOKEN: 'tok\n' } }))) void r;
  assert.deepEqual(seen, [undefined, 'Bearer tok'],
    'keyless sends no credential, and a pasted newline never reaches the header');
});

test('a rate limited response degrades the run rather than failing it', async () => {
  const s = createGithubIssuesSource({ throttle: instantThrottle(), fetch: respond('', 403) });
  await s.plan(PLAN);
  const logs: string[] = [];
  const out = [];
  for await (const r of s.retrieve({ text: 'x' }, makeCtx({ log: (l) => logs.push(l) }))) out.push(r);
  assert.deepEqual(out, []);
  assert.match(logs.join(' '), /github/);
});

test('a date window becomes a created filter in the search query', async () => {
  let sent = '';
  const capture: typeof import('../http/safe-fetch.ts').safeFetch = async (url) => {
    sent = url;
    return { ok: true, status: 200, headers: {}, body: '{"items":[]}', url } as SafeFetchResult;
  };
  const s = createGithubIssuesSource({ throttle: instantThrottle(), fetch: capture });
  await s.plan(PLAN);
  for await (const r of s.retrieve({ text: 'x', withinDays: 30 }, makeCtx())) void r;
  assert.match(decodeURIComponent(sent), /created:>=\d{4}-\d{2}-\d{2}/);
  assert.match(decodeURIComponent(sent), /is:issue/);
});
