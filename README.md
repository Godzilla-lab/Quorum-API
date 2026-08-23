# Receipts

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

> **Status: early.** The scaffold and the corpus constants are in. Everything
> else is being ported from a working 4,000 line engine that lives elsewhere.
> Nothing is published. Do not depend on this yet.

## Why this and not a search API

Plenty of research APIs return citations now. Two things are different here.

**A receipt does not rot.** Their citation is a URL captured at query time
against a live index, and it dies when the page does. A receipt is a stable id
into a retained corpus, and it resolves identically forever, including after the
source deletes the original.

**Corroboration is a number, not a vibe.** A claim needs at least three
independent records before it is printed as a finding, and the count travels
with it. No search API can tell you "31 independent records across 5 channels",
because none of them keep a corpus to count against.

That second property is also the prompt injection defence. A single planted
comment cannot become a finding, because it cannot corroborate itself.

## The part people miss

Meta does not archive inactive commercial ads. Once a campaign stops running,
the record that it ran for 94 days is gone, and no amount of money brings it
back. Shopify drops delisted products from `/products.json` the day they are
pulled.

So the corpus is not a cache. For those sources it is the only copy that will
ever exist, and it only exists because something was recording on the day.

## Quickstart

Requires **Node 22.18 or newer**. No paid keys needed: Reddit via a public
archive, YouTube, Shopify and direct fetch are all free.

```bash
git clone <repo> && cd receipts
npm install
npm run build
npm test
```

Then research something. The input is a **subject**, not a URL. Plain text
works, a product URL works, and a product URL the store refuses still works,
which matters because four of four real store pages blocked a server side fetch
when this was measured.

```bash
npx receipts "running shoes" --communities running,runningshoegeeks
npx receipts "https://allbirds.com/products/mens-wool-runners"
npx receipts "running shoes" --offline      # corpus only, no network, no cost
npx receipts "running shoes" --json | jq    # progress goes to stderr
```

Every claim it prints is either a **finding**, meaning at least three
independent receipts stand behind it, or a **weak signal**, which is shown so it
can be chased and is never stated as a market pattern. Before anything is
printed, every cited receipt is fetched back out of the corpus, and the run
exits non zero if one of them does not resolve.

`receipts --help` lists the flags. The API contract is in `spec/`.

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
