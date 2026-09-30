'use strict';

/**
 * CODEX-NODAEMON-HARDENING (1.1.76). Every Codex hive agent gets `--no-daemon` unless its CLI is
 * KNOWN to predate the flag:
 * - an unreadable version (or a failed lookup) still gets it: a daemon target spawns git with
 *   visible console windows, and `codex resume` over a daemon is a "persistent resume" that skips the
 *   hook-trust bypass for the startup hooks review (codex 0.157.1 tui/src/lib.rs:1967-1972);
 * - the resume argv keeps it (the fresh spawn's flags ride into `codex resume <id> ...`);
 * - no git credential prompt or GCM window from codex's plugin sync or the agent's git;
 * - no `packages` link from an agent home into the user's real ~/.codex (only the managed daemon
 *   and its self-updater read $CODEX_HOME/packages), and a link an earlier build made is removed,
 *   the link ONLY.
 *
 * HOME is redirected and asserted before any hive is constructed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { codexNoDaemonGate, codexSupportsNoDaemon } = loadTs('src/main/codexCli.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'nodaemon176-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'home-'));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  fs.mkdirSync(path.join(home, '.codex', 'packages', 'standalone'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'packages', 'standalone', 'KEEP'), 'the user install');
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"x":1}');
  const hive = new HiveManager(() => path.join(home, 'harness'));
  t.after(() => hive.dispose());
  const logRows = () => { try { return fs.readFileSync(path.join(home, 'harness', 'hive', 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { home, hive, logRows };
}
const agentHome = (s, id) => path.join(s.home, 'harness', 'hive', 'agents', id, '.codex');

test('gate: unknown version -> flag (fail closed); known >= 0.157.0 -> flag; known older -> none', () => {
  assert.deepEqual(codexNoDaemonGate(null), { noDaemon: true, reason: 'version-unknown' });
  assert.deepEqual(codexNoDaemonGate(''), { noDaemon: true, reason: 'version-unknown' });
  for (const v of ['0.157.0', '0.157.1', '0.158.0', '1.0.0']) assert.deepEqual(codexNoDaemonGate(v), { noDaemon: true, reason: 'supported' }, v);
  for (const v of ['0.156.9', '0.154.0']) assert.deepEqual(codexNoDaemonGate(v), { noDaemon: false, reason: 'version-too-old' }, v);
  // The layer-b runner's strict proof is unchanged: it still requires a KNOWN version.
  assert.equal(codexSupportsNoDaemon(null), false);
});

test('spawn: a Codex agent with no verdict gets --no-daemon once, and no git prompt / GCM window env', async (t) => {
  const s = sandbox(t);
  const inj = await s.hive.ensureAgent({ id: 'dw-a', name: 'Dwight', provider: 'codex', cwd: s.home }, {});
  assert.equal(inj.args.filter((a) => a === '--no-daemon').length, 1);
  assert.equal(inj.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(inj.env.GCM_INTERACTIVE, 'never');
  const claude = await s.hive.ensureAgent({ id: 'jim-c', name: 'Jim', provider: 'claude', cwd: s.home }, {});
  assert.equal(claude.args.includes('--no-daemon'), false);
  assert.equal(claude.env.GCM_INTERACTIVE, undefined, 'the git env is Codex-only');
});

test('resume: the flags of the spawn ride into `codex resume`, including under another agent\'s CODEX_HOME', async (t) => {
  const s = sandbox(t);
  const inj = await s.hive.ensureAgent({ id: 'dw-r', name: 'Dwight', provider: 'codex', cwd: s.home }, {});
  const other = path.join(JAIL, 'other-home');
  const resumed = HiveManager.codexResumeArgs(inj.args, agentHome(s, 'dw-r'), other);
  assert.equal(resumed.filter((a) => a === '--no-daemon').length, 1);
  // index.ts builds `codex resume <sid> ...args` from those same args.
  const idx = read('src/main/index.ts');
  assert.match(idx, /opts\.args = HiveManager\.codexResumeArgs\(opts\.args \?\? \[\], myHome, ownerHome\);\n\s+const args = opts\.args \?\? \[\];/);
  assert.match(idx, /if \(args\[0\] !== rsub\) \{ opts\.args = \[rsub, sid, \.\.\.args\]; didResume = true; \}/);
});

test('wiring: a failed or unreadable CLI lookup is an unknown version (flag on), logged', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /try \{ cli = await codexCliNow\(\); \} catch \{/);
  assert.match(idx, /const gate = codexNoDaemonGate\(cli\.version\);\n\s+codexNoDaemon = gate\.noDaemon;\n\s+if \(gate\.reason !== 'supported'\) hive\.appendLog\(\{ kind: 'codex-no-daemon'/);
  assert.equal(/codexNoDaemon = codexSupportsNoDaemon/.test(idx), false, 'the spawn no longer uses the strict known-version test');
});

test('packages: a new agent home gets no link into the user\'s ~/.codex/packages', async (t) => {
  const s = sandbox(t);
  await s.hive.ensureAgent({ id: 'dw-p', name: 'Dwight', provider: 'codex', cwd: s.home }, {});
  assert.equal(fs.existsSync(path.join(agentHome(s, 'dw-p'), 'packages')), false);
});

test('packages: a link an earlier build made is removed at the next spawn, its target untouched', async (t) => {
  const s = sandbox(t);
  await s.hive.ensureAgent({ id: 'dw-l', name: 'Dwight', provider: 'codex', cwd: s.home }, {});
  const link = path.join(agentHome(s, 'dw-l'), 'packages');
  fs.symlinkSync(path.join(s.home, '.codex', 'packages'), link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  await s.hive.ensureAgent({ id: 'dw-l', name: 'Dwight', provider: 'codex', cwd: s.home }, {});
  assert.equal(fs.existsSync(link), false, 'the link is gone');
  assert.equal(fs.readFileSync(path.join(s.home, '.codex', 'packages', 'standalone', 'KEEP'), 'utf8'), 'the user install', 'the target is intact');
  const row = s.logRows().find((r) => r.kind === 'codex-packages-link');
  assert.deepEqual({ agentId: row.agentId, action: row.action }, { agentId: 'dw-l', action: 'removed' });
});

test('removeCodexPackagesLink: absent, a real dir, a foreign link and an unreadable link are never deleted', (t) => {
  const d = fs.mkdtempSync(path.join(JAIL, 'rm-'));
  const expected = path.join(d, 'user-packages');
  fs.mkdirSync(expected); fs.writeFileSync(path.join(expected, 'KEEP'), 'x');
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  assert.equal(HiveManager.removeCodexPackagesLink(path.join(d, 'none'), expected), 'absent');
  const real = path.join(d, 'real'); fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'f'), 'y');
  assert.equal(HiveManager.removeCodexPackagesLink(real, expected), 'kept-not-a-link');
  assert.equal(fs.readFileSync(path.join(real, 'f'), 'utf8'), 'y');
  const elsewhere = path.join(d, 'elsewhere'); fs.mkdirSync(elsewhere);
  const foreign = path.join(d, 'foreign'); fs.symlinkSync(elsewhere, foreign, type);
  assert.equal(HiveManager.removeCodexPackagesLink(foreign, expected), 'kept-foreign-link');
  assert.ok(fs.lstatSync(foreign).isSymbolicLink());
  const mine = path.join(d, 'mine'); fs.symlinkSync(expected, mine, type);
  const upper = process.platform === 'win32' ? expected.toUpperCase() : expected;
  assert.equal(HiveManager.removeCodexPackagesLink(mine, upper), 'removed', 'matched case-insensitively on Windows');
  assert.equal(fs.existsSync(mine), false);
  assert.equal(fs.readFileSync(path.join(expected, 'KEEP'), 'utf8'), 'x', 'the target is never touched');
  // Injected fs: the unlink is the only mutation, and only for a matching link.
  const calls = [];
  const fake = { lstatSync: () => ({ isSymbolicLink: () => true }), readlinkSync: () => '/u/.codex/packages', unlinkSync: (p) => calls.push(p) };
  assert.equal(HiveManager.removeCodexPackagesLink('/a/.codex/packages', '/u/.codex/packages', fake, 'linux'), 'removed');
  assert.deepEqual(calls, ['/a/.codex/packages']);
  const failing = { ...fake, readlinkSync: () => { throw new Error('EACCES'); } };
  assert.equal(HiveManager.removeCodexPackagesLink('/a/.codex/packages', '/u/.codex/packages', failing, 'linux'), 'failed');
  assert.equal(calls.length, 1);
  assert.doesNotMatch(read('src/main/hive.ts').slice(read('src/main/hive.ts').indexOf('static removeCodexPackagesLink'), read('src/main/hive.ts').indexOf('static codexResumeArgs')), /rmSync|rmdirSync/, 'never a recursive or directory remove');
});
