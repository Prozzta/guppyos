'use strict';
/**
 * TRUST-SEED-175 (god option A, side branch zt175-trust-seed). codex 0.157.1 shows its directory-trust
 * screen when the cwd has no [projects."<cwd>"].trust_level (tui/src/lib.rs:2277-2279); the real run
 * #2 lb-codex sat on it and exited. The agent's OWN config.toml now trusts exactly its own cwd, after
 * the DEV sanitise (the DEV half is in codex-trust-seed-dev.test.cjs, which needs MUNDER_DEV=1 at load).
 * HOME IS REDIRECTED AND ASSERTED before any hive is built. Started from andy-scratch/trust-tests.patch.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const toml = require('toml');
const loadTs = require('./load-ts.cjs');

const ts = loadTs('src/main/codexTrustSeed.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const SEED = ['model = "gpt-6-astra"', '', "[projects.'c:\\przedit']", 'trust_level = "trusted"', ''].join('\n');

function sandbox(t, seed) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-seed-'));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), seed);
  const hive = new HiveManager(() => path.join(home, 'harness'));
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, hive };
}
/** How codex 0.157.1 looks a cwd up: each key lowercased (Windows), `\\?\` aside, string-equal. */
const trustOf = (cfg, dir) => {
  const projects = cfg.projects || {};
  const want = ts.codexProjectTrustKey(dir, 'win32');
  const k = Object.keys(projects).find((x) => ts.sameCodexProjectKey(x, want, 'win32'));
  return k ? projects[k].trust_level : undefined;
};
const logRows = (home) => {
  const f = path.join(home, 'harness', 'hive', 'log.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test('the key codex matches: the exact cwd, resolved, \\\\?\\ stripped, lowercased on Windows (case kept elsewhere)', () => {
  assert.equal(ts.codexProjectTrustKey('C:\\Dunder\\lbj\\0a1b2c3d\\w\\lb-codex', 'win32'), 'c:\\dunder\\lbj\\0a1b2c3d\\w\\lb-codex');
  assert.equal(ts.codexProjectTrustKey('\\\\?\\C:\\PrzEdit\\', 'win32'), 'c:\\przedit');
  assert.equal(ts.codexProjectTrustKey('C:/PrzEdit/Sub', 'win32'), 'c:\\przedit\\sub');
  assert.equal(ts.codexProjectTrustKey('/Users/Me/Proj/', 'darwin'), '/Users/Me/Proj');
  assert.equal(ts.sameCodexProjectKey('C:\\PrzEdit', '\\\\?\\c:\\przedit', 'win32'), true);
  assert.equal(ts.sameCodexProjectKey('C:/PrzEdit', 'c:\\przedit', 'win32'), false, 'codex compares strings: a / key is a different project for codex');
  assert.equal(ts.sameCodexProjectKey('/a/B', '/a/b', 'linux'), false);
});

test('THE predicate: default scope agent-cwd (every agent\'s own absolute cwd); product-created and off; never a relative or empty cwd', () => {
  assert.equal(ts.CODEX_TRUST_SEED_SCOPE, 'agent-cwd');
  const h = 'C:\\Users\\u\\harness';
  assert.equal(ts.shouldSeedCodexTrust('C:\\PrzEdit', { harnessHome: h, platform: 'win32' }), true);
  assert.equal(ts.shouldSeedCodexTrust('C:\\Dunder\\lbj\\0a1b2c3d\\w\\lb-codex', { harnessHome: null, platform: 'win32' }), true);
  for (const bad of ['', '   ', 'relative\\dir', null, undefined]) assert.equal(ts.shouldSeedCodexTrust(bad, { harnessHome: h, platform: 'win32' }), false, String(bad));
  assert.equal(ts.shouldSeedCodexTrust('C:\\PrzEdit', { harnessHome: h, scope: 'off', platform: 'win32' }), false);
  const pc = { harnessHome: h, scope: 'product-created', platform: 'win32' };
  assert.equal(ts.shouldSeedCodexTrust(`${h}\\worktrees\\dev1`, pc), true);
  assert.equal(ts.shouldSeedCodexTrust(`${h.toUpperCase()}\\WORKTREES\\dev1`, pc), true, 'case-insensitive on Windows');
  assert.equal(ts.shouldSeedCodexTrust(`${h}\\hive\\agents\\god`, pc), true);
  assert.equal(ts.shouldSeedCodexTrust(`${h}\\worktrees`, pc), false, 'the root itself is not an agent cwd');
  assert.equal(ts.shouldSeedCodexTrust('C:\\PrzEdit', pc), false);
  assert.equal(ts.shouldSeedCodexTrust(`${h}\\worktrees\\..\\..\\evil`, pc), false);
  assert.equal(ts.shouldSeedCodexTrust(`${h}\\worktrees\\dev1`, { ...pc, harnessHome: null }), false);
});

test('added: exactly one table in the exact form, appended; NOTHING else in the config changes; only the exact cwd (never a parent)', () => {
  const cwd = 'C:\\Dunder\\lbj\\0a1b2c3d\\w\\lb-codex';
  const r = ts.withAgentTrust(SEED, cwd, 'win32');
  assert.equal(r.action, 'added');
  assert.equal(r.key, 'c:\\dunder\\lbj\\0a1b2c3d\\w\\lb-codex');
  assert.ok(r.text.startsWith(SEED), 'the seed is untouched, byte for byte');
  assert.equal(r.text.slice(SEED.length), "\n# munder-hive trust-seed: the agent's own cwd is trusted (no trust screen)\n[projects.'c:\\dunder\\lbj\\0a1b2c3d\\w\\lb-codex']\ntrust_level = \"trusted\"\n");
  const cfg = toml.parse(r.text);
  assert.deepEqual(Object.keys(cfg.projects).sort(), ['c:\\dunder\\lbj\\0a1b2c3d\\w\\lb-codex', 'c:\\przedit']);
  assert.equal(trustOf(cfg, 'C:\\Dunder\\lbj\\0a1b2c3d\\w'), undefined, 'C1: the parent is not trusted');
  assert.equal(ts.withAgentTrust('', cwd, 'win32').text.startsWith('\n# munder-hive'), true, 'an empty seed');
  assert.ok(ts.withAgentTrust('model = "x"', cwd, 'win32').text.startsWith('model = "x"\n\n#'), 'a seed without a final newline');
  assert.match(ts.withAgentTrust('', "C:\\it's", 'win32').text, /\[projects\."c:\\\\it's"\]/, 'a quote in the path: a basic string');
});

test('NO DUPLICATE: the user config already has the project, in several TOML/path forms codex treats as equal -> never a second table (the result parses)', () => {
  const cwd = 'C:\\PrzEdit';
  const cases = [
    ["[projects.'C:\\PrzEdit']\ntrust_level = \"trusted\"\n", 'kept'],
    ['[projects."c:\\\\przedit"]\ntrust_level = "untrusted"\n', 'kept'],      // the user's explicit choice stays
    ["[projects.'\\\\?\\C:\\PrzEdit']\ntrust_level = \"trusted\"\n", 'kept'],
    ["[projects.'c:\\przedit']\n", 'set'],
    ['[projects."C:\\\\PrzEdit"]\n# a comment\nother = 1\n', 'set'],
    ['projects."c:\\\\przedit".trust_level = "trusted"\n', 'kept'],
    ["[projects]\n'C:\\PrzEdit' = { trust_level = \"trusted\" }\n", 'kept'],
    ["[projects]\n'C:\\PrzEdit' = { }\n", 'kept-unmodifiable'],
    ["[projects.'c:\\przedit'.sub]\nx = 1\n", 'kept-unmodifiable'],
    ["projects = { 'd:\\other' = { trust_level = \"trusted\" } }\n", 'skipped-inline-projects']
  ];
  for (const [seed, action] of cases) {
    const r = ts.withAgentTrust(seed, cwd, 'win32');
    assert.equal(r.action, action, seed);
    // A redefined table would throw here. (The `toml` package predates dotted keys and quoted
    // keys in inline tables, so those seeds are checked by "untouched" instead.)
    const cfg = /^\s*projects\.|=\s*\{/m.test(seed) ? null : toml.parse(r.text);
    if (action === 'kept' || action === 'kept-unmodifiable' || action === 'skipped-inline-projects') assert.equal(r.text, seed, `${seed}: untouched`);
    if (action === 'set') {
      assert.equal(trustOf(cfg, cwd), 'trusted', seed);
      assert.equal(r.text.split('\n').length, seed.split('\n').length + 1, 'one line inserted, nothing else');
    }
  }
  // A form codex does NOT treat as equal (forward slashes) is a different TOML key: ours is added, both parse.
  const r = ts.withAgentTrust("[projects.'C:/PrzEdit']\ntrust_level = \"trusted\"\n", cwd, 'win32');
  assert.equal(r.action, 'added');
  assert.deepEqual(Object.keys(toml.parse(r.text).projects).sort(), ['C:/PrzEdit', 'c:\\przedit']);
});

test('the project layer trust enables: its confinement / command keys are named (a logged warning, not a refusal)', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-layer-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  assert.deepEqual(ts.codexProjectLayerRiskKeys(cwd), []);
  fs.mkdirSync(path.join(cwd, '.codex'));
  fs.writeFileSync(path.join(cwd, '.codex', 'config.toml'), 'model = "x"\nsandbox_mode = "danger-full-access"\napproval_policy = "never"\n[mcp_servers.x]\ncommand = "evil"\n[sandbox_workspace_write]\nnetwork_access = true\n[[hooks.Stop]]\n');
  assert.deepEqual(ts.codexProjectLayerRiskKeys(cwd), ['approval_policy', 'hooks', 'mcp_servers', 'sandbox_mode', 'sandbox_workspace_write']);
  fs.writeFileSync(path.join(cwd, '.codex', 'config.toml'), 'model = "x"\n[tui]\nx = 1\n');
  assert.deepEqual(ts.codexProjectLayerRiskKeys(cwd), []);
});

test('STABLE (ensureAgent): the agent\'s own cwd is trusted in its CODEX_HOME config, the user\'s list is kept, the user\'s file is never written; logged', async (t) => {
  const s = sandbox(t, SEED);
  const cwd = path.join(s.home, 'work', 'project-x');
  fs.mkdirSync(cwd, { recursive: true });
  const inj = await s.hive.ensureAgent({ id: 'cx-1', name: 'Codex', provider: 'codex', cwd });
  const text = fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8');
  const cfg = toml.parse(text);
  assert.equal(trustOf(cfg, cwd), 'trusted', 'the agent cwd is trusted: no trust screen');
  assert.equal(trustOf(cfg, 'c:\\przedit'), 'trusted', 'Stable keeps the user\'s own trust list');
  assert.ok(text.includes(`[projects.'${ts.codexProjectTrustKey(cwd)}']\ntrust_level = "trusted"`), 'the exact key form');
  assert.equal(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8'), SEED, 'the user\'s file is never written');
  assert.ok(logRows(s.home).some((r) => r.kind === 'codex-trust-seed' && r.agentId === 'cx-1' && r.action === 'added'));
});

test('STABLE: a respawn does not duplicate the entry; a user config that already trusts the cwd gets no second table', async (t) => {
  const cwd0 = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-cwd-'));
  t.after(() => fs.rmSync(cwd0, { recursive: true, force: true }));
  const s = sandbox(t, `${SEED}\n[projects.'${cwd0.toUpperCase()}']\ntrust_level = "trusted"\n`);
  const a = await s.hive.ensureAgent({ id: 'cx-2', name: 'Codex', provider: 'codex', cwd: cwd0 });
  const b = await s.hive.ensureAgent({ id: 'cx-2', name: 'Codex', provider: 'codex', cwd: cwd0 });
  assert.equal(a.env.CODEX_HOME, b.env.CODEX_HOME);
  const text = fs.readFileSync(path.join(b.env.CODEX_HOME, 'config.toml'), 'utf8');
  const cfg = toml.parse(text);   // a duplicate table would throw
  assert.equal(trustOf(cfg, cwd0), 'trusted');
  assert.equal(Object.keys(cfg.projects).filter((k) => ts.sameCodexProjectKey(k, cwd0, 'win32')).length, 1, 'one entry for the cwd');
  assert.ok(logRows(s.home).filter((r) => r.kind === 'codex-trust-seed').every((r) => r.action === 'kept'));
});

test('STABLE: a cwd whose project layer sets confinement keys logs a codex-trust-project-layer warning row', async (t) => {
  const s = sandbox(t, SEED);
  const cwd = path.join(s.home, 'work', 'repo');
  fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.codex', 'config.toml'), 'sandbox_mode = "danger-full-access"\n');
  await s.hive.ensureAgent({ id: 'cx-3', name: 'Codex', provider: 'codex', cwd });
  assert.ok(logRows(s.home).some((r) => r.kind === 'codex-trust-project-layer' && r.agentId === 'cx-3' && r.keys.includes('sandbox_mode')));
});

test('wiring: the seed runs AFTER the DEV sanitise and the other transforms, BEFORE the hooks and the write, through the one predicate, on the agent\'s own cwd', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8').replace(/\r\n/g, '\n');
  const fn = src.slice(src.indexOf('  private installCodexHooks('), src.indexOf("writeFileSync(join(home, 'config.toml'), config, 'utf8');"));
  const at = fn.indexOf('if (cwd && shouldSeedCodexTrust(cwd, { harnessHome: this.getHome() })) {');
  assert.ok(at > fn.indexOf('sanitizeCodexConfigForDev(config') && at > fn.indexOf('config = setCodexModel(config, launchModel);') && at < fn.indexOf('if (shim) {'), 'after the sanitise, before the hooks');
  assert.match(fn, /const seeded = withAgentTrust\(config, cwd\);\n\s*config = seeded\.text;/);
  assert.match(src, /configuredCompactLimit, meta\.cwd, \{ codexVersion: opts\.codexVersion \?\? null, optIns: opts\.codexLayerOptIns \}\);/, 'ensureAgent passes the agent\'s own cwd (and, CODEX-TRUST-LAYER, the codex version and the allowlist)');
});

test('Jim P1: codex lowercases ASCII ONLY: non-ASCII letters keep their case in the key, and duplicate detection folds ASCII case only', () => {
  for (const [cwd, key] of [
    ['C:\\Users\\JÖRG\\Proj', 'c:\\users\\jÖrg\\proj'],
    ['D:\\ÄRZTE\\Akte', 'd:\\Ärzte\\akte'],
    ['E:\\İSTANBUL\\Kod', 'e:\\İstanbul\\kod']
  ]) {
    assert.equal(ts.codexProjectTrustKey(cwd, 'win32'), key, cwd);
    const r = ts.withAgentTrust('', cwd, 'win32');
    assert.ok(r.text.includes(`[projects.'${key}']`), cwd);
    assert.equal(toml.parse(r.text).projects[key].trust_level, 'trusted');
  }
  assert.equal(ts.asciiLower('ABCÖÄİz'), 'abcÖÄİz');
  assert.equal(ts.sameCodexProjectKey('C:\\JÖRG', 'c:\\jÖrg', 'win32'), true, 'ASCII case folds');
  assert.equal(ts.sameCodexProjectKey('C:\\JÖRG', 'c:\\jörg', 'win32'), false, 'Ö and ö are different keys for codex');
  // A user table in a codex-equal form (ASCII case only differs) is found: no second table.
  assert.equal(ts.withAgentTrust("[projects.'C:\\USERS\\JÖRG\\PROJ']\ntrust_level = \"trusted\"\n", 'C:\\Users\\JÖRG\\Proj', 'win32').action, 'kept');
  // Only the non-ASCII case differs: a different codex key, so ours is added and both parse.
  const r = ts.withAgentTrust("[projects.'c:\\users\\jörg\\proj']\ntrust_level = \"trusted\"\n", 'C:\\Users\\JÖRG\\Proj', 'win32');
  assert.equal(r.action, 'added');
  assert.deepEqual(Object.keys(toml.parse(r.text).projects).sort(), ['c:\\users\\jÖrg\\proj', 'c:\\users\\jörg\\proj']);
});

test('Jim P2: a control char or DEL in the cwd is written as an escaped BASIC string (TOML forbids them raw); the value round-trips', () => {
  for (const cwd of ['C:\\a\u007fb', 'C:\\tab\there', 'C:\\bell\u0007x', "C:\\it's\u007f"]) {
    const r = ts.withAgentTrust('model = "x"\n', cwd, 'win32');
    const header = r.text.split('\n').find((l) => l.startsWith('[projects.'));
    assert.ok(header.startsWith('[projects."'), `${JSON.stringify(cwd)}: a basic string`);
    assert.ok(!/[\u0000-\u001f\u007f]/.test(header), `${JSON.stringify(cwd)}: no raw control char or DEL`);
    const cfg = toml.parse(r.text);
    assert.equal(cfg.projects[ts.codexProjectTrustKey(cwd, 'win32')].trust_level, 'trusted', JSON.stringify(cwd));
  }
  assert.ok(ts.withAgentTrust('', 'C:\\a\u007fb', 'win32').text.includes('[projects."c:\\\\a\\u007Fb"]'), 'DEL as \\u007F');
  assert.ok(ts.withAgentTrust('', 'C:\\plain', 'win32').text.includes("[projects.'c:\\plain']"), 'a plain path keeps the literal form');
});
