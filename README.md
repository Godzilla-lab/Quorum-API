# Quorum

**Market evidence with receipts.** Give it a product URL, get back what a market
actually says: voice of customer from public archives, competitor ads ranked by
how long they have been running, and a video versus static verdict computed as
arithmetic rather than opinion.

Every claim carries receipt ids. Every receipt id resolves to a real stored
record you can fetch back.

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

> **Status: working, unpublished.** The pipeline runs end to end, 953 tests pass
> offline with no keys, and the Postgres schema is applied and verified against
> a real PostgreSQL 18. Not on npm, and nothing is deployed. The MCP server and
> the JavaScript SDK are placeholders. Do not depend on the API shape yet.

## Requirements

**Node 22.18 or newer**, and nothing else. The engine has **zero runtime
dependencies**: no framework, no ORM, no HTTP client, no test runner. That is a
deliberate constraint rather than a boast, because every dependency in a tool
that fetches untrusted text from the public internet is another thing that can
reach the network on your behalf.

No key is required for anything. Reddit through a public archive, Hacker News,
the App Store, and four government safety archives are all free and keyless.
Keys only ever ADD sources, and a missing one degrades a run rather than
failing it.

### Environment

All optional. Put them in a `.env` at the repo root, which is gitignored.

| | |
|---|---|
| `QUORUM_CONTACT_EMAIL` | Not a key. The SEC requires a User-Agent naming who is calling and returns 403 without one, so `sec-edgar` reports itself unconfigured until this is set. A role address outlives whoever set it up. |
| `OPENROUTER_API_KEY` | Subject expansion, `--synthesise` and `--read-images`. All three are off by default, and the counts never come from a model, so the deterministic report is identical without it. |
| `APIFY_TOKEN` | The Meta ad library, and the only metered source in the repo. Every call charges the cost meter and lands on the report's bill. Absent, the ads leg is skipped exactly as `--no-ads` does. |
| `QUORUM_CORPUS` | SQLite corpus path. Default `./quorum.db`. |
| `QUORUM_PG_URL` | Postgres, for the hosted corpus. Paste the provider uri whole: it is parsed rather than split, so `sslmode` is honoured and a password containing `@` survives. |
| `QUORUM_PG_CA` | Path to the provider CA. Worth setting, because `sslmode=require` means encrypt and **not** verify. |
| `QUORUM_API_KEYS` | Comma separated bearer keys for the server. **Absent means the instance is open**, which the server says out loud on boot. |
| `QUORUM_CONCURRENCY` | Concurrent report runs, default 2. Not a throughput dial: every concurrent run is concurrent pressure on the same volunteer archives. |
| `PORT` | Default 8787. A host normally sets this. |

## Three ways to use it

| | what it is | who runs it |
|---|---|---|
| **CLI** | The whole engine on your machine, against a corpus you own | You |
| **Hosted API** | The same engine against a **shared, already warm** corpus | Us |
| **MCP server** | Five tools an agent can call | You, over stdio |

They are the same pipeline. The only thing the hosted API sells that the source
cannot is a corpus somebody already paid to fill: cold retrieval measured 596
seconds and about 500 throttled requests, and the same category answers in half
a second once it is warm.

**Nothing is published to npm yet**, so today the CLI means cloning this repo.
The `quorum` command below resolves inside the checkout and is not yet a global
install.

## Quickstart

Requires **Node 22.18 or newer**, and nothing else.

```bash
git clone https://github.com/Godzilla-lab/Quorum-API && cd Quorum-API
npm install
npm run build
npm test          # 953 tests, offline, no keys
```

Nothing above needs a key, and `--offline` never touches the network at all.
Start with none of them and add one when a report tells you what it could not
reach.

Then research something. The input is a **subject**, not a URL. Plain text
works, a product URL works, and a product URL the store refuses still works,
which matters because four of four real store pages blocked a server side fetch
when this was measured.

```bash
npx quorum "running shoes" --communities running,runningshoegeeks
npx quorum "https://allbirds.com/products/mens-wool-runners"
npx quorum "running shoes" --offline      # corpus only, no network, no cost
npx quorum "running shoes" --json | jq    # progress goes to stderr
npx quorum "wool runner" --compare "brooks ghost"   # versus what
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

`quorum --help` lists the flags. Every command above runs from inside the
checkout.

### Running the API yourself

The hosted API is one process and a corpus. It is the same engine the CLI runs.

```bash
QUORUM_CORPUS=./quorum.db QUORUM_API_KEYS=$(openssl rand -hex 32) PORT=8787 npm start
```

**Set `QUORUM_API_KEYS` or the instance is open**, which it will tell you on
boot. Callers then authenticate with a bearer token:

```bash
curl -H "Authorization: Bearer $KEY" localhost:8787/v1/categories/running%20shoes
```

One instance serves everybody, and that is deliberate. The corpus is global
because a category one caller warmed answers instantly for the next, which is
the whole point of keeping one. Reports are the exception: they are tenant
owned and row level security enforces it, verified against a real PostgreSQL 18.

For anything beyond a laptop the corpus belongs in Postgres rather than SQLite,
because SQLite's driver is synchronous and blocks the event loop on every read.
See `docs/postgres.md`.

### MCP

Five tools over stdio, spoken as JSON-RPC with **no dependency**, the same call
this repo makes everywhere else.

```bash
QUORUM_CORPUS=./quorum.db node packages/mcp/src/bin.ts
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
on every turn, so a server mirroring ten routes spends the context window
before the model has done anything.

**Aggregated, never a row dump.** `search_evidence` returns counts and a
handful of quotes. A research tool that streams a corpus into a context window
has spent the budget it was meant to save.

**Markdown, not JSON**, at roughly 60% of the tokens for the same content.

`research_product` is off by default because a report is minutes of throttled
retrieval against volunteer archives, and an agent should not be able to start
one by accident. The other four answer from what is already held and touch no
network.

The payoff is a thing no other research server can offer: **the calling agent
can independently verify every claim.** `search_evidence` cites ids and
`get_receipt` resolves them, so an id that does not resolve is a claim that was
never real, and it is the loudest line in the response when it happens.

## What the API does

Ten endpoints. The full contract, with schemas, is `spec/openapi.yaml`.

### Reports, the slow path

A report is minutes of throttled retrieval when a category is cold and about
half a second when it is warm, so it is a job rather than a request.

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
| `GET /v1/healthz` | Liveness. Touches no database. |

`POST /v1/verify` is the endpoint that makes the rest falsifiable. If a claim
cites a record that does not exist, this says so, and it says so about our
reports exactly as readily as about a competitor's.

## Why this is different

Three properties, none of which is a matter of opinion.

**A receipt does not rot.** Every other research API returns a URL captured
against a live index at query time, and it dies when the page does. A receipt
is a stable id into a retained corpus. It resolves identically forever,
including after the source deletes the original.

**Corroboration is arithmetic.** A claim needs at least three independent
records before it prints as a finding, and the count travels with it. "31
records across 5 channels" is a sentence no search API can produce, because
none of them keep a corpus to count against. It is also the prompt injection
defence: a planted comment cannot corroborate itself.

**The archive can be asked about the past.** Because records are kept rather
than fetched, the corpus answers questions a live index structurally cannot:

- **Trend**, as share of conversation over time, not raw counts. Counting
  records per month reports everything as rising, because it measures our
  harvesting rather than the market.
- **As of**, answering what the market said in March, filtered on when each
  record was written rather than when we found it. The archive is allowed to
  know more about March than we did in March.
- **Diff**, what changed since the last report for the same subject, naming the
  new receipts rather than counting them.
- **Comparison**, one full retrieval per rival, because counting records in one
  corpus that mention a competitor measures co-occurrence and attributes
  nothing.
- **Attested evidence**, records a named party filed with a regulator, which
  outranks any forum comment and which no listening tool holds.

And the thing that is easy to miss: **Meta does not archive inactive commercial
ads.** Once a campaign stops, the record that it ran for 94 days is gone and no
amount of money brings it back. Shopify drops delisted products from
`/products.json` the day they are pulled. For those sources the corpus is not a
cache, it is the only copy that will ever exist, and only because something was
recording on the day.


## How it is licensed

Apache 2.0 on the whole engine: every adapter, every gate, both corpus drivers,
the CLI, the SDK and the eval harness. Nothing is crippled.

The hosted service sells one thing the source cannot give you, which is a warm
corpus. Self hosting gets you the entire engine and a cold start. That is a real
product, and if it is the right one for you, take it.

## Development

```
npm run build          # tsc, declarations only, node runs the source directly
npm test               # node:test, offline, no keys required
npm run lint:copy      # house style
npm run check:security # secrets, SSRF guard, no-auth rule, audit
```

CI runs the test suite inside a network namespace with no route off the host, so
an adapter that quietly reaches for the wire fails immediately instead of
flaking later.

See `CONTRIBUTING.md` for adding a source, which is the main way to help.

## Acceptable use

Everything retrieved is public and logged off. This project never authenticates
to a scraped source and never will, because that is what its legal footing rests
on. Certificate Transparency data is used to discover brands and products, never
for infrastructure enumeration.
