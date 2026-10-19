'use strict';

/**
 * HEAVY-LOCK-OPAQUE-SCRIPT-196. The PreToolUse classifier reads the command line (and the scripts it
 * can read), so a `node --test` started from a script it cannot read ran heavy and unlocked: Jim's
 * mutant loop `node gen-mut.cjs muts.json root test/a,test/b` (one node --test per mutant), a
 * `bash x.sh`, a scratch `node scratch.cjs`. It overlapped Creed's FULL on 2026-10-19 00:46-00:55Z.
 *
 * Now every hive agent's node processes load resources/heavy-preload.cjs (NODE_OPTIONS --require),
 * and a TEST process (node --test at the top, or a suite runner) asks the lock before any test runs:
 *   - VISIBLE, the call's own `node --test` of exactly these files under the call's shell (Jim MUST
 *     A): light, as PreToolUse already judged it. An arguments-wrapper is NOT its test run.
 *   - part of a LIVE classified run (GUPPY_TEST_RUN; Jim MUST B): inherits it (no deadlock).
 *   - otherwise HIDDEN: a heavy job. It takes a slot, shares its agent's, or waits in the queue.
 *   - a lease ends at exit, or by the scan when its process is gone; a waiter that dies leaves the
 *     queue and its reservation passes on within one scan (Jim MUST C).
 * Cooperative, not enforcement (an agent can unset NODE_OPTIONS): a broker the preload cannot reach
 * fails open, with one hive row each time (Jim SHOULD 1).
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const REPO = path.resolve(__dirname, '..', '..');
const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);
const ENV = loadTs('src/main/ptyEnv.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const PRELOAD = path.join(REPO, 'resources', 'heavy-preload.cjs');
const H = { heavy: true, kind: 'suite' };
const C0 = 1_000_000 - 5_000;   // a test process's creation time in the rigs

function rig(M = HJ, extra = {}) {
  let now = 1_000_000; const logs = []; const notes = []; const lapses = []; const timers = [];
  const images = new Map(); const alive = new Set(); let listing = null;
  const l = new M.HeavyJobLock({
    limit: () => 1, now: () => now, log: (r) => logs.push(r),
    setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    notify: (a) => notes.push(a), notifyLapse: (a) => lapses.push(a),
    parentImage: async (pid) => images.get(pid) ?? null, pidAlive: (pid) => alive.has(pid), leasePollMs: 0, ...extra
  });
  return {
    l, logs, notes, lapses, images, alive, tick: (ms) => { now += ms; }, now: () => now,
    list: (rows) => { listing = rows === null ? null : [{ pid: 4, parentPid: 0, commandLine: 'System', createdMs: 1 }, ...rows.map(([pid, createdMs]) => ({ pid, parentPid: 4, commandLine: 'node', createdMs }))]; },
    probe: async () => listing,
    fire: async () => { for (const t of timers.splice(0)) t.fn(); await flush(); }
  };
}
const flush = () => new Promise((r) => setImmediate(r));
const ask = (x, agentId, pid, more = {}) => x.l.lease(agentId, { op: 'acquire', pid, createdMs: C0, ppid: 50, files: [], ...more });

const K = {};

// ─── the classifier side: what a call IS (Jim MUST A) ─────────────────────────────────────────────

K.invocation = (M = HJ) => {
  const ti = M.testInvocation;
  assert.deepEqual(ti('node --test test/a.test.cjs'), [['test/a.test.cjs']]);
  assert.deepEqual(ti('cd x && node --test --test-name-pattern "x y" a.cjs b.cjs 2>&1 | tail -5'), [['a.cjs', 'b.cjs']]);
  assert.deepEqual(ti('bash -lc "node --test a.cjs"'), [['a.cjs']], 'a wrapper body is read');
  assert.deepEqual(ti('node --test a.cjs; node --test b.cjs'), [['a.cjs'], ['b.cjs']]);
  assert.deepEqual(ti('node --test'), [[]], 'no files: node\'s own discovery');
  for (const c of ['node gen-mut.cjs muts.json root test/a.test.cjs,test/b.test.cjs', 'node gen-mut.cjs m.json r test/a.test.cjs && node --test test/a.test.cjs',
    'bash x.sh', 'node scratch.cjs', 'node x.cjs --test', 'npm test', 'echo hi']) {
    assert.equal(ti(c), null, `AN ARGUMENTS-WRAPPER IS NOT ITS TEST RUN: ${c}`);
  }
};
test('MUST A: a call IS a node --test run only when nothing else runs beside it (an arguments-wrapper is not)', () => K.invocation());

K.visibleLight = async (M = HJ) => {
  const x = rig(M);
  x.l.acquire('b', H, 'npm test', 'hb', false);
  x.l.noteCall('a', 'c1', 'node --test test/a.test.cjs');
  x.images.set(50, 'C:\\Program Files\\Git\\usr\\bin\\bash.exe');
  const a = await ask(x, 'a', 101, { files: ['test/a.test.cjs'] });
  assert.equal(a.state, 'light', "THE CALL'S OWN SINGLE FILE IS LIGHT (while another agent holds)");
  assert.equal(a.run, `101:${C0}`);
  const again = await ask(x, 'a', 102, { files: ['test/a.test.cjs'] });
  assert.equal(again.state, 'wait', 'A CALL IS CONSUMED BY ONE TEST PROCESS');
  x.l.noteCall('c', 'c2', 'node --test test/a.test.cjs');
  x.images.set(51, 'node.exe');
  const under = await ask(x, 'c', 103, { files: ['test/a.test.cjs'], ppid: 51 });
  assert.equal(under.state, 'wait', "A TEST PROCESS UNDER ANOTHER PROGRAM IS NOT THE CALL'S OWN");
  x.l.noteCall('d', 'c3', 'node --test test/a.test.cjs');
  x.l.noteCallEnd('d', 'c3');
  x.tick(HJ.HEAVY_CALL_SLACK_MS + 1);
  assert.equal((await ask(x, 'd', 104, { files: ['test/a.test.cjs'] })).state, 'wait', 'A CALL THAT ENDED LONG AGO MATCHES NOTHING');
};
test('MUST A: the call\'s own single-file run is light; once; only under the call\'s shell; only while the call is recent', () => K.visibleLight());

K.argsWrapper = async (M = HJ) => {
  const x = rig(M);
  x.images.set(50, 'bash.exe');   // even with the most favourable parent
  x.l.noteCall('a', 'c1', 'node gen-mut.cjs muts.json root test/a.test.cjs,test/b.test.cjs');
  const a = await ask(x, 'a', 201, { files: ['test/a.test.cjs', 'test/b.test.cjs'] });
  assert.equal(a.state, 'held', "AN ARGUMENTS-WRAPPER'S TEST RUN HOLDS THE SLOT");
  assert.equal(a.leaseId, `lease:201:${C0}`);
  assert.ok(x.logs.some((r) => r.action === 'acquire' && r.agentId === 'a' && r.heavyKind === 'bench'));
};
test('MUST A: an arguments-wrapper (Jim\'s gen-mut shape) does not make its test run visible: it takes the slot', () => K.argsWrapper());

K.opaqueWaits = async (M = HJ) => {
  const x = rig(M);
  x.l.acquire('b', H, 'npm test', 'hb', false);
  x.images.set(50, 'bash.exe');
  x.l.noteCall('a', 'c1', 'node scratch.cjs');
  const a = await ask(x, 'a', 301, { files: ['test/a.test.cjs'] });
  assert.deepEqual(a, { state: 'wait', position: 1, holders: ['b'] }, "AN OPAQUE NODE WRAPPER'S TEST RUN WAITS");
  x.l.noteCall('c', 'c2', 'bash x.sh');
  assert.equal((await ask(x, 'c', 302, { files: ['test/a.test.cjs'] })).state, 'wait', "A BASH WRAPPER'S TEST RUN WAITS");
  assert.equal(x.logs.filter((r) => r.action === 'deny' && r.agentId === 'a').length, 1);
  assert.equal((await ask(x, 'a', 301, { files: ['test/a.test.cjs'] })).state, 'wait');
  assert.equal(x.logs.filter((r) => r.action === 'deny' && r.agentId === 'a').length, 1, 'a waiting process asking again is no new deny row');
  x.l.callDone('b', 'hb');
  assert.deepEqual(x.notes, [], 'A WAITING TEST PROCESS IS NOT MAILED (it takes the slot itself)');
  const b = await ask(x, 'a', 301, { files: ['test/a.test.cjs'] });
  assert.equal(b.state, 'held', 'the reserved slot is taken by the waiting process');
};
test('HIDDEN: a test run under an opaque node or bash wrapper waits while another agent holds, then takes the slot', () => K.opaqueWaits());

K.longPoll = async (M = HJ) => {
  const x = rig(M, { leasePollMs: 25_000 });
  x.l.acquire('b', H, 'npm test', 'hb', false);
  assert.equal((await within(ask(x, 'a', 401), 2_000))?.state, 'wait', 'A NEWLY QUEUED PROCESS IS TOLD AT ONCE (it says it waits)');
  let answer = null;
  const p = ask(x, 'a', 401).then((v) => { answer = v; });
  await flush();
  assert.equal(answer, null, 'the request waits');
  x.l.callDone('b', 'hb');
  await within(p, 2_000);
  assert.equal(answer?.state, 'held', 'A WAITING TEST PROCESS TAKES THE FREED SLOT AT ONCE');
};
test('the lease request is a long poll: a freed slot answers it at once', () => K.longPoll());

K.nested = async (M = HJ) => {
  const x = rig(M);
  const held = await ask(x, 'a', 501);
  assert.equal(held.state, 'held');
  x.alive.add(501);
  const child = await ask(x, 'a', 502, { parentRun: held.run, ppid: 501 });
  assert.deepEqual(child, { state: 'held', run: `502:${C0}`, leaseId: null, why: 'part of a held run' }, 'A NESTED RUN OF A HOLDER SHARES (NO DEADLOCK)');
  // MUST B: a light run's nested node --test stays light while ANOTHER agent holds.
  x.l.noteCall('c', 'c1', 'node --test test/one.test.cjs');
  x.images.set(50, 'bash.exe');
  const light = await ask(x, 'c', 601, { files: ['test/one.test.cjs'] });
  assert.equal(light.state, 'light');
  x.alive.add(601);
  const inner = await ask(x, 'c', 602, { files: ['C:/tmp/inner.test.cjs'], ppid: 601, parentRun: light.run });
  assert.equal(inner.state, 'light', 'A NESTED RUN OF A LIGHT FILE IS LIGHT WHILE ANOTHER AGENT HOLDS');
  // A stale or foreign GUPPY_TEST_RUN grants nothing: the process classifies as it would without it.
  assert.equal((await ask(x, 'd', 603, { parentRun: light.run })).state, 'wait', "ANOTHER AGENT'S RUN IS NOT INHERITED");
  assert.equal((await ask(x, 'c', 604, { parentRun: '999:1' })).state, 'wait', 'AN UNKNOWN RUN IS NOT INHERITED');
  x.alive.delete(601);
  assert.equal((await ask(x, 'c', 605, { parentRun: light.run })).state, 'wait', 'A STALE GUPPY_TEST_RUN (ITS RUN HAS EXITED) GRANTS NOTHING');
};
test('MUST B: a nested node --test inherits its LIVE run\'s class (held shares, light stays light); a stale or foreign one grants nothing', () => K.nested());

K.crashRelease = async (M = HJ) => {
  const x = rig(M);
  // a's PTY root (pid 4) is in the listing, so a holder with no job process of its own is a miss.
  const y = rig(M, { probe: x.probe, roots: () => [{ agentId: 'a', pid: 4 }] });
  x.list([[701, C0]]);
  y.tick(10 * 60_000);   // the lease came long after its process started (it had waited)
  const a = await ask(y, 'a', 701);
  assert.equal(a.state, 'held');
  y.l.acquire('c', H, 'npm test', 'hc', false);
  for (let i = 0; i < 3; i++) { y.tick(HJ.HEAVY_SCAN_MS); await y.l.scan(); }
  assert.equal(y.l.snapshot()[0]?.agentId, 'a', 'A RUNNING LEASE KEEPS THE SLOT (whenever its process started)');
  x.list([]);
  await y.l.scan();
  await flush(); await flush();
  assert.ok(y.logs.some((r) => r.action === 'lease-gone' && r.pid === 701), 'the gone lease is logged');
  assert.equal(y.l.snapshot().length, 0, "A CRASHED TEST RUN'S LEASE IS FREED BY ONE SCAN");
  assert.deepEqual(y.notes, ['c'], 'and the next queued agent is told');
};
test('a crashed test process (no exit handler) frees its lease at the next scan; a running one keeps it', () => K.crashRelease());

K.deadWaiter = async (M = HJ) => {
  const x = rig(M);
  const y = rig(M, { probe: x.probe, roots: () => [] });
  x.list([[801, C0]]);
  y.l.acquire('a', H, 'npm test', 'ha', false);
  assert.equal((await ask(y, 'b', 801)).state, 'wait');
  assert.equal(y.l.acquire('c', H, 'npm test', 'hc', false).allow, false);
  // b's waiting process dies BEFORE a slot frees: it leaves the queue (and is not mailed).
  x.list([]);
  await y.l.scan();
  assert.deepEqual(y.l.queueSnapshot().waiters.map((w) => w.agentId), ['c'], 'A DEAD WAITER LEAVES THE QUEUE');
  assert.deepEqual(y.lapses, [], 'a test-process waiter is never mailed');
  // Again, dying AFTER the slot was reserved for it: the reservation passes on within one scan.
  const z = rig(M);
  const w = rig(M, { probe: z.probe, roots: () => [] });
  z.list([[802, C0]]);
  w.l.acquire('a', H, 'npm test', 'ha', false);
  await ask(w, 'b', 802);
  w.l.acquire('c', H, 'npm test', 'hc', false);
  w.l.callDone('a', 'ha');
  await flush(); await flush();
  assert.deepEqual(w.l.queueSnapshot().reserved.map((r) => r.agentId), ['b']);
  assert.deepEqual(w.notes, [], 'the waiting process is not mailed');
  z.list([]);
  await w.l.scan();
  assert.deepEqual(w.l.queueSnapshot().reserved.map((r) => r.agentId), ['c'], "A DEAD WAITER'S RESERVATION PASSES ON WITHIN ONE SCAN");
  assert.deepEqual(w.notes, ['c'], 'THE NEXT QUEUED AGENT GETS HEAVY SLOT FREE');
  assert.ok(w.logs.some((r) => r.action === 'reserve-dropped' && r.agentId === 'b' && r.reason === 'waiter-gone'));
};
test('MUST C: a waiting test process that dies leaves the queue; a slot reserved for it passes on within one scan', () => K.deadWaiter());

K.sharedConcurrent = async (M = HJ) => {
  const x = rig(M);
  x.l.acquire('a', H, 'npm test', 'ha', true);
  assert.equal((await ask(x, 'a', 901)).state, 'held');
  assert.equal(x.logs.some((r) => r.action === 'shared-concurrent'), false, 'one lease is not concurrent');
  assert.equal((await ask(x, 'a', 902)).state, 'held');
  assert.ok(x.logs.some((r) => r.action === 'shared-concurrent' && r.agentId === 'a' && r.leases === 2), 'TWO HEAVY JOBS ON ONE SLOT ARE LOGGED (shared-concurrent)');
};
test('SHOULD 3: a second concurrent lease of one agent on its shared slot is logged as shared-concurrent', () => K.sharedConcurrent());

K.releaseOp = async (M = HJ) => {
  const x = rig(M);
  const a = await ask(x, 'a', 1001);
  assert.deepEqual(await x.l.lease('b', { op: 'release', leaseId: a.leaseId }), { state: 'released' });
  assert.equal(x.l.snapshot().length, 1, "another agent cannot release a's lease");
  await x.l.lease('a', { op: 'release', leaseId: a.leaseId });
  assert.equal(x.l.snapshot().length, 0, 'A RELEASED LEASE FREES THE SLOT');
  await assert.rejects(x.l.lease('a', { op: 'acquire' }), /pid and createdMs/);
};
test('a release frees the lease (only its own agent\'s); an acquire without a process is refused', () => K.releaseOp());

K.runner = async (M = HJ) => {
  const x = rig(M);
  assert.equal((await ask(x, 'a', 1101, { runner: ['test/tools/run-tests.cjs', 'wake'] })).state, 'light', 'A FILTERED SUITE RUNNER IS LIGHT (as at PreToolUse)');
  const full = await ask(x, 'a', 1102, { runner: ['C:\\Dunder\\wt\\test\\tools\\run-tests.cjs'] });
  assert.equal(full.state, 'held', 'A FULL SUITE RUNNER HOLDS');
  assert.ok(x.logs.some((r) => r.action === 'acquire' && r.heavyKind === 'suite'));
  const y = rig(M);
  assert.equal((await ask(y, 'a', 1103, { suite: true })).state, 'held', 'node --test with no files is a suite');
};
test('a suite runner is judged by its own argv (filtered = light); node --test with no files is a suite', () => K.runner());

K.env = (E = ENV) => {
  const req = '--require "C:/Program Files/Munder Difflin/Guppy/resources/heavy-preload.cjs"';
  const win = 'C:\\Program Files\\Munder Difflin\\Guppy\\resources\\heavy-preload.cjs';
  assert.equal(E.buildPtyEnv({ NODE_OPTIONS: '--max-old-space-size=4096' }, '', {}, 'win32', [], [win]).NODE_OPTIONS, `--max-old-space-size=4096 ${req}`, 'NODE_OPTIONS IS APPENDED TO, NEVER REPLACED');
  assert.equal(E.buildPtyEnv({ NODE_OPTIONS: '--a' }, '', { NODE_OPTIONS: '--b' }, 'win32', [], [win]).NODE_OPTIONS, `--b ${req}`, "the agent's own value is the base");
  assert.equal(E.buildPtyEnv({}, '', {}, 'win32', [], [win]).NODE_OPTIONS, req);
  assert.equal(E.buildPtyEnv({ NODE_OPTIONS: req }, '', {}, 'win32', [], [win]).NODE_OPTIONS, req, 'never twice');
  assert.equal(E.buildPtyEnv({ NODE_OPTIONS: '--x' }, '', {}, 'win32').NODE_OPTIONS, '--x', 'no preload: untouched');
};
test('env: the preload is APPENDED to NODE_OPTIONS (forward slashes, quoted, once); nothing else changes', () => K.env());

K.wiring = (idx = readSource('src/main/index.ts'), hooks = readSource('src/main/hooks.ts'), builder = readSource('electron-builder.yml'), pty = readSource('src/main/pty.ts')) => {
  assert.match(idx, /const HEAVY_PRELOAD = join\(app\.isPackaged \? process\.resourcesPath : join\(app\.getAppPath\(\), 'resources'\), 'heavy-preload\.cjs'\);/);
  assert.match(idx, /  opts\.pathPrepend = undefined;\n  opts\.nodeRequire = undefined;\n/, "nodeRequire IS MAIN'S ALONE (never the renderer's)");
  assert.match(idx, /if \(existsSync\(HEAVY_PRELOAD\)\) opts\.nodeRequire = \[HEAVY_PRELOAD\];/, 'EVERY HIVE AGENT LOADS THE PRELOAD');
  assert.match(idx, /  parentImage: processImage,\n/);
  assert.match(pty, /buildPtyEnv\(process\.env, userPath, opts\.env, process\.platform, opts\.pathPrepend, opts\.nodeRequire\)/);
  assert.match(hooks, /      if \(command\) this\.heavyLock\.noteCall\(agentId, callId, command\);\n      if \(cls\.heavy\) \{/, 'EVERY PRETOOLUSE CALL IS NOTED');
  assert.match(hooks, /      this\.heavyLock\.callDone\(agentId, HookServer\.heavyCallId\(p\)\);\n      this\.heavyLock\.noteCallEnd\(agentId, HookServer\.heavyCallId\(p\)\);/);
  assert.match(hooks, /HOOK_ROUTE\.exec\(req\.url\) \?\? HEAVY_ROUTE\.exec\(req\.url\)/);
  assert.match(builder, /  - from: resources\/heavy-preload\.cjs\n    to: heavy-preload\.cjs\n/, 'THE PRELOAD IS PACKAGED');
};
test('wiring: main sets the preload on every hive agent (main only), notes every call, routes /heavy, packages the file', () => K.wiring());

// ─── end to end: real processes, the real preload, the real broker route ──────────────────────────

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
fs.writeFileSync(path.join(FIX, 'sleeper.test.cjs'), "require('node:test')('sleeps', () => new Promise((r) => setTimeout(r, 20000)));\n");

function cleanEnv(extra) {
  const env = { ...process.env };
  for (const k of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'GUPPY_TEST_RUN', 'HIVE_LEDGER_URL']) delete env[k];
  return { ...env, ...extra };
}
function start(args, { url, agent = 'a', preload = PRELOAD, root = JAIL } = {}) {
  const env = cleanEnv({ NODE_OPTIONS: `--require "${preload.replace(/\\/g, '/')}"`, HIVE_LEDGER_URL: url, HIVE_ROOT: root, AGENT_ID: agent });
  const child = spawn(args[0], args.slice(1), { cwd: FIX, env, windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.resume();
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
  return { child, done };
}
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), ms))]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms, what) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(50); }
}
function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
  else try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
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

K.e2eOpaque = async (t, M = HJ, preload = PRELOAD) => {
  const shapes = [['node wrapper', [process.execPath, 'wrapper.cjs']]];
  const bash = spawnSync('bash', ['--version'], { windowsHide: true });
  if (!bash.error && bash.status === 0) shapes.push(['bash wrapper', ['bash', 'x.sh']]);
  for (const [what, args] of shapes) {
    const b = await broker(t, M);
    b.lock.acquire('b', H, 'npm test', 'hb', false);
    const run = start(args, { url: b.url('a'), preload });
    assert.equal(await within(run.done, 2_500), 'timeout', `AN OPAQUE ${what.toUpperCase()}'S TEST RUN WAITS FOR THE SLOT`);
    assert.deepEqual(b.lock.queueSnapshot().waiters.map((w) => w.agentId), ['a']);
    b.lock.callDone('b', 'hb');
    const r = await within(run.done, 20_000);
    assert.equal(r.code, 0, `${what}: ${r.stderr}`);
    assert.match(r.stderr, /\[guppy\] waiting for the heavy-job slot \(held by b/);
    assert.ok(b.logs.some((x) => x.action === 'lease' && x.agentId === 'a'), `${what}: leased`);
    assert.equal(b.lock.snapshot().length, 0, 'THE LEASE IS RELEASED AT EXIT');
  }
};
test('E2E: a test run under an opaque node wrapper, and under a bash script, waits for another agent\'s slot, then runs and releases at exit', { timeout: 120_000 }, (t) => K.e2eOpaque(t));

K.e2eNested = async (t, M = HJ, preload = PRELOAD) => {
  // The harness is not a shell, so the "parent is the call's shell" check is answered for it.
  const b = await broker(t, M, { parentImage: async () => 'bash.exe' });
  b.lock.acquire('b', H, 'npm test', 'hb', false);
  b.lock.noteCall('a', 'c1', 'node --test outer.test.cjs');
  const t0 = Date.now();
  const r = await within(start([process.execPath, '--test', 'outer.test.cjs'], { url: b.url('a'), preload }).done, 30_000);
  const fast = r !== 'timeout' && r.code === 0 && Date.now() - t0 < 15_000;
  assert.ok(fast, `A NESTED RUN OF A VISIBLE FILE RUNS AT ONCE (it does not wait behind another agent): ${r === 'timeout' ? r : `code ${r.code} ${r.stderr}`}`);
  assert.ok(b.logs.some((x) => x.action === 'lease-inherit' && x.agentId === 'a' && x.held === false), 'the nested run inherited its light run');
  assert.equal(b.lock.snapshot()[0].agentId, 'b');
};
test('E2E MUST B: a visible single file whose test spawns a nested node --test (NODE_TEST_CONTEXT deleted) runs at once while another agent holds', { timeout: 60_000 }, (t) => K.e2eNested(t));

K.e2eNoop = async (t, M = HJ, preload = PRELOAD) => {
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ state: 'light', run: '1:1', why: 'x' })); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}/ledger/a/${'0'.repeat(32)}`;
  for (const args of [[process.execPath, '-e', 'process.exit(0)'], [process.execPath, 'wrapper.cjs', '--no-test-here']]) {
    if (args[1] === 'wrapper.cjs') continue;
    const r = await start(args, { url, preload }).done;
    assert.equal(r.code, 0, r.stderr);
  }
  assert.equal(hits, 0, 'A NODE PROCESS THAT IS NOT A TEST RUN NEVER ASKS');
  const r = await start([process.execPath, '--test', 'leaf.test.cjs'], { url, preload }).done;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(hits, 1, 'ONLY THE TEST RUNNER ASKS (its per-file child does not)');
};
test('E2E no-op: a node process that is not a test run never asks; a node --test run asks once (its file processes never)', { timeout: 60_000 }, (t) => K.e2eNoop(t));

K.e2eFailOpen = async (t, M = HJ, preload = PRELOAD) => {
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  const root = fs.mkdtempSync(path.join(JAIL, 'root-'));
  const r = await start([process.execPath, '--test', 'leaf.test.cjs'], { url: `http://127.0.0.1:${port}/ledger/a/${'0'.repeat(32)}`, preload, root }).done;
  assert.equal(r.code, 0, `it runs unlocked: ${r.stderr}`);
  assert.match(r.stderr, /\[guppy\] heavy lock unreachable, running unlocked/);
  const rows = fs.existsSync(path.join(root, 'log.jsonl')) ? fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  assert.equal(rows.filter((x) => x.kind === 'heavy-lock' && x.action === 'lease-fail-open' && x.agentId === 'a').length, 1, 'A FAIL-OPEN IS ONE HIVE ROW');
};
test('E2E SHOULD 1: a broker the preload cannot reach fails open, with one hive row', { timeout: 60_000 }, (t) => K.e2eFailOpen(t));

K.e2eCrashAndDeadWaiter = async (t, M = HJ, preload = PRELOAD) => {
  if (process.platform !== 'win32') { t.skip('the process listing is Windows-only'); return; }
  const b = await broker(t, M, { probe: M.probeProcesses, roots: () => [] });
  // A crashed lease holder: killed outright, so its exit handler never runs.
  const run = start([process.execPath, '--test', 'sleeper.test.cjs'], { url: b.url('a'), preload });
  await until(() => b.lock.snapshot().length === 1, 15_000, 'the lease');
  // b's wrapper waits behind it; c is denied at PreToolUse and queued after b.
  const wb = start([process.execPath, 'wrapper.cjs'], { url: b.url('b'), agent: 'b', preload });
  await until(() => b.lock.queueSnapshot().waiters.some((w) => w.agentId === 'b'), 15_000, "b's wait");
  assert.equal(b.lock.acquire('c', H, 'npm test', 'hc', false).allow, false);
  killTree(wb.child.pid);
  killTree(run.child.pid);
  await wb.done; await run.done;
  await b.lock.scan();
  await until(() => b.notes.includes('c'), 15_000, "c's notice");
  assert.ok(b.logs.some((x) => x.action === 'lease-gone' && x.agentId === 'a'), "A CRASHED TEST RUN'S LEASE IS FREED BY THE SCAN");
  assert.ok(b.logs.some((x) => x.action === 'queue-dropped' && x.agentId === 'b' && x.reason === 'waiter-gone'), 'A KILLED WAITING WRAPPER LEAVES THE QUEUE');
  assert.deepEqual(b.notes, ['c'], 'THE NEXT QUEUED AGENT GETS HEAVY SLOT FREE WITHIN ONE SCAN');
};
test('E2E MUST C: a killed lease holder and a waiting wrapper killed with taskkill /F leave the lock; the next agent gets HEAVY SLOT FREE in one scan', { timeout: 120_000 }, (t) => K.e2eCrashAndDeadWaiter(t));

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}
const PRE = 'resources/heavy-preload.cjs';

const MUTANTS = [
  { name: 'an arguments-wrapper reads as its test run (other node segments ignored)', file: HJF, module: true,
    edits: [["    if (!test) return null;\n    runs.push(files);", '    if (!test) continue;\n    runs.push(files);']],
    killer: 'invocation', dies: /AN ARGUMENTS-WRAPPER IS NOT ITS TEST RUN/ },
  { name: 'an arguments-wrapper reads as its test run (the lock side: any call mentioning the files)', file: HJF, module: true,
    edits: [['    const runs = (testInvocation(command) ?? []).filter((files) => files.length);', "    const runs = (testInvocation(command) ?? [command.split(' ').slice(-1)[0].split(',')]).filter((files) => files.length);"]],
    killer: 'argsWrapper', dies: /AN ARGUMENTS-WRAPPER'S TEST RUN HOLDS THE SLOT/ },
  { name: 'the parent is not checked', file: HJF, module: true,
    edits: [['    if (!CALL_PARENT.test(name)) {', '    if (false) {']],
    killer: 'visibleLight', dies: /A TEST PROCESS UNDER ANOTHER PROGRAM IS NOT THE CALL'S OWN/ },
  { name: 'a call is never consumed', file: HJF, module: true,
    edits: [['    c.used = true;\n    return true;', '    return true;']],
    killer: 'visibleLight', dies: /A CALL IS CONSUMED BY ONE TEST PROCESS/ },
  { name: 'nothing is visible (every single file waits)', file: HJF, module: true,
    edits: [["    if (!suite && await this.visible(agentId, r)) {", '    if (false) {']],
    killer: 'visibleLight', dies: /THE CALL'S OWN SINGLE FILE IS LIGHT/ },
  { name: 'no inheritance (a nested run acquires on its own)', file: HJF, module: true,
    edits: [['    if (parent && parent.agentId === agentId && this.runAlive(r.parentRun!)) {', '    if (false) {']],
    killer: 'nested', dies: /A NESTED RUN OF A HOLDER SHARES/ },
  { name: 'a stale run is inherited (no liveness check)', file: HJF, module: true,
    edits: [['    if (parent && parent.agentId === agentId && this.runAlive(r.parentRun!)) {', '    if (parent && parent.agentId === agentId) {']],
    killer: 'nested', dies: /A STALE GUPPY_TEST_RUN \(ITS RUN HAS EXITED\) GRANTS NOTHING/ },
  { name: "another agent's run is inherited", file: HJF, module: true,
    edits: [['    if (parent && parent.agentId === agentId && this.runAlive(r.parentRun!)) {', '    if (parent && this.runAlive(r.parentRun!)) {']],
    killer: 'nested', dies: /ANOTHER AGENT'S RUN IS NOT INHERITED/ },
  { name: 'a lease does not keep its agent busy (only call windows do)', file: HJF, module: true,
    edits: [['    for (const l of this.leases.values()) if (procLive(byPid, l.pid, l.createdMs)) busy.add(l.agentId);\n', '']],
    killer: 'crashRelease', dies: /A RUNNING LEASE KEEPS THE SLOT/ },
  { name: 'a gone lease is never ended', file: HJF, module: true,
    edits: [["    for (const [id, l] of [...this.leases]) if (!procLive(byPid, l.pid, l.createdMs)) this.leaseEnd(l.agentId, id, 'gone');\n", '']],
    killer: 'crashRelease', dies: /the gone lease is logged/ },
  { name: 'a dead waiter stays queued', file: HJF, module: true,
    edits: [['      if (w.procs.length || w.hooked) continue;\n      this.dequeue(w.agentId);', '      continue;\n      this.dequeue(w.agentId);']],
    killer: 'deadWaiter', dies: /A DEAD WAITER LEAVES THE QUEUE/ },
  { name: "a dead waiter's reservation is kept", file: HJF, module: true,
    edits: [['      if (r.procs.length || r.hooked) continue;\n      this.reservations.delete(agentId);', '      continue;\n      this.reservations.delete(agentId);']],
    killer: 'deadWaiter', dies: /A DEAD WAITER'S RESERVATION PASSES ON WITHIN ONE SCAN/ },
  { name: 'a waiting test process is mailed', file: HJF, module: true,
    edits: [['      if (!w.hooked) continue;\n', '']],
    killer: 'opaqueWaits', dies: /A WAITING TEST PROCESS IS NOT MAILED/ },
  { name: 'the long poll never wakes on a freed slot', file: HJF, module: true,
    edits: [['await this.waitFor(left, () => this.reservations.has(agentId) || !!gone?.())', 'await this.waitFor(left, () => false)']],
    killer: 'longPoll', dies: /the request waits|A WAITING TEST PROCESS TAKES THE FREED SLOT AT ONCE/ },
  { name: 'no shared-concurrent row', file: HJF, module: true,
    edits: [["          if (mine > 1) this.log({ kind: 'heavy-lock', action: 'shared-concurrent', agentId, leases: mine });\n", '']],
    killer: 'sharedConcurrent', dies: /TWO HEAVY JOBS ON ONE SLOT ARE LOGGED/ },
  { name: 'a released lease keeps the slot', file: HJF, module: true,
    edits: [['    this.callDone(agentId, id);\n  }', '  }']],
    killer: 'releaseOp', dies: /A RELEASED LEASE FREES THE SLOT/ },
  { name: 'a suite runner is always heavy (a filtered run too)', file: HJF, module: true,
    edits: [['      if (!classifyCommand(argv).heavy) {', '      if (false) {']],
    killer: 'runner', dies: /A FILTERED SUITE RUNNER IS LIGHT/ },
  { name: 'the preload REPLACES NODE_OPTIONS', file: 'src/main/ptyEnv.ts', env: true,
    edits: [['[baseOptions.trim(), ...requires]', '[...requires]']],
    killer: 'env', dies: /NODE_OPTIONS IS APPENDED TO, NEVER REPLACED/ },
  { name: 'PreToolUse does not note calls', file: 'src/main/hooks.ts', wiring: true,
    edits: [['      if (command) this.heavyLock.noteCall(agentId, callId, command);\n', '']],
    killer: 'wiring', dies: /EVERY PRETOOLUSE CALL IS NOTED/ },
  // The preload itself (a real process loads the mutated file).
  { name: 'preload: no fast path (every node process asks)', file: PRE, preload: true,
    edits: [["if (require.main !== module && !((process.execArgv.includes('--test')", "if (require.main !== module && false && !((process.execArgv.includes('--test')"]],
    killer: 'e2eNoop', dies: /A NODE PROCESS THAT IS NOT A TEST RUN NEVER ASKS/ },
  { name: 'preload: GUPPY_TEST_RUN not passed on (a nested run waits behind another agent)', file: PRE, preload: true,
    edits: [['    process.env.GUPPY_TEST_RUN = a.run;\n', '']],
    killer: 'e2eNested', dies: /A NESTED RUN OF A VISIBLE FILE RUNS AT ONCE/ },
  { name: 'preload: the lease is not released at exit', file: PRE, preload: true,
    edits: [["      process.on('exit', () => { ask({ op: 'release', leaseId }, 5_000); });\n", '']],
    killer: 'e2eOpaque', dies: /THE LEASE IS RELEASED AT EXIT/ },
  { name: 'preload: a fail-open writes no row', file: PRE, preload: true,
    edits: [["    if (root) require('node:fs').appendFileSync(", "    if (false) require('node:fs').appendFileSync("]],
    killer: 'e2eFailOpen', dies: /A FAIL-OPEN IS ONE HIVE ROW/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', { timeout: 600_000 }, async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async (st) => {
      const text = mutateText(m.file, m.edits, m.name);
      let run;
      if (m.module) run = () => K[m.killer](loadTs.fromText(m.file, text));
      else if (m.env) run = () => K[m.killer](loadTs.fromText(m.file, text));
      else if (m.wiring) run = () => K[m.killer](undefined, text);
      else {
        const p = path.join(JAIL, `pre-${MUTANTS.indexOf(m)}.cjs`);
        fs.writeFileSync(p, text);
        run = () => K[m.killer](st, HJ, p);
      }
      await assert.rejects(async () => run(), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
