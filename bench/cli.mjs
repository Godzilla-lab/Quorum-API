/*
 * ABUSE THE CLI, AS MANY PROCESSES AT ONCE AS THE MACHINE WILL START.
 *
 *   node bench/cli.mjs ./bench.db [shape] [total] [concurrency]
 *
 * The server harnesses next door share one process, one corpus handle and one
 * event loop. The CLI shares NONE of that: every invocation is a cold node
 * process that opens its own sqlite handle, and the failures live in exactly
 * the places that difference creates.
 *
 * WHY "TEN THOUSAND AT ONCE" MEANS SOMETHING DIFFERENT HERE. Ten thousand HTTP
 * requests are ten thousand sockets against one process. Ten thousand CLI runs
 * are ten thousand PROCESSES, and a cold node process is tens of megabytes
 * before it has read a byte of corpus. The ceiling is the machine, not the
 * product, so `ramp` climbs until something actually fails and reports where
 * rather than assuming a number.
 *
 * WHAT COUNTS AS A FAILURE
 *
 *   a stack trace on stderr    always. A usage error is a message and an exit
 *                              code, and anything that prints `at Object.<anon`
 *                              is an unhandled throw reaching a user.
 *   a non zero exit with no    a caller cannot act on silence.
 *     message
 *   a corrupted corpus         readers must never damage the file, and a
 *                              reader running beside a writer must not either.
 *   output that does not parse in the format it was asked for.
 *
 * An offline run is READ ONLY, verified by checksum before and after: no
 * retrieval, no product cache write, no report snapshot. So the write pressure
 * in `contend` is applied deliberately, by a writer process beside the readers,
 * rather than pretended.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { availableParallelism, loadavg, setPriority } from 'node:os';
import { percentile } from './queries.mjs';

const corpusPath = process.argv[2] ?? './bench.db';
const only = process.argv[3];
const total = Number(process.argv[4] ?? 200);

/*
 * DEFAULTS DERIVED FROM THE MACHINE, NOT PICKED.
 *
 * This harness starts real processes, and it ran at 512 of them on an eight
 * core laptop on 2026-08-22. Load average reached 51, the desktop became
 * unusable for minutes, and the levels past the knee produced no information:
 * throughput was already falling at 64 and everything after that was measuring
 * the OS scheduler rather than this product.
 *
 * So the default is one process per core and the ramp stops itself. Going
 * higher is still possible and is now a decision somebody types.
 */
const CORES = availableParallelism();
const concurrency = Number(process.argv[5] ?? CORES);

/*
 * Every child is niced. A load harness competing with the person watching it
 * on equal terms is a harness that makes their machine unusable to tell them a
 * number they could have had politely. Best effort: the call is not permitted
 * everywhere and a failure here must not stop the run.
 */
const NICE = 10;

const BIN = 'packages/cli/src/bin.ts';
const checksum = () => createHash('sha1').update(readFileSync(corpusPath)).digest('hex');

function run(args, { timeoutMs = 120_000 } = {}) {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try { if (child.pid) setPriority(child.pid, NICE); } catch { /* not permitted here, and not worth failing over */ }
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (c) => { if (out.length < 2_000_000) out += c; });
    child.stderr.on('data', (c) => { if (err.length < 100_000) err += c; });
    child.on('error', (e) => {
      clearTimeout(timer);
      /* Could not even start: EAGAIN, EMFILE, ENOMEM. The machine's ceiling,
       * and the thing `ramp` is looking for. */
      resolve({ code: null, spawnError: e.code ?? e.message, out: '', err: '', ms: performance.now() - t0 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, killed, out, err, ms: performance.now() - t0 });
    });
  });
}

/* A stack frame on stderr is an unhandled throw that reached a user, whatever
 * the exit code says. */
const STACK = /\n\s+at .+:\d+:\d+/;

async function pool(jobs, limit) {
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  }));
  return results;
}

function report(name, results, extra = []) {
  const ms = results.filter((r) => r.code !== null).map((r) => r.ms).sort((a, b) => a - b);
  const codes = {};
  const problems = [];
  for (const r of results) {
    const key = r.spawnError ? `spawn:${r.spawnError}` : r.killed ? 'timeout' : `exit:${r.code}`;
    codes[key] = (codes[key] ?? 0) + 1;
    if (STACK.test(r.err)) problems.push(`stack trace: ${r.err.split('\n').find((l) => l.trim())?.slice(0, 90)}`);
    else if (r.code !== 0 && r.code !== null && !r.err.trim()) problems.push(`exit ${r.code} with nothing on stderr`);
  }
  const p = (q) => percentile(ms, q).toFixed(0).padStart(6);
  console.log(
    `  ${name.padEnd(10)}${String(results.length).padStart(5)} runs  ${p(0.5)}ms ${p(0.95)}ms ${p(0.99)}ms  `
    + Object.entries(codes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' '),
  );
  for (const line of extra) console.log(`             ${line}`);
  const unique = [...new Set(problems)];
  for (const pr of unique.slice(0, 5)) console.log(`             FAILURE ${pr}`);
  if (unique.length > 5) console.log(`             and ${unique.length - 5} more distinct failures`);
  return unique.length;
}

const OFFLINE = ['--offline', '--corpus', corpusPath, '--no-ads', '--quiet'];

/*
 * Argv nobody should send and everybody eventually does. Each must produce a
 * message and an exit code. None may print a stack, and none may hang.
 */
const HOSTILE_ARGV = [
  ['', ...OFFLINE],
  ['   ', ...OFFLINE],
  ['x'.repeat(5000), ...OFFLINE],
  /*
   * NO NUL HERE, AND THAT IS A RESULT RATHER THAN AN OMISSION. The byte that
   * returned HTTP 500 from the API cannot reach a CLI through argv at all:
   * arguments are NUL terminated at the execve boundary, and node refuses the
   * spawn outright with ERR_INVALID_ARG_VALUE. The attack surface exists over
   * HTTP and not here, so it is tested over HTTP, in bench/same.mjs.
   */
  [`nul${String.fromCharCode(1)}control byte`, ...OFFLINE],
  ['category 3', ...OFFLINE, '--terms', '"; DROP TABLE docs; --'],
  ['category 3', ...OFFLINE, '--terms', 'NEAR("a" "b", 999999999)'],
  ['category 3', ...OFFLINE, '--terms', '('.repeat(21)],
  ['category 3', ...OFFLINE, '--terms', ''],
  ['category 3', ...OFFLINE, '--terms', 'a,'.repeat(500)],
  ['category 3', ...OFFLINE, '--queries', '-1'],
  ['category 3', ...OFFLINE, '--queries', 'NaN'],
  ['category 3', ...OFFLINE, '--max-records', '999999999999'],
  ['category 3', ...OFFLINE, '--deadline', '0'],
  ['category 3', ...OFFLINE, '--cap', '-5'],
  ['category 3', ...OFFLINE, '--as-of', '2026-13'],
  ['category 3', ...OFFLINE, '--as-of', 'yesterday'],
  ['category 3', ...OFFLINE, '--format', 'yaml'],
  ['category 3', ...OFFLINE, '--sources', 'nope'],
  ['category 3', ...OFFLINE, '--compare', 'category 3'],
  ['category 3', ...OFFLINE, '--compare', ''],
  ['category 3', '--corpus', '/definitely/not/here/x.db', '--offline', '--quiet'],
  ['category 3', '--corpus', '../../../etc/passwd', '--offline', '--quiet'],
  ['--offline'],
  ['category 3', ...OFFLINE, '--unknown-flag'],
  ['category 3', ...OFFLINE, '--terms'],
];

const SHAPES = {
  /*
   * THE SAME INVOCATION, OVER AND OVER, AS MANY AT ONCE AS ASKED FOR. Every
   * process reads the same rows of the same file, which is the shape a cron
   * over one category produces.
   */
  async same() {
    const before = checksum();
    const args = ['category 3', ...OFFLINE, '--terms', 'sizing,comfort'];
    const results = await pool(Array.from({ length: total }, () => () => run(args)), concurrency);
    const after = checksum();
    const bad = report('same', results, [
      `corpus ${before === after ? 'unchanged, an offline run is read only' : 'CHANGED, an offline run wrote to it'}`,
    ]);
    return bad + (before === after ? 0 : 1);
  },

  /* Every hostile argv, each sent `total / list` times so they overlap. */
  async hostile() {
    const jobs = [];
    for (let i = 0; i < total; i++) jobs.push(() => run(HOSTILE_ARGV[i % HOSTILE_ARGV.length], { timeoutMs: 60_000 }));
    const results = await pool(jobs, concurrency);
    /* A usage error is allowed to be non zero. What is not allowed is a stack,
     * a hang, or a silent failure, all of which `report` counts. */
    return report('hostile', results, [
      `${results.filter((r) => r.code === 0).length} answered, ${results.filter((r) => r.code && r.code !== 0).length} refused with a message`,
    ]);
  },

  /*
   * READERS BESIDE A WRITER. The one contention the CLI actually has: many
   * processes reading one sqlite file while another appends to it.
   */
  async contend() {
    const writer = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'bench/seed.mjs', corpusPath, '20000'], { stdio: 'ignore' });
    const args = ['category 5', ...OFFLINE, '--terms', 'sizing'];
    const results = await pool(Array.from({ length: total }, () => () => run(args)), concurrency);
    writer.kill('SIGKILL');
    await new Promise((r) => writer.on('close', r));
    const busy = results.filter((r) => /SQLITE_BUSY|database is locked/i.test(r.err)).length;
    return report('contend', results, [`${busy} run(s) saw a locked database`]);
  },

  /* Every format, repeatedly, and the output has to parse as what was asked
   * for. A harness that only checks exit codes cannot tell a report from an
   * empty file. */
  async formats() {
    const jobs = [];
    const wanted = ['json', 'ndjson', 'csv', 'markdown', 'text'];
    for (let i = 0; i < total; i++) {
      const f = wanted[i % wanted.length];
      jobs.push(async () => {
        const r = await run(['category 3', ...OFFLINE, '--terms', 'sizing', '--format', f]);
        let parsed = true;
        let why = '';
        try {
          if (f === 'json') JSON.parse(r.out);
          else if (f === 'ndjson') for (const l of r.out.trim().split('\n')) JSON.parse(l);
          else if (f === 'csv') {
            const lines = r.out.trim().split('\r\n');
            if (!lines[0].startsWith('kind,category,subject')) { parsed = false; why = 'csv header'; }
          } else if (f === 'markdown' && !r.out.startsWith('# ')) { parsed = false; why = 'markdown heading'; }
          else if (f === 'text' && !r.out.includes('RECEIPTS')) { parsed = false; why = 'text report'; }
        } catch (e) { parsed = false; why = String(e.message).slice(0, 60); }
        return { ...r, err: parsed ? r.err : `${r.err}\n  at unparseable ${f} output: ${why}:1:1` };
      });
    }
    return report('formats', await pool(jobs, concurrency));
  },

  /*
   * HOW MANY AT ONCE BEFORE THE MACHINE REFUSES. Climbs until a spawn fails or
   * a run times out, and prints the level rather than a guess.
   */
  async ramp() {
    const args = ['category 3', ...OFFLINE, '--terms', 'sizing'];
    /*
     * Levels are multiples of the core count and the climb STOPS ITSELF, for
     * two reasons that point the same way.
     *
     * Measuring: once throughput has fallen twice in a row the knee is behind
     * us and every further level is a longer, more expensive way of measuring
     * the OS scheduler. The 2026-08-22 run climbed to 512 and the last three
     * levels said nothing the 64 level had not already said.
     *
     * Manners: those levels drove the load average of an eight core laptop to
     * 51 and made it unusable for minutes. A harness is allowed to saturate the
     * thing under test. It is not allowed to take the machine down with it, and
     * a hard limit somebody has to raise deliberately is the difference.
     */
    const levels = [1, 2, 4, 8, 16, 32].map((m) => m * CORES);
    const ceiling = Number(process.env['BENCH_RAMP_MAX'] ?? CORES * 8);
    let bad = 0;
    let best = 0;
    let falling = 0;

    for (const level of levels) {
      if (level > ceiling) {
        console.log(`             stopped at the ${ceiling} process ceiling. Raise it with BENCH_RAMP_MAX if you mean it.`);
        break;
      }
      const t0 = performance.now();
      const results = await Promise.all(Array.from({ length: level }, () => run(args, { timeoutMs: 180_000 })));
      const wall = (performance.now() - t0) / 1000;
      const spawnFails = results.filter((r) => r.spawnError).length;
      const timeouts = results.filter((r) => r.killed).length;
      const ms = results.filter((r) => r.code !== null).map((r) => r.ms).sort((a, b) => a - b);
      const rate = level / wall;
      console.log(
        `  ramp ${String(level).padStart(4)}  ${wall.toFixed(1).padStart(5)}s  `
        + `p50 ${percentile(ms, 0.5).toFixed(0).padStart(6)}ms  p99 ${percentile(ms, 0.99).toFixed(0).padStart(6)}ms  `
        + `${rate.toFixed(1).padStart(5)} runs/s  load ${loadavg()[0].toFixed(1).padStart(5)}  `
        + `spawn failures ${spawnFails}  timeouts ${timeouts}`,
      );
      bad += spawnFails + timeouts;
      if (spawnFails || timeouts) { console.log('             stopped: the machine refused at this level'); break; }

      falling = rate < best ? falling + 1 : 0;
      best = Math.max(best, rate);
      if (falling >= 2) {
        console.log(`             stopped: throughput fell twice running, so the knee is behind us at about ${best.toFixed(1)} runs/s`);
        break;
      }
    }
    return bad;
  },
};

console.log(`  corpus ${corpusPath}, ${total} runs per shape, ${concurrency} concurrent processes on ${CORES} cores`);
console.log(`  children run at nice +${NICE}, so the machine stays usable while this runs`);
console.log();
console.log('  shape        runs     p50     p95     p99   outcomes');

let failures = 0;
for (const name of (only ? [only] : Object.keys(SHAPES))) {
  if (!SHAPES[name]) throw new Error(`unknown shape ${name}`);
  failures += await SHAPES[name]();
}

if (failures) {
  console.log(`\n  FAILED: ${failures} distinct problem(s)`);
  process.exitCode = 1;
}
