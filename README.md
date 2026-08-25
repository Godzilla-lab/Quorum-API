<div align="center">

# Quorum

**Market evidence with receipts.**

Give it a subject, get back what a market actually says. Every claim carries
receipt ids, and every receipt id resolves to a real stored record you can fetch
back. Fabricated citations are structurally impossible, and a test proves it
rather than a README asserting it.

[![CI](https://github.com/Godzilla-lab/Quorum-API/actions/workflows/ci.yml/badge.svg)](https://github.com/Godzilla-lab/Quorum-API/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen.svg)](https://nodejs.org)
[![npm](https://img.shields.io/npm/v/quorum-api.svg)](https://www.npmjs.com/package/quorum-api)
[![Tests](https://img.shields.io/badge/tests-1%2C232-brightgreen.svg)](#development)
[![Runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-1-brightgreen.svg)](#requirements)
[![OpenAPI](https://img.shields.io/badge/OpenAPI-3.1-6ba539.svg)](spec/openapi.yaml)

</div>

> [!TIP]
> The interesting part is not that it finds evidence. It is that you can check
> it. Every id in every answer resolves through `GET /v1/evidence/{id}`, and
> `POST /v1/verify` will re-resolve a set of claims against the corpus, ours or
> anybody else's. An id that does not resolve is a claim that was never real.

```json
{
  "finding": "Sizing runs small, and buyers only discover it after delivery",
  "corroboration": { "records": 31, "channels": 5 },
  "receipts": ["rc_8f2a1", "rc_44b0e", "rc_91c37"],
  "confidence": "finding"
}
```

`GET /v1/evidence/rc_8f2a1` returns the actual comment, its score, where it was
posted, when, and its permalink. A customer of your customer can click a claim
and read the human who said it.

The hosted API lives at **https://quorum-api-j15n.onrender.com**, on a free
tier instance that sleeps when idle, so the first request after a quiet spell
waits a few seconds for it to wake.

**The hosted instance is keyed while the API is early.** The
[API root](https://quorum-api-j15n.onrender.com) says how to request a key,
and always says which mode the instance you are talking to is in. The health
endpoint needs no key, so you can check it is alive right now:

```bash
curl https://quorum-api-j15n.onrender.com/v1/healthz
```

Self hosting supports open mode or per key auth, quotas, tenancy and webhook
secrets, all self served from `GET /v1/usage`.

> [!NOTE]
> On Windows, the curl bundled with Git Bash uses the Schannel TLS stack,
> which refuses any HTTPS connection when it cannot reach the certificate
> revocation servers (`CRYPT_E_REVOCATION_OFFLINE`, common behind corporate
> proxies and VPNs). That is the network, not this API. Add
> `--ssl-revoke-best-effort` to the curl command, or call from WSL or
> PowerShell instead.

## Contents

- [What it does](#what-it-does)
- [Use cases](#use-cases)
- [Status](#status)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Usage](#usage)
  - [CLI](#cli)
  - [HTTP API](#http-api)
  - [JavaScript SDK](#javascript-sdk)
  - [MCP server](#mcp-server)
  - [Webhooks](#webhooks)
  - [Running the API yourself](#running-the-api-yourself)
  - [Postgres](#postgres)
- [What the API does](#what-the-api-does)
- [Why this is different](#why-this-is-different)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgements](#acknowledgements)

## What it does

Voice of customer from public archives, competitor ads ranked by how long they
have actually been running, and a video versus static verdict computed as
arithmetic rather than opinion. It keeps everything it reads, so the second
question about a market is nearly free and the archive can be asked about the
past.

**Key capabilities**

- **Receipts, not links.** A stable id into a retained corpus, which resolves
  identically forever, including after the source deletes the original.
- **Corroboration as arithmetic.** A claim needs at least three independent
  records before it prints as a finding, and the count travels with it.
- **Ten sources behind one interface**, from a volunteer Reddit archive and
  GitHub issue search to four government safety regulators, each degrading
  rather than failing when unconfigured.
- **A corpus that compounds.** Cold retrieval measured 596 seconds and about 500
  throttled requests. The same category answers in half a second once warm.
- **Offline mode** that touches no network and costs nothing.
- **Fifteen HTTP operations, a typed SDK, an MCP server and a CLI**, all the same
  pipeline.

### What it looks like

Real output, excerpted from a cold `npx quorum "espresso machine"` run on
2026-08-24: 401 records in 227 seconds for $0.00.

```
EVIDENCE  a claim needs 3 independent receipts to be stated as a finding
          the percentage is share of all 401 records held for this category

  quality     88 receipts /  64 channels  21.9%  A0 B3 C85 D0   [finding]
      "I often hear the priority list being 1. Quality of beans 2. Quality
       of the grinder 3. Quality of the espresso machine..."
         hackernews Why a spritz of water before grinding coffee yields
         better results   rc_4d6d444821b0044f

ATTESTED  7 records from 6 named parties   [finding]
  A named party stated this to a regulator, on the record, with consequences
  for lying. Two of these are a finding on their own.

      "CPSC And Krups Announce Action On Espresso Makers..."
         cpsc Krups   rc_a4883bfb1b04d1c1

RECEIPTS  195 cited, 195 resolved back to real records

COST      $0.0000 in 227.3s
```

Every id in that output is fetchable from the corpus that run wrote. If an id
does not resolve, the run exits non zero and says which one.

## Use cases

- **Product and brand research.** What buyers actually complain about, with the
  comment behind every claim, rather than a summary you have to trust.
- **Competitive teardown.** One full retrieval per rival, so shares are compared
  instead of counts, and co-occurrence is never mistaken for a signal.
- **Ad creative decisions.** Video versus static judged by how long real
  campaigns ran, from dated observations rather than from a platform's own
  label.
- **Agent tooling that can be audited.** An MCP server whose every claim the
  calling model can independently resolve, which is the one thing a research
  tool cannot fake.
- **Diligence and monitoring.** Attested records a named party filed with a
  regulator, and a diff against the last report for the same subject.

## Status

| | |
|---|---|
| **Engine** | Working. 1,232 tests, offline and keyless |
| **CLI** | Working, every flag |
| **MCP server** | Working, five tools over stdio, four of them also remote at `/mcp` |
| **JavaScript SDK** | Working, 11 methods |
| **Webhooks** | Working. Signed to Standard Webhooks, durable, retried for about 75 hours |
| **Hosted API** | **Deployed and live** at https://quorum-api-j15n.onrender.com, on PostgreSQL, verified against the running instance |
| **npm** | **Published**: `npx quorum-api "running shoes"`. Five packages, zero external dependencies |
| **Corpus** | Young. 22 consumer and developer categories warmed on the hosted instance as of 2026-08-25; everything else is a cold run away |

> [!NOTE]
> **Do not depend on the API shape yet.** It is stable enough to build against
> and not yet frozen.
>
> Named rather than left as a surprise: **request quotas are held in memory**,
> so the per minute lookup counter resets on restart and none of the counters
> would hold across two instances. The hourly report counter is the exception:
> it is re-seeded from persisted reports at boot, so a restart is not a refill.
> And **`evals/` holds only its first layer**, a labelled relevance set scored
> in CI; the paid, scored report evals described in the project docs do not
> exist yet.

## Requirements

**Node 22.18 or newer**. The engine has **one runtime dependency**, `pg`, and
only in the hosted server: no framework, no ORM, no HTTP client, no test runner,
and nothing at all in the CLI or the corpus. That is a deliberate constraint
rather than a boast, because every dependency in a tool that fetches untrusted
text from the public internet is another thing that can reach the network on
your behalf. `pg` earned its place by being a connection pool that survives a
database restart, which is not a thing worth hand writing.

No key is required for anything. Reddit through a public archive, Hacker News,
the App Store and four government safety archives are all free and keyless. Keys
only ever ADD sources, and a missing one degrades a run rather than failing it.

<details>
<summary><strong>Environment variables</strong>, all optional. Put them in a gitignored <code>.env</code> at the repo root.</summary>

| | |
|---|---|
| `QUORUM_CONTACT_EMAIL` | Not a key. The SEC requires a User-Agent naming who is calling and returns 403 without one, so `sec-edgar` reports itself unconfigured until this is set. A role address outlives whoever set it up. |
| `OPENROUTER_API_KEY` | Subject expansion, `--synthesise` and `--read-images`. All three are off by default, and the counts never come from a model, so the deterministic report is identical without it. |
| `APIFY_TOKEN` | The Meta ad library, and the only metered source in the repo. Every call charges the cost meter and lands on the report's bill. Absent, the ads leg is skipped exactly as `--no-ads` does. |
| `QUORUM_CORPUS` | SQLite corpus path, read by the **server and the MCP server**. Default `./quorum.db`. The CLI does not read it: pass `--corpus` instead. |
| `QUORUM_PG_URL` | Postgres, for the hosted corpus. Paste the provider uri whole: it is parsed rather than split, so `sslmode` is honoured and a password containing `@` survives. |
| `QUORUM_PG_CA` | Path to the provider CA. Worth setting, because `sslmode=require` means encrypt and **not** verify. |
| `QUORUM_PG_CA_PEM` | The same CA as an inline PEM, for hosts that supply secrets as values rather than files. |
| `QUORUM_API_KEYS` | Comma separated bearer keys for the server. **Absent means the instance is open**, which the server says out loud on boot. |
| `QUORUM_WEBHOOK_SECRET` | Signing secret for webhook delivery, 24 characters or more. **Absent means webhooks are accepted and never delivered**, which the server also says on boot. |
| `QUORUM_CONCURRENCY` | Concurrent report runs, default 2. Not a throughput dial: every concurrent run is concurrent pressure on the same volunteer archives. |
| `PORT` | Default 8787. A host normally sets this. |
| `QUORUM_REPORTS_PER_MINUTE` | Reports one key may start per minute. Default 20. |
| `QUORUM_LOOKUPS_PER_MINUTE` | Everything else, per key per minute. Default 600, which is 10 a second. |
| `QUORUM_MAX_CAP_USD` | Ceiling on any one report. A caller's own `capUsd` can only lower it. Default 0. |
| `QUORUM_SPEND_PER_KEY_USD` | What one key may spend on metered sources per day. Default 0. |
| `QUORUM_SPEND_TOTAL_USD` | What **every** key together may spend per day. Default 0. |

</details>

## Quick start

Requires **Node 22.18 or newer**, and nothing else.

```bash
npx quorum-api "running shoes"
```

That is the whole install. Five packages come down from npm, about 240 KB with
zero external dependencies, and the first report starts.

Working on Quorum itself is the clone path:

```bash
git clone https://github.com/Godzilla-lab/Quorum-API && cd Quorum-API
npm install
npm run build
npm test          # 1,232 tests, offline, no keys
```

Then research something. The input is a **subject**, not a URL. Plain text
works, a product URL works, and a product URL the store refuses still works,
which matters because four of four real store pages blocked a server side fetch
when this was measured.

```bash
npx quorum "running shoes" --offline    # corpus only, no network, no cost
npx quorum "running shoes" --offline --corpus ./mine.db   # somewhere else
```

> [!NOTE]
> Nothing above needs a key, and `--offline` never touches the network at all.
> Start with none of them and add one when a report tells you what it could not
> reach.

## Usage

### CLI

The whole engine on your machine, against a corpus you own.

```bash
# A subject in plain words
npx quorum "running shoes" --communities running,runningshoegeeks

# A product url, including one a store refuses to serve to a server
npx quorum "https://allbirds.com/products/mens-wool-runners"

# Corpus only. No network, no cost, and it says so
npx quorum "running shoes" --offline

# Machine readable. Progress goes to stderr, so this pipes cleanly
npx quorum "running shoes" --json | jq '.findings[].term'

# Versus what: one full retrieval per rival
npx quorum "wool runner" --compare "brooks ghost"

# Skip the one metered source explicitly
npx quorum "running shoes" --no-ads
```

`--compare` is one full retrieval per rival, and it has to be. Counting records
in one corpus that happen to mention a rival measures co-occurrence: a comment
saying "these run smaller than my Brooks" names a rival and a complaint and
attributes the complaint to neither. So every side is a corpus of its own,
shares are compared rather than counts, and a gap inside the sampling noise for
those corpus sizes is reported as no difference rather than as a result.

Every claim it prints is either a **finding**, meaning at least three
independent receipts stand behind it, or a **weak signal**, which is shown so it
can be chased and is never stated as a market pattern. Before anything is
printed, every cited receipt is fetched back out of the corpus, and the run
exits non zero if one of them does not resolve.

`quorum --help` lists the flags. Every command above works through
`npx quorum-api` with nothing cloned, or through the `quorum` bin inside a
checkout; they are the same binary.

### HTTP API

Start a report, poll it, then resolve the ids it cites.

```bash
# Start one. Returns 202 immediately with an id
curl -sX POST http://localhost:8787/v1/reports \
  -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"subject":"wool runner","terms":["sizing","durability"]}'
```

```json
{ "id": "rep_3568995af829290a", "status": "running", "coalesced": false,
  "category": "wool runner", "queuePosition": 1, "estimatedSeconds": 60 }
```

```bash
# Poll it. Honours Retry-After while running, and ETags so polling costs nothing
curl -s http://localhost:8787/v1/reports/rep_3568995af829290a \
  -H "authorization: Bearer $KEY" -H 'if-none-match: "rep_3568995af829290a-7"'

# Watch it instead of polling
curl -N http://localhost:8787/v1/reports/rep_3568995af829290a/stream \
  -H "authorization: Bearer $KEY"

# Resolve one receipt. This is the endpoint everything else rests on
curl -s http://localhost:8787/v1/evidence/rc_a8697befab91e873 \
  -H "authorization: Bearer $KEY"

# Resolve up to 200 at once, because a report cites more than one
curl -sX POST http://localhost:8787/v1/evidence/batch \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"receiptIds":["rc_8f2a1","rc_44b0e","rc_91c37"]}'

# Is this category warm? Free, and worth asking before paying for a cold report
curl -s http://localhost:8787/v1/categories/running%20shoes \
  -H "authorization: Bearer $KEY"

# Check somebody's claims, ours or a competitor's
curl -sX POST http://localhost:8787/v1/verify \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"claims":[{"text":"sizing runs small","receipts":["rc_8f2a1"]}]}'
```

### JavaScript SDK

Typed, zero dependency, written against [`spec/openapi.yaml`](spec/openapi.yaml).
Every method is one operationId from that file.

```js
import { createClient } from '@quorum/sdk-js';

const quorum = createClient({ baseUrl: 'https://quorum-api-j15n.onrender.com', apiKey: process.env.QUORUM_KEY });

const found = await quorum.searchEvidence({ query: 'sizing', category: 'running shoes' });
if (!found.ok) throw new Error(found.error.message);

for (const record of found.data.records) console.log(record.receiptId, record.text);
```

**Errors are values, never thrown**, the same rule the engine follows anywhere a
vendor can be down. A caller gets `{ ok: false, error }` carrying the server's
`type`, its `requestId` and any `retryAfterSeconds`, because a 429, a 503 and a
report that is simply not finished yet are all normal and none of them is
exceptional.

**It honours the server's pacing.** `waitForReport` polls to completion using
`Retry-After` when the server sends one, and treats a 503 as the load shedder
rather than a failure. A client that gives up on the first refusal reports a busy
service as a broken one, which is exactly what the shedder exists to prevent.

```js
const started = await quorum.createReport({ subject: 'wool runner', offline: true });
if (started.ok) {
  const report = await quorum.waitForReport(started.data.id, {
    onPoll: (r) => console.log(r.status),
  });
}
```

`streamReport` returns the same run as an async iterable of server sent events,
parsed by hand because there is no EventSource in Node that accepts an
Authorization header.

### MCP server

Five tools spoken as JSON-RPC with **no dependency**, over two transports.

**Remote**, for connector forms that want a URL. The hosted instance answers
Streamable HTTP at:

```
https://quorum-api-j15n.onrender.com/mcp
```

Open without a key: the four read only tools spend nothing and serve public
data, and anonymous callers share one rate allowance so they cannot crowd out
keyed customers. The `research_product` tool is never exposed remotely.

**Local**, over stdio, for clients that launch a command:

```bash
QUORUM_CORPUS=./quorum.db node packages/mcp/src/bin.ts
```

```json
{
  "mcpServers": {
    "quorum": {
      "command": "node",
      "args": ["packages/mcp/src/bin.ts"],
      "env": { "QUORUM_CORPUS": "./quorum.db" }
    }
  }
}
```

| tool | answers |
|---|---|
| `search_evidence` | How many independent records exist, across how many channels, whether that clears the threshold, and the loudest few quotes |
| `get_receipt` | Resolves ids to the real records. **This is how an agent checks us** |
| `category_warmth` | Whether asking is instant and free, or minutes and expensive |
| `compare_formats` | Video versus static, from how long real ads ran |
| `research_product` | A full report. **Off unless `QUORUM_MCP_RESEARCH=1`** |

Three decisions worth knowing, because the tool schema is the expensive part to
change later:

**Five tools, not one per endpoint.** A tool definition costs 100 to 500 tokens
on every turn, so a server mirroring ten routes spends the context window before
the model has done anything.

**Aggregated, never a row dump.** `search_evidence` returns counts and a handful
of quotes. A research tool that streams a corpus into a context window has spent
the budget it was meant to save.

**Markdown, not JSON**, at roughly 60% of the tokens for the same content.

`research_product` is off by default because a report is minutes of throttled
retrieval against volunteer archives, and an agent should not be able to start
one by accident. The other four answer from what is already held and touch no
network.

The payoff is a thing no other research server can offer: **the calling agent can
independently verify every claim.** `search_evidence` cites ids and `get_receipt`
resolves them, so an id that does not resolve is a claim that was never real, and
it is the loudest line in the response when it happens.

### Webhooks

A report is minutes long, so `POST /v1/reports` can call you back instead of
being polled. Set a signing secret and delivery turns on:

```bash
QUORUM_WEBHOOK_SECRET=$(openssl rand -base64 32) npm start
```

```bash
curl -sX POST http://localhost:8787/v1/reports \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"subject":"wool runner","webhookUrl":"https://your-app.example/hooks/quorum"}'
```

When the report reaches a terminal state you receive a POST whose body is byte
identical to `GET /v1/reports/{id}`, plus three headers following the
[Standard Webhooks](https://www.standardwebhooks.com/) specification, so you can
verify with an off the shelf library rather than with code we invented:

| header | value |
|---|---|
| `webhook-id` | The report id. Stable across retries, so deduplicate on it |
| `webhook-timestamp` | Unix seconds at the moment of this attempt |
| `webhook-signature` | `v1,{base64 hmac-sha256}`, a space delimited list |

The signed content is `{webhook-id}.{webhook-timestamp}.{body}`, and the key is
the base64 body of your secret, not the `whsec_` label. **Your secret is the
`webhookSecret` field on `GET /v1/usage`**: scoped to your key, stable, and
derived rather than stored, so it rotates exactly when the operator rotates the
instance secret and never behind your back.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, headers, body, toleranceSeconds = 300) {
  const id = headers['webhook-id'];
  const timestamp = Number(headers['webhook-timestamp']);
  /* A signature alone is replayable forever, so bound the age first. */
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > toleranceSeconds) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();

  /* The header is a list so a secret can be rotated. Any one match is enough. */
  return String(headers['webhook-signature']).split(' ').some((part) => {
    const [version, value] = part.split(',');
    if (version !== 'v1') return false;
    const offered = Buffer.from(value ?? '', 'base64');
    return offered.length === expected.length && timingSafeEqual(offered, expected);
  });
}
```

**Delivery is at least once, and retried for about 75 hours.** A 2xx is success.
A 5xx, a 429, a timeout or a network failure is retried on the Standard Webhooks
schedule (immediately, 5s, 5m, 30m, 2h, 5h, 10h, 14h, 20h, 24h, with jitter).
Any other 4xx is not retried, because a receiver rejecting the body will reject
it again. Deliveries are held in the database, so a restart does not lose them.

> [!IMPORTANT]
> **The URL is checked, and where it is checked decides what you get back.**
> It must be `https` and must not carry credentials. A literal address is
> settled at submit, so `https://169.254.169.254/` is an immediate `400`. A
> hostname is settled at delivery instead, against the address that is then
> pinned, because a name can resolve to something different between your request
> and our connection. Every redirect hop is revalidated.
>
> Two limits, stated rather than left to be discovered. After the tenth attempt
> a delivery is abandoned and logged; there is no endpoint registry here, so
> nothing is disabled and nobody is emailed. And on an instance running without
> `QUORUM_API_KEYS`, every caller shares one key label and therefore one signing
> secret, so a signature proves the delivery came from that instance rather than
> which caller asked for it.

### Running the API yourself

The hosted API is one process and a corpus. It is the same engine the CLI runs.

```bash
QUORUM_CORPUS=./quorum.db \
QUORUM_API_KEYS=$(openssl rand -hex 32) \
QUORUM_WEBHOOK_SECRET=$(openssl rand -base64 32) \
PORT=8787 npm start
```

**Set `QUORUM_API_KEYS` or the instance is open**, which it will tell you on
boot. Callers then authenticate with a bearer token:

```bash
curl -H "Authorization: Bearer $KEY" localhost:8787/v1/categories/running%20shoes
```

One instance serves everybody, and that is deliberate. The corpus is global
because a category one caller warmed answers instantly for the next, which is
the whole point of keeping one. Reports and webhook deliveries are the
exception: they are tenant owned and row level security enforces it, verified
against a real PostgreSQL server.

### Postgres

Set `QUORUM_PG_URL` and the server uses Postgres instead of SQLite. Nothing else
changes.

```bash
npm run migrate -w packages/corpus     # applies the schema, refuses to re-run one

QUORUM_PG_URL='postgres://user:pass@host:5432/db?sslmode=require' \
QUORUM_PG_CA=./provider-ca.pem \
QUORUM_API_KEYS=$(openssl rand -hex 32) npm start
```

> [!WARNING]
> **Do this for anything beyond a laptop.** `node:sqlite` is synchronous, so
> every corpus read blocks the event loop: measured, evidence search topped out
> at 124 requests a second while an indexed read managed 7,477, and identical
> reports never coalesce because a second request cannot be received while the
> first is running. On a host with no persistent disk it is not an option at
> all, since the file disappears on every restart and takes the corpus with it.

**Set `QUORUM_PG_CA`.** `sslmode=require` means encrypt and **not** verify, and a
managed provider signs with its own CA so the public root store rejects it.
Download the provider's CA and the connection is verified rather than merely
encrypted. The server says which of the two you got on boot.

`pg` is the only runtime dependency in this repo, and it lives in
`packages/server` alone. The corpus package still has none, which is why its
driver takes an injected client: somebody using the CLI with SQLite never
installs a Postgres driver. See [`docs/postgres.md`](docs/postgres.md).

## What the API does

Ten endpoints. The full contract, with schemas, is
[`spec/openapi.yaml`](spec/openapi.yaml).

### Reports, the slow path

A report is minutes of throttled retrieval when a category is cold and about half
a second when it is warm, so it is a job rather than a request.

| | |
|---|---|
| `POST /v1/reports` | Start one. Returns `202` with an id immediately. Identical subjects already in flight are **coalesced** onto one run, and the response says whether yours was. |
| `GET /v1/reports/:id` | Poll it. Carries `findings`, `weakSignals` and `rejected`, and honours `Retry-After` while running. |
| `GET /v1/reports/:id/stream` | The same run as server sent events, so a caller sees each stage rather than a spinner. |

### Evidence, the fast path

Every number a report prints resolves here. This is the half that makes a claim
checkable, and it answers in single digit milliseconds against a warm corpus.

| | |
|---|---|
| `GET /v1/evidence/:receiptId` | One record: the text somebody wrote, its score, channel, permalink and timestamp. |
| `POST /v1/evidence/batch` | Up to 200 at once, because a report cites more than one. |
| `POST /v1/evidence/search` | Full text search across the retained corpus, filterable by category. |
| `GET /v1/evidence/ads/:adId` | Every observation of one ad, which is how a run duration becomes a fact rather than an estimate. |
| `GET /v1/categories/:slug` | How warm a category is: records held, channels, age. Free, and worth checking before paying for a cold report. |

### Verification

| | |
|---|---|
| `POST /v1/verify` | Hand it claims with receipt ids and it re-resolves every one against the corpus. **It will verify our own output or anybody else's.** |
| `GET /v1/usage` | What this key has used, what it is allowed, and its webhook signing secret. |
| `GET /v1/healthz` | Liveness. Touches no database, and is never rate limited. |

### Limits

Two quotas per key, not one, because a report is minutes of throttled upstream
retrieval and an evidence lookup is one indexed read. A single shared limit
either starves the lookups or leaves the reports unprotected.

| | default |
|---|---|
| Reports started | 20 per minute |
| Everything else | 600 per minute, which is 10 a second |
| Reports in flight at once | 3 |

Every metered answer carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
`X-RateLimit-Reset`, success or refusal alike, so a caller can pace itself
before being refused rather than after. `GET /v1/healthz` is exempt from the
limit and therefore sends none: an instance has to be able to say it is alive
while it is busy. A refusal is a `429` with `Retry-After`, and **a refused request is not
counted against the window**, or a client in a retry loop could never get back
in.

**Limits are on even when auth is off.** An instance with no keys has one caller
by definition, so the allowance is shared rather than absent. The one thing a
limit has to survive is somebody forgetting to configure it.

### Metered sources, and the money

Competitor ads come from a paid vendor, so `includeAds` is available to every
caller and bounded by a budget rather than by a rate limit. **A rate limit bounds
how often, never how much**: twenty reports a minute with ads on is twenty
metered vendor runs a minute, which a rate limit permits happily.

| | stops |
|---|---|
| `QUORUM_MAX_CAP_USD` | one runaway report draining the budget by itself |
| `QUORUM_SPEND_PER_KEY_USD` | one caller draining it |
| `QUORUM_SPEND_TOTAL_USD` | **all callers together** draining it |

The third is the one that matters when ads are open to everyone. Without it the
real ceiling is the per key figure multiplied by however many keys exist, which
is not a ceiling.

**All three default to zero, which leaves ads off.** An operator who has not set
a budget has not agreed to a bill, so forgetting produces a report without ads
rather than an invoice. The server says which state it is in on boot.

Running out is **not an error**. The report still runs and still answers, it just
answers without the metered leg, and the degradation list says exactly why.
Failing a whole report over an optional extra would throw away minutes of free
retrieval.

A coalesced run is paid for by **whoever started it**, and callers who join it
ride free. That is what coalescing is for, and splitting a bill across joiners
who arrived at different moments would be arbitrary in a way nobody could check.
Spend is charged from what the cost meter actually recorded, never from an
estimate, and `GET /v1/usage` reports it.

## Why this is different

Three properties, none of which is a matter of opinion.

**A receipt does not rot.** Every other research API returns a URL captured
against a live index at query time, and it dies when the page does. A receipt is
a stable id into a retained corpus. It resolves identically forever, including
after the source deletes the original.

**Corroboration is arithmetic.** A claim needs at least three independent records
before it prints as a finding, and the count travels with it. "31 records across
5 channels" is a sentence no search API can produce, because none of them keep a
corpus to count against. It is also the prompt injection defence: a planted
comment cannot corroborate itself.

**The archive can be asked about the past.** Because records are kept rather than
fetched, the corpus answers questions a live index structurally cannot:

- **Trend**, as share of conversation over time, not raw counts. Counting records
  per month reports everything as rising, because it measures our harvesting
  rather than the market.
- **As of**, answering what the market said in March, filtered on when each
  record was written rather than when we found it. The archive is allowed to know
  more about March than we did in March.
- **Diff**, what changed since the last report for the same subject, naming the
  new receipts rather than counting them.
- **Comparison**, one full retrieval per rival, because counting records in one
  corpus that mention a competitor measures co-occurrence and attributes nothing.
- **Attested evidence**, records a named party filed with a regulator, which
  outranks any forum comment and which no listening tool holds.

And the thing that is easy to miss: **Meta does not archive inactive commercial
ads.** Once a campaign stops, the record that it ran for 94 days is gone and no
amount of money brings it back. Shopify drops delisted products from
`/products.json` the day they are pulled. For those sources the corpus is not a
cache, it is the only copy that will ever exist, and only because something was
recording on the day.

## Documentation

| | |
|---|---|
| [`spec/openapi.yaml`](spec/openapi.yaml) | The API contract. The SDK is written against it |
| [`docs/citation-integrity.md`](docs/citation-integrity.md) | Measured fabrication rates elsewhere, and the structure that makes them impossible here |
| [`docs/gummysearch-alternative.md`](docs/gummysearch-alternative.md) | For GummySearch users: the overlap, the differences, and what this is not |
| [`docs/postgres.md`](docs/postgres.md) | Running on Postgres, and what was found verifying it |
| [`docs/rate-limits.md`](docs/rate-limits.md) | Every upstream, what it does when pushed, and what we do about it |
| [`bench/README.md`](bench/README.md) | Load and abuse testing, with the defects it found |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Adding a source, which is the main way to help |
| [`SECURITY.md`](SECURITY.md) | Reporting a vulnerability |

## Contributing

**Adding a source is the main way to help**, and it touches only its own
directory: one adapter behind the `Source` interface, one fixture, one
conformance case. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

```
npm run build          # tsc, declarations only, node runs the source directly
npm test               # node:test, offline, no keys required
npm run verify         # build, test, copy style, security, drift, spec
```

Two house rules that will fail your build if you miss them: **no em dashes or en
dashes anywhere**, enforced by `npm run lint:copy`, and **named exports only**.

Found a vulnerability? [`SECURITY.md`](SECURITY.md), not an issue.

## Development

```
npm run build          # tsc across workspaces
npm test               # node:test, all packages, offline, no keys
npm run lint:copy      # house style
npm run check:security # secrets, SSRF guard, no-auth rule, audit
npm run check:spec     # the spec against the code it describes
npm run migrate -w packages/corpus     # Postgres schema
npm run test:postgres  # the driver against a real server, needs QUORUM_PG_URL
```

CI runs the test suite inside a network namespace with no route off the host, so
an adapter that quietly reaches for the wire fails immediately instead of flaking
later. Three of the 1,232 tests need a real PostgreSQL server and skip without
`QUORUM_PG_URL`.

## License

Apache 2.0 on the whole engine: every adapter, every gate, both corpus drivers,
the CLI and the SDK. Nothing is crippled.

The hosted service sells one thing the source cannot give you, which is a warm
corpus. Self hosting gets you the entire engine and a cold start. That is a real
product, and if it is the right one for you, take it.

## Acknowledgements

This runs on archives other people maintain, most of them for free:

- [Arctic Shift](https://github.com/ArthurHeitmann/arctic_shift), the public
  Reddit archive, which is a volunteer project and is treated as one
- [Hacker News](https://hn.algolia.com/api) search
- The [GitHub issue search API](https://docs.github.com/en/rest/search/search),
  used keyless as documented, which is what puts filed defects with reaction
  counts in tier B
- The [Apple App Store](https://www.apple.com/app-store/) public review feeds
- [CPSC](https://www.cpsc.gov/), [openFDA](https://open.fda.gov/),
  [NHTSA](https://www.nhtsa.gov/) and the
  [EU Safety Gate](https://ec.europa.eu/safety-gate/), four regulators whose
  recall data is what makes attested evidence possible
- [SEC EDGAR](https://www.sec.gov/edgar), which asks callers to identify
  themselves and is the reason `QUORUM_CONTACT_EMAIL` exists
- [Standard Webhooks](https://www.standardwebhooks.com/), so webhook signing is
  somebody else's well reviewed design rather than ours

> [!WARNING]
> **Acceptable use.** Everything retrieved is public and logged off. This project
> never authenticates to a scraped source and never will, because that is what
> its legal footing rests on. A session cookie forfeits it, which is why the rule
> is architectural rather than a preference. Certificate Transparency data is
> used to discover brands and products, never for infrastructure enumeration.
> Respect the archives above: they are mostly volunteers, and the throttle curve
> in this repo exists because of them.
