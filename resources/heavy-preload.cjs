'use strict';
/**
 * HEAVY-LOCK-OPAQUE-SCRIPT-196: the heavy-job lock, from inside a test process.
 *
 * Guppy appends `--require "<this file>"` to every hive agent's NODE_OPTIONS, so EVERY node process an
 * agent starts loads it, however it was started: a node script, a bash script, a Makefile. The
 * PreToolUse classifier cannot read those (a mutant loop `node gen-mut.cjs ...` spawning `node --test`
 * ran heavy and unlocked). Here a test process (`node --test` at the top, or a suite runner) asks the
 * app before any test runs: light (its call's own run), held (a slot), or wait (queued; asks again).
 *
 * Cooperative, not enforcement: an agent can unset NODE_OPTIONS. A broker it cannot reach fails OPEN,
 * and every fail-open is one hive row (heavy-lock / lease-fail-open), so a broken token shows up.
 *
 * HEAVY-LOCK-SCRIPT-ELECTRON-LIGHT-108: a hive agent's other node processes (the agent CLIs' node
 * launchers, npm, tsc, a script) only wrap child_process: a child that is an Electron executable asks
 * the app first (see the spawn guard below). No I/O unless one does. A node process outside the hive,
 * and an Electron process, leaves at the first statement below.
 */
const entryPath = process.argv[1] || '';
const entry = entryPath.replace(/\\/g, '/').toLowerCase();
const NPM_HEAVY_COMMANDS = new Set(['ci', 'install', 'install-test', 'install-ci-test', 'rebuild', 'update', 'dedupe']);
const NPM_FALLBACK_ALIASES = {
  add: 'install', i: 'install', in: 'install', ins: 'install', inst: 'install', insta: 'install', instal: 'install',
  isnt: 'install', isnta: 'install', isntal: 'install', isntall: 'install', it: 'install-test', cit: 'install-ci-test',
  sit: 'install-ci-test', rb: 'rebuild', u: 'update', up: 'update', upgrade: 'update', udpate: 'update',
  'clean-install': 'ci', 'install-clean': 'ci', 'isntall-clean': 'ci', ic: 'ci'
};
const npmFallbackDeref = (word) => NPM_HEAVY_COMMANDS.has(word) ? word : NPM_FALLBACK_ALIASES[word];
function npmValueTakingOption(cli) {
  try {
    const path = require('node:path');
    const config = require(path.join(path.dirname(cli), '..', 'node_modules', '@npmcli', 'config', 'lib', 'definitions', 'index.js'));
    const options = new Map();
    for (const [name, definition] of Object.entries(config.definitions)) {
      const types = Array.isArray(definition.type) ? definition.type : [definition.type];
      // npm's Boolean options may stand alone; its other config definitions consume the next argv.
      const takesValue = !types.includes(Boolean);
      options.set(`--${name}`, takesValue);
      for (const short of [].concat(definition.short || [])) options.set(`-${short}`, takesValue);
    }
    return (arg) => !String(arg).includes('=') && options.get(String(arg)) === true;
  } catch { return () => false; /* npm changed layout: retain command-only fallback */ }
}
/** The npm CLI chooses the first known command after options; option values are not commands. */
function npmInstallKind(cli, args) {
  let deref = npmFallbackDeref;
  try {
    const path = require('node:path');
    const list = require(path.join(path.dirname(cli), '..', 'lib', 'utils', 'cmd-list.js'));
    if (typeof list.deref === 'function') deref = list.deref;
  } catch { /* npm changed layout: the pinned fallback covers install aliases */ }
  const optionTakesValue = npmValueTakingOption(cli);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') return null;
    if (String(arg).startsWith('-')) {
      if (optionTakesValue(arg)) index++;
      continue;
    }
    const command = deref(String(arg).toLowerCase());
    if (command !== undefined) return NPM_HEAVY_COMMANDS.has(command) ? 'install' : null;
  }
  return null;
}
if (require.main === module && process.argv[2] === '--guppy-heavy-npm-command') {
  process.stdout.write(JSON.stringify({ preloadKind: npmInstallKind(process.argv[3], process.argv.slice(4)) }));
  return;
}
const testRun = process.execArgv.includes('--test') && !process.env.NODE_TEST_CONTEXT;
const suiteRunner = /(^|[\\/])(run-?tests?|test-?runner|run-?all(-?tests)?)\.[cm]?[jt]s$/i.test(entry);
const npmCli = /(^|[\\/])npm(?:-cli)?\.js$/i.test(entry);
const install = npmCli && npmInstallKind(entryPath, process.argv.slice(2)) === 'install';
const builder = /(?:^|[\\/])node_modules[\\/](?:electron-builder|app-builder-lib)[\\/].+\.[cm]?[jt]s$/i.test(entry);
const preloadKind = install ? 'install' : builder ? 'build' : null;
const leasing = testRun || suiteRunner || preloadKind;
// HEAVY-LOCK-SCRIPT-ELECTRON-LIGHT-108: every hive agent node process (not an Electron one) also
// guards its child processes: one that starts an Electron executable asks for the slot first.
const url = (process.env.HIVE_LEDGER_URL || '').replace('/ledger/', '/heavy/');
const hive = /^http:\/\/127\.0\.0\.1:\d+\/heavy\//.test(url);
const guard = hive && !process.versions.electron;
if (require.main !== module && !(leasing || guard)) return;

const HELPER = '--guppy-heavy-helper';
// Synchronous: the process blocks in spawnSync right after, and a piped stderr is asynchronous on Windows.
const say = (line) => { try { require('node:fs').writeSync(2, line); } catch { /* no stderr */ } };

if (require.main === module) {
  // Helper mode (a child of the waiting process; it has no NODE_OPTIONS): one POST, the answer on stdout.
  if (process.argv[2] !== HELPER) process.exit(2);
  const chunks = [];
  process.stdin.on('data', (d) => chunks.push(d));
  process.stdin.on('end', () => {
    let job;
    try { job = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { process.exit(3); }
    const body = Buffer.from(JSON.stringify(job.req));
    const req = require('node:http').request(job.url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length }, timeout: job.timeoutMs || 30_000 }, (res) => {
      const out = [];
      res.on('data', (d) => out.push(d));
      res.on('end', () => {
        process.stdout.write(res.statusCode === 200 ? Buffer.concat(out) : JSON.stringify({ state: 'error', status: res.statusCode, line: Buffer.concat(out).toString('utf8').slice(0, 200) }));
        process.exit(0);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => { process.stdout.write(JSON.stringify({ state: 'error', line: String(e).slice(0, 200) })); process.exit(0); });
    req.end(body);
  });
  return;
}

if (!hive) return;   // not a hive agent's process
const childProcess = require('node:child_process');
// Taken before the spawn guard wraps the module's functions: the helper is never guarded.
const { spawnSync } = childProcess;

/** One request through the helper (the waiting is synchronous: no test may start meanwhile). */
function ask(req, timeoutMs) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [__filename, HELPER], { input: JSON.stringify({ url, req, timeoutMs }), env, encoding: 'utf8', timeout: timeoutMs + 5_000, windowsHide: true });
  if (r.error) return { state: 'error', line: String(r.error).slice(0, 200) };
  try { return JSON.parse(r.stdout); } catch { return { state: 'error', line: `helper exit ${r.status}: ${String(r.stderr || '').slice(0, 160)}` }; }
}

function failOpen(why) {
  say(`[guppy] heavy lock unreachable, running unlocked: ${why}\n`);
  try {
    const root = process.env.HIVE_ROOT;
    if (root) require('node:fs').appendFileSync(require('node:path').join(root, 'log.jsonl'), `${JSON.stringify({ ts: Date.now(), kind: 'heavy-lock', action: 'lease-fail-open', agentId: process.env.AGENT_ID || null, pid: process.pid, why: String(why).slice(0, 200) })}\n`);
  } catch { /* the stderr line stands */ }
}

const createdMs = Math.round(Date.now() - process.uptime() * 1000);

/** Ask until the lock answers light or held (waiting in its queue meanwhile). A held lease is
 *  released at exit. Returns the grant, or null when the lock failed open. */
function hold(req, what) {
  let told = false;
  for (;;) {
    const a = ask(req, 30_000);
    if (a && (a.state === 'light' || a.state === 'held') && typeof a.run === 'string') {
      if (a.leaseId) {
        const leaseId = a.leaseId;
        process.on('exit', () => { ask({ op: 'release', leaseId }, 5_000); });
      }
      return a;
    }
    if (a && a.state === 'wait') {
      if (!told) say(`[guppy] waiting for the heavy-job slot${what} (held by ${(a.holders || []).join(', ') || 'a reservation'}; queue position ${a.position})\n`);
      told = true;
      continue;
    }
    // Jim SHOULD 1: the status names a version skew (an older app has no /heavy route: 404).
    const why = a && a.line ? a.line : `unexpected answer ${JSON.stringify(a).slice(0, 120)}`;
    failOpen(a && a.status ? `status ${a.status}: ${why}` : why);
    return null;
  }
}

if (guard) {
  // HEAVY-LOCK-SCRIPT-ELECTRON-LIGHT-108 (Jim 2026-11-17 16:50Z: `node repro.cjs` started a hidden
  // Electron twice while another agent held the slot; the call looked light). Judged by what runs:
  // a child whose executable is electron(.exe) is an Electron launch, however the script named it,
  // unless ELECTRON_RUN_AS_NODE makes it node. This process asks once, before its first such child,
  // and keeps what it gets until it exits (so each later launch is covered too). Inside a held run
  // (a suite) the answer is at once; otherwise it waits in the queue like any heavy job.
  // Not covered: a shell line (`exec('electron .')`: the shell resolves the name, and the agent CLI's
  // own shell calls would match on any text), which the PreToolUse classifier reads; and programs
  // that are not node (an `electron` shim on PATH runs node_modules/electron/cli.js, which IS guarded).
  const ELECTRON_EXE = /(?:^|[\\/])electron(?:\.exe)?$/i;
  const asNode = (env) => {
    if (Array.isArray(env)) return env.some((p) => /^ELECTRON_RUN_AS_NODE=./i.test(String(p)));
    if (!env || typeof env !== 'object') env = process.env;
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'ELECTRON_RUN_AS_NODE' && env[k] != null && String(env[k]) !== '') return true;
    return false;
  };
  let asked = false;
  const electronSlot = (file, shell, env) => {
    if (asked || shell || typeof file !== 'string' || !ELECTRON_EXE.test(file) || asNode(env)) return;
    asked = true;
    hold({
      op: 'acquire', pid: process.pid, createdMs, ppid: process.ppid, files: [], preloadKind: 'electron',
      ...(process.env.GUPPY_TEST_RUN ? { parentRun: process.env.GUPPY_TEST_RUN } : {})
    }, ' to start Electron');
  };
  // spawn, exec, execFile and fork all start through ChildProcess#spawn (options.file, envPairs).
  const protoSpawn = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = function guppyHeavySpawn(options) {
    if (options && typeof options === 'object') electronSlot(options.file, false, options.envPairs);
    return protoSpawn.apply(this, arguments);
  };
  // The synchronous ones do not; they take (file, args?, options?).
  const syncOptions = (args) => (args[1] && typeof args[1] === 'object' && !Array.isArray(args[1]) ? args[1] : args[2]) || {};
  for (const name of ['spawnSync', 'execFileSync']) {
    const original = childProcess[name];
    childProcess[name] = function guppyHeavySync(file) {
      const o = syncOptions(arguments);
      electronSlot(file, !!o.shell, o.env);
      return original.apply(this, arguments);
    };
  }
}

if (!leasing) return;
const files = testRun ? process.argv.slice(1) : [];
const grant = hold({
  op: 'acquire',
  pid: process.pid,
  createdMs,
  ppid: process.ppid,
  files,
  suite: testRun && files.length === 0,
  ...(testRun ? {} : suiteRunner ? { runner: process.argv.slice(1), cwd: process.cwd() } : { preloadKind }),
  ...(testRun && process.env.GUPPY_TEST_RUN ? { parentRun: process.env.GUPPY_TEST_RUN } : {})
}, '');
// A nested `node --test` this run spawns says it is part of this run (checked live by the app).
if (grant) process.env.GUPPY_TEST_RUN = grant.run;
