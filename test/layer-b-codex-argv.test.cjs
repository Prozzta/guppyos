'use strict';

/**
 * god (on the codex git-window research): lb-codex and every Codex repro run the PRODUCT's argv,
 * built by the product's own code, with --no-daemon; a hand-written argv or one without --no-daemon
 * FAILS. HOME IS REDIRECTED AND ASSERTED before any hive object is built.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const lb = require('./tools/layer-b-run.cjs');
const pa = require('./tools/codex-product-argv.cjs');
const { codexSupportsNoDaemon } = require('./load-ts.cjs')('src/main/codexCli.ts');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-codexargv-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));

const SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*', ''
].join('\r\n');
function npmPrefix(version) {
  const prefix = fs.mkdtempSync(path.join(JAIL, 'npm-'));
  const pkgDir = path.join(prefix, 'node_modules', '@openai', 'codex');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@openai/codex', version }));
  fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'bin', 'codex.js'), '');
  // The npm cmd-shim shape of the installed codex.cmd (C:\nvm4w\nodejs\codex.cmd).
  fs.writeFileSync(path.join(prefix, 'codex.cmd'), SHIM);
  return path.join(prefix, 'codex.cmd');
}

function jailedHome(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'home-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const cwd = path.join(home, 'w');
  fs.mkdirSync(cwd, { recursive: true });
  return { home, cwd, harnessHome: path.join(home, 'harness') };
}

const COMMAND = lb.lbCodexCommand(lb.DEFAULT_MODELS.codex);

test('the product builder: codex 0.157.1 gives the runner command + the product\'s hive args, --no-daemon exactly once; the guard accepts it', async (t) => {
  const j = jailedHome(t);
  const spec = await pa.productCodexSpawn({ ...j, agentId: 'lb-codex', name: 'Codex-LB', command: COMMAND, commandPath: npmPrefix('0.157.1') });
  assert.equal(spec.exe, 'codex');
  assert.deepEqual(spec.args.slice(0, 6), ['--model', lb.DEFAULT_MODELS.codex, '--sandbox', 'workspace-write', '--ask-for-approval', 'never']);
  assert.equal(spec.args.filter((a) => a === '--no-daemon').length, 1);
  assert.ok(spec.args.includes('--dangerously-bypass-hook-trust'));
  assert.equal(spec.codexNoDaemon, true);
  assert.equal(spec.version, '0.157.1');
  assert.equal(path.resolve(spec.env.CODEX_HOME), path.resolve(j.harnessHome, 'hive', 'agents', 'lb-codex', '.codex'), 'the agent\'s own CODEX_HOME under the jailed harness');
  assert.ok(!fs.existsSync(path.join(spec.env.CODEX_HOME, 'auth.json')), 'no credential: the jailed ~/.codex has none');
  const iso = require('./load-ts.cjs')('src/main/devIsolation.ts');
  assert.ok(spec.hiveSock, 'a hive pipe is set');
  for (const live of ['C:\\Dunder\\hive', 'C:\\Dunder\\MunderDevData']) assert.notEqual(spec.hiveSock.toLowerCase(), iso.hookPipeName(live, false, 'win32').toLowerCase(), 'never a live pipe');
  assert.deepEqual(pa.codexArgvProblems(spec), []);
  assert.equal(pa.assertProductCodexArgv(spec), spec);
  assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.args), 'the product argv cannot be edited after the build');
});

test('productLaunch: the PRODUCT decodes the npm shim and starts node <codex.js> <product argv>; a refused spec never gets a launch', async (t) => {
  const j = jailedHome(t);
  const cmd = npmPrefix('0.157.1');
  const spec = await pa.productCodexSpawn({ ...j, agentId: 'lb-codex', name: 'Codex-LB', command: COMMAND, commandPath: cmd });
  const nodeDir = fs.mkdtempSync(path.join(JAIL, 'nodebin-'));
  fs.writeFileSync(path.join(nodeDir, 'node.exe'), '');
  const l = pa.productLaunch(spec, cmd, nodeDir);
  assert.equal(l.file, path.join(nodeDir, 'node.exe'));
  assert.equal(l.args[0].toLowerCase(), path.join(path.dirname(cmd), 'node_modules', '@openai', 'codex', 'bin', 'codex.js').toLowerCase());
  assert.deepEqual(l.args.slice(1), [...spec.args]);
  assert.throws(() => pa.productLaunch({ ...spec }, cmd, nodeDir), /refusing the Codex spawn/);
});

test('MUTANT (drop --no-daemon): a CLI the product gate does not grant (0.156.0, unknown) builds no --no-daemon, and the guard REFUSES it', async (t) => {
  for (const v of ['0.156.0', null]) {
    const j = jailedHome(t);
    const cmd = v ? npmPrefix(v) : path.join(JAIL, 'nowhere', 'codex.cmd');
    const spec = await pa.productCodexSpawn({ ...j, agentId: 'lb-codex', name: 'Codex-LB', command: COMMAND, commandPath: cmd });
    assert.equal(spec.args.includes('--no-daemon'), false, String(v));
    assert.match(pa.codexArgvProblems(spec).join(' '), /--no-daemon appears 0 times/);
    assert.throws(() => pa.assertProductCodexArgv(spec), /refusing the Codex spawn/);
  }
});

test('MUTANT (hand-written argv): an array written by hand, even with every flag, and a copy of a real product argv are REFUSED', async (t) => {
  const hand = { exe: 'codex', args: ['--model', 'gpt-5.6-luna', '--sandbox', 'workspace-write', '--ask-for-approval', 'never', '--dangerously-bypass-hook-trust', '--no-daemon'], env: {}, codexNoDaemon: true, version: '0.157.1' };
  assert.match(pa.codexArgvProblems(hand).join(' '), /not built by the product/);
  assert.throws(() => pa.assertProductCodexArgv(hand), /refusing the Codex spawn/);
  // The short-path repro's argv (andy-scratch/trust-repro-short.cjs): neither built nor --no-daemon.
  const repro = { exe: 'codex.exe', args: ['--model', 'gpt-5.6-luna', '--sandbox', 'workspace-write', '--ask-for-approval', 'never'] };
  assert.equal(pa.codexArgvProblems(repro).length, 4);
  const j = jailedHome(t);
  const spec = await pa.productCodexSpawn({ ...j, agentId: 'lb-codex', name: 'Codex-LB', command: COMMAND, commandPath: npmPrefix('0.157.1') });
  assert.match(pa.codexArgvProblems({ ...spec }).join(' '), /not built by the product/, 'a copy is not the product\'s build');
  assert.match(pa.codexArgvProblems({ ...spec, args: [...spec.args] }).join(' '), /not built by the product/);
});

test('the builder refuses to run with HOME not redirected, or with a home/harness/cwd overlapping a live root', async (t) => {
  const j = jailedHome(t);
  const ok = { ...j, agentId: 'lb-codex', name: 'Codex-LB', command: COMMAND, commandPath: npmPrefix('0.157.1') };
  await assert.rejects(pa.productCodexSpawn({ ...ok, home: path.join(JAIL, 'other') }), /HOME\/USERPROFILE must be redirected/);
  await assert.rejects(pa.productCodexSpawn({ ...ok, harnessHome: 'C:\\Dunder\\hive\\x' }), /overlaps the live/);
  await assert.rejects(pa.productCodexSpawn({ ...ok, cwd: 'C:\\Dunder' }), /overlaps the live/);
  await assert.rejects(pa.productCodexSpawn({ ...ok, command: 'claude --model x' }), /not a codex command/);
});

// ── the runner's check on the real run (the OS view of the app's own spawn) ──
const LAUNCH = 'C:\\nvm4w\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js';
const good = `"C:\\nvm4w\\nodejs\\node.exe" "${LAUNCH}" --model gpt-5.6-luna --sandbox workspace-write --ask-for-approval never --dangerously-bypass-hook-trust --no-daemon`;
const row = { kind: 'codex-version', version: '0.157.1', cause: 'spawn', agentId: 'lb-codex' };
const proc = (cmd, extra = {}) => ({ pid: 11, ppid: 10, name: 'node.exe', cmd, ...extra });

test('runner: lb-codex\'s launcher with the product argv and --no-daemon passes; the codex.exe it starts and other processes are not launchers', () => {
  assert.deepEqual(lb.codexSpawnArgvProblems([proc(good), { pid: 12, ppid: 11, name: 'codex.exe', cmd: 'codex.exe --model x' }, { pid: 13, ppid: 10, name: 'node.exe', cmd: 'node stub.cjs' }], row, codexSupportsNoDaemon), []);
  assert.deepEqual(lb.winCmdTokens(`"C:\\a b\\node.exe" "${LAUNCH}" --no-daemon`), ['C:\\a b\\node.exe', LAUNCH, '--no-daemon']);
});

test('runner MUTANTS: no --no-daemon, a hand-written argv, --no-daemon twice, no/two launchers, no version row, a version the product gate refuses: every one FAILS', () => {
  const f = (procs, r = row, g = codexSupportsNoDaemon) => lb.codexSpawnArgvProblems(procs, r, g).join(' ');
  assert.match(f([proc(good.replace(' --no-daemon', ''))]), /--no-daemon appears 0 times/);
  assert.match(f([proc(`node "${LAUNCH}" --model gpt-5.6-luna --sandbox workspace-write --ask-for-approval never --no-daemon`)]), /not the argv the product builds/);
  assert.match(f([proc(`${good} --no-daemon`)]), /appears 2 times/);
  assert.match(f([]), /0 Codex launchers/);
  assert.match(f([proc(good), proc(good, { pid: 14 })]), /2 Codex launchers/);
  assert.match(f([proc(good)], null), /no codex-version spawn row/);
  assert.match(f([proc(good)], { ...row, version: '0.156.0' }), /does not grant --no-daemon for codex 0\.156\.0/);
  assert.match(f([proc(good)], row, null), /product gate .* not loaded/);
  // "--no-daemon" inside another token (a quoted prompt) is not the flag.
  assert.match(f([proc(good.replace(' --no-daemon', ' "say --no-daemon"'))]), /--no-daemon appears 0 times/);
});

test('runner wiring: after EVERY launch (phase A, phase B, rollback) the real run checks lb-codex\'s argv with the PRODUCT gate, and a failure stops the run', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tools', 'layer-b-run.cjs'), 'utf8').replace(/\r\n/g, '\n');
  for (const label of ['phase A', 'phase B', 'rollback']) {
    assert.match(src, new RegExp(`await this\\.waitAgentsUp\\('${label}'\\);\\n\\s*this\\.checkCodexArgv\\('${label}'\\);`), label);
  }
  const m = src.slice(src.indexOf('  checkCodexArgv(label) {'), src.indexOf('  checkCodexSeed() {'));
  assert.match(m, /if \(this\.args\.dryRun\) return;/);
  assert.match(m, /load-ts\.cjs'\)\)\(path\.join\(REPO, 'src', 'main', 'codexCli\.ts'\)\)\.codexSupportsNoDaemon;\n/,'the PRODUCT gate, loaded from src/, not a copy');
  assert.match(m, /: codexSpawnArgvProblems\(procs, row, gate\);/, 'the verdict gets that gate unchanged');
  assert.match(m, /PS_TREE_CMDLINES\(this\.app\.proc\.pid\)/, 'the app\'s own descendants (never a text match that could see itself)');
  assert.match(m, /this\.stop\(/);
  assert.match(m, /throw new Error\(`lb-codex argv/);
  assert.doesNotMatch(lb.PS_TREE_CMDLINES(123), /-like|-match|codex/i, 'the tree query selects by pid only');
});

test('repro helpers: every Codex spawn in test/tools goes through assertProductCodexArgv(productCodexSpawn(...)); no hand-written codex argv', () => {
  const dir = path.join(__dirname, 'tools');
  const helper = fs.readFileSync(path.join(dir, 'codex-exit-repro.cjs'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(helper, /const spec = pa\.assertProductCodexArgv\(await pa\.productCodexSpawn\(/);
  assert.match(helper, /pty\.spawn\(launch\.file, launch\.args,/);
  assert.match(helper, /const launch = pa\.productLaunch\(spec, /);
  assert.match(helper, /const command = lb\.lbCodexCommand\(/, 'the runner\'s own lb-codex command, not a copy');
  assert.match(helper, /process\.argv\.slice\(2\);\nif \(!argv\.includes\('--go'\)\)/, 'refused without --go');
  assert.doesNotMatch(helper, /--sandbox'?,\s*'workspace-write|'--no-daemon'|ARGS\s*=/, 'no argv literal in the repro');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.cjs') && x !== 'layer-b-run.cjs' && x !== 'codex-product-argv.cjs' && x !== 'codex-exit-repro.cjs')) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(s, /codex(\.exe|\.cmd)?['"`]\s*,\s*\[/i, `${f}: no other tool spawns codex with a literal argv`);
  }
  void REPO;
});
