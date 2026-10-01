'use strict';
/**
 * RESOLVER-TIMEOUT-MISS (1.1.76): a command lookup killed by its time box is UNKNOWN, not a miss.
 *
 * Under CPU load the 3 s `where` (win32) / login-shell `which` (POSIX) could time out. The resolver
 * reported that as found:false, the same as "not installed", cached it for MISS_TTL_MS, and every
 * caller acted on it: the missing-CLI path ran `npm install -g` in the agent's pty, the headless
 * spawn refused with "not installed", and codex lost --no-daemon (fixed separately by 6ab65753).
 *
 * Now:
 *  - lookupCommandAsync returns { found:false, unknown:true } when the box fired and no install-dir
 *    candidate matched (a real `where` exit 1 is still a plain miss);
 *  - CommandResolver retries an unknown ONCE, never caches it, and still caches a real miss;
 *  - PtyManager.commandStatus: found / missing / unknown;
 *  - the callers: the installer never runs on unknown, the headless spawn refuses with a distinct
 *    retryable reason, an unknown npm/node keeps the npm rung, the codex daemon start does not run a
 *    bare name, the setup catalog marks the row;
 *  - ResolverDeps.whereTimeoutMs: the box as a seam (tests, fixtures).
 * No real `where`, shell or npm runs here: every exec is a fake.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const R = loadTs('src/main/commandResolver.ts');

/** A fake exec. `where` / the shell: 'hang' (never answers: only the time box ends it), an Error
 *  (a real non-zero exit), or stdout text. taskkill always succeeds. */
function deps(platform, behaviour, { onDisk = [], env = {}, whereTimeoutMs } = {}) {
  const calls = [];
  const d = {
    platform, env, exists: (p) => onDisk.includes(p),
    exec: (file, args, opts, cb) => {
      calls.push({ file, args, timeout: opts.timeout });
      if (file === 'taskkill') { setImmediate(() => cb(null, 'SUCCESS')); return { pid: 2 }; }
      const b = typeof behaviour === 'function' ? behaviour(calls.length) : behaviour;
      if (b === 'hang') {
        // POSIX: execFile's own timeout kills the child and reports killed:true.
        if (opts.timeout > 0) setTimeout(() => cb(Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' }), ''), opts.timeout);
        return { pid: 4242 };
      }
      setImmediate(() => (b instanceof Error ? cb(b, '') : cb(null, b)));
      return { pid: 4243 };
    }
  };
  if (whereTimeoutMs !== undefined) d.whereTimeoutMs = whereTimeoutMs;
  return { d, calls };
}

// ─── lookupCommandAsync ───────────────────────────────────────────────────────────────

test('win32: a `where` killed by its box, no candidate -> UNKNOWN (found:false, unknown:true)', async () => {
  const { d, calls } = deps('win32', 'hang', { whereTimeoutMs: 5 });
  assert.deepEqual(await R.lookupCommandAsync('codex', d), { path: 'codex', found: false, unknown: true });
  assert.deepEqual(calls.map((c) => c.file), ['where', 'taskkill'], 'the box fired and killed the tree');
});

test('win32: a real `where` miss (exit 1) is still a plain miss, never unknown', async () => {
  const { d } = deps('win32', Object.assign(new Error('exit 1'), { code: 1 }));
  assert.deepEqual(await R.lookupCommandAsync('codex', d), { path: 'codex', found: false });
});

test('win32: a timed-out `where` is rescued by an install-dir candidate (found, not unknown)', async () => {
  const { d } = deps('win32', 'hang', { whereTimeoutMs: 5, onDisk: ['C:\\AppData\\npm\\codex.cmd'], env: { APPDATA: 'C:\\AppData' } });
  assert.deepEqual(await R.lookupCommandAsync('codex', d), { path: 'C:\\AppData\\npm\\codex.cmd', found: true });
});

test('POSIX: a login shell killed by its box -> UNKNOWN; so is a shell that fails without printing its fence (Andy C1)', async () => {
  const hung = deps('darwin', 'hang', { whereTimeoutMs: 7, env: { SHELL: '/bin/zsh', HOME: '/Users/u' } });
  assert.deepEqual(await R.lookupCommandAsync('claude', hung.d), { path: 'claude', found: false, unknown: true });
  assert.equal(hung.calls[0].timeout, 7, 'POSIX: execFile gets the seam value as its timeout');
  const failed = deps('darwin', Object.assign(new Error('exit 1'), { code: 1 }), { env: { SHELL: '/bin/zsh', HOME: '/Users/u' } });
  assert.deepEqual(await R.lookupCommandAsync('claude', failed.d), { path: 'claude', found: false, unknown: true });
});

test('whereTimeoutMs: the seam sets the box; unset, the box is LOOKUP_TIMEOUT_MS (3000)', async () => {
  assert.equal(R.LOOKUP_TIMEOUT_MS, 3000);
  const t0 = Date.now();
  const { d } = deps('win32', 'hang', { whereTimeoutMs: 20 });
  assert.equal((await R.lookupCommandAsync('codex', d)).unknown, true);
  assert.ok(Date.now() - t0 < 2000, 'a 20 ms box fires long before the default 3 s');
  const posix = deps('linux', 'hang', { env: { SHELL: '/bin/sh', HOME: '/h' } });
  const realSetTimeout = global.setTimeout;
  const seen = [];
  global.setTimeout = (fn, ms, ...a) => { seen.push(ms); return realSetTimeout(fn, ms === 3000 ? 5 : ms, ...a); };
  try { await R.lookupCommandAsync('codex', posix.d); } finally { global.setTimeout = realSetTimeout; }
  assert.equal(posix.calls[0].timeout, 3000, 'the default box');
  assert.equal(await R.resolveCliAsync(deps('win32', 'hang', { whereTimeoutMs: 5 }).d, 'agy'), null, 'resolveCliAsync honours the seam too (and stays uncached)');
});

// ─── CommandResolver: retry once, never cache unknown ─────────────────────────────────

function scripted(answers) {
  const seen = [];
  const r = new R.CommandResolver({
    deps: () => ({ platform: 'win32', env: {}, exists: (p) => p.endsWith('.cmd'), exec: () => { throw new Error('no exec here'); } }),
    lookup: async (command) => { seen.push(command); const a = answers.shift(); return a ?? { path: command, found: false }; }
  });
  return { r, seen };
}
const UNKNOWN = (c) => ({ path: c, found: false, unknown: true });

test('resolver: an unknown is retried ONCE at once; a found retry is returned and cached', async () => {
  const { r, seen } = scripted([UNKNOWN('codex'), { path: 'C:\\n\\codex.cmd', found: true }]);
  assert.deepEqual(await r.resolve('codex'), { path: 'C:\\n\\codex.cmd', found: true });
  assert.deepEqual(await r.resolve('codex'), { path: 'C:\\n\\codex.cmd', found: true });
  assert.equal(seen.length, 2, 'unknown, then the one retry; the hit is then cached');
  assert.equal(r.lookups, 2);
});

test('resolver: unknown twice is returned as unknown and NEVER cached; the next resolve looks again', async () => {
  const { r, seen } = scripted([UNKNOWN('codex'), UNKNOWN('codex'), { path: 'C:\\n\\codex.cmd', found: true }]);
  assert.deepEqual(await r.resolve('codex'), UNKNOWN('codex'));
  assert.equal(seen.length, 2, 'exactly one retry');
  assert.deepEqual(await r.resolve('codex'), { path: 'C:\\n\\codex.cmd', found: true }, 'not trusted: looked up again');
  assert.equal(seen.length, 3);
});

test('resolver: a real miss is still cached for the TTL (unchanged); a thrown lookup is UNKNOWN, retried once, not cached (Andy C1)', async () => {
  const { r, seen } = scripted([{ path: 'agy', found: false }]);
  assert.deepEqual(await r.resolve('agy'), { path: 'agy', found: false });
  assert.deepEqual(await r.resolve('agy'), { path: 'agy', found: false });
  assert.equal(seen.length, 1, 'a miss is not retried and is cached');
  let n = 0;
  const threw = new R.CommandResolver({ lookup: async () => { n += 1; throw new Error('boom'); } });
  assert.deepEqual(await threw.resolve('claude'), { path: 'claude', found: false, unknown: true });
  await threw.resolve('claude');
  assert.equal(n, 4, 'retried once per resolve, never cached');
});

test('resolver: concurrent callers of an unknown share the ONE lookup and its one retry', async () => {
  const { r, seen } = scripted([UNKNOWN('npm'), UNKNOWN('npm')]);
  const all = await Promise.all([r.resolve('npm'), r.resolve('npm'), r.resolve('npm')]);
  assert.ok(all.every((x) => x.unknown === true));
  assert.equal(seen.length, 2);
});

test('the app resolver end to end (win32): a hung `where` twice -> unknown, two where runs, nothing cached', async () => {
  const { d, calls } = deps('win32', 'hang', { whereTimeoutMs: 5 });
  const r = new R.CommandResolver({ deps: () => d });
  assert.deepEqual(await r.resolve('codex'), UNKNOWN('codex'));
  assert.equal(calls.filter((c) => c.file === 'where').length, 2, 'the lookup and its one retry');
  await r.resolve('codex');
  assert.equal(calls.filter((c) => c.file === 'where').length, 4, 'nothing was cached');
});

// ─── PtyManager.commandStatus ─────────────────────────────────────────────────────────

test('PtyManager.commandStatus: found / missing / unknown; commandPath stays null for unknown', async () => {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const pm = new PtyManager();
  pm.resolver = { resolve: async (c) => (c === 'codex' ? { path: 'C:\\n\\codex.cmd', found: true } : c === 'npm' ? UNKNOWN('npm') : { path: c, found: false }) };
  assert.equal(await pm.commandStatus('codex'), 'found');
  assert.equal(await pm.commandStatus('npm'), 'unknown');
  assert.equal(await pm.commandStatus('agy'), 'missing');
  assert.equal(await pm.isCommandAvailable('npm'), false);
  assert.equal(await pm.commandPath('npm'), null);
});

// ─── Andy C1: only an ANSWER from where/the shell is a miss; every other failure is UNKNOWN ──

test('C1 win32: where exit 2, a spawn error (EAGAIN/ENOMEM), a thrown exec (EMFILE) and a foreign signal are UNKNOWN; only exit 1 and a listing are misses', async () => {
  const U = { path: 'codex', found: false, unknown: true };
  const M = { path: 'codex', found: false };
  const exit = (code) => Object.assign(new Error(`exit ${code}`), { code });
  assert.deepEqual(await R.lookupCommandAsync('codex', deps('win32', exit(2)).d), U, 'where exit 2 (its own error)');
  assert.deepEqual(await R.lookupCommandAsync('codex', deps('win32', Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' })).d), U, 'spawn EAGAIN');
  assert.deepEqual(await R.lookupCommandAsync('codex', deps('win32', Object.assign(new Error('spawn ENOMEM'), { code: 'ENOMEM' })).d), U, 'spawn ENOMEM');
  assert.deepEqual(await R.lookupCommandAsync('codex', deps('win32', Object.assign(new Error('killed'), { code: null, signal: 'SIGKILL' })).d), U, 'a signal that was not our box');
  const throwing = { platform: 'win32', env: {}, exists: () => false, exec: () => { throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' }); } };
  assert.deepEqual(await R.lookupCommandAsync('codex', throwing), U, 'a synchronous EMFILE throw from exec');
  assert.deepEqual(await R.lookupCommandAsync('codex', deps('win32', exit(1)).d), M, 'where exit 1 IS the miss');
  assert.deepEqual(await R.lookupCommandAsync('codex', deps('win32', 'C:\\x\\codex\r\n', { onDisk: ['C:\\x\\codex'] }).d), M, 'where listed only a non-executable hit: an answer, a miss');
});

test('C1 POSIX: a shell that could not start or died (no fence) is UNKNOWN; a shell that ran `which` and found nothing is a miss', async () => {
  const env = { SHELL: '/bin/zsh', HOME: '/Users/u' };
  assert.deepEqual(await R.lookupCommandAsync('claude', deps('darwin', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), { env }).d), { path: 'claude', found: false, unknown: true });
  assert.deepEqual(await R.lookupCommandAsync('claude', deps('darwin', '__MD_SHELL_FENCE____MD_SHELL_FENCE__', { env }).d), { path: 'claude', found: false });
});

test('C1 resolver: an EAGAIN lookup is unknown, retried once, and NOT cached (the next resolve looks again)', async () => {
  const { d, calls } = deps('win32', Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }));
  const r = new R.CommandResolver({ deps: () => d });
  assert.deepEqual(await r.resolve('codex'), UNKNOWN('codex'));
  await r.resolve('codex');
  assert.equal(calls.filter((c) => c.file === 'where').length, 4, 'two lookups per resolve, nothing cached');
});

// ─── The decisions (cliLookupPolicy.ts), as behaviour (Andy R2) ─────────────────────────

const P = loadTs('src/main/cliLookupPolicy.ts');

test('policy: the installer runs ONLY on a known miss; unknown goes ahead, logged', () => {
  assert.equal(P.missingCliAction('missing'), 'install');
  assert.equal(P.missingCliAction('unknown'), 'log-and-proceed');
  assert.equal(P.missingCliAction('found'), 'proceed');
  assert.equal(P.cliStatus({ path: 'x', found: false, unknown: true }), 'unknown');
  assert.equal(P.cliStatus({ path: 'x', found: false }), 'missing');
  assert.equal(P.cliStatus({ path: 'C:\\x.cmd', found: true }), 'found');
});

test('policy: the npm rung - a known missing npm is unavailable; an unknown npm or node keeps the npm rung; otherwise the node version decides', () => {
  assert.equal(P.npmRungDecision('missing', 'found'), 'unavailable');
  assert.equal(P.npmRungDecision('missing', 'unknown'), 'unavailable');
  assert.equal(P.npmRungDecision('unknown', 'found'), 'available');
  assert.equal(P.npmRungDecision('found', 'unknown'), 'available');
  assert.equal(P.npmRungDecision('found', 'found'), 'check-node-version');
  assert.equal(P.npmRungDecision('found', 'missing'), 'check-node-version');
});

test('policy: the headless spawn refuses an unknown with a DISTINCT, retryable reason; a miss says not installed; found goes on', () => {
  assert.match(P.headlessSpawnRefusal('codex', 'unknown'), /could not be checked: its lookup timed out or failed \(machine under load\); retry the spawn/);
  assert.doesNotMatch(P.headlessSpawnRefusal('codex', 'unknown'), /not installed/);
  assert.equal(P.headlessSpawnRefusal('codex', 'missing'), 'engine CLI "codex" is not installed');
  assert.equal(P.headlessSpawnRefusal('codex', 'found'), null);
});

test('policy: the codex daemon start never gets a bare name from an unknown lookup', () => {
  assert.equal(P.daemonExecutable({ path: 'codex', found: false, unknown: true }), null);
  assert.equal(P.daemonExecutable({ path: 'C:\\n\\codex.cmd', found: true }), 'C:\\n\\codex.cmd');
});

test('policy: the Setup row marks an unknown lookup NOT CHECKED and never counts it found', () => {
  const on = (p) => p === 'C:\\n\\codex.cmd';
  assert.deepEqual(P.toolRowStatus({ path: 'codex', found: false, unknown: true }, 'codex', on), { found: false, path: null, unknown: true });
  assert.deepEqual(P.toolRowStatus({ path: 'codex', found: false }, 'codex', on), { found: false, path: null, unknown: false });
  assert.deepEqual(P.toolRowStatus({ path: 'C:\\n\\codex.cmd', found: true }, 'codex', on), { found: true, path: 'C:\\n\\codex.cmd', unknown: false });
});

test('policy (C2/C3, LOSSY-CMD-ROUTE): ANY multi-line spawn on the lossy cmd.exe route is refused, with a reason that says which; single-line args pass', () => {
  const ML = ['--x', 'line one\nline two'];
  const U = { path: 'claude', found: false, unknown: true };
  const BAT = { path: 'C:\\n\\claude.bat', found: true };
  // unknown lookups: RETRYABLE, naming the lookup that gave no answer
  assert.match(P.lossyRouteRefusal('claude', U, ML), /^engine CLI "claude" could not be checked: .*retry the spawn$/);
  assert.match(P.lossyRouteRefusal('claude', BAT, ML, { bin: 'node', problem: 'unknown' }), /^engine CLI "node" could not be checked: .*retry the spawn$/);
  // N1: a real npm shim whose interpreter is absent / only a .cmd names the INTERPRETER (not retryable)
  const CMD = { path: 'C:\\n\\claude.cmd', found: true };
  assert.match(P.lossyRouteRefusal('claude', CMD, ML, { bin: 'node', problem: 'missing' }), /^engine CLI "claude" needs its interpreter "node", which is not installed: install node/);
  assert.match(P.lossyRouteRefusal('claude', CMD, ML, { bin: 'node', problem: 'not-exe' }), /^engine CLI "claude" needs its interpreter "node", which resolves only to a \.cmd\/\.bat, not a real executable/);
  assert.doesNotMatch(P.lossyRouteRefusal('claude', CMD, ML, { bin: 'node', problem: 'missing' }), /retry|unsupported launcher/);
  // an undecodable found launcher: UNSUPPORTED LAUNCHER (not retryable)
  assert.match(P.lossyRouteRefusal('claude', BAT, ML), /^engine CLI "claude" is an unsupported launcher for a multi-line argument: C:\\n\\claude\.bat can only start through cmd\.exe/);
  assert.doesNotMatch(P.lossyRouteRefusal('claude', BAT, ML), /retry/);
  // a real miss: not installed
  assert.equal(P.lossyRouteRefusal('claude', { path: 'claude', found: false }, ML), 'engine CLI "claude" is not installed');
  // CRLF counts too; single-line args keep the cmd.exe route whatever the lookups said
  assert.notEqual(P.lossyRouteRefusal('claude', BAT, ['a\r\nb']), null);
  assert.equal(P.lossyRouteRefusal('claude', U, ['--x', 'one line']), null);
  assert.equal(P.lossyRouteRefusal('claude', BAT, ['--x', 'one line'], { bin: 'node', problem: 'unknown' }), null);
});

// ── the ONE rule through PtyManager.spawn (win32): one test per cause, and a single-line control ──
const SPAWN_ML = ['--append-system-prompt', 'HIVE PROTOCOL\nline two'];
const NPM_SHIM = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*'].join('\r\n');
const FIXTURES = [];
// T1 (Andy): a dir a just-killed process still holds must not fail the FILE; each removal is retried and isolated.
test.after(() => {
  for (const d of FIXTURES) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { console.warn(`# fixture not removed: ${d}: ${e.code || e.message}`); }
  }
});
function spawnFixture() {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lossy-rule-'));
  FIXTURES.push(dir);
  fs.mkdirSync(path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'), '// stub\n');
  fs.writeFileSync(path.join(dir, 'claude.cmd'), NPM_SHIM);
  fs.writeFileSync(path.join(dir, 'handmade.bat'), '@echo off\r\necho hi %*\r\n');
  return dir;
}
const WIN = { skip: process.platform !== 'win32' };

test('SPAWN (C2): an UNRESOLVED name with a multi-line argument is refused, retryable, before any session', WIN, async () => {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const dir = spawnFixture();
  const pm = new PtyManager();
  pm.resolver = { resolve: async (c) => ({ path: c, found: false, unknown: true }) };
  const res = await pm.spawn({ id: 'zz-c2', cwd: dir, command: 'claude', args: SPAWN_ML, cols: 80, rows: 24 });
  assert.equal(res.ok, false);
  assert.match(res.error, /^engine CLI "claude" could not be checked: .*retry the spawn$/);
  assert.equal(pm.list().length, 0, 'no session, no process');
});

test('SPAWN (C3, Andy): a FOUND npm claude.cmd whose node lookup is UNKNOWN is refused, retryable, naming node', WIN, async () => {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const dir = spawnFixture();
  const pm = new PtyManager();
  pm.resolver = { resolve: async (c) => (c === 'node' ? { path: 'node', found: false, unknown: true } : { path: path.join(dir, 'claude.cmd'), found: true }) };
  const res = await pm.spawn({ id: 'zz-c3', cwd: dir, command: 'claude', args: SPAWN_ML, cols: 80, rows: 24 });
  assert.equal(res.ok, false);
  assert.match(res.error, /^engine CLI "node" could not be checked: .*retry the spawn$/);
  assert.equal(pm.list().length, 0);
});

test('SPAWN (LOSSY-CMD-ROUTE): a FOUND hand-written .bat with a multi-line argument is refused as an UNSUPPORTED LAUNCHER', WIN, async () => {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const dir = spawnFixture();
  const pm = new PtyManager();
  pm.resolver = { resolve: async () => ({ path: path.join(dir, 'handmade.bat'), found: true }) };
  const res = await pm.spawn({ id: 'zz-bat', cwd: dir, command: 'handmade', args: SPAWN_ML, cols: 80, rows: 24 });
  assert.equal(res.ok, false);
  assert.match(res.error, /^engine CLI "handmade" is an unsupported launcher for a multi-line argument: .*handmade\.bat can only start through cmd\.exe/);
  assert.equal(pm.list().length, 0);
});

test('SPAWN (N1, Andy): a FOUND npm claude.cmd whose node is a KNOWN miss is refused naming node, not as an unsupported launcher', WIN, async () => {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const dir = spawnFixture();
  const pm = new PtyManager();
  pm.resolver = { resolve: async (c) => (c === 'node' ? { path: 'node', found: false } : { path: path.join(dir, 'claude.cmd'), found: true }) };
  const res = await pm.spawn({ id: 'zz-n1', cwd: dir, command: 'claude', args: SPAWN_ML, cols: 80, rows: 24 });
  assert.equal(res.ok, false);
  assert.match(res.error, /^engine CLI "claude" needs its interpreter "node", which is not installed/);
  assert.equal(pm.list().length, 0);
});

test('SPAWN control: the same .bat with SINGLE-LINE arguments still starts through cmd.exe', { ...WIN, timeout: 90_000 }, async () => {
  const os = require('node:os');
  const { PtyManager } = loadTs('src/main/pty.ts');
  const dir = spawnFixture();
  const pm = new PtyManager();
  pm.resolver = { resolve: async () => ({ path: path.join(dir, 'handmade.bat'), found: true }) };
  // T1 (Andy): the real cmd.exe runs in os.tmpdir(), not in the fixture dir it would lock, and its
  // exit is awaited (killAllAsync waits for every session's exit) before the test ends.
  const res = await pm.spawn({ id: 'zz-bat1', cwd: os.tmpdir(), command: 'handmade', args: ['--x', 'one line'], cols: 80, rows: 24 });
  try {
    assert.equal(res.ok, true, res.error);
    assert.equal(pm.list().length, 1);
    // rc gate 3/b (Creed): node-pty's WindowsTerminal defers kill() (ClosePseudoConsole) until the
    // terminal's FIRST output. Killed before it, conhost and the input pipe outlive cmd.exe and this
    // process never exits (product card PTY-EARLY-KILL-LEAK). So the kill waits for the .bat's output.
    const until = Date.now() + 60_000;
    while (pm.hasOutput('zz-bat1') === false && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    assert.notEqual(pm.hasOutput('zz-bat1'), false, 'the .bat produced output before the kill (60 s)');
  } finally {
    await pm.killAllAsync(5_000);
  }
});

// ─── One pin per index.ts call site (the decision itself is tested above) ────────────────

test('WIRING: each index.ts call site goes through its policy function; the installer script is built only on install', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /const binAction = missingCliAction\(bin && !opts\.noAutoInstall \? await ptyManager\.commandStatus\(bin\) : 'found'\);/);
  const block = idx.slice(idx.indexOf("if (binAction === 'install') {"), idx.indexOf('pendingInstallRelaunch.set(opts.id'));
  assert.match(block, /buildMissingCliScript\(/, 'the installer script is built only inside the install branch');
  assert.equal((idx.match(/buildMissingCliScript\(/g) || []).length, 1, 'and nowhere else');
  assert.match(idx, /const npmRung = npmRungDecision\(await ptyManager\.commandStatus\('npm'\), await ptyManager\.commandStatus\('node'\)\);/);
  assert.match(idx, /const engineRefusal = headlessSpawnRefusal\(bin, await ptyManager\.commandStatus\(bin\)\);\r?\n\s+if \(engineRefusal\) \{ fail\(engineRefusal\); return; \}/);
  assert.match(idx, /const executable = daemonExecutable\(await resolveCommandAsync\(opts\.command\)\);\r?\n\s+if \(executable === null\) \{/);
  assert.match(idx, /row = toolRowStatus\(await resolveCommandAsync\(spec\.bin\), spec\.bin, existsSync\);/);
  const pty = read('src/main/pty.ts');
  assert.match(pty, /const lossy = needsCmd \? lossyRouteRefusal\(opts\.command, resolution, opts\.args \?\? \[\], shimSeen\.interpreter \?\? null\) : null;/);
  assert.match(pty, /seen\.interpreter = \{ bin: target\.interpreter, problem: interp\.unknown \? 'unknown' : 'missing' \};/);
  assert.match(pty, /seen\.interpreter = \{ bin: target\.interpreter, problem: 'not-exe' \};/);
});

test('WIRING: the Setup panel says NOT CHECKED, offers no install command for an unknown row, and does not count it missing', () => {
  const panel = read('src/renderer/src/components/SetupPanel.tsx');
  assert.match(panel, /tool\.unknown \? 'NOT CHECKED'/);
  assert.match(panel, /\{!tool\.found && !tool\.unknown && tool\.installCommand && \(/);
  assert.match(panel, /filter\(\(t\) => !t\.found && !t\.unknown && t\.essential\)/);
});
