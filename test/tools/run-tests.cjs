#!/usr/bin/env node
/**
 * The focused-suite runner: enumerate `test/*.test.cjs` in Node and hand the expanded
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
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn: spawnAsync } = require('child_process');

const TEST_SUFFIX = '.test.cjs';
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
function startWatchdog(limitMs, outFile) {
  if (process.platform !== 'win32') return { stop: () => {} };
  const child = spawnAsync(process.execPath, [WATCHDOG, String(process.pid), String(limitMs), outFile, String(watchdogPollMs(limitMs))], { stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  return { stop: () => { try { child.kill(); } catch { /* gone */ } } };
}

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

/** Every top-level test file in `entries`, sorted, narrowed by `filters`. Pure. */
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

/** The runner proper. Every effect is injected; returns the process exit code. */
function run({
  testDir,
  filters = [],
  readdir = (d) => fs.readdirSync(d),
  spawn = (args, opts) => spawnSync(process.execPath, args, opts),
  cwd = process.cwd(),
  timeoutMs = fileTimeoutMs(),
  // node --test's own default: spec on a terminal, TAP otherwise (the gate logs grep TAP).
  isTTY = !!process.stdout.isTTY,
  eventsFile = path.join(os.tmpdir(), `run-tests-timeouts-${process.pid}-${Date.now()}.jsonl`),
  readFile = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } },
  removeFile = (p) => { try { fs.rmSync(p, { force: true }); } catch { /* noop */ } },
  watchdog = startWatchdog,
  log = (line) => process.stdout.write(`${line}\n`),
  err = (line) => process.stderr.write(`${line}\n`)
} = {}) {
  let entries;
  try {
    entries = readdir(testDir);
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
  // The watchdog (win32) kills a file's whole tree at the limit; node --test's timeout is the
  // backstop, a little later. Each writes its own record file (node truncates its destination).
  const watchFile = `${eventsFile}.watchdog`;
  const dog = watchdog(timeoutMs, watchFile);
  const args = [
    '--test', `--test-timeout=${backstopMs(timeoutMs)}`,
    '--test-reporter', isTTY ? 'spec' : 'tap', '--test-reporter-destination', 'stdout',
    '--test-reporter', TIMEOUT_REPORTER, '--test-reporter-destination', eventsFile,
    ...rel
  ];
  // A runner started from inside a node:test file inherits NODE_TEST_CONTEXT, which turns the
  // nested `node --test` into a reporting child (no real run, no reporters). It is a run of its own.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  let res;
  try { res = spawn(args, { cwd, stdio: 'inherit', env }); } finally { dog.stop(); }
  const hung = [];
  for (const h of [...timedOutFiles(readFile(watchFile)), ...timedOutFiles(readFile(eventsFile))]) {
    if (!hung.some((x) => path.resolve(x.file) === path.resolve(h.file))) hung.push(h);
  }
  removeFile(eventsFile);
  removeFile(watchFile);
  for (const h of hung) err(`[test-runner] FILE TIMED OUT after ${timeoutMs} ms (it never finished; node --test killed it): ${h.file}`);
  if (hung.length) err(`[test-runner] ${hung.length} test file(s) timed out - the run FAILS (node --test lists them as cancelled, not failed)`);
  if (res.error) {
    err(`[test-runner] could not start node --test: ${String(res.error)}`);
    return 1;
  }
  // A child killed by a signal reports status null; that is a failure, not a pass.
  if (typeof res.status !== 'number') {
    err(`[test-runner] node --test terminated by signal ${res.signal ?? 'unknown'}`);
    return 1;
  }
  // A timed-out file fails the run whatever node's own exit code says.
  return hung.length && res.status === 0 ? 1 : res.status;
}

module.exports = { selectTestFiles, run, TEST_SUFFIX, FILE_TIMEOUT_MS, fileTimeoutMs, timedOutFiles, watchdogPollMs, backstopMs, BACKSTOP_MIN_MARGIN_MS, WATCHDOG };

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  process.exit(run({
    testDir: path.join(repoRoot, 'test'),
    filters: process.argv.slice(2),
    cwd: repoRoot
  }));
}
