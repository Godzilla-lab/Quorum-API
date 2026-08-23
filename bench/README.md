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
QUORUM_CORPUS=./bench.db PORT=8787 npm run dev -w packages/server

node bench/mixed.mjs http://localhost:8787 ./bench.db 10000 100
node bench/waves.mjs http://localhost:8787 ./bench.db
node bench/same.mjs  http://localhost:8787 ./bench.db 10000
node bench/cli.mjs   ./bench.db
```

The four are deliberately different questions:

| harness | asks |
| --- | --- |
| `mixed` | does a realistic weighted mix stay up, honest and fast |
| `waves` | does the same traffic survive being SHAPED differently |
| `same` | what happens when every request is IDENTICAL |
| `cli` | what happens when the caller is a process rather than a socket |

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

## Identical traffic, 2026-08-22

`mixed.mjs` maximises DISTINCT queries on purpose, because a run drawn from
twelve strings measures a warm cache instead of the FTS parser. `same.mjs` does
the opposite and sends one byte for byte identical request ten thousand times,
because the two failure modes are opposites and each harness is blind to the
other's:

```
shape        served  p50     p95     p99     max     statuses
resolve       10000   699ms  1086ms  1129ms  1138ms  200:10000
search         1343  3501ms  7707ms  7991ms  8053ms  0:8657 200:1143 503:200
report          375 14335ms 18423ms 18423ms 18423ms  0:9625 202:247 503:128
batch          9343  2937ms  5662ms  6482ms  6701ms  200:8944 0:657 503:399
nul           10000   775ms  1217ms  1264ms  2830ms  200:10000
missing       10000   572ms  6289ms  6778ms  6892ms  404:10000
```

No 500s and nothing dropped after being accepted. The NUL that returned HTTP
500 twelve times out of twelve now answers 200 ten thousand times out of ten
thousand, sent identically rather than sprinkled through a mix.

### Coalescing cannot fire under load, and the reason is the driver

The report row is the finding. Ten thousand callers asking for the SAME subject
should produce one run and 9,999 joiners. It produced **247 runs and not one
joiner**, and at a gentler 200 simultaneous submissions it produced 32 runs from
32 accepted requests, again with none coalesced.

The queue is not broken. `runsByKey` is set synchronously inside `submit`,
before any await, so two identical requests in flight together really would
share a run. **There is never a moment when two are in flight together.** A
report run holds the event loop for its entire duration on `node:sqlite`, so the
second request is not RECEIVED until the first has finished and unregistered its
key:

```
report complete in 244ms
healthz idle p50 0ms, during the report p50 0ms max 243ms over 4 pings
```

`/v1/healthz` touches no database and answers in under a millisecond when the
process is idle. During a 244ms report its worst ping was 243ms and only four
completed. The loop was held for the whole run.

So coalescing is a property of the queue that the storage driver currently makes
unreachable from the network. It is measured rather than asserted in `same.mjs`,
and it becomes an assertion the day a corpus read yields. This is the same
finding as the 124 req/s search ceiling wearing different clothes, and it has
the same answer: Postgres.

## The CLI, 2026-08-22

`cli.mjs` is a different problem from everything above it. The server harnesses
share one process, one corpus handle and one event loop. **Every CLI invocation
is a cold node process with its own sqlite handle**, so "ten thousand at once"
means ten thousand PROCESSES, and the ceiling is the machine rather than the
product.

```
concurrent   wall     p50        p99        runs/s   spawn failures   timeouts
         8    0.7s     739ms      743ms      10.7                 0          0
        16    1.1s    1070ms     1096ms      14.5                 0          0
        32    2.1s    2002ms     2059ms      15.5                 0          0
        64    4.6s    4486ms     4601ms      13.9                 0          0
       128   11.5s   11298ms    11480ms      11.1                 0          0
       256   31.2s   30783ms    31165ms       8.2                 0          0
       512  170.9s  169695ms   170796ms       3.0                 0          0
```

**Nothing ever fails, and that is the problem.** The knee is 32 concurrent at
15.5 runs a second. Past it throughput falls while latency grows without limit:
512 concurrent runs take 171 seconds each for work that takes 0.2 seconds alone,
an 800x slowdown, with no spawn failure and no timeout to tell anybody. The
server sheds with a 503 and a caller learns to retry. **The CLI has no admission
control of any kind**, because a process cannot refuse work it was started to
do. Recorded rather than fixed: a queue in front of a CLI belongs to whoever is
running the CLI in a loop.

### What the CLI survives

- **Twenty five hostile argv shapes**, each sent repeatedly and concurrently:
  empty and blank subjects, a 5,000 character subject, FTS metacharacters in
  `--terms`, 500 terms, 21 nested parens, negative and NaN numbers, a corpus
  path that does not exist, `../../../etc/passwd`, an unknown flag, a flag with
  its value missing. **No stack trace, no hang, and a message every time.** Exit
  codes stay distinct and actionable: 0 answered, 1 the run failed, 2 usage, 4 a
  cited receipt did not resolve.
- **A NUL cannot reach the CLI through argv at all.** The byte that returned
  HTTP 500 from the API is refused at the execve boundary, where arguments are
  NUL terminated, and node will not even start the process. The attack surface
  is real over HTTP and does not exist here, so it is tested over HTTP.
- **Forty readers beside a writer appending 11,000 rows: zero locked
  databases.** The corpus runs in WAL, which is why. Verified by checksum that
  an offline run is READ ONLY: no retrieval, no product cache write, no report
  snapshot, so the write pressure is applied deliberately by a writer process
  rather than pretended.
- **Every output format parses as what it claims**, checked on every run rather
  than assumed from an exit code: json parses, every ndjson line parses, the csv
  header is intact, markdown starts with its heading.

### One defect, found and fixed

`quorum: nothing to research. Pass a subject: receipts "running shoes"`. The
usage example still named the old product, so the one message a first time user
is most likely to see told them to type a command that does not exist.

## What could not be tested

**The MCP server does not exist.** `packages/mcp/src/index.ts` is two lines and
a comment saying the milestone that owns it will populate it. `packages/sdk-js`
is the same. There is nothing to load test, and a harness pointed at them would
have measured an empty file. Said here rather than left as a gap in a table.

## A note on scoring, 2026-08-22

`mixed.mjs` counted a connection the KERNEL never accepted as a failed request.
The accept queue is 128 deep by default on this machine, so every run above a
few hundred concurrent reported FAILED for something no code in this repo can
see or refuse. It now reads the transport cause, scores only 500s and requests
dropped AFTER being accepted, and reports the unaccepted count separately. A
harness that cries wolf at its own ceiling gets ignored, which costs more than
the wrong number does.

Ten thousand simultaneous requests, after that change: 3,266 never accepted,
6,734 served, zero 500s, zero dropped after acceptance. The server was still
answering healthz at 166MB RSS with nothing in its log.
