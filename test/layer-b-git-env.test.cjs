'use strict';

/**
 * god ruling A: GIT_CONFIG_NOSYSTEM=1, GCM_INTERACTIVE=never and GIT_TERMINAL_PROMPT=0 are in the jailed
 * app env, and reach a Codex agent's pty through the PRODUCT's own env chain. (Codex's own git child
 * keeping them is proven from the 0.157.1 source, cited in layer-b-run.cjs at JAIL_GIT_ENV.)
 * HOME IS REDIRECTED AND ASSERTED before any hive object is built.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lb = require('./tools/layer-b-run.cjs');
const pa = require('./tools/codex-product-argv.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-gitenv-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));
const WANT = { GIT_CONFIG_NOSYSTEM: '1', GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' };

test('the three values, and the check names any one that is missing or wrong (keys case-insensitive, as on Windows)', () => {
  assert.deepEqual({ ...lb.JAIL_GIT_ENV }, WANT);
  assert.ok(Object.isFrozen(lb.JAIL_GIT_ENV));
  assert.deepEqual(lb.jailGitEnvProblems({ ...WANT }, 'x'), []);
  assert.deepEqual(lb.jailGitEnvProblems({ git_config_nosystem: '1', Gcm_Interactive: 'never', GIT_TERMINAL_PROMPT: '0' }, 'x'), []);
  for (const k of Object.keys(WANT)) {
    const without = { ...WANT }; delete without[k];
    assert.match(lb.jailGitEnvProblems(without, 'the app env').join(' '), new RegExp(`the app env: ${k} is undefined`), k);
    assert.match(lb.jailGitEnvProblems({ ...WANT, [k]: 'other' }, 'x').join(' '), new RegExp(`${k} is "other"`), k);
  }
});

test('BEHAVIOUR: the app env the runner builds (dry run) carries all three, and the product pty env built from it keeps them', (t) => {
  const base = fs.mkdtempSync(path.join(JAIL, 'base-'));
  const run = new lb.LayerB(lb.parseArgs(['--dry-run-stubs']));
  run.s = { base, jail: path.join(base, 'j'), devRoot: path.join(base, 'd') };
  const env = run.appEnv(path.join(JAIL, 'no-live-userdata'));
  for (const [k, v] of Object.entries(WANT)) assert.equal(env[k], v, k);
  assert.ok(run.checks.some((c) => c.ok && /carry GIT_CONFIG_NOSYSTEM=1, GCM_INTERACTIVE=never, GIT_TERMINAL_PROMPT=0/.test(c.label)));
  assert.deepEqual(lb.jailGitEnvChain(env), []);
  const ptyEnv = pa.productPtyEnv(env, {});
  for (const [k, v] of Object.entries(WANT)) assert.equal(ptyEnv[k], v, `pty ${k}`);
  // None is secret-shaped: the rig allowlist guard keeps them.
  const iso = require('./mail-rig/isolation.cjs');
  for (const k of Object.keys(WANT)) assert.equal(iso.SECRET_NAME.test(k), false, k);
  void t;
});

test('productPtyEnv IS the product builder (src/main/ptyEnv.ts buildPtyEnv, as pty.ts calls it), not a merge', () => {
  const { buildPtyEnv } = require('./load-ts.cjs')('src/main/ptyEnv.ts');
  const parent = { PATH: 'C:\\Windows\\System32', CLAUDECODE: '1', ...WANT };
  const agent = { CODEX_HOME: 'C:\\j\\.codex' };
  const got = pa.productPtyEnv(parent, agent);
  assert.deepEqual(got, buildPtyEnv(parent, parent.PATH, agent, 'win32', []));
  assert.equal(got.CLAUDECODE, undefined, 'the product strips the parent Claude session marker');
  assert.equal(got.TERM, 'xterm-256color');
});

test('the chain check FAILS when the app env lacks one, and when the product pty env would drop one', () => {
  const env = { PATH: 'C:\\Windows\\System32', ...WANT };
  for (const k of Object.keys(WANT)) {
    const without = { ...env }; delete without[k];
    const p = lb.jailGitEnvChain(without).join(' ');
    assert.match(p, new RegExp(`the app env: ${k}`), k);
    assert.match(p, new RegExp(`the product pty env of a Codex agent: ${k}`), k);
  }
});

test('FULL product chain: the product-built Codex agent env (HiveManager.ensureAgent + the Codex overlay) sets no GIT_/GCM_ key, and buildPtyEnv(app env, that agent env) keeps all three', async (t) => {
  const home = fs.mkdtempSync(path.join(JAIL, 'home-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const cwd = path.join(home, 'w'); fs.mkdirSync(cwd);
  const prefix = fs.mkdtempSync(path.join(JAIL, 'npm-'));
  fs.mkdirSync(path.join(prefix, 'node_modules', '@openai', 'codex'), { recursive: true });
  fs.writeFileSync(path.join(prefix, 'node_modules', '@openai', 'codex', 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.157.1' }));
  fs.writeFileSync(path.join(prefix, 'codex.cmd'), '@echo off');
  const spec = await pa.productCodexSpawn({ home, harnessHome: path.join(home, 'harness'), agentId: 'lb-codex', name: 'Codex-LB', cwd, command: lb.lbCodexCommand('m'), commandPath: path.join(prefix, 'codex.cmd') });
  assert.deepEqual(Object.keys(spec.env).filter((k) => /^(GIT_|GCM_)/i.test(k)), [], 'the product agent env never sets or overrides them');
  const ptyEnv = pa.productPtyEnv({ PATH: 'C:\\Windows\\System32', ...WANT }, spec.env);
  for (const [k, v] of Object.entries(WANT)) assert.equal(ptyEnv[k], v, k);
  assert.equal(ptyEnv.CODEX_HOME, spec.env.CODEX_HOME, 'the agent env is really in the chain');
});

test('wiring: appEnv adds JAIL_GIT_ENV to the app env and REFUSES (throws) when the chain check fails', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tools', 'layer-b-run.cjs'), 'utf8').replace(/\r\n/g, '\n');
  const m = src.slice(src.indexOf('  appEnv(liveUserData) {'), src.indexOf('  appEnv(liveUserData) {') + 3000);
  assert.match(m, /Object\.assign\(env, \{ MUNDER_DEV: '1', MUNDER_HIDDEN: '1', MUNDER_DEV_ROOT: s\.devRoot, ELECTRON_ENABLE_LOGGING: '1' \}, JAIL_GIT_ENV\);/);
  assert.match(m, /const gitEnv = jailGitEnvChain\(env\);\n\s*if \(!this\.check\(!gitEnv\.length,[\s\S]*?throw new Error\(`the jailed git env is incomplete/);
  assert.ok(m.indexOf('jailGitEnvChain(env)') < m.indexOf('this.env = env;'), 'before the env is used for any launch');
});

test('GIT PROOF verdict: nothing printed + exit 1 passes; any output, exit 0, another exit or a spawn error FAILS', () => {
  assert.deepEqual(lb.gitCredentialHelperProblems({ status: 1, stdout: '', stderr: '' }), []);
  assert.match(lb.gitCredentialHelperProblems({ status: 0, stdout: 'file:C:/Program Files/Git/etc/gitconfig\tmanager-core\n' }).join(' '), /credential helper is configured .*manager-core/);
  assert.match(lb.gitCredentialHelperProblems({ status: 0, stdout: '' }).join(' '), /exited 0/);
  assert.match(lb.gitCredentialHelperProblems({ status: 128, stdout: '', stderr: 'fatal' }).join(' '), /exited 128/);
  assert.match(lb.gitCredentialHelperProblems({ error: new Error('ENOENT') }).join(' '), /could not run: ENOENT/);
  assert.deepEqual(lb.GIT_HELPER_ARGV, ['config', '--show-origin', '--get-all', 'credential.helper']);
});

test('GIT PROOF behaviour (real git config, local only, hidden): the jailed app env has no credential helper; without GIT_CONFIG_NOSYSTEM the system helper shows and the check FAILS', (t) => {
  const git = lb.agentGitExe();
  if (!git) { t.skip('no git on this machine'); return; }
  const base = fs.mkdtempSync(path.join(JAIL, 'gp-'));
  const run = new lb.LayerB(lb.parseArgs(['--dry-run-stubs']));
  run.s = { base, jail: path.join(base, 'j'), devRoot: path.join(base, 'd') };
  run.appEnv(path.join(JAIL, 'no-live-userdata'));
  run.proveNoGitCredentialHelper();
  assert.equal(run.gitHelperProof.problems.length, 0, JSON.stringify(run.gitHelperProof));
  assert.equal(run.gitHelperProof.stdout.trim(), '');
  // The same env minus GIT_CONFIG_NOSYSTEM: the machine's system config (credential.helper=manager-core
  // on Git for Windows) becomes visible, so the proof is not vacuous here.
  const { spawnSync } = require('node:child_process');
  const env = { ...run.env }; delete env.GIT_CONFIG_NOSYSTEM;
  const r = spawnSync(git, lb.GIT_HELPER_ARGV, { cwd: run.s.jail, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (!String(r.stdout || '').trim()) { t.skip('this machine has no system credential helper: the negative case cannot show'); return; }
  run.env = env;
  let stopped = null; run.stop = (why) => { stopped = why; };
  assert.throws(() => run.proveNoGitCredentialHelper(), /git credential helper check: a credential helper is configured/);
  assert.match(stopped, /credential helper is reachable/);
});

test('GIT PROOF wiring: main runs it right after appEnv, before the seed and before the first launch (both modes)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tools', 'layer-b-run.cjs'), 'utf8').replace(/\r\n/g, '\n');
  const main = src.slice(src.indexOf('async main() {'));
  const at = main.indexOf('this.proveNoGitCredentialHelper();');
  assert.ok(at > main.indexOf('this.appEnv(liveUserData);') && at < main.indexOf('this.seed();') && at < main.indexOf('await this.launch('));
  const m = src.slice(src.indexOf('  proveNoGitCredentialHelper() {'), src.indexOf('  jailLinkGate(label) {'));
  assert.doesNotMatch(m, /dryRun/);
  assert.match(m, /env: this\.env, encoding: 'utf8', windowsHide: true/);
  assert.match(m, /cwd: this\.s\.jail/);
});
