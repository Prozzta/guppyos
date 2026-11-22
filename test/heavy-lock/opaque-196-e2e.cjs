'use strict';

/**
 * HEAVY-LOCK-OPAQUE-196-MUSTC-REALPROBE-108: the end-to-end plumbing of heavy-lock-opaque-196 (real
 * processes, the real preload, the real broker route), shared with the serial perf lane.
 *
 * E2E MUST C ran in the parallel suite against the REAL process listing (one PowerShell CIM query
 * with the product's 10 s box). Under suite load the listing fails, and a failed listing is unknown:
 * sweepLeases changes nothing (fail closed, by design). So c never heard HEAVY SLOT FREE and the cell
 * timed out on a PowerShell timing it does not own. Now mustC takes its probe:
 *   - 'recorder' (the parallel cell): the rows of the processes the lock itself was asked about (pid
 *     and createdMs as the preload sent them), kept while pidRunning says they live, plus the test
 *     process (a listing is never empty, or the sweep would return before the path under test).
 *   - 'real' (test/perf/heavy-lock-mustc-realprobe.perf.cjs, serial): the product's own listing.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { nodeEnv } = require('../tools/node-env.cjs');
const own = require('../tools/own-procs.cjs');
const loadTs = require('../load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const REPO = path.resolve(__dirname, '..', '..');
const HJ = loadTs('src/main/heavyJob.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const PRELOAD = path.join(REPO, 'resources', 'heavy-preload.cjs');
const H = { heavy: true, kind: 'suite' };

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'hlo196-'));
test.after(() => { try { fs.rmSync(JAIL, { recursive: true, force: true }); } catch { /* best effort */ } });
const FIX = path.join(JAIL, 'fix');
fs.mkdirSync(FIX, { recursive: true });
const node = JSON.stringify(process.execPath);
const leafSrc = "require('node:test')('leaf', () => {});\n";
fs.writeFileSync(path.join(FIX, 'leaf.test.cjs'), leafSrc);
fs.writeFileSync(path.join(FIX, 'wrapper.cjs'), `const r = require('node:child_process').spawnSync(process.execPath, ['--test', ${JSON.stringify(path.join(FIX, 'leaf.test.cjs'))}], { stdio: 'inherit' }); process.exit(r.status ?? 1);\n`);
fs.writeFileSync(path.join(FIX, 'x.sh'), `"${process.execPath.replace(/\\/g, '/')}" --test "${path.join(FIX, 'leaf.test.cjs').replace(/\\/g, '/')}"\n`);
fs.writeFileSync(path.join(FIX, 'outer.test.cjs'), `const test = require('node:test'); const assert = require('node:assert');
test('outer spawns a nested node --test', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const r = require('node:child_process').spawnSync(process.execPath, ['--test', ${JSON.stringify(path.join(FIX, 'leaf.test.cjs'))}], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
});\n`);
// LOAD-FLAKES-105: the crashed lease holder runs until it is killed. A fixed 20 s sleep ended on its
// own under load (the setup and two process-table queries outlived it): it exited and released.
// Bounded at 10 min (Jim SHOULD): far past any kill, and the still-running assert below catches an
// early end; but if the kill's process snapshot fails, the file child cannot live on forever.
fs.writeFileSync(path.join(FIX, 'sleeper.test.cjs'), "require('node:test')('sleeps until killed (10 min bound)', () => new Promise((r) => setTimeout(r, 10 * 60_000)));\n");

function cleanEnv(extra) {
  const env = { ...process.env };
  for (const k of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'GUPPY_TEST_RUN', 'HIVE_LEDGER_URL']) delete env[k];
  return nodeEnv({ ...env, ...extra });
}
function start(args, { url, agent = 'a', preload = PRELOAD, root = JAIL } = {}) {
  const env = cleanEnv({ NODE_OPTIONS: `--require "${preload.replace(/\\/g, '/')}"`, HIVE_LEDGER_URL: url, HIVE_ROOT: root, AGENT_ID: agent });
  const child = spawn(args[0], args.slice(1), { cwd: FIX, env, windowsHide: true });
  const bornMs = Date.now();
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.resume();
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
  return { child, done, bornMs };
}
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), ms))]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms, what) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(50); }
}
/** Kill a start()ed child and its tree: on win32 only what own-procs proves is ours (no taskkill /T). */
function killTree({ child, bornMs }, { rootFirst = false } = {}) {
  // rootFirst: the root before its children (killVerified hands them deepest first). For a lease
  // holder, so it is gone before its file child dies and cannot exit on its own and release.
  if (process.platform === 'win32') own.killOwnTree({ pid: child.pid, bornMs }, rootFirst ? { kill: (rows) => own.stopIfSame(rows.slice().reverse()) } : {});
  else try { process.kill(-child.pid, 'SIGKILL'); } catch { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }
}

async function broker(t, M, deps = {}) {
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\hlo196-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(fs.mkdtempSync(path.join(JAIL, 's-')), 's.sock');
  const hive = {
    sockPath: () => sock, codexHomeFor: () => null, recordSession: () => {}, appendLog: () => {},
    registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {},
    toolOutputDir: (id) => path.join(JAIL, 'agents', id, 'tool-output')
  };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => ({ send: () => {} }), () => ({}), control);
  const logs = []; const notes = [];
  const lock = new M.HeavyJobLock({ limit: () => 1, log: (r) => logs.push(r), notify: (a) => notes.push(a), parentImage: M.processImage, ...deps });
  s.setHeavyLock(lock);
  s.start();
  t.after(() => s.stop());
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await sleep(5);
  const url = (a) => s.hookUrl(a).replace('/hook/', '/ledger/');
  return { s, lock, logs, notes, url };
}

/** The parallel cell's listing: what the lock was asked about, while it lives (see the header). */
function recorder(M) {
  const seen = new Map();
  const self = { pid: process.pid, parentPid: 0, commandLine: 'the test process', createdMs: Math.round(Date.now() - process.uptime() * 1000) };
  return {
    watch(lock) {
      const lease = lock.lease.bind(lock);
      lock.lease = (agentId, r, gone) => {
        const pid = Number(r && r.pid);
        if (Number.isInteger(pid) && pid > 0) seen.set(pid, Math.round(Number(r.createdMs)));
        return lease(agentId, r, gone);
      };
    },
    probe: async () => [self, ...[...seen].filter(([pid]) => M.pidRunning(pid)).map(([pid, createdMs]) => ({ pid, parentPid: 0, commandLine: 'node', createdMs }))]
  };
}

/** E2E MUST C. probe: 'recorder' (the parallel cell) or 'real' (the serial perf lane). */
async function mustC(t, { M = HJ, preload = PRELOAD, probe = 'recorder' } = {}) {
  if (process.platform !== 'win32') { t.skip('the process listing is Windows-only'); return; }
  if (probe !== 'recorder' && probe !== 'real') throw new Error(`mustC: probe must be 'recorder' or 'real', not ${probe}`);
  const rec = probe === 'recorder' ? recorder(M) : null;
  const b = rec ? await broker(t, M, { probe: rec.probe, roots: () => [] })
    : await broker(t, M, { probe: () => M.probeProcesses(require('../tools/ps-env.cjs').psEnv()), roots: () => [] });
  if (rec) rec.watch(b.lock);
  // A crashed lease holder: killed outright, so its exit handler never runs.
  const run = start([process.execPath, '--test', 'sleeper.test.cjs'], { url: b.url('a'), preload });
  t.after(() => { if (run.child.exitCode === null) try { killTree(run); } catch { /* gone */ } });   // it never ends on its own
  await until(() => b.lock.snapshot().length === 1, 15_000, 'the lease');
  // b's wrapper waits behind it; c is denied at PreToolUse and queued after b.
  const wb = start([process.execPath, 'wrapper.cjs'], { url: b.url('b'), agent: 'b', preload });
  await until(() => b.lock.queueSnapshot().waiters.some((w) => w.agentId === 'b'), 15_000, "b's wait");
  assert.equal(b.lock.acquire('c', H, 'npm test', 'hc', false).allow, false);
  killTree(wb);
  // INT102-TEST-FOLLOWUPS (Jim, INT-1.1.102 MUST C): the lease holder (the node --test runner)
  // dies BEFORE its file child. Killed after, it could see the child die and exit on its own, and
  // its preload's release would log lease-end, not lease-gone.
  assert.equal(run.child.exitCode, null, 'the lease holder is still running when it is killed (a crash, not an exit)');
  killTree(run, { rootFirst: true });
  await wb.done; await run.done;
  const t0 = Date.now();
  await b.lock.scan();
  // Every assert names the lock's path, so a flake says which way the slot was freed.
  const trail = () => `${JSON.stringify(b.logs.map((x) => [x.action, x.agentId, x.reason].filter(Boolean).join(':')))} notes=${JSON.stringify(b.notes)} scan+${Date.now() - t0}ms`;
  await until(() => b.notes.includes('c'), 15_000, "c's notice").catch((e) => { throw new Error(`${e.message}: ${trail()}`); });
  assert.ok(b.logs.some((x) => x.action === 'lease-gone' && x.agentId === 'a'), `A CRASHED TEST RUN'S LEASE IS FREED BY THE SCAN: ${trail()}`);
  assert.ok(b.logs.some((x) => x.action === 'queue-dropped' && x.agentId === 'b' && x.reason === 'waiter-gone'), `A KILLED WAITING WRAPPER LEAVES THE QUEUE: ${trail()}`);
  assert.deepEqual(b.notes, ['c'], `THE NEXT QUEUED AGENT GETS HEAVY SLOT FREE WITHIN ONE SCAN: ${trail()}`);
}

module.exports = { JAIL, FIX, cleanEnv, start, within, sleep, until, killTree, broker, mustC };
