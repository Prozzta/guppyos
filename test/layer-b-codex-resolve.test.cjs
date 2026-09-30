'use strict';

/**
 * god R1 (Jim's real-mode sweep): the zero-token real-run preflight runs the PRODUCT's resolution
 * (commandPath('codex') over the commandResolver, readCodexVersion, codexSupportsNoDaemon) in a
 * hidden child with the jailed app env, and refuses the run unless it yields the CLI dir's
 * codex.cmd, 0.157.1 and --no-daemon. Fixtures are fake npm prefixes in a temp dir; where.exe runs
 * hidden; no codex is ever started.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lb = require('./tools/layer-b-run.cjs');
const src = fs.readFileSync(path.join(__dirname, 'tools', 'layer-b-run.cjs'), 'utf8').replace(/\r\n/g, '\n');
const probeSrc = fs.readFileSync(path.join(__dirname, 'tools', 'codex-resolve-probe.cjs'), 'utf8').replace(/\r\n/g, '\n');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-resolve-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));
const SYS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

/** A fake npm global prefix: <dir>\codex.<ext> + node_modules\@openai\codex\package.json. */
function prefix(version, ext = 'cmd', under = null) {
  const dir = under || fs.mkdtempSync(path.join(JAIL, 'npm-'));
  fs.mkdirSync(path.join(dir, 'node_modules', '@openai', 'codex'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', '@openai', 'codex', 'package.json'), JSON.stringify({ name: '@openai/codex', version }));
  fs.writeFileSync(path.join(dir, `codex.${ext}`), '@echo off\r\nexit /b 99\r\n');
  return dir;
}
function run(t, { pathDirs, appData = null, cliDir = null, dry = false }) {
  const base = fs.mkdtempSync(path.join(JAIL, 'base-'));
  const report = path.join(base, 'report');
  lb.W.allowRoot(report);
  const home = path.join(base, 'home');
  const la = path.join(home, 'AppData', 'Local');
  const ad = appData || path.join(home, 'AppData', 'Roaming');
  for (const d of [la, ad]) fs.mkdirSync(d, { recursive: true });
  const r = new lb.LayerB(lb.parseArgs(dry ? ['--dry-run-stubs'] : []));
  r.s = { base, report };
  r.env = { SystemRoot: process.env.SystemRoot, PATHEXT: '.COM;.EXE;.BAT;.CMD', PATH: [...pathDirs, SYS].join(';'), HOME: home, USERPROFILE: home, APPDATA: ad, LOCALAPPDATA: la };
  r.cliPaths = { codex: cliDir ? path.join(cliDir, 'codex.cmd') : null };
  r.stopped = null;
  r.stop = (why) => { r.stopped = why; };
  let threw = null;
  let res = null;
  try { res = r.proveCodexResolution(); } catch (e) { threw = e.message; }
  return { r, res, threw, report };
}

test('the certified version is pinned', () => {
  assert.equal(lb.CODEX_EXPECTED_VERSION, '0.157.1');
  assert.equal(path.basename(lb.CODEX_RESOLVE_PROBE), 'codex-resolve-probe.cjs');
});

test('PASS: the CLI dir on the jailed PATH holds codex.cmd 0.157.1 -> the product resolves it, reads 0.157.1, grants --no-daemon; recorded in the report and the evidence', (t) => {
  const cli = prefix('0.157.1');
  const x = run(t, { pathDirs: [cli], cliDir: cli });
  assert.equal(x.threw, null, x.threw);
  assert.equal(x.res.path.toLowerCase(), path.join(cli, 'codex.cmd').toLowerCase(), 'the child used the GIVEN env (the fixture), not the runner\'s own PATH');
  assert.deepEqual([x.res.found, x.res.version, x.res.noDaemon], [true, '0.157.1', true]);
  assert.equal(x.r.proofs.codexResolve.problems.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(x.report, 'codex-resolve.json'), 'utf8')).version, '0.157.1');
  assert.ok(x.r.checks.some((c) => c.ok && /real-mode Codex resolution preflight/.test(c.label)));
});

test('REFUSES: no CLI dir on the PATH and no %APPDATA%\\npm fallback -> not found; the run stops', (t) => {
  const cli = prefix('0.157.1');
  const x = run(t, { pathDirs: [], cliDir: cli });
  assert.match(String(x.threw), /codex resolution preflight: the product resolver does not find codex/);
  assert.match(x.r.stopped, /would not spawn the certified codex/);
  assert.equal(x.r.proofs.codexResolve.found, false);
});

test('REFUSES: found only through the %APPDATA%\\npm fallback, which is not the CLI dir', (t) => {
  const cli = prefix('0.157.1');
  const ad = fs.mkdtempSync(path.join(JAIL, 'appdata-'));
  prefix('0.157.1', 'cmd', path.join(ad, 'npm'));
  const x = run(t, { pathDirs: [], appData: ad, cliDir: cli });
  assert.equal(x.r.proofs.codexResolve.found, true, 'the product fallback found it');
  assert.match(String(x.threw), /not the CLI dir/);
});

test('REFUSES: a version other than 0.157.1 (even one that has --no-daemon)', (t) => {
  const cli = prefix('0.158.0');
  const x = run(t, { pathDirs: [cli], cliDir: cli });
  assert.equal(x.r.proofs.codexResolve.noDaemon, true);
  assert.match(String(x.threw), /readCodexVersion reads "0\.158\.0", not 0\.157\.1/);
});

test('REFUSES: an older CLI the PRODUCT gate refuses --no-daemon for (0.156.0): noDaemon false comes from the product, and the run stops', (t) => {
  const cli = prefix('0.156.0');
  const x = run(t, { pathDirs: [cli], cliDir: cli });
  // LOAD-FLAKES REFUSES: found AND read, so `noDaemon: false` is the version gate, never a lookup that failed.
  assert.deepEqual([x.r.proofs.codexResolve.found, x.r.proofs.codexResolve.unknown, x.r.proofs.codexResolve.version], [true, false, '0.156.0']);
  assert.equal(x.r.proofs.codexResolve.noDaemon, false, 'codexSupportsNoDaemon(0.156.0) is false in the product');
  assert.match(String(x.threw), /WITHOUT --no-daemon/);
});

test('REFUSES: a resolved codex that is not a codex.cmd npm shim', (t) => {
  const cli = prefix('0.157.1', 'bat');
  const x = run(t, { pathDirs: [cli], cliDir: cli });
  assert.match(String(x.threw), /codex\.bat, not a codex\.cmd npm shim/);
});

test('REFUSES (verdict): noDaemon false, a probe error, nothing returned', () => {
  const ok = { path: 'C:\\n\\codex.cmd', found: true, version: '0.157.1', noDaemon: true };
  assert.deepEqual(lb.codexResolveProblems(ok, '0.157.1', 'C:\\n'), []);
  assert.match(lb.codexResolveProblems({ ...ok, noDaemon: false }, '0.157.1', 'C:\\n').join(' '), /WITHOUT --no-daemon/);
  assert.match(lb.codexResolveProblems({ error: 'Error: boom\n at x' }, '0.157.1', 'C:\\n').join(' '), /probe failed: Error: boom/);
  assert.match(lb.codexResolveProblems(null, '0.157.1', 'C:\\n').join(' '), /returned nothing/);
  assert.match(lb.codexResolveProblems({ ...ok, path: 'C:\\n\\codex.exe' }, '0.157.1', 'C:\\n').join(' '), /not a codex\.cmd/);
});

test('DRY RUN: N/A (the stub PATH has no codex), recorded as such; no child is started', (t) => {
  const x = run(t, { pathDirs: [], dry: true });
  assert.equal(x.threw, null);
  assert.equal(x.res, null);
  assert.match(x.r.proofs.codexResolve, /^N\/A: the dry run has no codex on its PATH/);
  assert.ok(x.r.checks.some((c) => c.ok && /N\/A in the dry run/.test(c.label)));
  assert.equal(fs.existsSync(path.join(x.report, 'codex-resolve.json')), false);
});

test('wiring: in main, right after appEnv and the first helper preflight, before the seed and every launch; the child gets this.env and the app cwd, hidden', () => {
  const main = src.slice(src.indexOf('async main() {'));
  const at = main.indexOf('this.proveCodexResolution();');
  assert.ok(at > main.indexOf('this.appEnv(liveUserData);') && at > main.indexOf('this.proveNoGitCredentialHelper();'), 'after appEnv and the helper preflight');
  assert.ok(at < main.indexOf('this.seed();') && at < main.indexOf('await this.launch('), 'before the first launch');
  const m = src.slice(src.indexOf('  proveCodexResolution() {'), src.indexOf('  jailLinkGate(label) {'));
  assert.match(m, /spawnSync\(process\.execPath, \[CODEX_RESOLVE_PROBE\], \{ cwd: this\.s\.base, env: this\.env, encoding: 'utf8', windowsHide: true,/);
  assert.match(m, /codexResolveProblems\(res, CODEX_EXPECTED_VERSION, expectedDir\)/);
  assert.match(m, /this\.stop\([\s\S]*throw new Error\(`codex resolution preflight/);
});

test('the child runs the PRODUCT modules from src/ (not copies), and never starts codex', () => {
  assert.match(probeSrc, /const \{ PtyManager \} = loadTs\('src\/main\/pty\.ts'\);/);
  assert.match(probeSrc, /const \{ CommandResolver, nodeResolverDeps \} = loadTs\('src\/main\/commandResolver\.ts'\);/);
  assert.match(probeSrc, /const \{ readCodexVersion, codexSupportsNoDaemon \} = loadTs\('src\/main\/codexCli\.ts'\);/);
  assert.match(probeSrc, /await PtyManager\.prototype\.commandPath\.call\(self, 'codex'\)/);
  assert.match(probeSrc, /self\.resolver = new CommandResolver\(/, 'the product resolver class and lookup (the seam is pinned below)');
  assert.doesNotMatch(probeSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /child_process|spawn|exec/,'the probe itself starts nothing (the product resolver runs where.exe, hidden)');
  // readCodexVersion starts no process: codexCli.ts imports only node:fs and node:path.
  const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'codexCli.ts'), 'utf8');
  assert.deepEqual([...cli.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]), ['node:fs', 'node:path']);
});

test('LOAD-FLAKES REFUSES: the probe resolves with the product resolver and lookup, through the whereTimeoutMs seam (a loaded machine cannot fire the 3 s box)', () => {
  const probe = fs.readFileSync(path.join(__dirname, 'tools', 'codex-resolve-probe.cjs'), 'utf8');
  assert.match(probe, /self\.resolver = new CommandResolver\(\{ deps: \(\) => \(\{ \.\.\.nodeResolverDeps\(\), whereTimeoutMs: 60_000 \}\) \}\);/);
  assert.match(probe, /unknown: resolved\.unknown === true/);
});
