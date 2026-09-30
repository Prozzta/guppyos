'use strict';
/**
 * CODEX-TRUST-LAYER (1.1.76). Design: CODEX-TRUST-LAYER.md rev 2 section 6 (tests 1-11, 13-15;
 * test 12 is Jim's real codex run, whose facts these tests encode: an MCP server starts at
 * launch, hooks run on the first turn (R1); hooks.json is loaded (12g); a linked worktree's hooks,
 * hooks.json included, come from the MAIN checkout (12i) while its rules are its own (12h)).
 * The Human's ruling: B (refuse, one-click opt-in per folder, a harness allowlist) where only our
 * seed would load the layer; A (start, visible warning) where the user's own list trusts it.
 * Real directory trees in a temp dir; the system codex config is pointed at an empty dir.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const L = loadTs('src/main/codexProjectLayers.ts');
const seedTs = loadTs('src/main/codexTrustSeed.ts');

function tmp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'programdata'), { recursive: true });
  return root;
}
const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const gitRepo = (dir) => put(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
const trustLine = (dir, level = 'trusted') => `[projects.'${seedTs.codexProjectTrustKey(dir)}']\ntrust_level = "${level}"\n`;
/** The agent's config before our seed (`user`) and after it (the seed adds the cwd). */
function run(root, cwd, { user = '', version = '0.157.1', seed = true, home } = {}) {
  const after = seed ? seedTs.withAgentTrust(user, cwd).text : user;
  return L.codexProjectLayers({ cwd, configBeforeSeed: user, configAfterSeed: after, codexHome: home ?? path.join(root, 'agent', '.codex'), codexVersion: version, programData: path.join(root, 'programdata') });
}
const MCP = '[mcp_servers.m]\ncommand = "node"\nargs = ["-e", "1"]\n';
const same = (a, b) => seedTs.sameCodexProjectKey(a, b);

// ── the TOML reader ──────────────────────────────────────────────────────────────────────────

test('TOML: tables, dotted keys, inline tables, arrays of tables and all four string forms parse; errors are errors', () => {
  const v = L.parseToml([
    'model = "x" # c', "a.'b c'.d = 'lit'", '"q\\u0041" = """', 'multi', 'line"""', "m2 = '''", "raw\\n'''",
    'arr = [ 1, "two",', '  [3], { k = true } ]', 'inl = { x = 1, y.z = "w" }',
    '[projects."C:\\\\Repo"]', 'trust_level = "trusted"', '[[hooks.PreToolUse]]', '[[hooks.PreToolUse.hooks]]', 'type = "command"', '[[hooks.PreToolUse]]'
  ].join('\n'));
  assert.equal(v.model, 'x');
  assert.equal(v.a['b c'].d, 'lit');
  assert.equal(v.qA, 'multi\nline');
  assert.equal(v.m2, 'raw\\n');
  assert.deepEqual(v.inl, { x: '1', y: { z: 'w' } });
  assert.equal(v.projects['C:\\Repo'].trust_level, 'trusted');
  assert.equal(v.hooks.PreToolUse.length, 2);
  for (const bad of ['a = 1\na = 2', '[t]\n[t]', 'x = "unterminated', 'x = ', 'x = [1, 2', 'k = { a = 1 } junk', '= 1', 'a.b = 1\n[a.b]', 's = "\\q"', 'inl = { a = 1 }\ninl.b = 2']) {
    assert.throws(() => L.parseToml(bad), L.TomlError, JSON.stringify(bad));
  }
});

// ── 1. the root walk ─────────────────────────────────────────────────────────────────────────

test('1 root walk: .git at repo, .codex at repo and repo/a/b: both layers, root first (the user trusts the repo); seed-only loads the cwd layer only', (t) => {
  const root = tmp(t);
  const repo = path.join(root, 'repo'); gitRepo(repo);
  const cwd = path.join(repo, 'a', 'b');
  put(path.join(repo, '.codex', 'config.toml'), MCP);
  put(path.join(cwd, '.codex', 'config.toml'), MCP);
  const user = run(root, cwd, { user: trustLine(repo) });
  assert.deepEqual(user.layers.map((l) => l.dotCodex), [path.join(repo, '.codex'), path.join(cwd, '.codex')]);
  assert.ok(user.layers.every((l) => l.trust === 'user'));
  const seedOnly = run(root, cwd);
  assert.deepEqual(seedOnly.layers.map((l) => l.dotCodex), [path.join(cwd, '.codex')], 'the repo layer needs the dir, root or repo-root key, which only the user can give');
  assert.equal(seedOnly.layers[0].trust, 'seed');
  // .codex only at repo/a (between root and cwd), trusted through the root key.
  const r2 = tmp(t); const repo2 = path.join(r2, 'repo'); gitRepo(repo2);
  put(path.join(repo2, 'a', '.codex', 'config.toml'), MCP);
  assert.deepEqual(run(r2, path.join(repo2, 'a', 'b'), { user: trustLine(repo2) }).layers.map((l) => l.dotCodex), [path.join(repo2, 'a', '.codex')]);
});

// ── 2. markers ───────────────────────────────────────────────────────────────────────────────

test('2 markers: [] means root = cwd; a custom .hg is honoured; a .git dir without HEAD is skipped; a .git FILE counts', (t) => {
  const root = tmp(t);
  const top = path.join(root, 'top'); const cwd = path.join(top, 'sub');
  put(path.join(top, '.codex', 'config.toml'), MCP);
  fs.mkdirSync(cwd, { recursive: true });
  const trustTop = trustLine(top);
  gitRepo(top);
  assert.equal(run(root, cwd, { user: trustTop }).layers.length, 1, 'default .git: top is the root, its layer loads');
  assert.equal(run(root, cwd, { user: `project_root_markers = []\n${trustTop}` }).layers.length, 0, '[]: root = cwd, top is never walked');
  fs.rmSync(path.join(top, '.git'), { recursive: true });
  put(path.join(top, '.hg', 'x'), '');
  assert.equal(run(root, cwd, { user: `project_root_markers = [".hg"]\n${trustTop}` }).layers.length, 1, '.hg honoured');
  assert.equal(run(root, cwd, { user: trustTop }).layers.length, 0, 'no .git: root = cwd');
  fs.mkdirSync(path.join(top, '.git'));
  assert.equal(run(root, cwd, { user: trustTop }).layers.length, 0, 'a .git dir without HEAD is not a root');
  fs.rmSync(path.join(top, '.git'), { recursive: true });
  put(path.join(top, '.git'), 'gitdir: elsewhere\n');
  const r = run(root, cwd, { user: trustTop });
  assert.equal(r.layers.length, 1, 'a .git file makes top the root');
});

test('2 markers from the SYSTEM config are honoured (J3); an unparsable system file is unknown, which refuses', (t) => {
  const root = tmp(t);
  const top = path.join(root, 'top'); const cwd = path.join(top, 'sub');
  put(path.join(top, '.codex', 'config.toml'), MCP); put(path.join(top, '.hg', 'x'), ''); fs.mkdirSync(cwd, { recursive: true });
  put(path.join(root, 'programdata', 'OpenAI', 'Codex', 'config.toml'), 'project_root_markers = [".hg"]\n');
  assert.equal(run(root, cwd, { user: trustLine(top) }).layers.length, 1);
  put(path.join(root, 'programdata', 'OpenAI', 'Codex', 'config.toml'), 'project_root_markers = [".hg"\n');
  const r = run(root, cwd);
  assert.ok(r.unknown.some((u) => /system codex config/.test(u)));
  assert.equal(L.decideCodexLayers(r, []).action, 'refuse');
});

test('2 markers and trust from MANAGED config (unix, /etc/codex/managed_config.toml) are honoured; unparsable managed is unknown', () => {
  const files = {
    '/etc/codex/managed_config.toml': 'project_root_markers = [".proj"]\n[projects."/w/top"]\ntrust_level = "trusted"\n',
    '/w/top/.proj': '', '/w/top/.codex': 'DIR', '/w/top/.codex/config.toml': MCP, '/w/top/sub': 'DIR'
  };
  const fakeFs = (f) => ({
    statSync: (p) => { if (!(p in f)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return { isDirectory: () => f[p] === 'DIR', isFile: () => f[p] !== 'DIR' }; },
    readFileSync: (p) => { if (!(p in f) || f[p] === 'DIR') { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return f[p]; },
    readdirSync: () => []
  });
  const r = L.codexProjectLayers({ cwd: '/w/top/sub', configBeforeSeed: '', configAfterSeed: seedTs.withAgentTrust('', '/w/top/sub', 'linux').text, codexHome: '/h/.codex', codexVersion: '0.157.1', platform: 'linux', fs: fakeFs(files) });
  assert.equal(r.managedConfig, true);
  assert.deepEqual(r.layers.map((l) => [l.dotCodex, l.trust]), [['/w/top/.codex', 'user']], 'managed markers make top the root; managed trust counts as the user\'s');
  const bad = L.codexProjectLayers({ cwd: '/w/top/sub', configBeforeSeed: '', configAfterSeed: '', codexHome: '/h/.codex', codexVersion: '0.157.1', platform: 'linux', fs: fakeFs({ ...files, '/etc/codex/managed_config.toml': 'x = ' }) });
  assert.ok(bad.unknown.some((u) => /managed codex config/.test(u)));
});

// ── 3. what is a layer ───────────────────────────────────────────────────────────────────────

test('3 a .codex FILE is not a layer; a .codex that IS the agent\'s CODEX_HOME is skipped', (t) => {
  const root = tmp(t); const cwd = path.join(root, 'p');
  put(path.join(cwd, '.codex'), 'not a dir');
  assert.equal(run(root, cwd).layers.length, 0);
  const cwd2 = path.join(root, 'q'); put(path.join(cwd2, '.codex', 'config.toml'), MCP);
  assert.equal(run(root, cwd2, { home: path.join(cwd2, '.codex') }).layers.length, 0);
  assert.equal(run(root, cwd2).layers.length, 1);
});

// ── 4. trust source ──────────────────────────────────────────────────────────────────────────

test('4 trust source: seed-only, user at the dir, at the root; ASCII-only case folding (JÖRG) and \\\\?\\ match as codex does', (t) => {
  const root = tmp(t);
  const repo = path.join(root, 'JÖRG'); gitRepo(repo);
  const cwd = path.join(repo, 'w'); put(path.join(cwd, '.codex', 'config.toml'), MCP);
  assert.equal(run(root, cwd).layers[0].trust, 'seed');
  assert.equal(run(root, cwd, { user: trustLine(cwd) }).layers[0].trust, 'user', 'user at the dir');
  assert.equal(run(root, cwd, { user: trustLine(repo) }).layers[0].trust, 'user', 'user at the root');
  const asciiUpper = repo.replace(/[a-z]/g, (c) => c.toUpperCase());
  assert.equal(run(root, cwd, { user: `[projects.'${asciiUpper}']\ntrust_level = "trusted"\n` }).layers[0].trust, 'user', 'ASCII case folds');
  const nonAscii = repo.replace('Ö', 'ö');
  assert.equal(run(root, cwd, { user: `[projects.'${nonAscii}']\ntrust_level = "trusted"\n` }).layers[0].trust, 'seed', 'Ö is not folded (Rust to_ascii_lowercase)');
  assert.equal(run(root, cwd, { user: `[projects.'\\\\?\\${repo}']\ntrust_level = "trusted"\n` }).layers[0].trust, 'user', '\\\\?\\ stripped');
});

// ── 5. classes ───────────────────────────────────────────────────────────────────────────────

test('5 classes: TOML hooks in every form, hooks.json, mcp_servers and rules are EXECUTE; confinement keys CONFINE; model nothing', (t) => {
  const root = tmp(t);
  const one = (name, files) => { const cwd = path.join(root, name); for (const [f, text] of Object.entries(files)) put(path.join(cwd, '.codex', f), text); fs.mkdirSync(cwd, { recursive: true }); return run(root, cwd).layers[0]; };
  for (const [name, text] of [['h1', '[hooks.SessionStart]\ncommand = "x"\n'], ['h2', 'hooks.Stop = []\n'], ['h3', '[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\ntype = "command"\n']]) {
    const f = one(name, { 'config.toml': text });
    assert.ok(f.execute.some((e) => /hooks .* run on the agent's first turn/.test(e)), `${name}: ${f.execute}`);
  }
  assert.ok(one('j1', { 'hooks.json': '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"x"}]}]}}' }).execute.some((e) => /hooks\.json: hooks \(SessionStart\) run on the agent's first turn/.test(e)));
  const badJson = one('j2', { 'hooks.json': '{"hooks": ' });
  assert.ok(badJson.parse.some((p) => /hooks\.json: not valid JSON .*codex would ignore this file/.test(p)), 'R2 wording');
  assert.equal(one('j3', { 'hooks.json': '{}', 'config.toml': 'model = "x"\n' }), undefined, 'an empty hooks.json and a model key: nothing');
  assert.ok(one('m1', { 'config.toml': MCP }).execute.some((e) => /mcp_servers \(m\) start with the agent/.test(e)), 'R1: MCP starts at launch');
  assert.ok(one('r1', { 'rules/x.rules': 'prefix_rule(pattern=["ls"], decision="allow")\n' }).execute.some((e) => /x\.rules: command policy/.test(e)));
  const c = one('c1', { 'config.toml': 'sandbox_mode = "danger-full-access"\napproval_policy = "never"\n[shell_environment_policy]\ninherit = "all"\n' });
  assert.deepEqual(c.execute, []); assert.equal(c.confine.length, 3);
  const d = L.decideCodexLayers(run(root, path.join(root, 'c1')), []);
  assert.equal(d.action, 'start-warn', 'confinement alone starts, with a warning');
});

// ── 6. linked worktrees ──────────────────────────────────────────────────────────────────────

function worktree(root, { mainCodex = {}, wtCodex = null } = {}) {
  const main = path.join(root, 'main'); gitRepo(main);
  put(path.join(main, '.git', 'worktrees', 'wt1', 'commondir'), '../..\n');
  const wt = path.join(root, 'wt1');
  put(path.join(main, '.git', 'worktrees', 'wt1', 'gitdir'), `${path.join(wt, '.git')}\n`);
  put(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt1')}\n`);
  for (const [f, text] of Object.entries(mainCodex)) put(path.join(main, '.codex', f), text);
  if (wtCodex) { fs.mkdirSync(path.join(wt, '.codex'), { recursive: true }); for (const [f, text] of Object.entries(wtCodex)) put(path.join(wt, '.codex', f), text); }
  return { main, wt };
}

test('6 linked worktree: hooks (config.toml AND hooks.json) come from MAIN (12i); the worktree\'s own hooks do not count; its rules are its own (12h)', (t) => {
  const root = tmp(t);
  const { main, wt } = worktree(root, {
    mainCodex: { 'config.toml': '[hooks.SessionStart]\ncommand = "main"\n', 'hooks.json': '{"hooks":{"SessionStart":[{}]}}' },
    wtCodex: { 'config.toml': 'model = "x"\n', 'rules/x.rules': 'r' }
  });
  const r = run(root, wt);
  assert.equal(r.layers.length, 1);
  const f = r.layers[0];
  assert.equal(f.hooksFrom, path.join(main, '.codex'));
  assert.ok(f.execute.some((e) => e.startsWith(path.join(main, '.codex', 'config.toml')) && /hooks/.test(e)), 'TOML hooks from main');
  assert.ok(f.execute.some((e) => e.startsWith(path.join(main, '.codex', 'hooks.json'))), 'hooks.json from main');
  assert.ok(f.execute.some((e) => e.startsWith(path.join(wt, '.codex', 'rules', 'x.rules'))), 'rules from the worktree');
  assert.equal(r.projectFolder, main, 'the opt-in folder of a worktree is its main checkout');
  // Hooks only in the worktree copy: no hook EXECUTE.
  const r2root = tmp(t);
  const w2 = worktree(r2root, { mainCodex: { 'config.toml': 'model = "m"\n' }, wtCodex: { 'config.toml': '[hooks.Stop]\ncommand = "wt"\n', 'hooks.json': '{"hooks":{"Stop":[{}]}}' } });
  assert.equal(run(r2root, w2.wt).layers.length, 0, 'the worktree\'s own hooks are ignored by codex');
  // A main-only .codex and no .codex in the worktree: no layer (J5a).
  const r3root = tmp(t);
  const w3 = worktree(r3root, { mainCodex: { 'config.toml': '[hooks.Stop]\ncommand = "m"\n' } });
  assert.equal(run(r3root, w3.wt).layers.length, 0);
  // Trust through the user trusting the MAIN checkout (J5b): the repo-root key.
  const r4root = tmp(t);
  const w4 = worktree(r4root, { mainCodex: { 'config.toml': '[hooks.Stop]\ncommand = "m"\n' }, wtCodex: { 'config.toml': 'model = "x"\n' } });
  assert.equal(run(r4root, w4.wt, { user: trustLine(w4.main), seed: false }).layers[0].trust, 'user');
});

// ── 7-11, 13: the decision ───────────────────────────────────────────────────────────────────

test('7 PARSE in a layer that would load refuses, naming the error (T4)', (t) => {
  const root = tmp(t); const cwd = path.join(root, 'p');
  put(path.join(cwd, '.codex', 'config.toml'), 'model = "x\n');
  const d = L.decideCodexLayers(run(root, cwd), []);
  assert.equal(d.action, 'refuse');
  assert.match(d.reason, /config\.toml: line 1: unterminated string \(codex would exit at start\)/);
});

test('10 A: EXECUTE in a layer the USER\'s own list trusts starts with a visible warning; 11 T6: the user\'s own "untrusted" on the root, overridden by our seed, refuses naming it', (t) => {
  const root = tmp(t);
  const repo = path.join(root, 'repo'); gitRepo(repo);
  const cwd = path.join(repo, 'sub'); put(path.join(cwd, '.codex', 'config.toml'), MCP);
  const a = L.decideCodexLayers(run(root, cwd, { user: trustLine(repo) }), []);
  assert.equal(a.action, 'start-warn');
  assert.match(a.reason, /your codex trust list trusts this folder.*run unreviewed/);
  const benign = path.join(repo, 'b'); put(path.join(benign, '.codex', 'config.toml'), 'model = "x"\n');
  const t6 = L.decideCodexLayers(run(root, benign, { user: trustLine(repo, 'untrusted') }), []);
  assert.equal(t6.action, 'refuse', 'even with nothing that runs: the user said untrusted');
  assert.match(t6.reason, /you marked .* "untrusted" in your codex config/);
});

test('13 version gate: another codex version (or an unknown one) with a .codex present refuses; with no .codex anywhere nothing changes', (t) => {
  const root = tmp(t); const cwd = path.join(root, 'p');
  put(path.join(cwd, '.codex', 'config.toml'), 'model = "x"\n');
  for (const v of ['0.158.0', '0.157.1-alpha.2', null]) {
    const d = L.decideCodexLayers(run(root, cwd, { version: v }), []);
    assert.equal(d.action, 'refuse', String(v));
    assert.match(d.reason, /is not the modelled 0\.157\.1/);
  }
  const clean = path.join(root, 'clean'); fs.mkdirSync(clean);
  assert.equal(L.decideCodexLayers(run(root, clean, { version: '0.158.0' }), []).action, 'start');
});

test('14 fail closed: an unreadable .codex, an unresolvable worktree, an unreadable hooks.json all count as code that runs', () => {
  const err = (code) => { const e = new Error(code); e.code = code; return e; };
  const base = { '/w': 'DIR', '/w/.codex': 'DIR', '/w/.codex/config.toml': 'model = "x"\n' };
  const mk = (f, over = {}) => ({
    statSync: (p) => { if (over.stat?.[p]) throw err(over.stat[p]); if (!(p in f)) throw err('ENOENT'); return { isDirectory: () => f[p] === 'DIR', isFile: () => f[p] !== 'DIR' }; },
    readFileSync: (p) => { if (over.read?.[p]) throw err(over.read[p]); if (!(p in f) || f[p] === 'DIR') throw err('ENOENT'); return f[p]; },
    readdirSync: () => []
  });
  const go = (fsx) => L.decideCodexLayers(L.codexProjectLayers({ cwd: '/w', configBeforeSeed: '', configAfterSeed: seedTs.withAgentTrust('', '/w', 'linux').text, codexHome: '/h/.codex', codexVersion: '0.157.1', platform: 'linux', fs: fsx }), [], 'linux');
  assert.equal(go(mk(base)).action, 'start', 'the control: a benign readable layer starts');
  assert.equal(go(mk(base, { stat: { '/w/.codex': 'EACCES' } })).action, 'refuse', 'unreadable .codex');
  assert.equal(go(mk(base, { read: { '/w/.codex/hooks.json': 'EACCES' } })).action, 'refuse', 'unreadable hooks.json');
  const wt = { ...base, '/w/.git': 'gitdir: /nowhere/.git/worktrees/x\n' };
  const d = go(mk(wt));
  assert.equal(d.action, 'refuse', 'a worktree whose main checkout cannot be found');
  assert.match(d.reason, /could not be resolved to its main checkout/);
});

test('15 regression: no .codex, or benign keys only, decides start (v1.1.75 behaviour)', (t) => {
  const root = tmp(t); const cwd = path.join(root, 'p'); fs.mkdirSync(cwd);
  assert.deepEqual(L.decideCodexLayers(run(root, cwd), []), { action: 'start', layers: [], reason: '', optInKey: L.codexLayerOptInKey(cwd) });
  put(path.join(cwd, '.codex', 'config.toml'), 'model = "x"\n');
  assert.equal(L.decideCodexLayers(run(root, cwd), []).action, 'start');
});

test('9 the opt-in: an allowed folder starts with a warning; the key is ASCII-case-insensitive on Windows (it survives a case change)', (t) => {
  const root = tmp(t); const cwd = path.join(root, 'Proj'); put(path.join(cwd, '.codex', 'config.toml'), MCP);
  const rep = run(root, cwd);
  const refused = L.decideCodexLayers(rep, []);
  assert.equal(refused.action, 'refuse');
  assert.match(refused.reason, /MCP servers start with the agent, hooks on its first turn/, 'R1 wording');
  assert.match(refused.reason, /the hooks and MCP servers in this folder will then run unreviewed/, 'R3 wording');
  const allowed = L.decideCodexLayers(rep, [process.platform === 'win32' ? refused.optInKey.toUpperCase() : refused.optInKey]);
  assert.equal(allowed.action, 'start-warn');
  assert.match(allowed.reason, /folder allowed.*run unreviewed/);
  assert.equal(L.decideCodexLayers(rep, [path.join(root, 'Other')]).action, 'refuse', 'another folder\'s opt-in does not count');
});

// ── 8, 9 through the real spawn path (HiveManager.ensureAgent) ───────────────────────────────

function sandbox(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-hive-')));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE; const realPD = process.env.ProgramData;
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.ProgramData = path.join(home, 'programdata');
  t.after(() => {
    for (const [k, v] of [['HOME', realHome], ['USERPROFILE', realProfile], ['ProgramData', realPD]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  const { HiveManager } = loadTs('src/main/hive.ts');
  const hive = new HiveManager(() => path.join(home, 'harness'));
  const notices = [];
  hive.codexLayerSink = (n) => notices.push(n);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, hive, notices };
}
const logRows = (home) => {
  const f = path.join(home, 'harness', 'hive', 'log.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test('8 B through the spawn: a seed-only layer with an MCP server REFUSES (a refusal, the opt-in key, a log row, a notice); the agent config is NOT written', async (t) => {
  const s = sandbox(t);
  const cwd = path.join(s.home, 'work', 'repo');
  put(path.join(cwd, '.codex', 'config.toml'), MCP);
  const r = await s.hive.ensureAgent({ id: 'cx-1', name: 'Codex', provider: 'codex', cwd }, { codexVersion: '0.157.1', codexLayerOptIns: [] });
  assert.ok(r.refusal && /Not started/.test(r.refusal), r.refusal);
  assert.deepEqual(r.args, []);
  assert.ok(same(r.codexLayerOptIn, cwd));
  const agentCfg = path.join(s.home, 'harness', 'hive', 'agents', 'cx-1', '.codex', 'config.toml');
  assert.equal(fs.existsSync(agentCfg), false, 'no config.toml written for a refused agent');
  const row = logRows(s.home).find((x) => x.kind === 'codex-trust-layer' && x.agentId === 'cx-1');
  assert.equal(row.action, 'refuse');
  assert.ok(row.layers[0].execute.some((e) => /mcp_servers/.test(e)));
  assert.equal(s.notices.length, 1);
  assert.equal(s.notices[0].action, 'refuse');
  assert.ok(same(s.notices[0].folder, cwd));
});

test('9 through the spawn: the same folder ALLOWED starts, trusted, with a warning row and notice; a clean folder writes no row at all', async (t) => {
  const s = sandbox(t);
  const cwd = path.join(s.home, 'work', 'repo');
  put(path.join(cwd, '.codex', 'config.toml'), MCP);
  const r = await s.hive.ensureAgent({ id: 'cx-2', name: 'Codex', provider: 'codex', cwd }, { codexVersion: '0.157.1', codexLayerOptIns: [cwd.toUpperCase()] });
  assert.equal(r.refusal, undefined);
  assert.ok(r.args.includes('--dangerously-bypass-hook-trust'));
  const cfg = fs.readFileSync(path.join(r.env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.match(cfg, /trust_level = "trusted"/);
  assert.equal(logRows(s.home).find((x) => x.kind === 'codex-trust-layer' && x.agentId === 'cx-2').action, 'start-warn');
  assert.equal(s.notices[0].action, 'start-warn');
  const clean = path.join(s.home, 'work', 'clean'); fs.mkdirSync(clean, { recursive: true });
  const r2 = await s.hive.ensureAgent({ id: 'cx-3', name: 'Codex', provider: 'codex', cwd: clean }, { codexVersion: '0.157.1' });
  assert.equal(r2.refusal, undefined);
  assert.equal(logRows(s.home).filter((x) => x.kind === 'codex-trust-layer' && x.agentId === 'cx-3').length, 0);
});

// ── wiring pins ──────────────────────────────────────────────────────────────────────────────

const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

test('wiring: the decision runs after the seed and BEFORE config.toml is written; a throw refuses; index.ts passes the version and the allowlist', () => {
  const hive = src('src/main/hive.ts');
  const fn = hive.slice(hive.indexOf('  private installCodexHooks('), hive.indexOf("writeFileSync(join(home, 'config.toml'), config, 'utf8');"));
  const seed = fn.indexOf('const seeded = withAgentTrust(config, cwd);');
  const decide = fn.indexOf('const decision = decideCodexLayers(report, layer.optIns);');
  assert.ok(seed > 0 && decide > seed, 'after the seed, inside the part before the write');
  assert.match(fn, /if \(refusal\) return \{ home, refusal: refusal\.reason/);
  assert.match(fn, /catch \(e\) \{\n\s+const reason = `Not started: the check of this agent's codex project folder failed/);
  const index = src('src/main/index.ts');
  assert.match(index, /codexVersion = cli\.version \?\? null;/);
  assert.match(index, /codexLayerOptIns: readConfig\(\)\.codexLayerOptIns \?\? \[\]/);
  assert.match(index, /if \(inj\.refusal\) return \{ ok: false, error: inj\.refusal, \.\.\.\(inj\.codexLayerOptIn/);
});

test('wiring: the opt-in is only for a folder main actually refused; the window shows every refusal; Add Agent offers allow-and-start; Settings can withdraw', () => {
  const index = src('src/main/index.ts');
  assert.match(index, /if \(!codexLayerNotices\.some\(\(n\) => n\.action === 'refuse' && n\.optInKey === optInKey\)\) return \{ ok: false, error: 'that folder was not refused' \};/);
  assert.match(src('src/renderer/src/App.tsx'), /<CodexLayerNotice \/>/);
  const modal = src('src/renderer/src/components/AddAgentModal.tsx');
  assert.match(modal, /setLayerOptIn\(spawnRes\.codexLayerOptIn\);/);
  assert.match(modal, /Allow this folder and start/);
  assert.match(modal, /will then run unreviewed/);
  const notice = src('src/renderer/src/components/CodexLayerNotice.tsx');
  assert.match(notice, /hooks and MCP servers in this folder will run unreviewed/, 'R3');
  assert.match(src('src/renderer/src/components/SettingsModal.tsx'), /<CodexLayerOptInsSetting \/>/);
  assert.match(src('src/main/config.ts'), /next\.codexLayerOptIns = patch\.codexLayerOptIns/);
});
