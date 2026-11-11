'use strict';
require('../tools/own-job.cjs');

/**
 * HEAVY-PRELOAD-SHORT-TEST. Andy (mail 58a657 point 3, 2026-11-11 06:28-06:40Z): short single-file
 * `node --test` runs queued behind Dwight's slot ("[guppy] waiting for the heavy-job slot") and his
 * `timeout` killed the wait (lease-fail-open "helper exit 143"); every deny row said "a node --test its
 * call does not show (heavy preload)".
 *
 * Cause: the preload sends the app the test process's files; the app's lease() made a test process light
 * only when visible() matched it to the agent's PreToolUse call, i.e. testInvocation() could READ the
 * call. Andy's calls ran node by variable (`$N --test f`), beside `$(date ...)`, or ran one literal file
 * several times in a loop (the call's match is consumed by the first process). None of those read, so
 * each single file fell through to the heavy 'bench' class and queued.
 *
 * Fix: one named test file is light when an open call of the agent SHOWS a `--test` run (its text), its
 * parent is a shell, and no other light single-file run of the agent is alive. A hidden wrapper (no
 * `--test` in the call), a node/python parent, a glob, a directory, several files, node's own discovery
 * (no files), a suite runner, and a parallel fan-out still take the slot.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const REPO = path.resolve(__dirname, '..', '..');
const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);
const { HookServer } = loadTs('src/main/hooks.ts');
const PRELOAD = path.join(REPO, 'resources', 'heavy-preload.cjs');
const H = { heavy: true, kind: 'suite' };
const C0 = 1_000_000 - 5_000;

function rig(M = HJ) {
  let now = 1_000_000; const logs = []; const images = new Map(); const alive = new Set();
  const l = new M.HeavyJobLock({
    limit: () => 1, now: () => now, log: (r) => logs.push(r), setTimer: () => ({}), clearTimer: () => {},
    notify: () => {}, notifyLapse: () => {}, parentImage: async (pid) => images.get(pid) ?? null, pidAlive: (pid) => alive.has(pid), leasePollMs: 0
  });
  images.set(50, 'C:\\Program Files\\Git\\usr\\bin\\timeout.exe');
  images.set(51, 'node.exe');
  return { l, logs, images, alive, tick: (ms) => { now += ms; } };
}
const ask = (x, agentId, pid, more = {}) => x.l.lease(agentId, { op: 'acquire', pid, createdMs: C0, ppid: 50, files: [], ...more });

const K = {};

// Andy's own call shapes (from his 06:32-06:41Z calls), while another agent holds the slot.
const ANDY = [
  'cd C:/Dunder/_work/andy-lts-clean && N=C:/Dunder/_tools/node-v24.22.2-win-x64/node.exe; timeout -k 5 40 $N --test --test-timeout=1860000 --test-reporter=tap test/config-integrity.test.cjs >/dev/null 2>&1; echo "RC $?"',
  'cd x && for i in 1 2; do s=$(date +%s); timeout -k 5 22 C:/n/node.exe --test test/config-integrity.test.cjs > /tmp/np$i.txt 2>&1; echo "$i RC $? $(( $(date +%s)-s ))s"; done',
  'cd x && for v in 20.20.2 24.22.2; do timeout -k 5 30 C:/Dunder/_tools/node-v$v-win-x64/node.exe --test --test-reporter=tap test/config-integrity.test.cjs > a 2>&1; done',
  'cd x && for i in 1 2 3; do timeout -k 5 22 C:/n/node.exe --test --test-reporter=tap test/config-integrity.test.cjs > /tmp/np$i.txt 2>&1; done'
];

K.singleLight = async (M = HJ) => {
  for (const [n, cmd] of ANDY.entries()) {
    const x = rig(M);
    x.l.acquire('b', H, 'npm test', 'hb', false);
    x.l.noteCall('a', 'c1', cmd);
    for (let i = 0; i < 3; i++) {
      const pid = 100 + i;
      const a = await ask(x, 'a', pid, { files: ['test/config-integrity.test.cjs'] });
      assert.equal(a.state, 'light', `A SINGLE FILE PASSES WHILE ANOTHER AGENT HOLDS THE SLOT (shape ${n}, run ${i + 1})`);
      x.tick(20_000);   // one file after the other, through the call
    }
    assert.equal(x.l.queueSnapshot().waiters.length, 0, 'nobody queued');
    assert.equal(x.logs.filter((r) => r.action === 'deny').length, 0, 'no deny row');
  }
};
test('a single-file node --test passes while another agent holds the slot (Andy\'s call shapes: node by variable or path, $(...), a file run in a loop)', () => K.singleLight());

K.fanOut = async (M = HJ) => {
  const x = rig(M);
  x.l.acquire('b', H, 'npm test', 'hb', false);
  x.l.noteCall('a', 'c1', 'for f in a b c; do $N --test test/$f.test.cjs & done; wait');
  assert.equal((await ask(x, 'a', 201, { files: ['test/a.test.cjs'] })).state, 'light');
  x.alive.add(201);
  assert.equal((await ask(x, 'a', 202, { files: ['test/b.test.cjs'] })).state, 'wait', 'A SECOND SINGLE FILE AT ONCE IS A FAN-OUT: IT WAITS');
  x.alive.delete(201);
  assert.equal((await ask(x, 'a', 203, { files: ['test/c.test.cjs'] })).state, 'light', 'once the first ends, the next single file is light');
  // the cap is per agent: another agent's live single file does not count
  x.l.noteCall('c', 'c2', '$N --test test/a.test.cjs');
  x.alive.add(203);
  assert.equal((await ask(x, 'c', 204, { files: ['test/a.test.cjs'] })).state, 'light', 'the cap is per agent');
};
test('a parallel fan-out of single files: the first is light, the rest wait while it runs', () => K.fanOut());

K.suiteWaits = async (M = HJ) => {
  const shapes = [
    ['node --test (node\'s own discovery)', 'node --test', { suite: true }],
    ['a glob', '$N --test "test/*.test.cjs"', { files: ['test/*.test.cjs'] }],
    ['a directory', '$N --test test', { files: ['test'] }],
    ['two files', '$N --test test/a.test.cjs test/b.test.cjs', { files: ['test/a.test.cjs', 'test/b.test.cjs'] }],
    ['a full suite runner', 'node test/tools/run-tests.cjs', { runner: ['test/tools/run-tests.cjs'], cwd: REPO }]
  ];
  for (const [what, cmd, more] of shapes) {
    const x = rig(M);
    x.l.acquire('b', H, 'npm test', 'hb', false);
    x.l.noteCall('a', 'c1', cmd);
    const a = await ask(x, 'a', 301, more);
    assert.equal(a.state, 'wait', `A FULL SUITE STILL WAITS: ${what}`);
  }
};
test('a full suite still waits for the slot: no files, a glob, a directory, several files, the suite runner', () => K.suiteWaits());

K.hiddenWaits = async (M = HJ) => {
  const cases = [
    ['a bash script (no --test in its call)', 'bash muts.sh', 50],
    ['a node wrapper beside a shown run', 'node gen-mut.cjs m.json r test/a.test.cjs && node --test test/a.test.cjs', 51],
    ['no call at all', null, 50]
  ];
  for (const [what, cmd, ppid] of cases) {
    const x = rig(M);
    x.l.acquire('b', H, 'npm test', 'hb', false);
    if (cmd) x.l.noteCall('a', 'c1', cmd);
    x.l.noteCall('a', 'c0', 'node --test test/a.test.cjs');   // its own visible run is consumed first
    assert.equal((await ask(x, 'a', 400, { files: ['test/a.test.cjs'] })).state, 'light');
    x.l.noteCallEnd('a', 'c0');
    x.tick(HJ.HEAVY_CALL_SLACK_MS + 1);
    assert.equal((await ask(x, 'a', 401, { files: ['test/a.test.cjs'], ppid })).state, 'wait', `A HIDDEN SINGLE FILE STILL WAITS: ${what}`);
  }
  const x = rig(M);
  x.l.acquire('b', H, 'npm test', 'hb', false);
  x.l.noteCall('a', 'c1', '$N --test test/a.test.cjs');
  x.l.noteCallEnd('a', 'c1');
  assert.equal((await ask(x, 'a', 402, { files: ['test/a.test.cjs'] })).state, 'wait', 'A SHOWN CALL THAT HAS ENDED SHOWS NOTHING');
};
test('a single file nobody shows still waits: a hidden script, a node parent, no call, a call that ended', () => K.hiddenWaits());

// ─── E2E: the real preload in a real test process ─────────────────────────────────────────────

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'hpst-'));
test.after(() => { try { fs.rmSync(JAIL, { recursive: true, force: true }); } catch { /* best effort */ } });
const FIX = path.join(JAIL, 'fix');
fs.mkdirSync(FIX);
fs.writeFileSync(path.join(FIX, 'leaf.test.cjs'), "require('node:test')('leaf', () => {});\n");
fs.writeFileSync(path.join(FIX, 'two.test.cjs'), "require('node:test')('two', () => {});\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), ms))]);
function start(args, url) {
  const env = { ...process.env };
  for (const k of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'GUPPY_TEST_RUN', 'HIVE_LEDGER_URL']) delete env[k];
  Object.assign(env, { NODE_OPTIONS: `--require "${PRELOAD.replace(/\\/g, '/')}"`, HIVE_LEDGER_URL: url, HIVE_ROOT: JAIL, AGENT_ID: 'a' });
  const child = spawn(args[0], args.slice(1), { cwd: FIX, env, windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.resume();
  return { child, done: new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr }))) };
}
async function broker(t, M) {
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\hpst-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(fs.mkdtempSync(path.join(JAIL, 's-')), 's.sock');
  const hive = {
    sockPath: () => sock, codexHomeFor: () => null, recordSession: () => {}, appendLog: () => {},
    registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {},
    toolOutputDir: (id) => path.join(JAIL, 'agents', id, 'tool-output')
  };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => ({ send: () => {} }), () => ({}), control);
  const logs = [];
  // The harness is not a shell: the parent check is answered for it, as in heavy-lock-opaque-196 e2eNested.
  const lock = new M.HeavyJobLock({ limit: () => 1, log: (r) => logs.push(r), notify: () => {}, parentImage: async () => 'bash.exe' });
  s.setHeavyLock(lock);
  s.start();
  t.after(() => s.stop());
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await sleep(5);
  return { lock, logs, url: s.hookUrl('a').replace('/hook/', '/ledger/') };
}

K.e2e = async (t, M = HJ) => {
  const b = await broker(t, M);
  b.lock.acquire('b', H, 'npm test', 'hb', false);
  b.lock.noteCall('a', 'c1', 'N=$(command -v node); timeout -k 5 60 "$N" --test leaf.test.cjs');
  const t0 = Date.now();
  const one = await within(start([process.execPath, '--test', 'leaf.test.cjs'], b.url).done, 30_000);
  assert.ok(one !== 'timeout' && one.code === 0 && Date.now() - t0 < 15_000,
    `A SINGLE FILE RUNS AT ONCE WHILE ANOTHER AGENT HOLDS THE SLOT: ${one === 'timeout' ? one : `code ${one.code} ${one.stderr}`}`);
  assert.doesNotMatch(one.stderr, /waiting for the heavy-job slot/);
  assert.ok(b.logs.some((r) => r.action === 'lease-single' && r.agentId === 'a'), 'the single-file rule let it through');
  // A full run (node's own discovery: no files) in the same shown call still waits.
  const suite = start([process.execPath, '--test'], b.url);
  assert.equal(await within(suite.done, 2_500), 'timeout', 'A FULL SUITE STILL WAITS FOR THE SLOT');
  assert.deepEqual(b.lock.queueSnapshot().waiters.map((w) => w.agentId), ['a']);
  b.lock.callDone('b', 'hb');
  const r = await within(suite.done, 30_000);
  assert.ok(r !== 'timeout' && r.code === 0, `the suite then runs: ${r === 'timeout' ? r : r.stderr}`);
  assert.match(r.stderr, /\[guppy\] waiting for the heavy-job slot \(held by b/);
  assert.equal(b.lock.snapshot().length, 0, 'its lease is released at exit');
};
test('E2E: through the real preload, a single file runs at once while another agent holds; a full suite waits, then runs', { timeout: 120_000 }, (t) => K.e2e(t));

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

const MUTANTS = [
  { name: 'no single-file rule (the old behaviour)', edits: [['    if (!suite && await this.singleFile(agentId, r)) {', '    if (false) {']], killer: 'singleLight', dies: /A SINGLE FILE PASSES WHILE ANOTHER AGENT HOLDS/ },
  { name: 'no shown call needed', edits: [['.pop();\n    if (!call) return false;', ".pop() ?? { callId: 'none' };"]], killer: 'hiddenWaits', dies: /A HIDDEN SINGLE FILE STILL WAITS|A SHOWN CALL THAT HAS ENDED/ },
  { name: 'no fan-out cap', edits: [["    if (live >= SINGLE_FILE_LIGHT_MAX) {", '    if (false) {']], killer: 'fanOut', dies: /IS A FAN-OUT/ },
  { name: 'any parent counts', edits: [["    if (!CALL_PARENT.test((image ?? '').replace(/\\\\/g, '/').split('/').pop()!)) return false;\n    this.spendLight", '    this.spendLight']], killer: 'hiddenWaits', dies: /A HIDDEN SINGLE FILE STILL WAITS: a node wrapper/ },
  { name: 'a glob or directory counts as one file', edits: [['    if (files.length !== 1 || typeof files[0] !== \'string\' || !ONE_TEST_FILE(files[0])) return false;', "    if (files.length !== 1 || typeof files[0] !== 'string') return false;"]], killer: 'suiteWaits', dies: /A FULL SUITE STILL WAITS: a (glob|directory)/ },
  { name: 'several files count as one', edits: [['    if (files.length !== 1 || typeof files[0] !== \'string\' || !ONE_TEST_FILE(files[0])) return false;', "    if (!files.length || typeof files[0] !== 'string' || !ONE_TEST_FILE(files[0])) return false;"]], killer: 'suiteWaits', dies: /A FULL SUITE STILL WAITS: two files/ },
  { name: 'a call is not marked shown', edits: [['    if (shown) list.push({ callId, files: [SHOWN_TEST], start: t, end: null, used: false });\n', '']], killer: 'singleLight', dies: /A SINGLE FILE PASSES/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async () => {
      let text = readSource(HJF);
      for (const [from, to] of m.edits) {
        const hits = text.split(from).length - 1;
        assert.equal(hits, 1, `mutant ${m.name}: edit target must match EXACTLY ONCE, matched ${hits}`);
        text = text.replace(from, () => to);
      }
      const M = loadTs.fromText(HJF, text);
      await assert.rejects(async () => K[m.killer](M), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
