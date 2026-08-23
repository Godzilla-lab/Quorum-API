# bench

Load and abuse testing for the hosted API. Offline, keyless, no services, and
nothing here costs money.

This is not `evals/`. Evals score whether the answers are any good and cost real
money to run. These measure whether the server stays up, stays honest and stays
fast while people misuse it, and they run against a synthetic corpus so anyone
reading this repo can reproduce every number below.

## Running it

```
node bench/seed.mjs ./bench.db 100000
RECEIPTS_CORPUS=./bench.db PORT=8787 npm run dev -w packages/server

node bench/mixed.mjs http://localhost:8787 ./bench.db 10000 100
node bench/waves.mjs http://localhost:8787 ./bench.db
```

`bench.db` is gitignored. Seeding 100,000 records takes about twelve seconds.

`mixed.mjs` exits non zero if anything returns a 500 or loses its connection. A
503 is not a failure: it is the shedder working, and it is the whole difference
between a caller who knows to retry and one who cannot tell busy from broken.

## What these are for

Every defect found this way was invisible to reading the code, and most were
invisible to a smaller test.

**A NUL byte returned HTTP 500**, twelve times out of twelve. SQLite takes a NUL
terminated string, so the FTS5 match text was truncated to its opening quote and
the parser threw `unterminated string`. One byte, from any caller. It answered
200 sent on its own, answered 200 sent two thousand times at concurrency 100,
and only failed inside the full mix. That is why the hostile inputs are
interleaved with real traffic here rather than run as their own pass.

**The load shedder took three attempts and the first two shipped nothing.**
Counting handlers in flight reported 1, always, because a synchronous handler
has no yield point between arriving and responding. Counting open sockets was
worse: keep alive means a pool of 100 holds 100 sockets open whether or not it
is doing anything, so shedding above 64 refused one hundred percent of a 10,000
request run. It punished clients for pooling, which is what good clients do.
Event loop lag is the measure that works.

**SQLite chose the wrong join order** for a category filtered search, probing
the FTS index once per row in the category: 190ms for the product's hottest
query. `CROSS JOIN` pins the loop order. 190ms to 8.4ms, identical results.

## Measured 2026-08-22

One process, 100,000 records, `node:sqlite`, 3,000 requests per level.

```
concurrent   offered/s   served/s   shed   p95     dropped
         5         275        275     0%    76ms         0
        20         283        283     0%   178ms         0
        40         319        314     1%   246ms         0
        80         612        279    54%   385ms         0
       300         882        271    69%   853ms         0
```

Served throughput is flat and nothing is dropped. Real capacity for this mix is
about 290 a second, the knee is between 20 and 40 concurrent, and past it the
shedder refuses exactly the surplus. Below the knee it never fires.

The ceiling is not the query, it is the driver. `node:sqlite` is synchronous, so
every corpus read blocks the event loop:

```
/v1/healthz          7,365 req/s    no database
/v1/evidence/:id     7,477 req/s    one indexed read
/v1/evidence/search    124 req/s    one FTS read at 8.5ms
```

1 / 0.0085 = 118. The search number is not a mystery to be profiled, it is
arithmetic. This is what the Postgres driver is for, and it is why the hosted
tier cannot be SQLite.

## The one thing shedding cannot save

`waves.mjs herd` opens 3,000 connections at once with no limit:

```
shape       reqs    wall  served/s  dropped     p50     p95     p99
herd        3000     8.4s      165      846    1654    8289    8306
```

846 connections died with `ETIMEDOUT`. Load shedding only protects requests the
server **accepts**, and a herd overflows the kernel accept queue, where no code
in this repo can see them or refuse them. Every other shape is clean, including
a fresh TCP connection per request:

```
churn       3000     4.4s      682        0     140     202     240
agent       4000     4.7s      843        0      42      77     134
```

`agent` is the shape that matters most and it is the healthiest: sequential
dependent chains, search then resolve each cited receipt, p99 134ms with no
parallelism hiding anything.

Recorded rather than fixed, because the honest fix is upstream of this process:
a queue or a proxy that accepts and holds. A single node cannot refuse a
connection it was never given.
