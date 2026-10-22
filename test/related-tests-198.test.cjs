'use strict';
/**
 * BRANCH-RELATED-PINS-RUN (1.1.98 stage 12): scripts/related-tests.cjs.
 * - The matcher is pure: path forms a test uses (quoted, require without the extension, path
 *   segments, a MIRROR comment, a test helper's './x'), never the bare basename.
 * - package.json counts only through a changed key (scripts: through a changed script's name).
 * - Lanes: census (test/tools/*-mutants.cjs), tools (other test/tools runners: listed, never run),
 *   electron (runScenario: never run), heavy (@heavy-lock), light.
 * - A test naming a changed file's dir (two segments or more) relates through its basename or a walk.
 * - "same on base" compares the NAMES of the failing tests (or the first error line), never counts.
 * - --base must be an ancestor of --tip.
 * - The CLI runs on a REAL temp git repo: a red file is run again at base in a temp worktree
 *   ("same on base" vs "BRANCH RED" vs "new"), the worktree is removed, the hive env is stripped.
 * Named mutants (census at the end, compiled from text, no file written), each must die:
 *   R1 basename match (no path boundary)   R2 package.json by its bare name
 *   R3 electron files in the light lane    R4 reds never re-run at base
 *   R5 the hive env reaches the child      R6 the base worktree is left behind
 *   R7 same on base by counts              R8 no dir rule (a new module in src/main)
 *   R9 a non-ancestor base accepted        R10 every test/tools runner is a census
 *   R11 nameless reds by the first line alone (no rc, an empty line matches)
 *   R12 no inventory rule (RELATED-TEST-INVENTORY-198: an added test file never selects the glob pin)
 *   R13 a deleted test file is not an inventory change
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('./tools/test-temp.cjs');

const SRC = path.join(__dirname, '..', 'scripts', 'related-tests.cjs');
const REAL = require(SRC);

// Built by concatenation: this file must not itself read as a harness user.
const HARNESS = "require('./electron-" + "harness/run.cjs')";

const PIN_TEXT = {
  quoted: "const t = load('src/main/hive.ts');",
  required: "require('../src/main/hive')",
  segments: "fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8')",
  mirror: ' * The logic under test lives in src/main/hive.ts redactSecrets()',
  basename: "const files = ['hive.ts', 'index.ts'];",
  longer: "load('src/main/hiveRegistry.ts')",
  nested: "load('test/src/main/hive.ts')"
};

function matcherChecks(M) {
  for (const k of ['quoted', 'required', 'segments', 'mirror']) {
    assert.deepEqual(M.namedPaths(PIN_TEXT[k], ['src/main/hive.ts']), ['src/main/hive.ts'], `${k} names the path`);
  }
  for (const k of ['basename', 'longer', 'nested']) {
    assert.deepEqual(M.namedPaths(PIN_TEXT[k], ['src/main/hive.ts']), [], `${k} does not name src/main/hive.ts`);
  }
  assert.deepEqual(M.namedPaths("require('./load-ts.cjs')", ['test/load-ts.cjs']), ['test/load-ts.cjs'], "a test helper's ./x form");
}

function packageChecks(M) {
  const base = JSON.stringify({ scripts: { dev: 'a', 'cut:win': 'b' }, build: { x: 1 }, dependencies: { y: '1' } });
  const tip = JSON.stringify({ scripts: { dev: 'a', 'cut:win': 'c' }, build: { x: 1 }, dependencies: { y: '1' } });
  const d = M.packageDiff(base, tip);
  assert.deepEqual(d, { keys: ['scripts'], scripts: ['cut:win'] });
  assert.equal(M.packageNamed("const pkg = require('../package.json'); pkg.scripts['cut:win']", d), true, 'a changed script by name');
  assert.equal(M.packageNamed("const pkg = require('../package.json'); pkg.scripts['test:focused']", d), false, 'an unchanged script');
  assert.equal(M.packageNamed("const pkg = require('../package.json'); pkg.version", d), false, 'package.json alone');
  const dep = M.packageDiff(base, JSON.stringify({ ...JSON.parse(base), dependencies: { y: '2' } }));
  assert.equal(M.packageNamed("JSON.parse(read('package.json')).dependencies.y", dep), true, 'a changed top-level key');
}

function laneChecks(M) {
  assert.equal(M.laneOf('test/tools/x-mutants.cjs', ''), 'census');
  assert.equal(M.laneOf('test/tools/codex-resolve-probe.cjs', ''), 'tools', 'a probe is not a census');
  assert.equal(M.laneOf('test/a.test.cjs', `const { runScenario } = ${HARNESS};`), 'electron');
  assert.equal(M.laneOf('test/a.test.cjs', "read('test/electron-harness/scenarios/x.ts')"), 'light', 'reading a harness file is not running it');
  assert.equal(M.laneOf('test/a.test.cjs', "'use strict';\n// @heavy-lock live: real worktrees\n"), 'heavy');
  assert.equal(M.laneOf('test/a.test.cjs', "'use strict';\n"), 'light');
}

test('matcher: quoted, require, segments and MIRROR forms name a path; a basename, a longer name or a nested copy do not', () => matcherChecks(REAL));
test('package.json: only a changed key counts; scripts only through a changed script name', () => packageChecks(REAL));
test('lanes: census, tools, electron (never run), heavy, light', () => laneChecks(REAL));

function dirChecks(M) {
  const NEW = ['src/main/brandNew.ts'];
  const walker = "const root = path.join(__dirname, '..', 'src', 'main'); for (const f of walkSrc(root)) check(f);";
  const lister = "for (const f of ['hive.ts', 'brandNew.ts']) read(path.join(__dirname, '..', 'src', 'main', f));";
  const template = "const SRC = path.join(ROOT, 'src', 'main'); for (const name of ['brandNew']) read(path.join(SRC, `${name}.ts`));";
  const readdir = "const ents = fs.readdirSync('src/main');";
  for (const [k, t] of Object.entries({ walker, lister, template, readdir })) assert.deepEqual(M.namedPaths(t, NEW), NEW, `${k}: a test over src/main sees a new module there`);
  assert.deepEqual(M.namedPaths("read(path.join(__dirname, '..', 'src', 'main', 'hive.ts'))", NEW), [], 'the dir with another basename and no walk');
  assert.deepEqual(M.namedPaths("for (const f of walk(path.join(root, 'src'))) check(f);", ['src/top.ts']), [], 'a one-segment dir is too wide');
  assert.deepEqual(M.namedPaths("for (const f of walk(path.join(root, 'src', 'shared'))) check(f);", NEW), [], 'another dir');
  assert.deepEqual(M.namedPaths("const files = walk(path.join(ROOT, 'src/renderer'));", ['src/renderer/src/store/x.ts']), ['src/renderer/src/store/x.ts'], 'a walk over an ancestor dir');
  assert.deepEqual(M.namedPaths("read(path.join(ROOT, 'src/renderer', 'x.ts'));", ['src/renderer/src/store/x.ts']), [], 'an ancestor dir plus the basename is not the file');
}

function failureChecks(M) {
  const tap = [
    'TAP version 13',
    '    not ok 2 - feature',
    'not ok 1 - C:\\work\\tree-a\\test\\g.test.cjs',
    '  not ok 3 - later # TODO not yet',
    "# Error: Cannot find module 'C:\\work\\tree-a\\node_modules\\x'"
  ].join('\n');
  assert.deepEqual(M.parseFailures(tap, 'test/g.test.cjs'), { failed: ['feature'], firstError: "# Error: Cannot find module '<path>'" }, 'the file row and TODOs dropped; paths neutral');
  const row = (rc, failed, firstError = '') => ({ rc, fail: failed.length || 1, failed, firstError });
  assert.equal(M.sameOnBase(row(1, ['feature']), row(1, ['env'])), false, 'same counts, different test: the branch');
  assert.equal(M.sameOnBase(row(1, ['env']), row(1, ['env', 'other'])), true, 'every tip failure fails at base');
  assert.equal(M.sameOnBase(row(1, [], 'Error: A'), row(1, [], 'Error: B')), false, 'both crash at load for different reasons');
  assert.equal(M.sameOnBase(row(1, [], 'Error: A'), row(1, [], 'Error: A')), true, 'the same load crash');
  assert.equal(M.sameOnBase(row(1, []), row(1, [])), false, 'no names and no error line on either side: nothing to compare');
  assert.equal(M.sameOnBase(row(1, [], 'Error: A'), row(7, [], 'Error: A')), false, 'the same first line, a different rc');
  assert.equal(M.sameOnBase(row(1, ['x']), { rc: 0, fail: 0, failed: [], firstError: '' }), false, 'green at base');
}

test('dir rule: a test over src/main relates to a brand-new module there (walk, name list, template); not a wider or other dir', () => dirChecks(REAL));
test('same on base: by failing test NAMES (or the first error), never by counts', () => failureChecks(REAL));
test('parseCounts reads node --test totals; nothing printed is null', () => {
  assert.deepEqual(REAL.parseCounts('# tests 3\n# pass 2\n# fail 1\n'), { pass: 2, fail: 1 });
  assert.equal(REAL.parseCounts('SyntaxError'), null);
});

// ── the real fixture: a git repo, base and tip commits ─────────────────────────────────────────
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', windowsHide: true });
const PASS = "const test = require('node:test'); test('ok', () => {});\n";
const FAIL = "const test = require('node:test'); test('red', () => { throw new Error('red'); });\n";
const READS_V1 = "const test = require('node:test'); const fs = require('fs');\n" +
  "test('v1', () => { if (!fs.readFileSync(require('path').join(__dirname, '..', 'src', 'a.ts'), 'utf8').includes('v1')) throw new Error('not v1'); });\n";
// Andy's probe: the same count fails at base and tip, but a different test.
const SWAP = (red) => "const test = require('node:test');\n" +
  `for (const n of ['env', 'feature']) test(n, () => { if (n === '${red}') throw new Error(n); });\n`;
const NO_HIVE = "const test = require('node:test'); test('env', () => { if (process.env.HIVE_ROOT || process.env.AGENT_ID) throw new Error('hive env leaked'); });\n";

let fixture = null;
function repo() {
  if (fixture) return fixture;
  const dir = tempDir('related-tests-');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'test', 'tools'), { recursive: true });
  const write = (f, s) => fs.writeFileSync(path.join(dir, f), s);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'user.name', 'fixture');
  write('src/a.ts', 'export const v = "v1";\n');
  write('test/a.test.cjs', `// pins src/a.ts\n${PASS}`);
  write('test/b.test.cjs', `// pins src/a.ts\n${FAIL}`);
  write('test/c.test.cjs', READS_V1);
  write('test/d.test.cjs', PASS);
  write('test/e.test.cjs', `// src/a.ts\nconst { runScenario } = ${HARNESS};\n`);
  write('test/f.test.cjs', `// src/a.ts\n${NO_HIVE}`);
  write('test/tools/x-mutants.cjs', "// mutates 'src/a.ts'\n");
  write('test/tools/probe.cjs', "// reads 'src/a.ts'\n");
  write('test/g.test.cjs', SWAP('env'));
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  write('src/a.ts', 'export const v = "v2";\n');
  write('test/n.test.cjs', `// src/a.ts\n${FAIL}`);
  write('test/g.test.cjs', SWAP('feature'));
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'tip');
  const tip = git(dir, 'rev-parse', 'HEAD').trim();
  fixture = { dir, base, tip };
  return fixture;
}

function setChecks(M) {
  const { dir } = repo();
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };
  const set = M.relatedSet({ changed: ['src/a.ts', 'test/g.test.cjs', 'test/n.test.cjs'], files: M.candidateFiles(dir), read, pkg: null });
  assert.deepEqual(set.lanes.light.sort(), ['test/a.test.cjs', 'test/b.test.cjs', 'test/c.test.cjs', 'test/f.test.cjs', 'test/g.test.cjs', 'test/n.test.cjs']);
  assert.deepEqual(set.lanes.electron, ['test/e.test.cjs'], 'the harness file is ELECTRON, never run');
  assert.deepEqual(set.lanes.census, ['test/tools/x-mutants.cjs']);
  assert.deepEqual(set.lanes.tools, ['test/tools/probe.cjs'], 'a non-census runner is listed as a tool');
  return set;
}

function runChecks(M) {
  const { dir, base, tip } = repo();
  const set = setChecks(M);
  const saved = { HIVE_ROOT: process.env.HIVE_ROOT, AGENT_ID: process.env.AGENT_ID };
  process.env.HIVE_ROOT = path.join(dir, 'not-a-hive'); process.env.AGENT_ID = 'fixture-agent';
  let r;
  try { r = M.runLight({ repo: dir, base, light: set.lanes.light.sort() }); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  const by = Object.fromEntries(r.rows.map((x) => [x.file, x]));
  assert.equal(by['test/a.test.cjs'].red, false);
  assert.equal(by['test/f.test.cjs'].red, false, 'HIVE_ROOT and AGENT_ID are stripped for the child');
  assert.equal(by['test/b.test.cjs'].base, 'same on base', 'red at base too: the environment');
  assert.equal(by['test/c.test.cjs'].base, 'BRANCH RED', 'green at base: the branch');
  assert.equal(by['test/n.test.cjs'].base, 'new');
  assert.match(by['test/g.test.cjs'].base, /^base differs/, 'same count, different failing test: the branch');
  assert.equal(r.line, 'light run: 2 pass, 4 red (1 same on base, 3 branch)');
  assert.equal(r.rc, 1);
  assert.equal(git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'the base worktree is removed');
  assert.equal(M.summary(set, base, tip), `related: 6 light, 0 heavy, 1 electron, 1 census, 1 tools for 3 changed files (${base.slice(0, 8)}..${tip.slice(0, 8)})`);
}

test('fixture: the related set and its lanes on a real repo', () => { setChecks(REAL); });
test('--run: reds are re-run at base (same on base, BRANCH RED, new); the hive env is stripped; the base worktree is removed', () => { runChecks(REAL); });

test('--run: the base re-run keeps the caller\'s NODE_PATH after the tip\'s node_modules', () => {
  const seen = [];
  const { dir, base } = repo();
  const saved = process.env.NODE_PATH;
  process.env.NODE_PATH = path.join(dir, 'callers-modules');
  try { REAL.runLight({ repo: dir, base, light: ['test/c.test.cjs'], run: (cwd, f, env = {}) => { seen.push(env.NODE_PATH); return { rc: 1, pass: 0, fail: 1 }; } }); }
  finally { if (saved === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = saved; }
  assert.deepEqual(seen, [undefined, [path.join(dir, 'node_modules'), path.join(dir, 'callers-modules')].join(path.delimiter)]);
});

test('CLI: --json prints the set and the summary line; --run exits 1 on a branch red', () => {
  const { dir, base, tip } = repo();
  const out = execFileSync(process.execPath, [SRC, '--base', base, '--tip', tip, '--repo', dir, '--json'], { encoding: 'utf8', windowsHide: true });
  const j = JSON.parse(out);
  assert.match(j.summary, /^related: 6 light, 0 heavy, 1 electron, 1 census, 1 tools for 3 changed files/);
  assert.deepEqual(j.changed.sort(), ['src/a.ts', 'test/g.test.cjs', 'test/n.test.cjs']);
  let rc = 0;
  try { execFileSync(process.execPath, [SRC, '--base', base, '--tip', tip, '--repo', dir, '--run'], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }); }
  catch (e) { rc = e.status; assert.match(String(e.stdout), /light run: 2 pass, 4 red \(1 same on base, 3 branch\)/); }
  assert.equal(rc, 1);
});

function ancestorChecks(M) {
  const { dir, base, tip } = repo();
  assert.throws(() => M.main(['--base', tip, '--tip', base, '--repo', dir]), /is not an ancestor of --tip/, 'a base past the tip is refused');
}
test('--base must be an ancestor of --tip (a moved INT head would count its own changes)', () => ancestorChecks(REAL));

// RELATED-TEST-INVENTORY-198: 60dba590 added 2 test files and RELATED never ran the glob pin (493).
let invFixture = null;
function invRepo() {
  if (invFixture) return invFixture;
  const dir = tempDir('related-inventory-');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'test', 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test', 'fixtures'));
  const write = (f, s) => fs.writeFileSync(path.join(dir, f), s);
  const commit = (m) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', m); return git(dir, 'rev-parse', 'HEAD').trim(); };
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'user.name', 'fixture');
  write('src/a.ts', 'export const v = "v1";\n');
  write('test/test-runner-glob.test.cjs', PASS);
  write('test/test-runner-perf-lane.test.cjs', PASS);
  write('test/d.test.cjs', PASS);
  const base = commit('base');
  const at = (name, change) => { git(dir, 'checkout', '-q', '--detach', base); change(); return commit(name); };
  invFixture = {
    dir, base,
    add: at('add', () => write('test/new.test.cjs', PASS)),
    del: at('del', () => fs.rmSync(path.join(dir, 'test', 'd.test.cjs'))),
    ren: at('ren', () => git(dir, 'mv', 'test/d.test.cjs', 'test/e.test.cjs')),
    src: at('src', () => write('src/a.ts', 'export const v = "v2";\n')),
    fixture: at('fixture', () => write('test/fixtures/y.test.cjs', PASS))
  };
  return invFixture;
}

function cliSet(M, dir, base, tip) {
  const lines = [];
  const log = console.log;
  console.log = (s) => lines.push(s);
  try { M.main(['--base', base, '--tip', tip, '--repo', dir, '--json']); } finally { console.log = log; }
  return JSON.parse(lines.join('\n'));
}

const INV = ['test/test-runner-glob.test.cjs', 'test/test-runner-perf-lane.test.cjs'];
function inventoryChecks(M) {
  const r = invRepo();
  for (const kind of ['add', 'del', 'ren']) {
    const j = cliSet(M, r.dir, r.base, r[kind]);
    for (const f of INV) {
      assert.ok(j.lanes.light.includes(f), `A TEST FILE ${kind.toUpperCase()} SELECTS ${f}`);
      assert.deepEqual(j.why[f], ['(test inventory changed)'], `${kind}: ${f} is there for the inventory`);
    }
  }
  for (const kind of ['src', 'fixture']) {
    const j = cliSet(M, r.dir, r.base, r[kind]);
    for (const f of INV) assert.ok(!j.lanes.light.includes(f), `${kind}: no collected test file added or removed, so no ${f}`);
  }
  assert.equal(M.collectedPath('test/heavy-lock/x.test.cjs', ['heavy-lock']), true, 'a feature dir file is collected');
  assert.equal(M.collectedPath('test/fixtures/x.test.cjs', ['heavy-lock']), false, 'a nested non-feature dir is not');
  assert.equal(M.collectedPath('test/tools/x-mutants.cjs', []), false, 'a census runner is not a suite file');
  assert.deepEqual(M.inventoryPaths('M\ttest/a.test.cjs\nA\tsrc/b.ts\nR100\ttest/d.test.cjs\ttest/heavy-lock/d.test.cjs\n', ['heavy-lock']),
    ['test/d.test.cjs', 'test/heavy-lock/d.test.cjs'], 'a modify is no inventory change; a rename counts on both sides');
}
test('inventory: a branch that adds, deletes or renames a collected test file selects test-runner-glob and test-runner-perf-lane; a src or fixture-only change does not', () => inventoryChecks(REAL));

// ── mutant census ──────────────────────────────────────────────────────────────────────────────
function compile(text) {
  const m = new Module(SRC, module);
  m.filename = SRC; m.paths = Module._nodeModulePaths(path.dirname(SRC));
  m._compile(text, SRC);
  return m.exports;
}

const MUTANTS = [
  ['R1 basename match', "const before = `(^|[^\\\\w./-]|\\\\.\\\\./|\\\\./)`;", "const before = `()`;", matcherChecks],
  ['R2 package.json by its bare name', "if (diff.keys.includes('*')) return true;", 'return true;', packageChecks],
  ['R3 electron in the light lane', "if (/require\\(\\s*['\"`][^'\"`]*electron-" + "harness/.test(text)) return 'electron';", '', setChecks],
  ['R4 reds never re-run at base', 'if (row.red) {', 'if (false) {', runChecks],
  ['R5 the hive env reaches the child', 'for (const k of STRIP_ENV) delete env[k];', '', runChecks],
  ['R7 same on base by counts', 'return tf.length > 0 && tf.every((n) => bf.includes(n));', 'return tip.fail === base.fail;', failureChecks],
  ['R8 no dir rule', ' || namesViaDir(text, p)', '', dirChecks],
  ['R9 a non-ancestor base accepted', 'if (anc.status !== 0) throw', 'if (false) throw', ancestorChecks],
  ['R10 every test/tools runner is a census', "? 'census' : 'tools'", "? 'census' : 'census'", laneChecks],
  ['R11 nameless reds by the first line alone', "return tip.rc === base.rc && !!tip.firstError && tip.firstError === base.firstError;", "return (tip.firstError || '') === (base.firstError || '');", failureChecks],
  ['R12 no inventory rule', "    if (inventory.length && INVENTORY_TESTS.includes(f)) hits.push('(test inventory changed)');", '', inventoryChecks],
  ['R13 a deleted test file is not an inventory change', 'if (!status || !/^[ADR]/.test(status)) continue;', 'if (!status || !/^[AR]/.test(status)) continue;', inventoryChecks],
  ['R6 the base worktree is left behind', "try { git(repo, ['worktree', 'remove', '--force', baseTree]); } catch { fs.rmSync(baseTree, { recursive: true, force: true }); }", '', runChecks]
];

test('MUTANT CENSUS RELATED-TESTS: R1-R13 each apply once and die at their named check', () => {
  const text = fs.readFileSync(SRC, 'utf8');
  for (const [name, from, to, check] of MUTANTS) {
    assert.equal(text.split(from).length, 2, `${name}: its anchor is in the script exactly once`);
    const M = compile(text.replace(from, to));
    assert.throws(() => check(M), `${name} must die`);
    if (name.startsWith('R6')) {
      for (const l of git(repo().dir, 'worktree', 'list', '--porcelain').split('\n')) {
        const wt = l.startsWith('worktree ') ? l.slice(9) : null;
        if (wt && path.resolve(wt) !== path.resolve(repo().dir)) git(repo().dir, 'worktree', 'remove', '--force', wt);
      }
    }
  }
});
