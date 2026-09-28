'use strict';

/**
 * AGY 1.1.48 commit 2 - the statusline shim, its transport, and HookServer's intake.
 *
 * The shim is executed for real here: written to a temp dir exactly as hive.ts writes it,
 * run under node with real stdin, and pointed at a real local pipe. Antigravity waits on
 * it (and auto-disables a statusline that keeps failing), so the timing contract is part
 * of the behaviour: every path exits 0, the fast paths well inside 500 ms.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { AGY_STATUSLINE_SHIM } = loadTs('src/main/agyStatuslineShim.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

const FIXTURE = path.join(__dirname, 'fixtures', 'agy-statusline-1.2.8.json');
const EMAIL = 'fixture.person@example.invalid';
const golden = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

// ─── harness ────────────────────────────────────────────────────────────────

/** The shim's own watchdog (agyStatuslineShim.ts WATCHDOG_MS). */
const WATCHDOG_MS = 400;
/**
 * A HANG guard, not a timing bound: it only turns a shim that never exits into a failing test
 * instead of a stuck suite. It counts from spawn, so it includes node's startup, which under a
 * saturated machine measured 3-7 s (FLAKY-XAUDIT finding 1: a 5 s guard killed healthy shims).
 * Whether a shim ended on its own or by a timer is judged from the timers it recorded, never
 * from this.
 */
const HANG_GUARD_MS = 90_000;
/** Where the preload moves the watchdog when asked: beyond the hang guard, so only the guard can end a hang. */
const STRETCHED_WATCHDOG_MS = 120_000;
/**
 * CPU budget for a fast path, measured from the preload's first line to exit: loading the
 * shim, reading stdin, one parse, one connect. Measured ~15-30 ms; 200 ms is well clear of
 * that under load (CPU time does not include waiting for a CPU) and well under the 500 ms
 * of synchronous work that FLAKY-XAUDIT M1c injects.
 */
const FAST_PATH_CPU_MS = 200;
/** A deadline for an EVENT (the server seeing the envelope), generous on purpose: a real bug fails at it. */
const DELIVERY_DEADLINE_MS = 60_000;

function shimFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-shim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'agy-statusline.cjs');
  fs.writeFileSync(file, AGY_STATUSLINE_SHIM, 'utf8');
  // Loaded with --require BEFORE the shim: records how long the shim itself ran (first line to
  // exit), which of its timers fired, the CPU time it used and how many connections it opened,
  // into a side file - so stdout and stderr stay exactly what the shim wrote. With
  // SHIM_STRETCH_WATCHDOG=1 the shim's 400 ms watchdog is pushed past the test's hang guard: a
  // path that must end ON ITS OWN then either does, or hangs until the guard kills it. That is
  // the contract itself, with no wall-clock bound a busy machine can break (FLAKY-TIMING: the
  // old '< 300 ms in-process' bounds flaked under the full suite).
  //
  // CPU time (process.cpuUsage, from the preload's first line to exit) is what pins the FAST
  // path without a clock: it does not grow while the process waits for a CPU, so a saturated
  // machine cannot break it, but a shim that does 500 ms of synchronous work before it sends
  // (FLAKY-XAUDIT M1c/M1d) spends that CPU and fails. In production such a shim runs past its
  // own 400 ms watchdog, and AGY auto-disables a statusline that keeps failing.
  fs.writeFileSync(path.join(dir, 'timing-preload.cjs'),
    "const t0 = process.hrtime.bigint();\n" +
    "const c0 = process.cpuUsage();\n" +
    "const fired = [];\n" +
    "let connects = 0;\n" +
    "const net = require('net');\n" +
    "const realConnect = net.createConnection;\n" +
    "net.createConnection = function (...a) { connects += 1; return realConnect.apply(this, a); };\n" +
    "const realSetTimeout = global.setTimeout;\n" +
    "global.setTimeout = function (fn, ms, ...rest) {\n" +
    "  const delay = process.env.SHIM_STRETCH_WATCHDOG === '1' && ms === " + WATCHDOG_MS + " ? " + STRETCHED_WATCHDOG_MS + " : ms;\n" +
    "  return realSetTimeout(function (...a) { fired.push(ms); return fn.apply(this, a); }, delay, ...rest);\n" +
    "};\n" +
    "process.on('exit', () => {\n" +
    "  const c = process.cpuUsage(c0);\n" +
    "  require('fs').writeFileSync(process.env.SHIM_ELAPSED_FILE, JSON.stringify({ ms: Number(process.hrtime.bigint() - t0) / 1e6, cpuMs: (c.user + c.system) / 1000, fired, connects }));\n" +
    "});\n");
  return { dir, file };
}

let pipeSeq = 0;
let elapsedSeq = 0;
const pipeName = (dir) => process.platform === 'win32'
  ? `\\\\.\\pipe\\agy-shim-test-${process.pid}-${++pipeSeq}`
  : path.join(dir, `s${++pipeSeq}.sock`);

/** A pipe server that records every newline-delimited message it receives. */
async function server(t, dir) {
  const sock = pipeName(dir);
  const got = [];
  const srv = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => { buf += d; });
    c.on('end', () => { if (buf) got.push(buf); c.end('{}'); });
    c.on('error', () => {});
  });
  await new Promise((r) => srv.listen(sock, r));
  t.after(() => srv.close());
  return { sock, got };
}

/** Run the shim. `stdin` null leaves stdin OPEN (to test the watchdog). */
function runShim(file, { stdin, env = {}, args = [], preload = null, stretchWatchdog = false } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const elapsedFile = path.join(path.dirname(file), `elapsed-${++elapsedSeq}.txt`);
    const extra = preload ? ['--require', preload] : [];
    const child = spawn(process.execPath, ['--require', path.join(path.dirname(file), 'timing-preload.cjs'), ...extra, file, ...args], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SHIM_ELAPSED_FILE: elapsedFile, ...(stretchWatchdog ? { SHIM_STRETCH_WATCHDOG: '1' } : {}), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    // A shim that never exits must FAIL a test, not hang the suite: kill it and say so. A hang
    // guard only (see HANG_GUARD_MS) - it is never what decides a timing question.
    const guard = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } }, HANG_GUARD_MS);
    // The child may exit (or be killed) before it reads stdin: writing to it then fails with
    // EPIPE/EOF, asynchronously. That is the child's outcome to report, not a test crash.
    child.stdin.on('error', () => {});
    child.on('close', (code, signal) => {
      clearTimeout(guard);
      let inProcess = null;
      let fired = null;
      let cpuMs = null;
      let connects = null;
      try {
        const rec = JSON.parse(fs.readFileSync(elapsedFile, 'utf8'));
        inProcess = rec.ms; fired = rec.fired; cpuMs = rec.cpuMs; connects = rec.connects;
      } catch (e) { /* never exited cleanly */ }
      resolve({ code: signal ? `killed:${signal}` : code, out, err, ms: Date.now() - started, inProcess, fired, cpuMs, connects });
    });
    if (stdin !== null) { try { child.stdin.end(stdin); } catch (e) { /* the child is already gone */ } }
  });
}

/**
 * Wait until a server has received `n` envelopes. Polls the EVENT instead of sleeping a fixed
 * 50 ms (a sleep races cross-process pipe delivery on a busy machine); a missing envelope
 * fails at the generous deadline.
 */
async function received(srv, n) {
  const until = Date.now() + DELIVERY_DEADLINE_MS;
  while (srv.got.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  return srv.got.length;
}

/** The fast-path contract, judged without a clock: it ended on its own and did little work. */
function assertFast(r, what) {
  assert.ok(r.fired !== null, `${what}: exited cleanly (code ${r.code}), the preload recorded it`);
  assert.ok(!r.fired.includes(WATCHDOG_MS), `${what}: exits on its own, not by the watchdog (fired: ${JSON.stringify(r.fired)})`);
  assert.ok(r.cpuMs < FAST_PATH_CPU_MS, `${what}: ${r.cpuMs} ms of CPU, budget ${FAST_PATH_CPU_MS} ms (${r.inProcess} ms in-process wall, diagnostic only)`);
}

/**
 * THE TIMING CONTRACT, MEASURED INSIDE THE SHIM.
 *
 * Wall time from spawn includes process creation, which the shim cannot influence: under
 * the full suite's concurrency two back-to-back bare node starts differed by hundreds of
 * milliseconds, and first an absolute bound and then a baseline-relative one both flaked
 * on it. So the shim is timed from its own first line to its exit (see the preload), and
 * the assertions say what the contract actually means: a fast path exits ON ITS OWN, long
 * before the 400 ms watchdog could fire; a stuck stdin exits BECAUSE of the watchdog.
 * End-to-end latency under a real AGY on a loaded machine is a packaged-gate measurement
 * (commit 5), and a real risk - AGY auto-disables a statusline that keeps failing.
 */
/** The shim's 150 ms connect deadline (agyStatuslineShim.ts CONNECT_MS). */
const CONNECT_MS = 150;

// ─── the happy path ─────────────────────────────────────────────────────────

test('SHIM: one sanitized line out, one envelope to HIVE_SOCK, exit 0 - fast', async (t) => {
  const { dir, file } = shimFile(t);
  const srv = await server(t, dir);
  const r = await runShim(file, { stdin: JSON.stringify(golden()), env: { HIVE_SOCK: srv.sock, AGENT_ID: 'andy-1' }, stretchWatchdog: true });
  t.diagnostic(`fast path: ${r.cpuMs} ms CPU, ${r.inProcess} ms in-process, ${r.ms} ms from spawn`);

  assert.equal(r.code, 0, 'exits by itself - with the watchdog out of reach, a hang would be killed by the guard');
  assert.equal(r.out, `AGY ${String.fromCharCode(183)} Gemini 3.8 Flash (High) ${String.fromCharCode(183)} working\n`);
  assert.equal(r.err, '');
  assert.deepEqual(r.fired, [], `exits on its own: no timer ended it (${r.inProcess} ms in-process)`);
  assertFast(r, 'fast path');
  assert.equal(r.connects, 1, 'one connection');

  assert.equal(await received(srv, 1), 1, 'exactly one envelope');
  const lines = srv.got[0].split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'newline-delimited, one message');
  const env = JSON.parse(lines[0]);
  // Exact shape on purpose: a new envelope field must be noticed here. `read_at` joined in
  // the c4 rework - the shim runs at READING time, and arrival times through one socket are
  // monotone, so without it the wake coordinator's ordering guard can never fire.
  assert.deepEqual(Object.keys(env).sort(), ['agent_id', 'agy_status', 'hook_event_name', 'read_at']);
  assert.equal(env.hook_event_name, 'AgyStatusLine');
  assert.equal(env.agent_id, 'andy-1');
  assert.ok(Number.isFinite(env.read_at) && env.read_at > 0, 'read_at is a real instant');
  assert.ok(Math.abs(Date.now() - env.read_at) < 60_000, 'stamped on this machine\'s clock, now');
  assert.deepEqual(env.agy_status, golden(), 'the payload travels whole, to be normalized in main');
});

test('SHIM: the terminal line carries no quota, no identity, no path, no JSON', async (t) => {
  const { file } = shimFile(t);
  const r = await runShim(file, { stdin: JSON.stringify(golden()) });
  for (const secret of [EMAIL, 'fixture-home', 'fixture-workspace', '0.97', '97', 'quota', '{', 'Google AI Pro']) {
    assert.ok(!r.out.includes(secret), `leaked to the terminal: ${secret}`);
  }
});

test('SHIM: state words for idle, tool_use and confirmation', async (t) => {
  const { file } = shimFile(t);
  const line = async (fn) => { const p = golden(); fn(p); return (await runShim(file, { stdin: JSON.stringify(p) })).out; };
  assert.match(await line((p) => { p.agent_state = 'idle'; }), / idle\n$/);
  assert.match(await line((p) => { p.agent_state = 'tool_use'; }), / working\n$/);
  assert.match(await line((p) => { p.agent_state = 'tool_use'; p.tool_confirmation_pending = true; }), / confirmation\n$/);
  assert.equal(await line((p) => { p.agent_state = 'authenticating'; p.model = null; }), '', 'boot: no line');
});

test('SHIM: control characters and escapes are stripped; the model is cut at 48', async (t) => {
  const { file } = shimFile(t);
  const p = golden();
  p.model.display_name = `\u001b[31mRed\u0007 ${'M'.repeat(80)}`;
  const r = await runShim(file, { stdin: JSON.stringify(p) });
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(r.out.slice(0, -1)), 'no control characters survive');
  const model = r.out.split(` ${String.fromCharCode(183)} `)[1];
  assert.ok([...model].length <= 48, `truncated: ${[...model].length}`);
});

test('SHIM: a personal session (no AGENT_ID) sends agent_id null - never invented', async (t) => {
  const { dir, file } = shimFile(t);
  const srv = await server(t, dir);
  await runShim(file, { stdin: JSON.stringify(golden()), env: { HIVE_SOCK: srv.sock } });
  assert.equal(await received(srv, 1), 1, 'the envelope arrived');
  assert.equal(JSON.parse(srv.got[0]).agent_id, null);
});

// ─── every failure path exits 0, quickly ────────────────────────────────────

test('SHIM FAILURES: dead socket, bad JSON, empty, array, oversize - all exit 0, none connect', async (t) => {
  const { dir, file } = shimFile(t);
  const srv = await server(t, dir);
  const big = JSON.stringify({ ...golden(), pad: 'x'.repeat(70 * 1024) });
  const cases = [
    ['dead socket', JSON.stringify(golden()), { HIVE_SOCK: pipeName(dir) }],
    ['invalid JSON', '{ nope', { HIVE_SOCK: srv.sock }],
    ['empty stdin', '', { HIVE_SOCK: srv.sock }],
    ['an array', '[1,2,3]', { HIVE_SOCK: srv.sock }],
    ['over the 64 KiB ceiling', big, { HIVE_SOCK: srv.sock }]
  ];
  for (const [name, stdin, env] of cases) {
    const r = await runShim(file, { stdin, env, stretchWatchdog: true });
    assert.equal(r.code, 0, `${name}: exit 0, by itself (the watchdog is out of reach)`);
    assertFast(r, name);
    if (name !== 'dead socket') {
      assert.equal(r.out, '', `${name}: nothing printed`);
      // Recorded inside the child, so no settle/sleep is needed to know it never connected.
      assert.equal(r.connects, 0, `${name}: never opened a connection`);
    }
  }
  assert.equal(srv.got.length, 0, 'not one of them reached the server');
});

test('SHIM WATCHDOG: stdin that never closes still exits 0 at ~400 ms', async (t) => {
  const { file } = shimFile(t);
  const r = await runShim(file, { stdin: null });
  assert.equal(r.code, 0, 'exits by itself - not killed by the test guard');
  // It ends at all (no hang), and it ends because of the 400 ms watchdog - not before. Which
  // timer fired is recorded, so no upper wall-clock bound is needed (the hang guard catches a hang).
  assert.ok(r.fired !== null && r.fired.includes(WATCHDOG_MS), `the WATCHDOG ended it (fired: ${JSON.stringify(r.fired)})`);
  assert.ok(r.inProcess >= WATCHDOG_MS - 10, `not an early exit: ${r.inProcess} ms in-process`);
});

test('SHIM CONNECT DEADLINE: a socket that never connects is abandoned at ~150 ms, long before the watchdog', async (t) => {
  // Jim's upgrade for mutant #11b, which a census alone could only kill structurally. The
  // preload swaps net.createConnection for a socket that never connects and never errors,
  // so ONLY the shim's own 150 ms deadline can end the attempt - without it, the 400 ms
  // watchdog would, and this assertion fails.
  const { dir, file } = shimFile(t);
  const hang = path.join(dir, 'never-connects.cjs');
  fs.writeFileSync(hang,
    "const net = require('net');\n" +
    "net.createConnection = function () { return new net.Socket(); };\n");
  const r = await runShim(file, { stdin: JSON.stringify(golden()), env: { HIVE_SOCK: 'unused-by-the-fake' }, preload: hang, stretchWatchdog: true });
  // With the watchdog out of reach, only the deadline can end this: without it the shim hangs
  // until the hang guard kills it (code 'killed:...'), whatever the machine's load.
  assert.equal(r.code, 0, 'the DEADLINE ended it (a missing deadline hangs until the guard kills it)');
  assert.ok(r.fired !== null && r.fired.includes(CONNECT_MS), `the 150 ms deadline fired: ${JSON.stringify(r.fired)}`);
  assert.ok(r.inProcess >= CONNECT_MS - 20, `it waited for the deadline: ${r.inProcess} ms`);
});

// ─── endpoint selection ─────────────────────────────────────────────────────

function locator(dir, fields) {
  const file = path.join(dir, 'endpoint.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 1, pid: process.pid, processStartedAt: 1, createdAt: 1, ...fields }));
  return file;
}
const OWNER = 'c'.repeat(32);

test('LOCATOR: with no HIVE_SOCK, a valid locator for THIS owner token is used', async (t) => {
  const { dir, file } = shimFile(t);
  const srv = await server(t, dir);
  const loc = locator(dir, { sock: srv.sock, token: OWNER });
  await runShim(file, { stdin: JSON.stringify(golden()), args: ['--owner', OWNER, '--locator', loc] });
  assert.equal(await received(srv, 1), 1);
});

test('LOCATOR: a token mismatch, a dead owner, a wrong schema or a relative path - no connect', async (t) => {
  const { dir, file } = shimFile(t);
  const srv = await server(t, dir);
  const cases = [
    ['token mismatch', { sock: srv.sock, token: 'd'.repeat(32) }, OWNER],
    ['dead owning process', { sock: srv.sock, token: OWNER, pid: 2147483646 }, OWNER],
    ['wrong schema', { sock: srv.sock, token: OWNER, schema: 2 }, OWNER]
  ];
  for (const [name, fields, owner] of cases) {
    const loc = locator(dir, fields);
    const r = await runShim(file, { stdin: JSON.stringify(golden()), args: ['--owner', owner, '--locator', loc] });
    assert.equal(r.code, 0, name);
    assert.equal(r.connects, 0, `${name}: never opened a connection`);
  }
  const rel = await runShim(file, { stdin: JSON.stringify(golden()), args: ['--owner', OWNER, '--locator', 'endpoint.json'] });
  assert.equal(rel.code, 0);
  assert.equal(rel.connects, 0, 'relative locator: never opened a connection');
  assert.equal(srv.got.length, 0, 'none of them connected');
});

test('LOCATOR: an inherited HIVE_SOCK wins over any locator', async (t) => {
  const { dir, file } = shimFile(t);
  const worker = await server(t, dir);
  const personal = await server(t, dir);
  const loc = locator(dir, { sock: personal.sock, token: OWNER });
  const r = await runShim(file, { stdin: JSON.stringify(golden()), env: { HIVE_SOCK: worker.sock }, args: ['--owner', OWNER, '--locator', loc] });
  assert.equal(r.connects, 1, 'exactly one connection');
  assert.equal(await received(worker, 1), 1);
  assert.equal(personal.got.length, 0);
});

// ─── census ─────────────────────────────────────────────────────────────────

test('CENSUS: the shim requires built-in fs, net and path, and nothing else', () => {
  const requires = [...AGY_STATUSLINE_SHIM.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(requires, ['fs', 'net', 'path']);
  assert.ok(!/\bimport\b/.test(AGY_STATUSLINE_SHIM), 'no ESM import either');
});

test('CENSUS: the shim source has no backslash, backtick or dollar-brace to be mangled', () => {
  assert.ok(!AGY_STATUSLINE_SHIM.includes(String.fromCharCode(92)), 'backslash');
  assert.ok(!AGY_STATUSLINE_SHIM.includes(String.fromCharCode(96)), 'backtick');
  assert.ok(!AGY_STATUSLINE_SHIM.includes('$' + '{'), 'dollar-brace');
});

test('CENSUS: the shim never logs, never reads email, never polls', () => {
  assert.ok(!/console\./.test(AGY_STATUSLINE_SHIM), 'no console output - stdout is the terminal line only');
  assert.ok(!/email/.test(AGY_STATUSLINE_SHIM), 'never names the email field');
  assert.ok(!/setInterval/.test(AGY_STATUSLINE_SHIM), 'no polling');
  assert.match(AGY_STATUSLINE_SHIM, /var MAX_STDIN = 65536;/);
  assert.match(AGY_STATUSLINE_SHIM, /var CONNECT_MS = 150;/);
  assert.match(AGY_STATUSLINE_SHIM, /var WATCHDOG_MS = 400;/);
  // Declared is not enough - each deadline must actually be ARMED.
  // Plain substring checks, deliberately: a regex here has to escape parentheses, and a
  // lost backslash turns the escape into a capture group that silently tests something
  // else. (It happened while writing this test.)
  assert.ok(AGY_STATUSLINE_SHIM.includes('setTimeout(quit, WATCHDOG_MS);'), 'the absolute watchdog is armed');
  assert.ok(AGY_STATUSLINE_SHIM.includes('}, CONNECT_MS);'), 'the connect/write deadline is armed');
  assert.ok(AGY_STATUSLINE_SHIM.includes('if (size > MAX_STDIN)'), 'the stdin ceiling is enforced');
});

// ─── HookServer intake ──────────────────────────────────────────────────────

/**
 * The golden payload, re-anchored to NOW. HookServer stamps receipt with the real clock,
 * and the normaliser checks every reset against receipt within 5 s - so the fixture's
 * resets, measured against 2026-09-22, are correctly refused as `reset-disagree`. That
 * refusal is the consistency check doing its job; for an accept-path test the resets have
 * to be consistent with the moment of receipt.
 */
function fresh() {
  const p = golden();
  const now = Date.now();
  for (const b of Object.values(p.quota)) b.reset_time = new Date(now + b.reset_in_seconds * 1000).toISOString();
  return p;
}

const logRows = [];
function hookServer({ onEvent, onAgyTick, control } = {}) {
  logRows.length = 0;
  const hive = { sockPath: () => null, codexHomeFor: () => null, recordSession: () => {}, appendLog: (e) => logRows.push(e) };
  return new HookServer(hive, () => null, () => ({}), control, undefined, undefined, onEvent, undefined, onAgyTick);
}

test('HOOKSERVER: a valid envelope yields ONE coherent tick, and touches no hook machinery', () => {
  const ticks = [];
  const events = [];
  const s = hookServer({
    onEvent: (...a) => events.push(a),
    onAgyTick: (agentId, tick) => ticks.push({ agentId, tick }),
    control: { shouldHalt: () => { throw new Error('the halt gate must not be consulted'); } }
  });
  const res = s.handle({ hook_event_name: 'AgyStatusLine', agent_id: 'andy-1', agy_status: fresh() });
  assert.deepEqual(res, {});
  assert.equal(events.length, 0, 'a statusline tick is not a hook event');
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].agentId, 'andy-1');
  assert.equal(ticks[0].tick.observations.length, 2);
  assert.equal(ticks[0].tick.lifecycle, 'running');
});

test('HOOKSERVER: a personal tick arrives with agentId null', () => {
  const ticks = [];
  const s = hookServer({ onAgyTick: (agentId) => ticks.push(agentId) });
  s.handle({ hook_event_name: 'AgyStatusLine', agent_id: null, agy_status: fresh() });
  assert.deepEqual(ticks, [null]);
});

test('HOOKSERVER: drift is counted by {version, code} - no tick, nothing retained', (t) => {
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a);
  t.after(() => { console.warn = orig; });
  const ticks = [];
  const s = hookServer({ onAgyTick: (...a) => ticks.push(a) });
  const bad = fresh();
  bad.quota['3p-5h'].remaining_fraction = 2;
  s.handle({ hook_event_name: 'AgyStatusLine', agent_id: 'a', agy_status: bad });
  s.handle({ hook_event_name: 'AgyStatusLine', agent_id: 'a', agy_status: bad });
  assert.equal(ticks.length, 0);
  assert.deepEqual(s.agyDriftCounts(), { '1.2.8|fraction': 2 });
  assert.equal(warned.length, 1, 'logged once per kind, not once per tick');
  assert.deepEqual(logRows, [{ kind: 'agy-statusline-drift', version: '1.2.8', driftCode: 'fraction' }],
    'one log.jsonl row: the fixed code and version, and nothing else');
  const logged = JSON.stringify(warned);
  for (const secret of [EMAIL, 'fixture-home', 'quota', '0.97']) assert.ok(!logged.includes(secret), `leaked: ${secret}`);
});

test('HOOKSERVER: the boot tick is not drift; the tally is bounded', (t) => {
  const orig = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = orig; });
  const s = hookServer({});
  s.handle({ hook_event_name: 'AgyStatusLine', agy_status: { version: '1.2.8', agent_state: 'authenticating', model: null } });
  assert.deepEqual(s.agyDriftCounts(), {}, 'authenticating is the ratified boot state, not a fault');
  for (let i = 0; i < 50; i++) {
    const p = golden();
    p.version = `9.${i}`;
    p.agent_state = 'mystery';
    s.handle({ hook_event_name: 'AgyStatusLine', agy_status: p });
  }
  const counts = s.agyDriftCounts();
  assert.equal(Object.keys(counts).length, 33, '32 distinct keys plus one overflow bucket');
  assert.equal(counts.overflow, 18);
});

// ─── wiring census ──────────────────────────────────────────────────────────

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('WIRING: startup TAKES NOTHING - it gives back leftovers; the lease is taken on an AGY spawn', () => {
  // god, on Jim's consent note: a Munder start with no AGY agent must not touch the user's
  // global AGY settings. Plain substring checks - no regex escaping to get wrong.
  const hive = read('src/main/hive.ts');
  const start = hive.slice(hive.indexOf('  startAgyStatusline(): void {'), hive.indexOf('  reconcileAgyStatusline(): void {'));
  assert.ok(start.includes('recoverStatuslineLeftovers(env)'), 'startup gives back what a dead run left');
  assert.ok(!start.includes('.ensure(') && !start.includes('this.reconcileAgyStatusline()'),
    'startup never takes the lease');
  // The command is the UNQUOTED builder's - agy passes quote characters literally.
  assert.ok(start.includes('buildStatuslineCommand(launcher, shim, token, locator)'));
  assert.ok(!start.includes('this.nodeRun('), 'never the quoted nodeRun form');
  assert.ok(start.includes("code: 'unsafe-command-path'"), 'an unexpressible path refuses the lease, named');
  // Released when the LAST AGY agent leaves the floor.
  const index = read('src/main/index.ts');
  const teardown = index.slice(index.indexOf('function teardownPty(id: string): void {'), index.indexOf('// 2) Remove the isolated worktree'));
  assert.ok(teardown.includes("leftProvider === 'antigravity' && ![...ptyProvider.values()].includes('antigravity')"));
  assert.ok(teardown.includes('hive.agyAgentsGone()'));
});

test('WIRING: startup prepares after the HookServer listens; every teardown releases it', () => {
  const index = read('src/main/index.ts');
  const start = index.indexOf('hookServer.start();');
  const lease = index.indexOf('hive.startAgyStatusline();');
  assert.ok(start > 0 && lease > start, 'the locator must name a pipe that is already listening');
  for (const tag of ['quit', 'changeHome', 'reset']) {
    const release = index.indexOf(`console.error('[${tag}] stopAgyStatusline:'`);
    const stop = index.indexOf(`console.error('[${tag}] hookServer.stop:'`);
    assert.ok(release > 0 && release < stop, `${tag}: released before the HookServer stops`);
  }
  assert.match(index, /app\.on\('will-quit', \(\) => \{[\s\S]{0,600}hive\.stopAgyStatusline\(\)/,
    'and on will-quit, which an ordinary quit with no terminals reaches without teardownAndQuit');
});

test('WIRING: the dev build never leases, and an AGY spawn reconciles first', () => {
  const hive = read('src/main/hive.ts');
  const body = hive.slice(hive.indexOf('  startAgyStatusline(): void {'), hive.indexOf('  reconcileAgyStatusline(): void {'));
  assert.match(body, /if \(DEV_ISOLATION\) \{[\s\S]*?return;/, 'MUNDER_DEV=1 returns before anything is written');
  assert.ok(body.indexOf('DEV_ISOLATION') < body.indexOf('new AgyStatuslineOwner'));
  const spawnBranch = hive.slice(hive.indexOf("if (desc.shim === 'agy') {"), hive.indexOf("else if (desc.shim === 'codex')"));
  assert.match(spawnBranch, /this\.installAgyHooks\(\);\s*[\s\S]*?this\.reconcileAgyStatusline\(\);/);
});
