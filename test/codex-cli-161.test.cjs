'use strict';

/**
 * CODEX-WAKE-161 addendum (Jim): (a) Codex agents spawn with `--no-daemon`, but only when the
 * installed CLI has the flag; (b) the Codex CLI version is logged at app start and per spawn,
 * with a row when it changes. HOME IS REDIRECTED AND ASSERTED before any hive is built.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { readCodexVersion, codexPackageJsonCandidates, codexSupportsNoDaemon, compareVersions, CodexVersionLog, CODEX_NO_DAEMON_SINCE } = loadTs('src/main/codexCli.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'codexcli161-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));

function npmPrefix(version, name = '@openai/codex') {
  const prefix = fs.mkdtempSync(path.join(JAIL, 'npm-'));
  const pkgDir = path.join(prefix, 'node_modules', '@openai', 'codex');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version }));
  fs.writeFileSync(path.join(prefix, 'codex.cmd'), '@echo off');
  return { prefix, cmd: path.join(prefix, 'codex.cmd') };
}

test('(b) the version is read from the npm package beside the resolved command (the Windows npm-shim layout), with no process started', () => {
  const { cmd } = npmPrefix('0.157.1');
  assert.equal(readCodexVersion(cmd), '0.157.1');
  assert.equal(readCodexVersion(npmPrefix('1.2.3', 'not-codex').cmd), null, 'another package is not Codex');
  assert.equal(readCodexVersion(npmPrefix('garbage').cmd), null);
  assert.equal(readCodexVersion(null), null);
  assert.equal(readCodexVersion(path.join(JAIL, 'nowhere', 'codex')), null);
  // "No process started" (Jim's audit: the title claimed it, nothing asserted it): the module
  // that reads the version cannot start one.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'codexCli.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(src, /child_process|\bspawn(Sync)?\(|\bexec(File)?(Sync)?\(|process\.execPath/);
});

test('(b) a POSIX bin symlinked into the package resolves through its real path', () => {
  const fake = {
    existsSync: (p) => p === path.join('/usr/lib/node_modules/@openai/codex', 'package.json'),
    readFileSync: () => JSON.stringify({ name: '@openai/codex', version: '0.158.0' }),
    realpathSync: () => path.join('/usr/lib/node_modules/@openai/codex', 'bin', 'codex.js')
  };
  if (path.sep === '/') {
    assert.equal(codexPackageJsonCandidates('/usr/bin/codex', fake)[0], '/usr/lib/node_modules/@openai/codex/package.json');
    assert.equal(readCodexVersion('/usr/bin/codex', fake), '0.158.0');
  } else {
    const c = codexPackageJsonCandidates('C:\\x\\codex', { ...fake, realpathSync: () => 'C:\\p\\node_modules\\@openai\\codex\\bin\\codex.js' });
    assert.equal(c[0], 'C:\\p\\node_modules\\@openai\\codex\\package.json');
  }
});

test('(a) --no-daemon only for a CLI known to have it (>= 0.157.0); unknown or older gets nothing added', () => {
  assert.equal(CODEX_NO_DAEMON_SINCE, '0.157.0');
  for (const v of ['0.157.0', '0.157.1', '0.158.0', '1.0.0']) assert.equal(codexSupportsNoDaemon(v), true, v);
  for (const v of ['0.156.9', '0.154.0', null]) assert.equal(codexSupportsNoDaemon(v), false, String(v));
  assert.ok(compareVersions('0.157.10', '0.157.9') > 0, 'numeric, not lexical');
  assert.equal(compareVersions('0.157.1-alpha.2', '0.157.1'), 0);
});

test('(b) one codex-version row per note; codex-version-changed only when it differs from the last seen, which survives a restart', () => {
  const file = path.join(JAIL, 'ud', 'codex-cli-version.json');
  const rows = [];
  const a = new CodexVersionLog(file, (r) => rows.push(r));
  a.note('0.154.0', 'C:/n/codex.cmd', 'app-start');
  a.note('0.154.0', 'C:/n/codex.cmd', 'spawn', 'dwight');
  assert.deepEqual(rows.map((r) => r.kind), ['codex-version', 'codex-version'], 'no change row for the first ever, or an unchanged one');
  assert.deepEqual(rows[1], { kind: 'codex-version', version: '0.154.0', path: 'C:/n/codex.cmd', cause: 'spawn', agentId: 'dwight' });
  // A new app run after a global npm update:
  const b = new CodexVersionLog(file, (r) => rows.push(r));
  b.note('0.157.1', 'C:/n/codex.cmd', 'app-start');
  assert.deepEqual(rows.slice(2).map((r) => r.kind), ['codex-version', 'codex-version-changed']);
  assert.deepEqual(rows[3], { kind: 'codex-version-changed', from: '0.154.0', to: '0.157.1', cause: 'app-start' });
  b.note(null, null, 'spawn', 'x');
  assert.equal(rows.at(-1).version, null, 'an unreadable version is still a row, never a change');
  assert.equal(rows.filter((r) => r.kind === 'codex-version-changed').length, 1);
});

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'home-'));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"x":1}');
  const hive = new HiveManager(() => path.join(home, 'harness'));
  t.after(() => hive.dispose());
  return { home, hive };
}

test('(a) a Codex hive spawn carries --no-daemon exactly when the caller says the CLI has it; other providers never do', async (t) => {
  const s = sandbox(t);
  const on = await s.hive.ensureAgent({ id: 'dwight-a', name: 'Dwight', provider: 'codex', cwd: s.home }, { codexNoDaemon: true });
  assert.equal(on.args.filter((a) => a === '--no-daemon').length, 1);
  assert.ok(on.args.includes('--dangerously-bypass-hook-trust'));
  const off = await s.hive.ensureAgent({ id: 'dwight-b', name: 'Dwight', provider: 'codex', cwd: s.home }, {});
  assert.equal(off.args.includes('--no-daemon'), false, 'no version known -> no flag');
  const claude = await s.hive.ensureAgent({ id: 'jim-c', name: 'Jim', provider: 'claude', cwd: s.home }, { codexNoDaemon: true });
  assert.equal(claude.args.includes('--no-daemon'), false);
});

test('(a)+(b) wiring: a Codex spawn logs its CLI and gates the flag on that same reading; the app-start row is off the start-up path', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(idx, /if \(provider === 'codex'\) \{\n\s+const cli = codexCliNow\(\);\n\s+codexVersionLog\.note\(cli\.version, cli\.path, 'spawn', opts\.hive\.id\);\n\s+codexNoDaemon = codexSupportsNoDaemon\(cli\.version\);/);
  // 1.1.65 (codex-bloat fix 2) added settings after codexNoDaemon, so it may end with a comma.
  assert.match(idx, /skillsDir: skillsResourceDir\(\),\n\s+codexNoDaemon,?\n/);
  // "Off the start-up path" (Jim's audit): the app-start row is taken on an unref'd timer,
  // NATIVE_MEMORY_PREWARM_DELAY_MS after the first window finished loading, never inline.
  assert.match(idx, /webContents\.once\('did-finish-load', \(\) => \{[\s\S]*?const c = setTimeout\(\(\) => \{\n\s+try \{ const cli = codexCliNow\(\); if \(cli\.path\) codexVersionLog\.note\(cli\.version, cli\.path, 'app-start'\); \} catch \{ \/\* best-effort \*\/ \}\n\s+\}, NATIVE_MEMORY_PREWARM_DELAY_MS\);\n\s+c\.unref\?\.\(\);/);
  assert.equal(idx.match(/'app-start'\)/g)?.length, 1, 'the only app-start note is that one');
});
