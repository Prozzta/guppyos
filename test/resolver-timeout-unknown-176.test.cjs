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

test('POSIX: a login shell killed by its box -> UNKNOWN; a shell that fails -> a plain miss', async () => {
  const hung = deps('darwin', 'hang', { whereTimeoutMs: 7, env: { SHELL: '/bin/zsh', HOME: '/Users/u' } });
  assert.deepEqual(await R.lookupCommandAsync('claude', hung.d), { path: 'claude', found: false, unknown: true });
  assert.equal(hung.calls[0].timeout, 7, 'POSIX: execFile gets the seam value as its timeout');
  const failed = deps('darwin', Object.assign(new Error('exit 1'), { code: 1 }), { env: { SHELL: '/bin/zsh', HOME: '/Users/u' } });
  assert.deepEqual(await R.lookupCommandAsync('claude', failed.d), { path: 'claude', found: false });
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

test('resolver: a real miss is still cached for the TTL (unchanged), and a thrown lookup is still a miss', async () => {
  const { r, seen } = scripted([{ path: 'agy', found: false }]);
  assert.deepEqual(await r.resolve('agy'), { path: 'agy', found: false });
  assert.deepEqual(await r.resolve('agy'), { path: 'agy', found: false });
  assert.equal(seen.length, 1, 'a miss is not retried and is cached');
  const threw = new R.CommandResolver({ lookup: async () => { throw new Error('boom'); } });
  assert.deepEqual(await threw.resolve('claude'), { path: 'claude', found: false });
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

// ─── The callers (index.ts is not loadable in a test: its wiring is pinned) ──────────

test('WIRING: the missing-CLI installer runs ONLY on a known miss, never on unknown (logged)', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /const binStatus = bin && !opts\.noAutoInstall \? await ptyManager\.commandStatus\(bin\) : 'found';\r?\n\s+if \(binStatus === 'unknown'\) \{ try \{ hive\.appendLog\(\{ kind: 'cli-lookup-unknown', command: bin, at: 'spawn', id: opts\.id \}\); \} catch \{ \/\* best-effort \*\/ \} \}\r?\n\s+if \(binStatus === 'missing'\) \{/);
  const block = idx.slice(idx.indexOf("if (binStatus === 'missing') {"), idx.indexOf('pendingInstallRelaunch.set(opts.id'));
  assert.match(block, /buildMissingCliScript\(/, 'the installer script is built only inside the known-miss branch');
  assert.equal((idx.match(/buildMissingCliScript\(/g) || []).length, 1, 'and nowhere else');
});

test('WIRING: an unknown npm or node keeps the npm rung (no Node download over a working install)', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /const npmStatus = await ptyManager\.commandStatus\('npm'\);\r?\n\s+const nodeStatus = await ptyManager\.commandStatus\('node'\);\r?\n\s+const npmAvailable = npmStatus !== 'missing' && \(npmStatus === 'unknown' \|\| nodeStatus === 'unknown' \|\|\r?\n\s+nodeIsUsable\(await detectNodeVersion\(await ptyManager\.commandPath\('node'\)\)\)\);/);
});

test('WIRING: the headless spawn refuses an unknown with a DISTINCT, retryable reason, never "not installed"', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /const engineStatus = await ptyManager\.commandStatus\(bin\);\r?\n\s+if \(engineStatus === 'unknown'\) \{ fail\(`engine CLI "\$\{bin\}" could not be checked: its lookup timed out \(machine under load\); retry the spawn`\); return; \}\r?\n\s+if \(engineStatus === 'missing'\) \{ fail\(`engine CLI "\$\{bin\}" is not installed`\); return; \}/);
});

test('WIRING: the codex daemon start never runs a bare name from an unknown lookup; the setup catalog marks unknown', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /const resolvedCli = await resolveCommandAsync\(opts\.command\);[\s\S]{0,200}if \(resolvedCli\.unknown\) \{[\s\S]{0,160}return false;\r?\n\s+\}\r?\n\s+const executable = resolvedCli\.path;/);
  assert.match(idx, /unknown = !!r\.unknown;[\s\S]{0,200}found: !!path, path, \.\.\.\(unknown \? \{ unknown: true \} : \{\}\) \};/);
  assert.match(read('src/renderer/src/components/SetupPanel.tsx'), /tool\.unknown \? 'NOT CHECKED'/);
});
