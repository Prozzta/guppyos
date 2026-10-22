#!/usr/bin/env node
/**
 * The focused-suite runner: recursively enumerate test files in Node and hand the expanded
 * list to `node --test`.
 *
 * WHY THIS EXISTS. `node --test test/*.test.cjs` relies on the SHELL expanding the glob.
 * cmd.exe does not, and Node's own glob support for `--test` arrived in Node 21, so on
 * Windows + Node 20 the pattern reached Node verbatim, matched nothing, and the script
 * exited having run ZERO tests. The failure mode that actually cost us was not the red
 * exit: it was that a run which executed nothing was indistinguishable, from the outside,
 * from a run that passed. So this runner's contract is narrow and deliberate:
 *
 *   - it expands the list itself, so no shell is involved on any platform;
 *   - it PRINTS the count it is about to run, so a reader can see work happened;
 *   - an empty selection is an ERROR, never a quiet success. A filter that matches
 *     nothing, or a test directory with no test files in it, exits non-zero and says so.
 *
 * Optional args narrow the run by substring (case-insensitive) against the file name:
 *   npm run test:focused -- wake        # every *wake*.test.cjs
 *   npm run test:focused -- wake canary # the union of both
 *
 * Pure selection + injected effects, so the zero-match and exit-code paths are testable
 * without spawning anything.
 *
 * TEST-RUNNER-FILE-TIMEOUT (1.1.76): every file gets a wall-clock limit (`--test-timeout`,
 * FILE_TIMEOUT_MS, or TEST_FILE_TIMEOUT_MS from the environment). A file whose process never exits
 * (all its tests done, a handle left open: the rc/1.1.76 gate stalled two hours on one) is killed
 * by node --test, and its non-detached descendants go with it (libuv's kill-on-close job). node
 * --test counts it "cancelled", so a second reporter (file-timeout-reporter.cjs) records it and the
 * runner NAMES it after the run and fails the run, even if node's own exit code were 0.
 *
 * CLAIMS-PERF-LANE: wall-clock gates (frozen bounds) measured under the parallel run measured the
 * machine, not the code (W2's 200 ms derive gates: 203/279 ms in 2 of 3 full runs, green alone). So
 * `test/perf/*.perf.cjs` is a SERIAL lane: after the parallel run, with --test-concurrency=1, on an
 * otherwise idle runner. An unfiltered run (`npm test`, the full suite) always runs it, and a failure
 * in either part fails the run. A filtered run skips it and says so. An empty perf folder is an error.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn: spawnAsync } = require('child_process');

const TEST_SUFFIX = '.test.cjs';
const PERF_SUFFIX = '.perf.cjs';
/** The per-file wall-clock limit: well above the slowest file under a loaded dual-suite run (the
 *  longest explicit per-test timeout in the suite is 25 min, renderer-memory-recovery). */
const FILE_TIMEOUT_MS = 30 * 60_000;
// A file:// URL: node --test loads reporters through the ESM loader, which reads a bare Windows
// path's drive letter ("C:") as a URL scheme and refuses it (ERR_UNSUPPORTED_ESM_URL_SCHEME).
const TIMEOUT_REPORTER = require('url').pathToFileURL(path.join(__dirname, 'file-timeout-reporter.cjs')).href;

const WATCHDOG = path.join(__dirname, 'file-watchdog.cjs');

/** How often the win32 watchdog looks (a tenth of the limit, 1 s to 30 s), and node --test's own
 *  backstop timeout: three polls later, but never less than BACKSTOP_MIN_MARGIN_MS after the limit,
 *  so the watchdog's TREE kill comes first.
 *  GATE-178 (gate 3 round 1): each poll is one PowerShell process snapshot, and under a dual-suite
 *  load it took 0.4-9.6 s (35 of 402 over 3 s). With a short limit (the 4 s of the END TO END test)
 *  three polls were only 3 s, so the backstop sometimes killed the file alone and its ConPTY conhost
 *  (outside node's kill-on-close job) was orphaned. The floor is twice the slowest snapshot seen. */
const BACKSTOP_MIN_MARGIN_MS = 20_000;
function watchdogPollMs(limitMs) { return Math.min(30_000, Math.max(1_000, Math.floor(limitMs / 10))); }
function backstopMs(limitMs) { return limitMs + Math.max(3 * watchdogPollMs(limitMs), BACKSTOP_MIN_MARGIN_MS); }

/** win32: start the per-file tree-kill watchdog (file-watchdog.cjs) beside the blocking run. */
function startWatchdog(limitMs, outFile, jobExe = null) {
  if (process.platform !== 'win32') return { stop: () => {} };
  const child = spawnAsync(process.execPath, [WATCHDOG, String(process.pid), String(limitMs), outFile, String(watchdogPollMs(limitMs)), jobExe || ''], { stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  return { stop: () => { try { child.kill(); } catch { /* gone */ } } };
}

/**
 * LOAD-FLAKES-178: the per-file job tool (file-job.cs), built once with the in-box csc and kept in
 * the temp folder under its source's hash. Each file joins its own job at start (file-job-preload.cjs),
 * and the watchdog kills a hung file's job at once instead of the tree in its snapshot, which missed
 * a process born between the snapshot and the kill. { exe } or { exe: null, why }.
 */
const FILE_JOB_SRC = path.join(__dirname, 'file-job.cs');
const FILE_JOB_PRELOAD = path.join(__dirname, 'file-job-preload.cjs');
const CSC = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
function prepareFileJob({ csc = CSC, src = FILE_JOB_SRC, dir = require('./shared-temp.cjs').sharedTemp() } = {}) {
  if (process.platform !== 'win32') return { exe: null, why: 'not Windows' };
  if (!fs.existsSync(csc)) return { exe: null, why: `no in-box csc at ${csc}` };
  const hash = require('crypto').createHash('sha256').update(fs.readFileSync(src)).digest('hex').slice(0, 12);
  const exe = path.join(dir, `guppy-file-job-${hash}.exe`);
  if (fs.existsSync(exe)) return { exe };
  // Built beside it and moved in: two runs at once never see half a file.
  const tmp = path.join(dir, `guppy-file-job-${hash}-${process.pid}.exe`);
  const r = spawnSync(csc, ['-nologo', '-O', `-out:${tmp}`, src], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (r.status !== 0) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* none */ }
    return { exe: null, why: `csc failed: ${`${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 300) || String(r.error)}` };
  }
  try { fs.renameSync(tmp, exe); } catch { try { fs.rmSync(tmp, { force: true }); } catch { /* none */ } }
  return fs.existsSync(exe) ? { exe } : { exe: null, why: `could not place ${exe}` };
}

/**
 * LOAD-BURST-196: the start gate (file-start-gate.cjs): at most `slots` test files load at once, and
 * each file's start-up is recorded for the burst summary. GUPPY_START_SLOTS overrides the default
 * (0 = record only, no cap: the before measurement). { slots, dir } with a fresh gate folder.
 */
const START_GATE_PRELOAD = path.join(__dirname, 'file-start-gate.cjs');
const startSlots = (env = process.env, cores = os.availableParallelism()) => {
  const n = Number(env.GUPPY_START_SLOTS);
  return env.GUPPY_START_SLOTS !== undefined && env.GUPPY_START_SLOTS !== '' && Number.isInteger(n) && n >= 0 ? n : Math.max(2, Math.ceil(cores / 4));
};
/** HALFCORES-SUITE-198: the processor count in a HARNESS_CPU_MASK (decimal); null = no limit ('' or not a mask). */
const maskCpus = (mask) => {
  if (typeof mask !== 'string' || !/^[1-9]\d*$/.test(mask)) return null;
  let n = 0;
  for (let m = BigInt(mask); m; m >>= 1n) n += Number(m & 1n);
  return n;
};
/**
 * TEST-TEMP-HYGIENE: every test-file process gets a temp folder of its own under one run folder
 * (temp-jail-preload.cjs), so a leak is named by its file and other processes' use of the shared
 * temp folder never counts. { root }.
 */
const TEMP_JAIL_PRELOAD = path.join(__dirname, 'temp-jail-preload.cjs');
function prepareTempJail({ dir = os.tmpdir() } = {}) {
  return { root: fs.mkdtempSync(path.join(dir, 'run-tests-temp-')) };
}

/** The files whose temp folder under `root` is not empty: [{ file, entries }], entries sorted. */
function tempLeaks(root, { readdir = (d) => fs.readdirSync(d), readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const out = [];
  let names;
  try { names = readdir(root); } catch { return out; }
  for (const name of names) {
    const pid = /^(\d+)-[A-Za-z0-9]+$/.exec(name);
    if (!pid) continue;
    let entries;
    try { entries = readdir(path.join(root, name)); } catch { continue; }
    if (!entries.length) continue;
    let file;
    try { file = readFile(path.join(root, `${name}.file`)).trim(); } catch { file = ''; }
    out.push({ file: file || `(pid ${pid[1]})`, entries: [...entries].sort() });
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** Names each leaking file on stderr; returns how many leaked. */
function reportTempLeaks(leaks, err) {
  for (const l of leaks) {
    const shown = l.entries.slice(0, 8).join(', ') + (l.entries.length > 8 ? `, ... (${l.entries.length} in all)` : '');
    err(`[test-runner] TEMP LEAK: ${l.file} left ${l.entries.length} entr${l.entries.length === 1 ? 'y' : 'ies'} in its temp folder: ${shown}`);
  }
  if (leaks.length) err(`[test-runner] ${leaks.length} test file(s) left files in the temp folder - the run FAILS (remove your temp in finally / t.after)`);
  return leaks.length;
}

function prepareStartGate({ dir = os.tmpdir(), slots = startSlots() } = {}) {
  return { slots, dir: fs.mkdtempSync(path.join(dir, 'run-tests-start-')) };
}

const nodeSpawn = (args, opts) => spawnSync(process.execPath, args, opts);

/** The limit to use: TEST_FILE_TIMEOUT_MS when it is a positive integer, else FILE_TIMEOUT_MS. */
function fileTimeoutMs(env = process.env) {
  const v = Number(env.TEST_FILE_TIMEOUT_MS);
  return Number.isInteger(v) && v > 0 ? v : FILE_TIMEOUT_MS;
}

/** The files the timeout reporter recorded (one JSON line each). Unreadable or empty: none. */
function timedOutFiles(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && r.file) out.push(r); } catch { /* a torn line: skip */ }
  }
  return out;
}

/** Every test-file name in `entries`, sorted, narrowed by `filters`. Pure. */
function selectTestFiles(entries, filters = []) {
  const all = entries.filter((n) => n.endsWith(TEST_SUFFIX)).sort();
  if (!filters.length) return { files: all, unmatched: [], total: all.length };
  const files = [];
  const unmatched = [];
  for (const f of filters) {
    const needle = String(f).toLowerCase();
    const hits = all.filter((n) => n.toLowerCase().includes(needle));
    if (!hits.length) unmatched.push(f);
    for (const h of hits) if (!files.includes(h)) files.push(h);
  }
  files.sort();
  return { files, unmatched, total: all.length };
}

// Feature tests are deliberately opt-in: the focused suite historically ran the test/
// root only, and unrelated nested suites (for example claims gates) have their own setup.
const FEATURE_TEST_DIRS = Object.freeze(['heavy-lock', 'start-fixes-163']);

/** Discover root tests plus the explicitly folded feature directories. */
function discoverTestFiles(testDir, readdir = (d) => fs.readdirSync(d, { withFileTypes: true }), featureDirs = FEATURE_TEST_DIRS) {
  const out = [];
  const walkFeature = (relative) => {
    for (const entry of readdir(path.join(testDir, relative))) {
      if (typeof entry === 'string') { if (entry.endsWith(TEST_SUFFIX)) out.push(path.join(relative, entry)); continue; }
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) walkFeature(child);
      else if (entry.isFile() && entry.name.endsWith(TEST_SUFFIX)) out.push(child);
    }
  };
  for (const entry of readdir(testDir)) {
    // String entries retain the small injected unit-test seam used by the runner tests.
    if (typeof entry === 'string') { if (entry.endsWith(TEST_SUFFIX)) out.push(entry); continue; }
    if (entry.isDirectory() && featureDirs.includes(entry.name)) walkFeature(entry.name);
    else if (entry.isFile() && entry.name.endsWith(TEST_SUFFIX)) out.push(entry.name);
  }
  return out;
}

/** The runner proper. Every effect is injected; returns the process exit code. */
function run({
  testDir,
  filters = [],
  readdir = (d) => fs.readdirSync(d, { withFileTypes: true }),
  spawn = nodeSpawn,
  cwd = process.cwd(),
  timeoutMs = fileTimeoutMs(),
  // node --test's own default: spec on a terminal, TAP otherwise (the gate logs grep TAP).
  isTTY = !!process.stdout.isTTY,
  eventsFile = path.join(os.tmpdir(), `run-tests-timeouts-${process.pid}-${Date.now()}.jsonl`),
  readFile = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } },
  removeFile = (p) => { try { fs.rmSync(p, { force: true }); } catch { /* noop */ } },
  failureFile = () => path.join(os.tmpdir(), `run-tests-failures-${process.pid}-${Date.now()}.json`),
  writeFailureFile = (p, text) => fs.writeFileSync(p, text, 'utf8'),
  watchdog = startWatchdog,
  // The real runs only: an injected spawn or watchdog runs nothing to put in a job.
  fileJob = spawn === nodeSpawn && watchdog === startWatchdog ? prepareFileJob : () => ({ exe: null, why: null }),
  // LOAD-BURST-196: the real runs only, as for fileJob. null = no gate.
  startGate = spawn === nodeSpawn && watchdog === startWatchdog ? prepareStartGate : () => null,
  // TEST-TEMP-HYGIENE: the real runs only, as for fileJob. null = no temp check.
  tempJail = spawn === nodeSpawn && watchdog === startWatchdog ? prepareTempJail : () => null,
  removeJail = (root) => fs.rmSync(root, { recursive: true, force: true }),
  log = (line) => process.stdout.write(`${line}\n`),
  err = (line) => process.stderr.write(`${line}\n`),
  // CLAIMS-PERF-LANE: the serial lane's folder (the CLI passes test/perf); absent = no lane.
  perfDir = null,
} = {}) {
  let entries;
  try {
    entries = discoverTestFiles(testDir, readdir);
  } catch (e) {
    err(`[test-runner] cannot read ${testDir}: ${String(e)}`);
    return 1;
  }
  const { files, unmatched, total } = selectTestFiles(entries, filters);

  // A filter that matched nothing is almost always a typo. Running the files that DID
  // match would report green for a suite the caller never actually asked for.
  if (unmatched.length) {
    err(`[test-runner] no test file matches: ${unmatched.join(', ')} (of ${total} in ${testDir})`);
    return 1;
  }
  // The regression this runner exists to prevent: never exit 0 having run nothing.
  if (!files.length) {
    err(`[test-runner] no *${TEST_SUFFIX} files found in ${testDir} - refusing to report a run that executed nothing`);
    return 1;
  }

  const rel = files.map((n) => path.join(path.relative(cwd, testDir) || '.', n));
  log(`[test-runner] running ${files.length}${filters.length ? ` of ${total}` : ''} test files via node --test (per-file limit ${timeoutMs} ms)`);
  // A runner started from inside a node:test file inherits NODE_TEST_CONTEXT, which turns the
  // nested `node --test` into a reporting child (no real run, no reporters). It is a run of its own.
  // TEST-PS-MODCACHE-LEAK: one PowerShell module-cache path in a temp folder for every file, so a
  // PowerShell that a test or the product under test starts never writes it under the repo root.
  // PS-POLICY-TEMP-LEAK: not the PowerShell temp folder; the files' temp jail sets theirs.
  const env = require('./ps-env.cjs').psEnv(process.env, { temp: false });
  delete env.NODE_TEST_CONTEXT;
  // LOAD-BURST-196: the gate loads first, so a file's job join below is inside its start slot too.
  let gate = null;
  try { gate = startGate({ slots: startSlots(env, os.availableParallelism()) }); } catch (e) { err(`[test-runner] no start gate (${String(e)}): every file loads at once (LOAD-BURST-196)`); }
  if (gate) {
    const opt = `--require "${START_GATE_PRELOAD.split(path.sep).join('/')}"`;
    env.NODE_OPTIONS = [env.NODE_OPTIONS, opt].filter(Boolean).join(' ');
    env.GUPPY_START_GATE = `${gate.slots}|${gate.dir}`;
    env.GUPPY_START_OPT = opt;
  }
  let jail = null;
  try { jail = tempJail(); } catch (e) { err(`[test-runner] no temp jail (${String(e)}): temp leaks are not checked (TEST-TEMP-HYGIENE)`); }
  if (jail) {
    const opt = `--require "${TEMP_JAIL_PRELOAD.split(path.sep).join('/')}"`;
    env.NODE_OPTIONS = [env.NODE_OPTIONS, opt].filter(Boolean).join(' ');
    env.GUPPY_TEMP_JAIL = jail.root;
    env.GUPPY_TEMP_JAIL_OPT = opt;
  }
  try {
    return runGated({ filters, rel, env, cpus, gate, jail, spawn, cwd, timeoutMs, isTTY, eventsFile, readFile, removeFile, failureFile, writeFailureFile, watchdog, fileJob, log, err, perfDir, readdir });
  } finally {
    if (gate) { try { fs.rmSync(gate.dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    if (jail) { try { removeJail(jail.root); } catch (e) { err(`[test-runner] the run's temp folders could not be removed (${e.code || e.message}; a child still holds a file): ${jail.root} (TEST-TEMP-HYGIENE)`); } }
  }
}

/** LOAD-BURST-196: the opening burst, one line, from the gate's start records. */
function burstLine(text, slots) {
  const s = require('./file-start-gate.cjs').burstSummary(text);
  const cap = slots > 0 ? `${slots} start slots` : 'no start cap (GUPPY_START_SLOTS=0)';
  if (!s) return `[test-runner] start-up burst: no start records (${cap})`;
  return `[test-runner] start-up burst: ${s.files} files, ${cap}; in the first ${s.windowMs / 1000} s ${s.early} files started, `
    + `load p50 ${s.loadP50} ms p95 ${s.loadP95} ms max ${s.loadMax} ms (without the gate wait p50 ${s.netP50} ms p95 ${s.netP95} ms max ${s.netMax} ms), gate wait max ${s.waitMax} ms, at most ${s.peakLoading} loading (${s.peakHolding} past the gate) at once`
    + `${s.noSlot ? `; ${s.noSlot} started without a slot` : ''}`;
}

/** run() from the per-file jobs on, with the start gate in place (LOAD-BURST-196). */
function runGated({ rel, env, cpus = null, gate, jail = null, spawn, cwd, timeoutMs, isTTY, eventsFile, readFile, removeFile, failureFile, writeFailureFile, watchdog, fileJob, log, err, perfDir, filters, readdir }) {
  const job = fileJob();
  if (job.exe) {
    const opt = `--require "${FILE_JOB_PRELOAD.split(path.sep).join('/')}"`;
    env.NODE_OPTIONS = [env.NODE_OPTIONS, opt].filter(Boolean).join(' ');
    env.GUPPY_FILE_JOB_EXE = job.exe;
    env.GUPPY_FILE_JOB_OPT = opt;
  } else if (job.why) {
    // Loud, once per run: the fallback must never pass for the normal path.
    err(`[test-runner] per-file jobs are unavailable (${job.why}): a hung file is killed from a process snapshot, which can miss a process born just before the kill (LOAD-FLAKES-178)`);
  }
  const fx = { spawn, cwd, timeoutMs, isTTY, env, readFile, removeFile, watchdog, jobExe: job.exe, err };
  const main = runNodeTest({ ...fx, rel, eventsFile, label: '', extraArgs: cpus === null ? [] : [`--test-concurrency=${Math.max(1, cpus - 1)}`] });
  if (gate) log(burstLine(readFile(path.join(gate.dir, 'starts.jsonl')), gate.slots));
  // A child that never started, or was killed by a signal (status null), is a failure, not a pass.
  if (spawnFailed(main.res, '', err)) return totals(1, main.counts, 'not run', log, main.failures, { failureFile, writeFailureFile });
  // A timed-out file fails the run whatever node's own exit code says.
  // TEST-TEMP-HYGIENE: a file that left anything in its temp folder fails the run, as a timed-out one does.
  const leaked = () => (jail ? reportTempLeaks(tempLeaks(jail.root), err) : 0);
  const hungCode = main.hung.length && main.res.status === 0 ? 1 : main.res.status;
  if (!perfDir) {
    const n = leaked();
    return totals(n && hungCode === 0 ? 1 : hungCode, main.counts, 'off', log, main.failures, { failureFile, writeFailureFile });
  }
  const lane = runPerfLane({ perfDir, filters, readdir, ...fx, eventsFile: `${eventsFile}.perf`, log });
  const mainCode = leaked() && hungCode === 0 ? 1 : hungCode;
  return totals(mainCode !== 0 ? mainCode : lane.code, sumCounts(main.counts, lane.counts), lane.state, log, [...main.failures, ...lane.failures], { failureFile, writeFailureFile });
}

/**
 * One `node --test` run with the per-file watchdog (win32 tree kill at the limit), node's own
 * timeout as the backstop, the normal reporter on stdout and the file-timeout reporter (which also
 * records the run's summary counts) on `eventsFile`. Timed-out files are named on stderr.
 */
function runNodeTest({ rel, extraArgs = [], label, spawn, cwd, timeoutMs, isTTY, env, eventsFile, readFile, removeFile, watchdog, jobExe = null, err }) {
  // The watchdog and node --test each write their own record file (node truncates its destination).
  const watchFile = `${eventsFile}.watchdog`;
  const dog = watchdog(timeoutMs, watchFile, jobExe);
  const args = [
    '--test', ...extraArgs, `--test-timeout=${backstopMs(timeoutMs)}`,
    '--test-reporter', isTTY ? 'spec' : 'tap', '--test-reporter-destination', 'stdout',
    '--test-reporter', TIMEOUT_REPORTER, '--test-reporter-destination', eventsFile,
    ...rel
  ];
  let res;
  try { res = spawn(args, { cwd, stdio: 'inherit', env }); } finally { dog.stop(); }
  const events = readFile(eventsFile);
  const failures = failingTests(events);
  const hung = [];
  for (const h of [...timedOutFiles(readFile(watchFile)), ...timedOutFiles(events)]) {
    if (!hung.some((x) => path.resolve(x.file) === path.resolve(h.file))) hung.push(h);
  }
  removeFile(eventsFile);
  removeFile(watchFile);
  for (const h of hung) err(`[test-runner] ${label}FILE TIMED OUT after ${timeoutMs} ms (it never finished; node --test killed it): ${h.file}`);
  if (hung.length) err(`[test-runner] ${label}${hung.length} test file(s) timed out - the run FAILS (node --test lists them as cancelled, not failed)`);
  return { res, hung, counts: runCounts(events), failures };
}

/** A spawn error or a signal death: logged, and true (the run failed). */
function spawnFailed(res, label, err) {
  if (res.error) { err(`[test-runner] ${label}could not start node --test: ${String(res.error)}`); return true; }
  if (typeof res.status !== 'number') { err(`[test-runner] ${label}node --test terminated by signal ${res.signal ?? 'unknown'}`); return true; }
  return false;
}

/** CLAIMS-PERF-LANE: every *.perf.cjs, serially (--test-concurrency=1), after the parallel run. */
function runPerfLane({ perfDir, filters, readdir, spawn, cwd, timeoutMs, isTTY, env, eventsFile, readFile, removeFile, watchdog, jobExe = null, log, err }) {
  const none = { code: 0, counts: ZERO_COUNTS, state: 'skipped', failures: [] };
  if (filters.length) {
    log(`[test-runner] perf lane SKIPPED: a filtered run (${filters.join(', ')}); run the full suite (npm test) for the wall-clock gates`);
    return none;
  }
  let entries;
  try { entries = readdir(perfDir); } catch (e) {
    err(`[test-runner] cannot read the perf lane ${perfDir}: ${String(e)}`);
    return { ...none, code: 1, state: 'fail' };
  }
  const files = entries.filter((n) => (typeof n === 'string' ? n : n.name).endsWith(PERF_SUFFIX)).map((n) => typeof n === 'string' ? n : n.name).sort();
  if (!files.length) {
    err(`[test-runner] no *${PERF_SUFFIX} files in ${perfDir} - refusing to report a perf lane that executed nothing`);
    return { ...none, code: 1, state: 'fail' };
  }
  log(`[test-runner] perf lane: running ${files.length} wall-clock file(s) serially (--test-concurrency=1), after the parallel suite (per-file limit ${timeoutMs} ms)`);
  const rel = files.map((n) => path.join(path.relative(cwd, perfDir) || '.', n));
  const lane = runNodeTest({ rel, extraArgs: ['--test-concurrency=1'], label: 'perf lane ', spawn, cwd, timeoutMs, isTTY, env, eventsFile, readFile, removeFile, watchdog, jobExe, err });
  if (spawnFailed(lane.res, 'perf lane ', err)) return { code: 1, counts: lane.counts, state: 'fail', failures: lane.failures };
  const code = lane.hung.length && lane.res.status === 0 ? 1 : lane.res.status;
  if (code !== 0) err('[test-runner] the perf lane FAILED (a wall-clock gate, measured serially)');
  else log('[test-runner] perf lane passed');
  return { code, counts: lane.counts, state: code === 0 ? 'pass' : 'fail', failures: lane.failures };
}

// CLAIMS-PERF-LANE totals: node --test's own summary counts ('tests N', 'pass N', ...), recorded by
// the file-timeout reporter. The run's LAST stdout line combines the main run and the lane, so a
// reader of the log's tail never takes the lane's own small TAP block for the suite's totals.
const COUNT_KEYS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const ZERO_COUNTS = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));

/** The summary counts in a record file; a count it never recorded is null (unknown, never 0). */
function runCounts(text) {
  const out = Object.fromEntries(COUNT_KEYS.map((k) => [k, null]));
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && COUNT_KEYS.includes(r.count) && Number.isInteger(r.n)) out[r.count] = r.n;
    } catch { /* a torn line: skip */ }
  }
  return out;
}

function sumCounts(a, b) {
  return Object.fromEntries(COUNT_KEYS.map((k) => [k, a[k] === null || b[k] === null ? null : a[k] + b[k]]));
}

/** The reporter's exact failing file/test records, deduped in first-seen order. */
function failingTests(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    try {
      const r = JSON.parse(line);
      const f = r && r.failure;
      if (f && f.file && f.name && !out.some((x) => x.file === f.file && x.name === f.name)) out.push(f);
    } catch { /* torn reporter line */ }
  }
  return out;
}

/** Prints the one totals line and returns `code`. Unknown counts print as '?'. */
function totals(code, counts, laneState, log, failures = [], {
  failureFile = () => path.join(os.tmpdir(), `run-tests-failures-${process.pid}-${Date.now()}.json`),
  writeFailureFile = (p, text) => fs.writeFileSync(p, text, 'utf8')
} = {}) {
  const n = (k) => (counts[k] === null ? '?' : String(counts[k]));
  if (failures.length) {
    log(`[test-runner] failing tests (${failures.length}):`);
    for (const f of failures) log(`[test-runner] FAIL ${f.file} :: ${f.name}`);
    const output = failureFile();
    try {
      writeFailureFile(output, `${JSON.stringify(failures, null, 2)}\n`);
      log(`[test-runner] failing-test list written to ${output}`);
    } catch (e) {
      log(`[test-runner] could not write failing-test list: ${String(e)}`);
    }
  }
  log(`[test-runner] totals: tests ${n('tests')} pass ${n('pass')} fail ${n('fail')} cancelled ${n('cancelled')} skipped ${n('skipped')} lane ${laneState} exit ${code}`);
  return code;
}

module.exports = { prepareFileJob, FILE_JOB_PRELOAD, prepareTempJail, TEMP_JAIL_PRELOAD, tempLeaks, reportTempLeaks,prepareStartGate, startSlots, maskCpus, START_GATE_PRELOAD, burstLine, selectTestFiles, discoverTestFiles, FEATURE_TEST_DIRS, run, runPerfLane, runCounts, failingTests, TEST_SUFFIX, PERF_SUFFIX, FILE_TIMEOUT_MS, fileTimeoutMs, timedOutFiles, watchdogPollMs, backstopMs, BACKSTOP_MIN_MARGIN_MS, WATCHDOG };

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const code = run({
    testDir: path.join(repoRoot, 'test'),
    filters: process.argv.slice(2),
    cwd: repoRoot,
    perfDir: path.join(repoRoot, 'test', 'perf')
  });
  // PS-POLICY-TEMP-LEAK: a file this run ended (hung, timed out) never ran its exit handler; its
  // guppy-pstemp-<pid>-* folder in the real temp folder goes here.
  require('./ps-env.cjs').sweepPsTempDirs();
  process.exit(code);
}
