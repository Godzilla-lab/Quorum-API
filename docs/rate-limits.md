# Rate limits, quotas and failure modes

Every upstream this project touches, what it actually does when pushed, and what
we do about it. Measured entries carry the date they were measured. Anything not
measured says so, because a limit somebody read on a forum is not a limit.

Keep this current. When an adapter starts failing in a new way, the answer
belongs here before it belongs in a fix.

---

## Arctic Shift, the Reddit archive

**Free, volunteer run, no authentication, no key.** It is the single point of
failure for the best source in the project, and it is somebody's unpaid project.
Treat it accordingly.

| | |
|---|---|
| Auth | None, and never. This is the legal footing |
| Published limit | None documented. The limit is dynamic and load dependent |
| Our floor between sends | 220ms, serialised process wide |
| Our ceiling under pressure | 4000ms |
| Retries | 4 attempts, gap doubles from a 600ms floor, plus up to 400ms jitter |

**Overload arrives as HTTP 422**, not 429 and not 200, carrying
`{"error":"Timeout. Maybe slow down a bit"}`.

Measured 2026-08-22: `posts/search` returned 422 four times in a row and
succeeded on the fifth attempt. **A client that gives up on the first refusal
will report an empty category as fact.** This is the single most important
behaviour on this page, and an earlier version of our client had exactly that
bug: it returned early on any non 2xx, never parsed the body, and never
recognised the overload.

Measured 2026-08-13 (from the engine): firing about 60 queries at concurrency 6
earns a sustained refusal that takes minutes to clear, and every request inside
that window silently returns nothing.

Other observed responses:

- `400` with `{"error":"'query' query parameter requires one of: author, subreddit"}`.
  A parameter error. **Not retried**, because retrying spends the whole attempt
  budget to receive the same refusal four times over.
- Archive lag is 0 to 1 hour, so it is effectively live.
- `fields` cuts payload roughly 20x. `permalink` is not a field, so links are
  constructed.

**Mitigations beyond throttling**, in order of how much they matter:

1. **The corpus.** A warm category costs zero requests. This is the real answer.
2. **Bulk dumps.** Arctic Shift publishes monthly torrent dumps covering the
   full history. Seeding from those and using the API only for the trailing
   month removes most of our traffic entirely. Not built yet, and it is the
   highest value thing left in M2.
3. **One shared client.** Hosted tenants share a single throttle instance rather
   than each getting their own and multiplying load.
4. **Be contactable.** The user agent carries a real URL. Being identifiable is
   the difference between the maintainer emailing us and blocking us.

---

## Hacker News, via the Algolia index

**Free, no key, no account.** The most forgiving upstream here.

| | |
|---|---|
| Auth | None |
| Published limit | 10,000 requests per hour per IP |
| Our floor between sends | 100ms |
| Page cap | 1000 hits per page; we request 100 |

**Comments carry no score.** Measured 2026-08-22: a comment hit has exactly
`objectID, comment_text, author, story_id, story_title, story_url, parent_id,
created_at_i`. There is no `points` and no `num_comments`.

This mattered: an earlier version filtered on `points>=2`, which matched **zero
of 6,903 available comments**. The adapter would have returned nothing in
production forever, and it passed its tests because the fixture was hand written
and invented the field. Fixtures here are captured, never authored.

`created_at_i` is the only numeric field a comment has, so it is the only thing
worth filtering on. Stories do have points, but a story is a headline somebody
submitted, not a customer talking.

---

## Meta Ad Library, official API

**Free, but geographically crippled outside the EU and UK.**

| | |
|---|---|
| Auth | App token required |
| Commercial ads | EEA and UK only. `ad_type=ALL` returns results only when `ad_reached_countries` names an EU state or the UK |
| Political and issue ads | Worldwide, 7 year retention |
| Rest of world commercial | **Nothing.** Not rate limited, simply absent |

**Meta does not archive inactive commercial ads.** Once a campaign stops, the
record that it ran for 94 days is gone and no amount of money brings it back.
That is why our corpus is the only copy that will ever exist for those, and why
ad observations are append only.

Not yet implemented.

---

## Apify, Meta Ad Library scraping

**Metered. This is the only path to commercial ad durations outside the EU and UK.**

| | |
|---|---|
| Actor | `curious_coder/facebook-ads-library-scraper`, build 2.7.21 |
| Auth | API token, ours. See the note below on why this is allowed |
| Measured cost | **$0.00076 per ad**, from a 30 ad pull billed at $0.0228 on 2026-08-22 |
| Superseded | $0.0058 per ad, measured 2026-08-13. The actor moved to pay per event in between |
| Free tier | $5 per month, so roughly 6,500 ads |
| Sync run cap | 300s imposed by Apify. A 30 ad pull took 23s and returned 1.05MB |
| Dataset retention | **7 days on the free plan.** Never treat Apify as storage, pull immediately |
| Enforcement | Our own spend cap in the cost meter, not a route guard |

The cap lives in the meter because a route guard cannot stop a minutes long job
that is already inside a retry loop burning credit. Callers ask `canSpend()`
before an expensive call, since the meter cannot prevent a call it does not make.

**The rate moved by 7.6x in nine days, and that is the lesson.** The old figure
made a $5 cap look like 862 ads when it is really about 6,500, so the spend cap
would have refused runs that were easily affordable. An overestimate is not the
safe direction: it silently shrinks what the product can do. Rates carry the
date they were taken for exactly this reason, and one older than a few weeks
should be re-measured rather than trusted.

**On authenticating.** This is the only place the engine sends a credential, and
it does not breach the no-auth rule. That rule is about SCRAPED sources: never
authenticate to a site whose public pages we are reading, because the legal
footing is logged off public data. Apify is a paid vendor API we hold an account
with. We authenticate to Apify. We never authenticate to Meta. The security
check enforces this with a per file allowlist naming the single host that file
may send a credential to.

### What a 30 ad capture measured, 2026-08-22

- **19 of 30 ads were active, and all 19 reported `end_date` equal to the day of
  the pull.** The other 11 were inactive with real end dates. A perfect 19/11
  correlation, replicating the 2026-08-13 finding. A live ad reports the read
  timestamp as its end date, so an end date only counts once the ad has stopped.
- `total_active_time` was absent on 30 of 30, so there is no reported duration
  field at all in this payload.
- `display_format` could not type **17 of 30**. The media arrays typed 16 of 17.
- **Keyword search cannot scope a competitor set at any threshold.** A search for
  "running shoes" returned "Cholesterol Relief Community" and "Arthritis Support
  Community", and no text gate separates those from Clarks Shoes. Advertiser
  scoped retrieval is the instrument; the text gate is only a backstop.

---

## Bright Data

**Not ported, and both of its uses are non functional.**

- The ads path errors with "async collection not wired yet": it triggers a
  dataset job and nothing ever collects the result.
- The unblocker has no Web Unlocker zone on the account.

Measured 2026-08-13: $0.0015 per request, per request rather than per byte, so a
heavy page costs the same as a light one. The rate stays in the table for if it
comes back. Porting a half built path attached to a dead account produces code
nobody can test.

---

## Sources not yet built, with their known limits

| Source | Auth | Limit | Note |
|---|---|---|---|
| WooCommerce Store API | None | Per site | Officially documented as unauthenticated |
| Shopify `/products.json` | None | Per site | Delisted products vanish, so retention creates the record |
| Google Ads Transparency | None | Undocumented | Non political ads persist only weeks to months |
| LinkedIn Ad Library | None | No API at all | Hard 12 month cutoff after last impression |
| TikTok Commercial Content | Registration | EEA and UK only | No Creative Center API exists |
| Apple App Store | None | 500 reviews per app | The cap is why polling compounds |
| Wayback CDX | None | **Slow, 2.5s to 60s** | See the section below. Measured, and it changes the design |
| ATS job boards | None | None documented | Official embed endpoints, no pagination |
| crt.sh | None | Be polite | Brand discovery only, never infrastructure enumeration |
| USPTO TSDR | Free key | Documented | Bulk daily deltas |

## Wayback CDX, measured 2026-08-22

**It works, it is free and unauthenticated, and it is far too slow to sit inside
a research run.**

Six consecutive queries against `web.archive.org/cdx/search/cdx`:

| query | time |
|---|---|
| `allbirds.com` domain, limit 5 | 2.5s |
| `allbirds.com` domain, limit 5 | 7.2s |
| `allbirds.com` domain, limit 5 | 32.6s |
| `allbirds.com` domain, limit 5 | 32.1s |
| `allbirds.com/products.json` | 48.6s |
| same with `collapse=digest` | **timed out at 60s** |

Same query, same parameters, an order of magnitude apart. There is no
documented rate limit and no `Retry-After` to back off against, so the only
honest description is that latency is unpredictable and a timeout is a normal
outcome rather than an error.

**Design consequence.** CDX cannot be a synchronous leg of a report. A single
call can cost more wall clock than the entire Reddit and Hacker News retrieval
combined, which measured 39.9s for 411 records on 2026-08-22. It belongs in an
explicit, opt in backfill operation, never on the default path.

### The premise it did not support

The plan assumed historical `/products.json` captures could be replayed to
recover catalogue and price history retroactively. Measured:

| url | snapshots ever |
|---|---|
| `allbirds.com/products.json` | **1**, from 2020-11-27 |
| `gymshark.com/products.json` | **0** |

One capture in six years for a major DTC brand, and none at all for another.
The Archive does not crawl those endpoints, because nothing links to them.

So catalogue history is **not** retroactively recoverable, and the README must
not claim it is. It is recoverable **forward from the day we start polling**,
which is the ordinary retention argument and does not need the Archive at all.

---

## OpenRouter free vision, measured 2026-08-22

**It works, it is genuinely free, and it is far too slow to sit on a default
path.**

| | |
|---|---|
| Auth | free API key, ours. `configured(env)` on `OPENROUTER_API_KEY` |
| Cost | $0.00. The key reports `is_free_tier: true` |
| Latency | **151s** for one ad creative, end to end |
| Limit | a SHARED pool, so 429 arrives through no fault of our key |

### Why there is a fallback chain rather than one pinned model

The first design pinned one model, on the reasoning that a silently swapped
model is a silently changed answer. That reasoning is right and the design was
still wrong: a free tier is a shared pool, so pinning means inheriting
everybody else's rate limit. The very first live call returned
`google/gemma-4-31b-it:free is temporarily rate-limited upstream`.

All eight free models that accept image input, same key, minutes apart:

| model | result |
|---|---|
| `nvidia/nemotron-nano-12b-v2-vl:free` | 200, answered |
| `dots-studio/dots-3-note-preview:free` | 200, answered the real image |
| `nvidia/nemotron-3.5-content-safety:free` | 200, unexpected response shape |
| `nvidia/nemotron-3-nano-omni-30b:free` | 502, upstream resource exhausted |
| `google/gemma-4-26b-a4b-it:free` | 429, shared pool limited |
| `google/gemma-4-31b-it:free` | 429, shared pool limited |
| `thinkingmachines/inkling:free` | 403, not on this tier |
| `thinkingmachines/inkling-small:free` | 403, not on this tier |

Half of them are unavailable at any given moment. The chain is tried in order
and the model that ACTUALLY answered is recorded on the reading, so
reproducibility is preserved where it matters: you can always see which model
produced a given sentence.

The 151s figure is the chain doing its job, four sequential attempts before one
answered. Design consequence: reading images is an explicit, opt in operation,
never part of a default report.

### What it is worth

A real ad from the captured set transcribed to `HYDRATION ALONE / MOTILITY
SUPPORT`. Neither phrase appears anywhere in the ad's `body` field. That copy
exists only inside the picture, which is where a large share of ad copy lives
and where our text parsing has always been blind.

**A transcription is extraction and a description is interpretation, and
neither is a receipt.** The image url is the receipt. See `packages/llm`.

---

## Capacity, and why user count is the wrong variable

**The binding constraint is not our servers, our database or our budget. It is
Arctic Shift, a volunteer archive we have chosen to be polite to.**

The throttle floor is 220ms, so one shared throttle sustains **4.5 requests per
second**, which is **392,727 requests a day**. A cold report costs about **500
throttled requests**, measured on real runs.

    max cold reports per day, ACROSS ALL CALLERS COMBINED:  785

**That number does not move.** It is the same at a thousand callers and at a
million, because it is a property of the upstream archive and our politeness
toward it, not of our traffic. Adding servers behind a politeness limit just
means more processes waiting.

So "how many users can we serve" is a question with no answer, and asking it
leads to the wrong engineering. The question that has an answer is:

    what fraction of requests need a cold retrieval?

Because a warm answer is a different kind of operation entirely. Measured
2026-08-22: **0.1s and zero upstream requests**, against 39.9s and hundreds of
requests cold. A warm answer is bounded by our own database, which sustained
**about 30,000 rows a second across 64 concurrent writers** on a development
machine, and by nothing else.

| cold share of requests | cold reports/day available | what that supports |
|---|---|---|
| 100% | 785 | 785 first-time subjects a day, at any user count |
| 10% | 785 | roughly 7,850 requests a day |
| 1% | 785 | roughly 78,500 requests a day |
| 0.1% | 785 | roughly 785,000 requests a day |

Read the second column: **it never changes.** Growth does not come from serving
more people, it comes from the same people asking about subjects somebody has
already paid to retrieve.

**This is the corpus thesis as arithmetic rather than as a pitch.** The corpus
is not a cache and not an optimisation. It is the only structure in which this
product scales past 785 requests a day at all, at any number of users.

It also decides the shape of the business. Growth has to concentrate on
overlapping categories, because the second product in a warm category is nearly
free and the first in a cold one costs 500 requests nobody else can use until
it lands. A thousand customers in one vertical is a far better business here
than a million spread across unrelated ones, which is the opposite of how most
API products grow.

**What would raise the ceiling**, in the order worth trying:

1. **Bulk dump ingest.** Arctic Shift publishes monthly torrents. Reading what
   they publish rather than querying them removes most of the 500 requests from
   the cold path and changes the relationship from "we hammer your service" to
   "we consume what you intended to be consumed". This is the single largest
   available win and it is unbuilt.
2. **More sources that are not rate limited.** The 785 figure is Reddit's share
   of a cold report. A report drawing on regulators, app stores and catalogues
   spends fewer of its requests against the constrained upstream.
3. **A licence or a mirror**, which is a commercial conversation rather than an
   engineering one, and the last resort rather than the first.

### What breaks first, in order

1. **SQLite, and it is still first.** Measured 2026-08-22: three processes
   opening the same corpus at once and **two crashed with "database is locked"**, on the `journal_mode`
   pragma, before writing a row. Fixed with `busy_timeout`, and four concurrent
   writers now store 1200 of 1200 rows. That makes a handful of local CLI runs
   safe. It does not make SQLite a multi tenant database, and at this scale the
   corpus is Postgres.
2. **Postgres, and it is no longer the unknown it was. It is also not the
   bottleneck.** Measured 2026-08-22 against PostgreSQL 17.10: 21 conformance
   tests, 10 row level security tests and 4 concurrency tests, all passing.

   | concurrent writers | rows | elapsed | rows/sec | all landed |
   |---|---|---|---|---|
   | 1 | 100 | 22ms | 4,545 | yes |
   | 4 | 400 | 23ms | 17,391 | yes |
   | 16 | 1,600 | 60ms | 26,667 | yes |
   | 32 | 3,200 | 101ms | 31,683 | yes |
   | 64 | 6,400 | 218ms | 29,358 | yes |

   Throughput plateaus around 30,000 rows a second at 32 writers and holds at
   64. A cold report stores roughly 400 records, so the database absorbs about
   75 cold reports' worth of writes every second while the politeness ceiling
   allows 785 a **day**. The corpus writes are four orders of magnitude away
   from being the constraint, which is worth knowing precisely so that nobody
   optimises them.

   Eight writers racing to insert the same 100 rows settled in 28ms with no
   deadlock, and between them claimed exactly 100 new rows, which is the
   coalescing failure case behaving correctly at the storage layer.
3. **The throttle is per process.** Shared per upstream now, so ten concurrent
   reports in one process queue behind one throttle instead of building ten.
   Several server instances still multiply load by instance count, and fixing
   that needs a coordinator the processes share.
4. **Apify at the free cap** is about 6,500 ads a month. That is a fixed
   monthly budget shared by every caller, so it divides by whatever the user
   count turns out to be and gets thin fast. Ads are a paid tier or they are
   cached hard.
5. **OpenRouter free vision** is a shared pool that already returned 429 for a
   single user. It is unusable at scale without a paid key, and at 151s per
   image it was never going on a default path anyway.
6. **Reports are minutes long**, so this is a job queue and not a request. Two
   identical requests must also collapse into one run, or popular products get
   researched repeatedly at full cost.

---

**Deliberately not used:**

- **Reddit official API.** $0.24 per 1k calls, and the commercial licence was
  unobtainable for a solo operator. This is what killed the closest comparable
  product. We read a third party archive instead.
- **X / Twitter.** Basic and Pro are closed to new signups. Pay per use is
  $0.005 per read capped at 2M, so roughly $10k per month at the cap, then
  enterprise at $42k+. Optional, bring your own key, never in the free path.
- **Amazon review text.** Behind a login redirect no proxy defeats, so it is out
  of bounds under the no auth rule. Public aggregate rating, review count and
  star distribution remain fair game.
- **G2 and Capterra.** Active anti bot defences on top of terms that forbid it.
- **Cloudflare Radar.** Useful and free, released CC BY-NC 4.0. Non commercial,
  so it cannot enter a corpus backing a paid product.

---

## What we do about our own callers

Not built yet, and specified so M6 does not invent it.

- Per key token bucket, `429` with `Retry-After`.
- **Two separate quotas.** A report is a minutes long job and a denial of
  service vector; an evidence lookup is one indexed read. One shared limit
  either starves lookups or leaves jobs unprotected.
- Cap concurrent running jobs per key, not just request rate.
- Spend caps per key and globally, enforced in the cost meter.
