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
 * Every other node process (the agent CLIs' node launchers, npm, tsc, electron-as-node) leaves at the
 * first statement below: no require, no I/O.
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
/** The npm CLI chooses the first known command after options; option values are not commands. */
function npmInstallKind(cli, args) {
  let deref = npmFallbackDeref;
  try {
    const path = require('node:path');
    const list = require(path.join(path.dirname(cli), '..', 'lib', 'utils', 'cmd-list.js'));
    if (typeof list.deref === 'function') deref = list.deref;
  } catch { /* npm changed layout: the pinned fallback covers install aliases */ }
  for (const arg of args) {
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
if (require.main !== module && !(testRun || suiteRunner || preloadKind)) return;

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

const url = (process.env.HIVE_LEDGER_URL || '').replace('/ledger/', '/heavy/');
if (!/^http:\/\/127\.0\.0\.1:\d+\/heavy\//.test(url)) return;   // not a hive agent's process
const { spawnSync } = require('node:child_process');

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

const files = testRun ? process.argv.slice(1) : [];
const req = {
  op: 'acquire',
  pid: process.pid,
  createdMs: Math.round(Date.now() - process.uptime() * 1000),
  ppid: process.ppid,
  files,
  suite: testRun && files.length === 0,
  ...(testRun ? {} : suiteRunner ? { runner: process.argv.slice(1), cwd: process.cwd() } : { preloadKind }),
  ...(testRun && process.env.GUPPY_TEST_RUN ? { parentRun: process.env.GUPPY_TEST_RUN } : {})
};
let told = false;
for (;;) {
  const a = ask(req, 30_000);
  if (a && (a.state === 'light' || a.state === 'held') && typeof a.run === 'string') {
    // A nested `node --test` this run spawns says it is part of this run (checked live by the app).
    process.env.GUPPY_TEST_RUN = a.run;
    if (a.leaseId) {
      const leaseId = a.leaseId;
      process.on('exit', () => { ask({ op: 'release', leaseId }, 5_000); });
    }
    break;
  }
  if (a && a.state === 'wait') {
    if (!told) say(`[guppy] waiting for the heavy-job slot (held by ${(a.holders || []).join(', ') || 'a reservation'}; queue position ${a.position})\n`);
    told = true;
    continue;
  }
  // Jim SHOULD 1: the status names a version skew (an older app has no /heavy route: 404).
  const why = a && a.line ? a.line : `unexpected answer ${JSON.stringify(a).slice(0, 120)}`;
  failOpen(a && a.status ? `status ${a.status}: ${why}` : why);
  break;
}
