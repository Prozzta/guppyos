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
const OWNER = 10;   // the app's main pid: node-pty runs in MAIN (pty.ts:691)
const PTY = 11;     // the pid the APP reports for pty-lb-codex (listPtys)
const proc = (cmd, extra = {}) => ({ pid: PTY, ppid: OWNER, name: 'node.exe', cmd, ...extra });
const CODEX_EXE = 'C:\\nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
/** codex.js passes its argv to codex.exe verbatim: the child the real launcher has. */
const childOf = (l, extra = {}) => ({ pid: l.pid + 1000, ppid: l.pid, name: 'codex.exe', cmd: String(l.cmd).replace(/^"[^"]*node\.exe"\s+"[^"]*codex\.js"/, `"${CODEX_EXE}"`), ...extra });
/** Each node launcher in the list gets its codex.exe child (unless the list already has one for it). */
const withChild = (procs) => [...procs, ...procs.filter((x) => /^node/i.test(x.name) && /codex\.js/.test(x.cmd) && !procs.some((c) => c.ppid === x.pid && /^codex/i.test(c.name))).map((x) => childOf(x))];

test('runner: lb-codex\'s launcher with the product argv and --no-daemon passes; the codex.exe it starts and other processes are not launchers', () => {
  assert.deepEqual(lb.codexSpawnArgvProblems(withChild([proc(good), { pid: 13, ppid: 10, name: 'node.exe', cmd: 'node stub.cjs' }]), row, codexSupportsNoDaemon, OWNER, PTY), []);
  // Jim B7: only a NODE process running the launcher script counts; a shell whose command line
  // mentions codex.js (an agent's Bash, say) is not a second launcher.
  assert.deepEqual(lb.codexSpawnArgvProblems(withChild([proc(good), { pid: 15, ppid: 11, name: 'cmd.exe', cmd: `cmd.exe /c node "${LAUNCH}" --no-daemon` }, { pid: 16, ppid: 11, name: 'powershell.exe', cmd: `powershell -c "& node '${LAUNCH}'"` }]), row, codexSupportsNoDaemon, OWNER, PTY), []);
  assert.deepEqual(lb.winCmdTokens(`"C:\\a b\\node.exe" "${LAUNCH}" --no-daemon`), ['C:\\a b\\node.exe', LAUNCH, '--no-daemon']);
});

test('runner MUTANTS: no --no-daemon, a hand-written argv, --no-daemon twice, no/two launchers, no version row, a version the product gate refuses: every one FAILS', () => {
  const f = (procs, r = row, g = codexSupportsNoDaemon, o = OWNER, q = PTY) => lb.codexSpawnArgvProblems(withChild(procs), r, g, o, q).join(' ');
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
  // Jim F1: the launcher is bound to the product spawn (its parent = the pty-owning main pid).
  assert.match(f([proc(good, { ppid: 99 })]), /its parent 99 is not the pty owner 10/, 'an agent-started launcher with the real one gone');
  assert.match(f([proc(good), proc(good, { pid: 14, ppid: 12 })]), /2 Codex launchers/, 'an agent-started launcher next to the real one');
  assert.match(f([proc(good)], row, codexSupportsNoDaemon, null), /pty-owning pid .* unknown/);
  // Dry #9 lesson: the launcher is the pty child the APP reports, by pid.
  assert.match(f([proc(good, { pid: 14 })]), /pid 14: not the pty child 11/, 'a launcher that is not the reported pty child');
  assert.match(f([proc(good)], row, codexSupportsNoDaemon, OWNER, null), /the app reported no pty pid for lb-codex/);
  assert.match(f([proc(good, { pid: 14 })], row, codexSupportsNoDaemon, OWNER, 99), /the pty child 99 the app reports is not among the app's descendants/);
  assert.match(f([{ pid: PTY, ppid: OWNER, name: 'cmd.exe', cmd: 'cmd.exe /d /s /c "codex.cmd ..."' }, proc(good, { pid: 14, ppid: PTY })]), /its parent 11 is not the pty owner 10.*not the pty child 11/, 'a cmd.exe fallback wrapper fails');
  // Doubled separators (the JSON.stringify'd registry command shape) still identify the launcher.
  assert.equal(f([proc(good.replace(/\\/g, '\\\\'))]), '');
});

test('runner (Jim, optional follow-up): the launcher has EXACTLY ONE codex.exe child carrying the same --no-daemon, marker and F2 flags (a codex.js that rewrites argv is caught)', () => {
  const f = (procs) => lb.codexSpawnArgvProblems(procs, row, codexSupportsNoDaemon, OWNER, PTY).join(' ');
  const L = proc(good);
  assert.equal(f([L, childOf(L)]), '');
  assert.equal(f([L, childOf(L), { pid: 5000, ppid: childOf(L).pid, name: 'codex.exe', cmd: `"${CODEX_EXE}" --codex-run-as-apply-patch` }]), '', 'codex.exe helper grandchildren are not the launcher\'s children');
  assert.match(f([L]), /pid 11: 0 codex\.exe children/);
  assert.match(f([L, childOf(L), childOf(L, { pid: 1012 })]), /pid 11: 2 codex\.exe children/);
  assert.match(f([L, childOf(L, { cmd: `"${CODEX_EXE}" --model gpt-5.6-luna --sandbox workspace-write --ask-for-approval never --dangerously-bypass-hook-trust` })]), /codex\.exe 1011: --no-daemon appears 0 times/, 'argv rewritten: --no-daemon dropped');
  assert.match(f([L, childOf(L, { cmd: `"${CODEX_EXE}" --model gpt-5.6-luna --sandbox workspace-write --ask-for-approval never --no-daemon` })]), /codex\.exe 1011: no --dangerously-bypass-hook-trust/);
  assert.match(f([L, childOf(L, { cmd: `${childOf(L).cmd} --dangerously-bypass-approvals-and-sandbox` })]), /codex\.exe 1011: REFUSED flag --dangerously-bypass-approvals-and-sandbox/);
  assert.match(f([L, childOf(L, { cmd: childOf(L).cmd.replace('--sandbox workspace-write', '--sandbox danger-full-access') })]), /codex\.exe 1011: not exactly one `--sandbox workspace-write`/);
  assert.match(f([L, childOf(L, { name: 'node.exe' })]), /0 codex\.exe children/, 'only a codex.exe counts');
});

test('runner (Jim F2): the launcher must carry exactly --sandbox workspace-write and --ask-for-approval never, and NONE of the bypass flags or overrides', () => {
  const f = (cmd) => lb.codexSpawnArgvProblems(withChild([proc(cmd)]), row, codexSupportsNoDaemon, OWNER, PTY).join(' ');
  assert.equal(f(good), '');
  assert.match(f(`${good} --dangerously-bypass-approvals-and-sandbox`), /REFUSED flag --dangerously-bypass-approvals-and-sandbox/, 'the renderer autoMode flag (store/config.ts:514)');
  for (const flag of ['--yolo', '--approve-for-me', '--not-so-yolo', '--full-auto', '--auto-review']) assert.match(f(`${good} ${flag}`), new RegExp(`REFUSED flag ${flag}`), flag);
  assert.match(f(good.replace('--sandbox workspace-write ', '')), /not exactly one `--sandbox workspace-write` \(found none\)/);
  assert.match(f(good.replace('--sandbox workspace-write', '--sandbox danger-full-access')), /not exactly one `--sandbox workspace-write`/);
  assert.match(f(`${good} -s danger-full-access`), /not exactly one `--sandbox workspace-write`/, 'a second, short-form sandbox flag');
  assert.match(f(`${good} --sandbox=danger-full-access`), /not exactly one `--sandbox workspace-write`/);
  assert.match(f(good.replace(' --ask-for-approval never', '')), /not exactly one `--ask-for-approval never`/);
  assert.match(f(good.replace('--ask-for-approval never', '--ask-for-approval on-request')), /not exactly one `--ask-for-approval never`/);
  assert.match(f(`${good} -a untrusted`), /not exactly one `--ask-for-approval never`/);
  assert.match(f(`${good} -c sandbox_mode="danger-full-access"`), /REFUSED override -c sandbox_mode/);
  assert.match(f(`${good} --config approval_policy="on-request"`), /REFUSED override -c approval_policy/);
  assert.deepEqual(lb.CODEX_REFUSED_FLAGS.slice(0, 2), ['--dangerously-bypass-approvals-and-sandbox', '--yolo']);
  // Jim H1: every clap form of -c/--config.
  assert.match(f(`${good} --config=sandbox_mode="danger-full-access"`), /REFUSED override -c sandbox_mode/);
  assert.match(f(`${good} -csandbox_mode="danger-full-access"`), /REFUSED override -c sandbox_mode/);
  assert.match(f(`${good} -c=approval_policy="on-request"`), /REFUSED override -c approval_policy/);
  assert.match(f(`${good} -capproval_policy=never`), /REFUSED override -c approval_policy/);
  assert.match(f(`${good} -c sandbox_workspace_write.writable_roots=["C:/"]`), /REFUSED override -c sandbox_workspace_write/);
  assert.equal(f(`${good} -c model_reasoning_effort=low`), '', 'an unrelated override is not refused');
  // Jim H2: flags that widen the sandbox or swap the config (0.157.1 shared_options.rs:35/:67/:71/:75).
  for (const [flag, re] of [['--add-dir C:/', /REFUSED flag --add-dir/], ['--add-dir=C:/', /REFUSED flag --add-dir/],
    ['--cd C:/', /REFUSED flag --cd\/-C/], ['--cd=C:/', /REFUSED flag --cd\/-C/], ['-C C:/', /REFUSED flag --cd\/-C/], ['-CC:/', /REFUSED flag --cd\/-C/],
    ['--profile wide', /REFUSED flag --profile\/-p/], ['--profile=wide', /REFUSED flag --profile\/-p/], ['-p wide', /REFUSED flag --profile\/-p/], ['-pwide', /REFUSED flag --profile\/-p/],
    ['--worktree', /REFUSED flag --worktree/], ['--worktree=true', /REFUSED flag --worktree/]]) {
    assert.match(f(`${good} ${flag}`), re, flag);
  }
  assert.deepEqual(lb.CODEX_WIDENING_FLAGS, [['--add-dir', null], ['--cd', '-C'], ['--profile', '-p'], ['--worktree', null]]);
  // Jim K1: a quoted TOML key, and the permissions keys.
  const t = (...extra) => lb.codexSafetyArgvProblems([...lb.winCmdTokens(good), ...extra]).join(' ');
  assert.match(t('-c', '"sandbox_mode"="danger-full-access"'), /REFUSED override -c "sandbox_mode"/);
  assert.match(t('-c', "'approval_policy'=never"), /REFUSED override -c 'approval_policy'/);
  assert.match(t('--config="sandbox_mode"=x'), /REFUSED override -c "sandbox_mode"/);
  for (const k of ['sandbox_permissions', 'default_permissions', 'permissions']) assert.match(t('-c', `${k}=["disk-full-write-access"]`), new RegExp(`REFUSED override -c ${k}`), k);
  assert.equal(t('-c', 'permissionsx=1'), '', 'a key that only starts with a refused name is not refused');
});

/** Dry #9's REAL shape: the registry command is `${JSON.stringify(node)} ${JSON.stringify(stub)}`
 *  (layer-b-run.cjs seed), split by the PRODUCT's tokenizeCommand and turned into the CreateProcess
 *  command line by node-pty's own argsToCommandLine: every backslash arrives DOUBLED. */
function dry9CommandLine(node, stub) {
  const { tokenizeCommand } = require('./load-ts.cjs')('src/shared/commandLine.ts');
  const { argsToCommandLine } = require('../node_modules/node-pty/lib/windowsPtyAgent.js');
  const [exe, ...args] = tokenizeCommand(`${JSON.stringify(node)} ${JSON.stringify(stub)}`);
  return argsToCommandLine(exe, args);
}
const DRY9 = { owner: 38660, pty: 88364, node: 'C:\\Users\\FiercePC\\AppData\\Local\\Temp\\md-rig-node-v20.19.5\\node.exe', stubs: 'C:\\Dunder\\lbj\\17f434f1\\s' };
const dry9Procs = () => [
  { pid: 27352, ppid: DRY9.owner, name: 'Munder Difflin.exe', cmd: '"Munder Difflin.exe" --type=gpu-process' },
  { pid: 63256, ppid: DRY9.owner, name: 'node.exe', cmd: dry9CommandLine(DRY9.node, path.join(DRY9.stubs, 'god.cjs')) },
  { pid: 43256, ppid: DRY9.owner, name: 'conhost.exe', cmd: '\\??\\C:\\Windows\\system32\\conhost.exe 0x4' },
  { pid: 40444, ppid: DRY9.owner, name: 'node.exe', cmd: dry9CommandLine(DRY9.node, path.join(DRY9.stubs, 'lb-claude.cjs')) },
  { pid: DRY9.pty, ppid: DRY9.owner, name: 'node.exe', cmd: dry9CommandLine(DRY9.node, path.join(DRY9.stubs, 'lb-codex.cjs')) },
  { pid: 40372, ppid: DRY9.owner, name: 'conhost.exe', cmd: '\\??\\C:\\Windows\\system32\\conhost.exe 0x4' }
];

test('dry #9 ROOT CAUSE, reproduced with the product tokenizer and node-pty: the stub command line has DOUBLED backslashes, so the stubs-path substring (68ce7c57) matched 0 processes', () => {
  const line = dry9CommandLine(DRY9.node, path.join(DRY9.stubs, 'lb-codex.cjs'));
  assert.ok(line.includes('C:\\\\Dunder\\\\lbj\\\\17f434f1\\\\s\\\\lb-codex.cjs'), line);
  assert.equal(line.toLowerCase().includes(path.join(DRY9.stubs, 'lb-codex.cjs').toLowerCase()), false, 'the 68ce7c57 match could never see it');
});

test('runner (Jim F1, dry run): the stub is identified by the pty pid the APP reports; parent = the pty owner, node, running lb-codex.cjs (dry #9 shape passes)', () => {
  assert.deepEqual(lb.stubPtyParentProblems(dry9Procs(), 'lb-codex.cjs', DRY9.owner, DRY9.pty), [], 'the real dry #9 process list');
  const edit = (patch) => dry9Procs().map((x) => (x.pid === DRY9.pty ? { ...x, ...patch } : x));
  assert.match(lb.stubPtyParentProblems(edit({ ppid: 5 }), 'lb-codex.cjs', DRY9.owner, DRY9.pty).join(' '), /parent is 5, not the pty owner 38660/);
  assert.match(lb.stubPtyParentProblems(edit({ name: 'cmd.exe' }), 'lb-codex.cjs', DRY9.owner, DRY9.pty).join(' '), /is cmd\.exe, not node/);
  assert.match(lb.stubPtyParentProblems(edit({ cmd: 'node.exe C:\\x\\lb-claude.cjs' }), 'lb-codex.cjs', DRY9.owner, DRY9.pty).join(' '), /does not run lb-codex\.cjs/);
  assert.match(lb.stubPtyParentProblems(edit({ cmd: 'node.exe C:\\x\\not-lb-codex.cjs' }), 'lb-codex.cjs', DRY9.owner, DRY9.pty).join(' '), /does not run lb-codex\.cjs/, 'the basename, not a suffix');
  assert.match(lb.stubPtyParentProblems(dry9Procs(), 'lb-codex.cjs', DRY9.owner, 40444).join(' '), /does not run lb-codex\.cjs/, 'the lb-claude pty pid');
  assert.match(lb.stubPtyParentProblems(dry9Procs(), 'lb-codex.cjs', DRY9.owner, 12345).join(' '), /not among the app's descendants/);
  assert.match(lb.stubPtyParentProblems(dry9Procs(), 'lb-codex.cjs', DRY9.owner, undefined).join(' '), /reported no pty pid/);
  assert.deepEqual(lb.procEvidence([{ pid: 1, ppid: 2, name: 'n', cmd: 'x --token sk-abcdefghijklmnopqrstuvwxyz0123456789', extra: 1 }]).map((x) => Object.keys(x)), [['pid', 'ppid', 'name', 'cmd']]);
});

test('runner wiring: after EVERY launch (phase A, phase B, rollback) the real run checks lb-codex\'s argv with the PRODUCT gate, and a failure stops the run', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tools', 'layer-b-run.cjs'), 'utf8').replace(/\r\n/g, '\n');
  for (const label of ['phase A', 'phase B', 'rollback']) {
    assert.match(src, new RegExp(`await this\\.waitAgentsUp\\('${label}'\\);\\n\\s*this\\.checkCodexArgv\\('${label}'\\);`), label);
  }
  const m = src.slice(src.indexOf('  checkCodexArgv(label) {'), src.indexOf('  checkCodexSeed() {'));
  assert.match(m, /const owner = this\.app\.proc\.pid;/);
  assert.match(m, /const pty = \(this\.agentPtys \|\| \[\]\)\.find\(\(x\) => x\.id === `pty-\$\{IDS\.codex\}`\) \|\| null;/, 'the pid the app reports');
  assert.match(m, /if \(this\.args\.dryRun\) \{[\s\S]*stubPtyParentProblems\(procs, `\$\{IDS\.codex\}\.cjs`, owner, ptyPid\)[\s\S]*processes: procEvidence\(procs\)[\s\S]*this\.stop\([\s\S]*throw new Error\(`pty owner binding[\s\S]*return;\n    \}/, 'the dry run confirms the pty-owner binding, records the raw list, and fails if it does not hold');
  const w = src.slice(src.indexOf('  async waitAgentsUp(label) {'), src.indexOf('  async waitAgentsUp(label) {') + 1200);
  assert.match(w, /const ptys = await this\.ptys\(\);\n    this\.agentPtys = ptys;/, 'waitAgentsUp keeps the app-reported pty pids');
  assert.match(m, /r\.agentId === IDS\.codex\)\.pop\(\)/, 'the version row is lb-codex\'s own (Jim B8)');
  assert.match(m, /const problems = err \? \[err\] : codexSpawnArgvProblems/, 'a failed process query is a problem by itself (Jim B13)');
  assert.match(m, /load-ts\.cjs'\)\)\(path\.join\(REPO, 'src', 'main', 'codexCli\.ts'\)\)\.codexSupportsNoDaemon;\n/,'the PRODUCT gate, loaded from src/, not a copy');
  assert.match(m, /: codexSpawnArgvProblems\(procs, row, gate, owner, ptyPid\);/, 'the verdict gets that gate, the pty owner and the pty pid unchanged');
  assert.match(m, /problems, processes: procEvidence\(procs\) \}\);\n    if \(!this\.check\(!problems\.length, `lb-codex runs the PRODUCT/, 'the real run records the raw list too');
  assert.match(m, /try \{ procs = query\(owner\); \}/);
  assert.match(m, /PS_TREE_CMDLINES\(pid\)/, 'the app\'s own descendants (never a text match that could see itself)');
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
  // Jim X3: no credential, in the jailed ~/.codex AND the agent CODEX_HOME, checked before the spawn.
  assert.match(helper, /for \(const f of \[path\.join\(home, '\.codex', 'auth\.json'\), path\.join\(codexHome, 'auth\.json'\)\]\) if \(fs\.existsSync\(f\)\) throw new Error\(`a credential exists/);
  assert.ok(helper.indexOf("path.join(codexHome, 'auth.json')") < helper.indexOf('pty.spawn(launch.file'), 'checked before the spawn');
  // Jim X4 (2e38b32f): the cleanup restores the real profile BEFORE the delete and the leftover query.
  const tail = helper.slice(helper.indexOf('(async () => {'));
  assert.match(helper, /function restoreRealProfile\(\) \{\n  for \(const \[k, v\] of Object\.entries\(REAL_ENV\)\) \{ if \(v === undefined\) delete process\.env\[k\]; else process\.env\[k\] = v; \}\n\}/);
  const restore = tail.indexOf('restoreRealProfile();');
  assert.ok(restore > 0 && restore < tail.indexOf('await rmBase();') && restore < tail.indexOf('rec.leftovers = leftovers();'), 'profile restored first');
  assert.match(helper, /const REAL_ENV = \{ HOME: process\.env\.HOME, USERPROFILE: process\.env\.USERPROFILE \};/);
  // ... and right after the product build, BEFORE the window watch and any snapshot PowerShell starts.
  const body = helper.slice(helper.indexOf('async function main() {'));
  const early = body.indexOf('restoreRealProfile();');
  assert.ok(early > body.indexOf('await pa.productCodexSpawn(') && early < body.indexOf('new lb.WindowWatch(') && early < body.indexOf('snapshotTree('), 'the redirect ends with the build');
  assert.match(tail, /rec\.recreated = fs\.existsSync\(base\);\n  if \(rec\.recreated\) await rmBase\(\);\n  rec\.gone = !fs\.existsSync\(base\);/, 're-verified after the leftover query');
  assert.doesNotMatch(helper, /--sandbox'?,\s*'workspace-write|'--no-daemon'|ARGS\s*=/, 'no argv literal in the repro');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.cjs') && x !== 'layer-b-run.cjs' && x !== 'codex-product-argv.cjs' && x !== 'codex-exit-repro.cjs')) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(s, /codex(\.exe|\.cmd)?['"`]\s*,\s*\[/i, `${f}: no other tool spawns codex with a literal argv`);
  }
  void REPO;
});

test('builder (Jim F3): a product ensureAgent REFUSAL makes productCodexSpawn reject; (Jim A2) a product argv with --no-daemon twice is refused by the guard', async (t) => {
  const { HiveManager } = require('./load-ts.cjs')('src/main/hive.ts');
  const real = HiveManager.prototype.ensureAgent;
  t.after(() => { HiveManager.prototype.ensureAgent = real; });
  const j = jailedHome(t);
  const o = { ...j, agentId: 'lb-codex', name: 'Codex-LB', command: COMMAND, commandPath: npmPrefix('0.157.1') };
  HiveManager.prototype.ensureAgent = async function () { return { args: [], env: {}, refusal: 'refusing to start Codex: injected F1 refusal' }; };
  await assert.rejects(pa.productCodexSpawn(o), /the product refused the spawn: refusing to start Codex: injected F1 refusal/);
  HiveManager.prototype.ensureAgent = async function (...a) { const r = await real.apply(this, a); return { ...r, args: [...r.args, '--no-daemon'] }; };
  const twice = await pa.productCodexSpawn({ ...o, agentId: 'lb-codex2' });
  assert.equal(twice.args.filter((x) => x === '--no-daemon').length, 2, 'branded, from the builder');
  assert.match(pa.codexArgvProblems(twice).join(' '), /--no-daemon appears 2 times/);
  assert.throws(() => pa.assertProductCodexArgv(twice), /refusing the Codex spawn/);
});

test('checkCodexArgv (Jim F1) behaviour: the DRY run fails and stops when the stub is not a direct child of the pty owner, passes when it is; the real run fails on an unbound launcher', (t) => {
  const root = fs.mkdtempSync(path.join(JAIL, 'chk-'));
  const report = path.join(root, 'report');
  lb.W.allowRoot(report);
  const mk = (dry) => {
    const run = new lb.LayerB(lb.parseArgs(dry ? ['--dry-run-stubs'] : []));
    run.s = { base: root, report, stubs: path.join(root, 's'), hive: path.join(root, 'hive') };
    run.app = { proc: { pid: OWNER } };
    run.stopped = null;
    run.stop = (why) => { run.stopped = why; };
    return run;
  };
  const stub = path.join(root, 's', 'lb-codex.cjs');
  const dry = mk(true);
  dry.agentPtys = [{ id: 'pty-god', pid: 29 }, { id: 'pty-lb-codex', pid: 30 }];
  dry.procQuery = () => [{ pid: 30, ppid: OWNER, name: 'node.exe', cmd: `"node.exe" "${stub}"` }];
  dry.checkCodexArgv('phase A');
  assert.equal(dry.stopped, null);
  // Dry #9 end to end: its real process list and pids pass now (on 68ce7c57 this threw '0 stub lb-codex processes').
  const d9 = mk(true);
  d9.app = { proc: { pid: DRY9.owner } };
  d9.agentPtys = [{ id: 'pty-god', pid: 63256 }, { id: 'pty-lb-claude', pid: 40444 }, { id: 'pty-lb-codex', pid: DRY9.pty }];
  d9.procQuery = () => dry9Procs();
  d9.checkCodexArgv('phase A dry9');
  assert.equal(d9.stopped, null);
  const ev = JSON.parse(fs.readFileSync(path.join(report, 'codex-pty-parent-phase-A-dry9.json'), 'utf8'));
  assert.equal(ev.ptyPid, DRY9.pty);
  assert.equal(ev.processes.length, 6, 'the raw process list is kept');
  assert.match(ev.codexExeChild, /^N\/A: /, 'the codex.exe child check is N/A in the dry run');
  dry.procQuery = () => [{ pid: 30, ppid: 77, name: 'node.exe', cmd: `"node.exe" "${stub}"` }];
  assert.throws(() => dry.checkCodexArgv('phase B'), /pty owner binding \(phase B\): the stub's parent is 77/);
  assert.match(dry.stopped, /pty-owner binding does not hold/);
  dry.procQuery = () => { throw new Error('EPERM (injected)'); };
  assert.throws(() => dry.checkCodexArgv('rollback'), /the process query failed: EPERM/);
  const real = mk(false);
  real.rows = () => [row];
  real.agentPtys = [{ id: 'pty-lb-codex', pid: PTY }];
  real.procQuery = () => withChild([proc(good, { ppid: 55 })]);
  assert.throws(() => real.checkCodexArgv('phase A'), /its parent 55 is not the pty owner 10/);
  assert.match(real.stopped, /not the product's --no-daemon spawn/);
  real.stopped = null;
  real.procQuery = () => withChild([proc(good)]);
  real.checkCodexArgv('phase A');
  assert.equal(real.stopped, null);
});
