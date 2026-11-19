'use strict';
require('../tools/own-job.cjs');

/**
 * HEAVY-LOCK-SCRIPT-ELECTRON-LIGHT-108. Jim, 2026-11-17 16:50-16:58Z: `node repro.cjs` started a
 * hidden Electron twice while UHera held the heavy slot. The call looked light (a node script), and
 * the heavy preload asked only for test processes, suite runners, npm installs and builders.
 *
 * Now the preload judges what runs: in every hive agent node process it wraps child_process, and a
 * child whose executable is electron(.exe) (not ELECTRON_RUN_AS_NODE) waits for the slot first. The
 * process asks once and keeps what it gets until it exits. The lock treats it as a bench (exclusive):
 *   - inside a HELD run (a suite, a bench of this agent) it shares the slot at once;
 *   - inside a LIGHT run (a single test file, a filtered runner) it does NOT inherit light: it waits;
 *   - its run key is its own, so a light single-file run that starts Electron stays counted.
 * A single test file that starts no Electron stays light (HEAVY-RESERVATION-BIND-108 fix 2).
 *
 * No real Electron starts here: the "electron.exe" is a hard link (or copy) of node.exe.
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { nodeEnv } = require('../tools/node-env.cjs');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');
const own = require('../tools/own-procs.cjs');

const electronMod = require.resolve('electron');
require.cache[electronMod] = { id: electronMod, filename: electronMod, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const REPO = path.resolve(__dirname, '..', '..');
const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);
const { HookServer } = loadTs('src/main/hooks.ts');
const PRELOAD = path.join(REPO, 'resources', 'heavy-preload.cjs');
const H = { heavy: true, kind: 'suite' };
const C0 = 1_000_000 - 5_000;

function rig(M = HJ) {
  let now = 1_000_000; const logs = []; const timers = [];
  const alive = new Set();
  const l = new M.HeavyJobLock({
    limit: () => 1, now: () => now, log: (r) => logs.push(r),
    setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    notify: () => {}, notifyLapse: () => {},
    parentImage: async () => 'node.exe', pidAlive: (pid) => alive.has(pid), leasePollMs: 0
  });
  return { l, logs, alive };
}
const ask = (x, agentId, pid, more = {}) => x.l.lease(agentId, { op: 'acquire', pid, createdMs: C0, ppid: 50, files: [], ...more });
const electronAsk = (x, agentId, pid, parentRun) => ask(x, agentId, pid, { preloadKind: 'electron', ...(parentRun ? { parentRun } : {}) });

const K = {};

// ─── the lock: an Electron launch is a bench of its own ───────────────────────────────────────────

K.lightParent = async (M = HJ) => {
  const x = rig(M);
  x.l.acquire('b', H, 'npm test', 'hb', false);
  x.l.noteCall('a', 'c1', 'node runone.cjs');
  x.alive.add(101);
  const one = await ask(x, 'a', 101, { files: ['test/one.test.cjs'] });
  assert.deepEqual([one.state, one.why], ['light', 'one test file, one at a time'], 'A SINGLE TEST FILE STAYS LIGHT (HEAVY-RESERVATION-BIND-108 fix 2)');
  // The test file's process (or a script it started, which inherited GUPPY_TEST_RUN) starts Electron.
  const e = await electronAsk(x, 'a', 101, one.run);
  assert.equal(e.state, 'wait', 'AN ELECTRON LAUNCH INSIDE A LIGHT RUN DOES NOT INHERIT LIGHT: IT WAITS FOR THE SLOT');
  assert.deepEqual(x.l.queueSnapshot().waiters.map((w) => w.agentId), ['a']);
  x.l.callDone('b', 'hb');
  const got = await electronAsk(x, 'a', 101, one.run);
  assert.equal(got.state, 'held', 'it gets the slot when it is free');
  assert.equal(got.leaseId, `lease:101:${C0}:electron`);
  assert.ok(x.logs.some((r) => r.action === 'lease' && r.agentId === 'a' && r.heavyKind === 'bench'), 'AN ELECTRON LAUNCH IS A BENCH (EXCLUSIVE)');
  assert.equal(x.l.snapshot()[0].agentId, 'a');
};
test('lock: an Electron launch inside a light single-file run waits for the slot, then holds it as a bench', () => K.lightParent());

K.ownRunKey = async (M = HJ) => {
  const x = rig(M);
  x.l.noteCall('a', 'c1', 'node runone.cjs');
  x.alive.add(101); x.alive.add(102);
  const one = await ask(x, 'a', 101, { files: ['test/one.test.cjs'] });
  assert.equal(one.state, 'light');
  assert.equal((await electronAsk(x, 'a', 101, one.run)).state, 'held');
  const two = await ask(x, 'a', 102, { files: ['test/two.test.cjs'] });
  assert.notEqual(two.why, 'one test file, one at a time', "THE ELECTRON LEASE DOES NOT OVERWRITE ITS PROCESS'S SINGLE-FILE RUN (one light file at a time still counts it)");
  x.l.lease('a', { op: 'release', leaseId: `lease:101:${C0}:electron` });
  const three = await ask(x, 'a', 103, { files: ['test/three.test.cjs'] });
  assert.notEqual(three.why, 'one test file, one at a time', 'releasing the Electron lease leaves the single-file run counted');
};
test('lock: the Electron lease has its own run key (the single-file run of the same process stays counted)', () => K.ownRunKey());

K.heldParent = async (M = HJ) => {
  const x = rig(M);
  x.l.acquire('b', H, 'npm test', 'hb', false);
  x.l.callDone('b', 'hb');
  // Agent a's suite holds the slot; a test file under it starts Electron.
  x.alive.add(200); x.alive.add(201);
  const suite = await ask(x, 'a', 200, { suite: true });
  assert.equal(suite.state, 'held');
  const e = await electronAsk(x, 'a', 201, suite.run);
  assert.deepEqual([e.state, e.leaseId, e.why], ['held', null, 'part of a held run'], 'INSIDE A HELD RUN AN ELECTRON LAUNCH SHARES THE SLOT AT ONCE');
};
test('lock: an Electron launch inside a held run (a suite) shares the slot at once', () => K.heldParent());

K.otherAgentParent = async (M = HJ) => {
  const x = rig(M);
  x.alive.add(200);
  const suite = await ask(x, 'b', 200, { suite: true });
  assert.equal(suite.state, 'held');
  x.alive.add(201);
  const e = await electronAsk(x, 'a', 201, suite.run);
  assert.equal(e.state, 'wait', "ANOTHER AGENT'S RUN IS NOT THIS ONE'S");
};
test("lock: another agent's held run does not let an Electron launch through", () => K.otherAgentParent());

// ─── end to end: real processes, the real preload, the real broker route ──────────────────────────

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'hse108-'));
test.after(() => { try { fs.rmSync(JAIL, { recursive: true, force: true }); } catch { /* best effort */ } });
const FIX = path.join(JAIL, 'fix');
const BIN = path.join(JAIL, 'bin');
fs.mkdirSync(FIX, { recursive: true });
fs.mkdirSync(BIN, { recursive: true });
// A stand-in Electron: node itself under the name electron(.exe). Nothing graphical ever starts.
const FAKE = path.join(BIN, process.platform === 'win32' ? 'electron.exe' : 'electron');
try { fs.linkSync(process.execPath, FAKE); } catch { fs.copyFileSync(process.execPath, FAKE); fs.chmodSync(FAKE, 0o755); }
const E = JSON.stringify(FAKE);
// TEST-EXECPATH-ENV-108 (god e5645c): node-only. Under the Electron leg process.execPath is electron.exe,
// so FAKE is the REAL Electron and these scripts' children inherit ELECTRON_RUN_AS_NODE (node, never asked
// about): the E2E premise cannot hold there, and without the key they would start real Electron apps.
const NODE_ONLY = process.versions.electron ? 'node-only: under the Electron leg the stand-in electron.exe is the real Electron (a hard link to process.execPath); run this file under node' : false;
// e2eSingleFile proves nothing there either: heavy-preload.cjs turns its spawn guard off whenever
// process.versions.electron is set, so "runs at once" holds with or without the fix (Jim NIT 2).
const NODE_ONLY_GUARD_OFF = process.versions.electron ? 'node-only: under the Electron leg heavy-preload.cjs has its spawn guard off (versions.electron is set), so a single file always runs at once and the test is vacuous; run this file under node' : false;
const N = JSON.stringify(process.execPath);
// Jim's shape: a node script that starts (hidden) Electron twice, one after the other.
fs.writeFileSync(path.join(FIX, 'launch.cjs'), `const { spawn } = require('node:child_process');
const once = () => new Promise((r) => spawn(${E}, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true }).on('close', r));
(async () => { await once(); process.stdout.write('launched 1\\n'); await once(); process.stdout.write('launched 2\\n'); })();\n`);
// HEAVY-LOCK-SCRIPT-ELECTRON-108-CENSUS-RACE: the state two suites hit, made certain. The first launch is quick,
// the second runs 4 s, so an UNGUARDED run has written 'launched 1' and is still running at any fixed early clock.
fs.writeFileSync(path.join(FIX, 'launch-slow.cjs'), `const { spawn } = require('node:child_process');
const once = (code) => new Promise((r) => spawn(${E}, ['-e', code], { stdio: 'ignore', windowsHide: true }).on('close', r));
(async () => { await once('process.exit(0)'); process.stdout.write('launched 1\\n'); await once('setTimeout(() => {}, 4000)'); process.stdout.write('launched 2\\n'); })();\n`);
fs.writeFileSync(path.join(FIX, 'launch-sync.cjs'), `const r = require('node:child_process').spawnSync(${E}, ['-e', 'process.exit(0)'], { windowsHide: true });
process.stdout.write('launched ' + r.status + '\\n');\n`);
fs.writeFileSync(path.join(FIX, 'launch-execfile.cjs'), `require('node:child_process').execFile(${E}, ['-e', 'process.exit(0)'], { windowsHide: true }, (e) => process.stdout.write('launched ' + !e + '\\n'));\n`);
fs.writeFileSync(path.join(FIX, 'as-node.cjs'), `const { spawnSync, spawn } = require('node:child_process');
spawnSync(${E}, ['-e', '0'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
spawn(${E}, ['-e', '0'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true }).on('close', () => process.stdout.write('ok\\n'));\n`);
fs.writeFileSync(path.join(FIX, 'plain.cjs'), `const { spawnSync, spawn, execFileSync } = require('node:child_process');
spawnSync(${N}, ['-e', '0'], { windowsHide: true }); execFileSync(${N}, ['-e', '0'], { windowsHide: true });
spawn(${N}, ['-e', '0'], { windowsHide: true }).on('close', () => process.stdout.write('ok\\n'));\n`);
fs.writeFileSync(path.join(FIX, 'one.test.cjs'), "require('node:test')('one', () => {});\n");
fs.writeFileSync(path.join(FIX, 'runone.cjs'), `const r = require('node:child_process').spawnSync(${N}, ['--test', 'one.test.cjs'], { stdio: 'inherit', windowsHide: true }); process.exit(r.status);\n`);

function cleanEnv(extra) {
  const env = { ...process.env };
  for (const k of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'GUPPY_TEST_RUN', 'HIVE_LEDGER_URL', 'ELECTRON_RUN_AS_NODE']) delete env[k];
  return { ...env, ...extra };
}
// Jim SHOULD 1: an Electron main process (a dev or harness app an agent started inherits NODE_OPTIONS)
// is not guarded: a self-spawn there would block the app's main thread in a synchronous slot wait.
// No real Electron starts here either: this makes node say it is Electron before the preload loads.
const AS_ELECTRON = path.join(FIX, 'as-electron.cjs');
fs.writeFileSync(AS_ELECTRON, "Object.defineProperty(process, 'versions', { value: { ...process.versions, electron: '45.0.0' }, configurable: true });\n");
function start(args, { url, agent = 'a', preload = PRELOAD, asElectron = false } = {}) {
  const req = (p) => `--require "${p.replace(/\\/g, '/')}"`;
  // TEST-EXECPATH-ENV-108: cleanEnv drops ELECTRON_RUN_AS_NODE, and args[0] is process.execPath here: under the
  // Electron leg the child would be a real Electron app. nodeEnv puts the key back only under Electron.
  const env = nodeEnv(cleanEnv({ NODE_OPTIONS: `${asElectron ? `${req(AS_ELECTRON)} ` : ''}${req(preload)}`, HIVE_LEDGER_URL: url, HIVE_ROOT: JAIL, AGENT_ID: agent }));
  const child = spawn(args[0], args.slice(1), { cwd: FIX, env, windowsHide: true });
  const bornMs = Date.now();
  let stderr = ''; let stdout = ''; let closed = false;
  // CENSUS-RACE: until(pred) resolves at the first output or close event at which pred holds (no clock).
  const waits = [];
  const check = () => { for (const w of waits.splice(0)) if (!w.pred({ stdout, stderr, closed })) waits.push(w); else w.resolve({ stdout, stderr, closed }); };
  child.stderr.on('data', (d) => { stderr += d; check(); });
  child.stdout.on('data', (d) => { stdout += d; check(); });
  const done = new Promise((resolve) => child.on('close', (code) => { closed = true; check(); resolve({ code, stderr, stdout }); }));
  const until = (pred) => new Promise((resolve) => { waits.push({ pred, resolve }); check(); });
  return { child, done, bornMs, out: () => stdout, until };
}
const WAITING = /\[guppy\] waiting for the heavy-job slot to start Electron \(held by b/;
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), ms))]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function killTree({ child, bornMs }) {
  if (process.platform === 'win32') own.killOwnTree({ pid: child.pid, bornMs });
  else try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
}

async function broker(t, M) {
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\hse108-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(fs.mkdtempSync(path.join(JAIL, 's-')), 'h.sock');
  const hive = {
    sockPath: () => sock, codexHomeFor: () => null, recordSession: () => {}, appendLog: () => {},
    registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {},
    toolOutputDir: (id) => path.join(JAIL, 'agents', id, 'tool-output')
  };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => ({ send: () => {} }), () => ({}), control);
  const logs = [];
  const lock = new M.HeavyJobLock({ limit: () => 1, log: (r) => logs.push(r), notify: () => {}, parentImage: M.processImage });
  s.setHeavyLock(lock);
  s.start();
  t.after(() => s.stop());
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await sleep(5);
  const url = (a) => s.hookUrl(a).replace('/hook/', '/ledger/');
  return { lock, logs, url };
}

/** A counting stand-in broker: every request answers light. */
async function counter(t) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      hits.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ state: 'light', run: '1:1', why: 'counter' }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { hits, url: `http://127.0.0.1:${srv.address().port}/ledger/a/${'0'.repeat(32)}` };
}

K.e2eScript = async (t, M = HJ, preload = PRELOAD, scripts = ['launch.cjs', 'launch-sync.cjs', 'launch-execfile.cjs']) => {
  for (const script of scripts) {
    const b = await broker(t, M);
    b.lock.acquire('b', H, 'npm test', 'hb', false);
    const run = start([process.execPath, script], { url: b.url('a'), preload });
    t.after(() => killTree(run));
    // HEAVY-LOCK-SCRIPT-ELECTRON-108-CENSUS-RACE: "it waited" is an event, not a 2.5 s clock. The first event
    // decides: the preload says it waits for the slot (stderr), or a launch finished (stdout), or the script
    // ended. Only the first can come from a guarded script while b holds: its launches start after the slot.
    // One assertion carries both facts (Jim 64eb93), so an unguarded run fails it however slow it is.
    const first = await within(run.until((s) => s.closed || s.stdout !== '' || WAITING.test(s.stderr)), 20_000);
    const waited = first !== 'timeout' && !first.closed && first.stdout === '' && WAITING.test(first.stderr);
    assert.ok(waited, `${script}: A NODE SCRIPT THAT STARTS ELECTRON WAITS FOR THE SLOT (it is not light) AND NO ELECTRON STARTED WHILE ANOTHER AGENT HELD THE SLOT: ${first === 'timeout' ? 'no event in 20 s' : `ended ${first.closed}, stdout ${JSON.stringify(first.stdout)}, stderr ${JSON.stringify(first.stderr.slice(-400))}`}`);
    assert.deepEqual(b.lock.queueSnapshot().waiters.map((w) => w.agentId), ['a']);
    b.lock.callDone('b', 'hb');
    const r = await within(run.done, 20_000);
    assert.notEqual(r, 'timeout', `${script}: it runs once the slot is free`);
    assert.equal(r.code, 0, `${script}: ${r.stderr}`);
    assert.match(r.stderr, WAITING);
    assert.match(r.stdout, /launched/);
    const leases = b.logs.filter((x) => x.action === 'lease' && x.agentId === 'a');
    assert.equal(leases.length, 1, `${script}: THE PROCESS ASKS ONCE AND KEEPS ITS LEASE (both launches covered)`);
    assert.equal(leases[0].heavyKind, 'bench');
    assert.ok(b.logs.some((x) => x.action === 'lease-end' && x.agentId === 'a'), `${script}: THE LEASE IS RELEASED AT EXIT`);
    assert.equal(b.lock.snapshot().length, 0);
  }
};
test('E2E: a node script that starts Electron (spawn, spawnSync, execFile) waits for another agent\'s slot, starts it after, and releases at exit', { timeout: 120_000, skip: NODE_ONLY }, (t) => K.e2eScript(t));
K.e2eScriptSlow = (t, M = HJ, preload = PRELOAD) => K.e2eScript(t, M, preload, ['launch-slow.cjs']);
test('E2E (CENSUS-RACE): a script whose second Electron launch is slow waits for the slot too', { timeout: 60_000, skip: NODE_ONLY }, (t) => K.e2eScriptSlow(t));

K.e2eNotElectron = async (t, M = HJ, preload = PRELOAD) => {
  const c = await counter(t);
  for (const script of ['plain.cjs', 'as-node.cjs']) {
    const r = await within(start([process.execPath, script], { url: c.url, preload }).done, 30_000);
    assert.notEqual(r, 'timeout', script);
    assert.equal(r.code, 0, `${script}: ${r.stderr}`);
    assert.match(r.stdout, /ok/);
  }
  assert.deepEqual(c.hits, [], 'A SCRIPT THAT STARTS NODE, OR ELECTRON AS NODE (ELECTRON_RUN_AS_NODE), NEVER ASKS');
};
test('E2E: a script that starts node, or Electron with ELECTRON_RUN_AS_NODE, never asks', { timeout: 60_000, skip: NODE_ONLY }, (t) => K.e2eNotElectron(t));

K.e2eInElectron = async (t, M = HJ, preload = PRELOAD) => {
  const c = await counter(t);
  const r = await within(start([process.execPath, 'launch-sync.cjs'], { url: c.url, preload, asElectron: true }).done, 30_000);
  assert.notEqual(r, 'timeout');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /launched 0/, 'the stand-in Electron ran');
  assert.deepEqual(c.hits, [], 'AN ELECTRON PROCESS IS NOT GUARDED (its main thread never blocks in a slot wait)');
};
test('E2E: inside an Electron process (versions.electron set) an Electron child never asks', { timeout: 60_000, skip: NODE_ONLY }, (t) => K.e2eInElectron(t));

K.e2eSingleFile = async (t, M = HJ, preload = PRELOAD) => {
  const b = await broker(t, M);
  b.lock.acquire('b', H, 'npm test', 'hb', false);
  b.lock.noteCall('a', 'c1', 'node runone.cjs');
  const r = await within(start([process.execPath, 'runone.cjs'], { url: b.url('a'), preload }).done, 30_000);
  assert.notEqual(r, 'timeout', 'A SINGLE TEST FILE STARTED BY A SCRIPT STAYS LIGHT (it does not wait behind another agent)');
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /waiting for the heavy-job slot/);
  assert.equal(b.lock.snapshot()[0].agentId, 'b');
};
test('E2E: a single test file started by a script runs at once while another agent holds (HEAVY-RESERVATION-BIND-108 fix 2)', { timeout: 60_000, skip: NODE_ONLY_GUARD_OFF }, (t) => K.e2eSingleFile(t));

// ─── MUTANT CENSUS ────────────────────────────────────────────────────────────────────────────────

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
  { name: 'an Electron launch inherits a light run', file: HJF, module: true,
    edits: [[' && (!electron || (parent.held && this.holders.has(agentId)))', '']],
    killer: 'lightParent', dies: /INSIDE A LIGHT RUN DOES NOT INHERIT LIGHT/ },
  { name: 'an Electron launch inherits no run (a held suite waits on itself)', file: HJF, module: true,
    edits: [['(!electron || (parent.held && this.holders.has(agentId)))', '!electron']],
    killer: 'heldParent', dies: /INSIDE A HELD RUN AN ELECTRON LAUNCH SHARES THE SLOT AT ONCE/ },
  { name: "the Electron lease reuses its process's run key", file: HJF, module: true,
    edits: [['electron ? `${pid}:${createdMs}:electron` : ', '']],
    killer: 'ownRunKey', dies: /DOES NOT OVERWRITE ITS PROCESS'S SINGLE-FILE RUN/ },
  { name: 'preload: no spawn guard', file: PRE, preload: true,
    edits: [['if (guard) {', 'if (false) {']],
    killer: 'e2eScript', dies: /A NODE SCRIPT THAT STARTS ELECTRON WAITS FOR THE SLOT/ },
  // CENSUS-RACE: the same mutant, met by a script that is still running with 'launched 1' written (two suite reds).
  { name: 'preload: no spawn guard (a slow second launch)', file: PRE, preload: true,
    edits: [['if (guard) {', 'if (false) {']],
    killer: 'e2eScriptSlow', dies: /launch-slow\.cjs: A NODE SCRIPT THAT STARTS ELECTRON WAITS FOR THE SLOT/ },
  { name: 'preload: the synchronous functions are not guarded', file: PRE, preload: true,
    edits: [["for (const name of ['spawnSync', 'execFileSync'])", 'for (const name of [])']],
    killer: 'e2eScript', dies: /launch-sync\.cjs: A NODE SCRIPT THAT STARTS ELECTRON WAITS FOR THE SLOT/ },
  { name: 'preload: every child asks (not only an Electron executable)', file: PRE, preload: true,
    edits: [['!ELECTRON_EXE.test(file)', 'false']],
    killer: 'e2eNotElectron', dies: /NEVER ASKS/ },
  { name: 'preload: an Electron process is guarded too (Jim SHOULD 1)', file: PRE, preload: true,
    edits: [['const guard = hive && !process.versions.electron;', 'const guard = hive;']],
    killer: 'e2eInElectron', dies: /AN ELECTRON PROCESS IS NOT GUARDED/ },
  { name: 'preload: ELECTRON_RUN_AS_NODE ignored', file: PRE, preload: true,
    edits: [[' || asNode(env)) return;', ') return;']],
    killer: 'e2eNotElectron', dies: /NEVER ASKS/ },
  { name: 'preload: asks before every launch (a second lease per process)', file: PRE, preload: true,
    edits: [['if (asked || shell', 'if (shell']],
    killer: 'e2eScript', dies: /THE PROCESS ASKS ONCE/ },
  { name: 'preload: the spawn-guard lease is never released', file: PRE, preload: true,
    edits: [["process.on('exit', () => { ask({ op: 'release', leaseId }, 5_000); });", '']],
    killer: 'e2eScript', dies: /THE LEASE IS RELEASED AT EXIT/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', { timeout: 600_000 }, async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, { skip: m.preload && NODE_ONLY }, async (st) => {
      const text = mutateText(m.file, m.edits, m.name);
      let run;
      if (m.module) run = () => K[m.killer](loadTs.fromText(m.file, text));
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
