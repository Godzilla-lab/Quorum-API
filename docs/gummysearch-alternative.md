# For GummySearch users: what Quorum is and is not

GummySearch closed on November 30, 2025, after more than two years of trying
and failing to reach a commercial licensing agreement for Reddit's Data API.
It had served over 140,000 founders, marketers and investors, and its stored
data is permanently deleted on December 1, 2026.
([GummySearch's own announcement](https://gummysearch.com/final-chapter/),
[their help center](https://gummysearch.com/docs/gummysearch-is-now-closed-6533h))

If you used it for audience research and pain point discovery, this page is an
honest accounting of how Quorum overlaps with that job, where it goes further,
and where it is a different kind of tool altogether.

## Why this one is not built on the thing that killed that one

GummySearch died of a dependency: commercial access to Reddit's API, priced
for companies larger than the ones that need it. Quorum reads Reddit through
[Arctic Shift](https://github.com/ArthurHeitmann/arctic_shift), a public
research archive, logged out, politely throttled, and never authenticated.
That posture is architectural: the adapter is structurally incapable of
sending a credential to a scraped source, and a CI check fails the build if
one ever tries.

The honest version of that sentence includes the risk: a volunteer archive is
its own dependency, and no one should tell you otherwise. The mitigation is
the corpus below, which retains everything ever read, and eight other sources
behind the same interface, so no single upstream is the product.

## The overlap: what GummySearch did that this does

- **Pain point discovery.** Ask about a product or a category and get what
  buyers actually complain about: sizing, durability, price, whatever the
  evidence supports.
- **Reddit as a primary source**, alongside Hacker News, GitHub issues, App
  Store reviews, and four government safety regulators.
- **Common complaints, ranked by evidence** rather than by recency.

## The differences, which are the reasons to care

**Every claim carries receipts.** A finding arrives with receipt ids, and
every id resolves through `GET /v1/evidence/{id}` to the actual comment, its
author context, its score and its permalink. The post-shutdown replacements
are dashboards that summarise; none of them will show you, resolvably, the
human behind every sentence. The measured case for why that matters is in
[citation-integrity.md](citation-integrity.md).

**A claim needs three independent records to print as a finding.** Enforced
in code at render time. One loud comment is not a market pattern here.

**The corpus compounds.** Everything read is stored and reused. A cold
category costs minutes of polite retrieval once; asking again is instant,
free, and answerable offline. Sources that delete their own history (Meta
drops inactive ads, stores delist products) stay queryable here.

**It is an API first, and open source underneath.** GummySearch was a
dashboard you visited. Quorum is a `POST /v1/reports` you build on, a CLI
(`npx quorum-api "your subject"`), an MCP server your agents can call at
`https://quorum-api-j15n.onrender.com/mcp`, and an Apache 2.0 repository you
can self host, which makes the free tier a real one: your own machine, your
own corpus, no key required for most sources.

## What it is not, stated plainly

- **Not a dashboard.** There is no web UI for saved audiences or browsing.
  If clicking through communities was the part you valued, a dashboard
  replacement will serve you better.
- **No alerting yet.** Scheduled re-runs with webhooks on corpus changes are
  on the roadmap; today a report runs when you ask for it.
- **The hosted instance is early and keyed.** The
  [API root](https://quorum-api-j15n.onrender.com) says how to request a key.
  Self hosting needs no key at all.

## Trying it takes one command

```bash
npx quorum-api "your product category"
```

That runs the whole pipeline locally against public sources, costs nothing,
and every id in the output resolves. Which is the point.
