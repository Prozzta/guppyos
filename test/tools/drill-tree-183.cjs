'use strict';
/**
 * DRILL-TREE-SELF-BUILD-108: the 1.1.83 tree the downgrade drills run (claims-drill-g36, -g63,
 * claims-gates/g32) is a FIXTURE THIS FILE BUILDS, not a folder somebody made by hand.
 *
 * This is the library. The command is test/tools/drill-tree-183-build.cjs; it carries the heavy-lock
 * tag, as does every test file that may build (a cold build is minutes of npm and a native compile):
 *   node test/tools/drill-tree-183-build.cjs            build if absent or broken, verify, print the path
 *   node test/tools/drill-tree-183-build.cjs --check    verify only (exit 1 with the reason; builds nothing)
 *   node test/tools/drill-tree-183-build.cjs --path     print where the tree lives
 *
 * WHERE. The first of:
 *   CLAIMS_DRILL_TREE_183   a tree of the caller's own: verified, NEVER built or repaired here;
 *   GUPPY_FIXTURE_ROOT      <that>/guppy-v1.1.83;
 *   HIVE_ROOT               <hive>/cache/fixtures/guppy-v1.1.83 (outside _work: the scratch reaper
 *                           manages direct children of _work only);
 *   LOCALAPPDATA            <local app data>/guppy-test-fixtures/guppy-v1.1.83 (a shell with no hive).
 *
 * WHAT. The pinned commit of tag v1.1.83, exported with git; `npm ci --ignore-scripts` from its own
 * lockfile; Electron's binary; better-sqlite3 built for that Electron; the memory model, by the
 * tree's own fetch script (digest-checked against its manifest), from a local copy when one matches
 * and from the manifest's source otherwise. It is built in a sibling folder, verified there, stamped
 * last and renamed into place, so a half-built tree is never at the fixture path. A lock folder keeps
 * two test files from building it at once.
 *
 * A tree that cannot be built or does not verify THROWS with the reason. Nothing here skips.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const TAG = 'v1.1.83';
const COMMIT = '6355a8d5d3c2372ddbd31073823f30df6ee3dd81';
const VERSION = '1.1.83';
const NAME = `guppy-${TAG}`;
const STAMP = '.guppy-fixture.json';
/** Bump when the recipe changes: a tree stamped by another recipe is rebuilt. */
const RECIPE = 1;
const LOCK_WAIT_MS = 25 * 60_000;
const STEP_MS = 20 * 60_000;

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Where the tree lives, and whether this file owns it (builds and repairs it). */
function treeLocation(env = process.env) {
  if (env.CLAIMS_DRILL_TREE_183) return { tree: path.resolve(env.CLAIMS_DRILL_TREE_183), managed: false, from: 'CLAIMS_DRILL_TREE_183' };
  if (env.GUPPY_FIXTURE_ROOT) return { tree: path.resolve(env.GUPPY_FIXTURE_ROOT, NAME), managed: true, from: 'GUPPY_FIXTURE_ROOT' };
  if (env.HIVE_ROOT) return { tree: path.resolve(env.HIVE_ROOT, 'cache', 'fixtures', NAME), managed: true, from: 'HIVE_ROOT' };
  // The suite's temp jail moves LOCALAPPDATA into a per-file folder and keeps the real one here.
  const local = env.GUPPY_SHARED_LOCALAPPDATA || env.LOCALAPPDATA;
  if (local) return { tree: path.resolve(local, 'guppy-test-fixtures', NAME), managed: true, from: 'LOCALAPPDATA' };
  throw new Error(`the ${VERSION} drill tree has no location: set GUPPY_FIXTURE_ROOT (or HIVE_ROOT, or CLAIMS_DRILL_TREE_183 for a tree of your own)`);
}

/** The first thing wrong with the tree, or null. `stamped`: the tree must carry this recipe's stamp. */
function treeFault(tree, { stamped = true } = {}) {
  const { treeProblem } = require('../claims-drill/runner.cjs');
  if (!fs.existsSync(tree)) return 'the tree is absent';
  if (stamped) {
    let stamp;
    try { stamp = JSON.parse(fs.readFileSync(path.join(tree, STAMP), 'utf8')); } catch { return `no ${STAMP} (the build did not finish, or this file did not build the tree)`; }
    if (stamp.commit !== COMMIT || stamp.recipe !== RECIPE) return `${STAMP} is for commit ${stamp.commit} recipe ${stamp.recipe}, not ${COMMIT} recipe ${RECIPE}`;
  }
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(tree, 'package.json'), 'utf8')); } catch { return 'missing or unreadable package.json'; }
  if (pkg.version !== VERSION) return `package.json is version ${pkg.version}, not ${VERSION}`;
  const problem = treeProblem(tree, true);
  if (problem) return problem;
  const manifest = JSON.parse(fs.readFileSync(path.join(tree, 'resources', 'models', 'native-memory-manifest.json'), 'utf8'));
  for (const [rel, want] of Object.entries(manifest.model.files)) {
    const f = path.join(tree, 'resources', 'models', manifest.model.dir, ...rel.split('/'));
    if (!fs.existsSync(f)) return `missing model file ${rel}`;
    const got = sha256(f);
    if (got !== want) return `model file ${rel} is ${got}, the manifest pins ${want}`;
  }
  return nativeFault(tree);
}

/** The tree's own Electron, as Node, opens a database and loads the vector extension; or why not. */
function nativeFault(tree) {
  const electron = require(path.join(tree, 'node_modules', 'electron'));
  const probe = "const D=require('better-sqlite3');const v=require('sqlite-vec');const d=new D(':memory:');v.load(d);const r=d.prepare('select vec_version() as v').get();d.close();process.stdout.write('NATIVE-OK '+r.v);";
  const r = spawnSync(electron, ['-e', probe], { cwd: tree, env: { ...baseEnv(process.env), ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (r.status === 0 && /NATIVE-OK /.test(r.stdout || '')) return null;
  return `better-sqlite3 or sqlite-vec does not load under the tree's Electron (exit ${r.status}${r.error ? `, ${r.error.message}` : ''}): ${String(r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(0, 4).join(' | ').slice(0, 600)}`;
}

/**
 * The environment the build's children get. NoDefaultCurrentDirectoryInExePath (set in agent shells)
 * breaks cmd-run build steps; the suite's per-file LOCALAPPDATA jail would make npm and Electron
 * download everything again into a folder the file then has to delete, so the real one is used.
 */
function baseEnv(env, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^NoDefaultCurrentDirectoryInExePath$/i.test(k) && !/^npm_/i.test(k) && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'NODE_OPTIONS') out[k] = v;
  if (env.GUPPY_SHARED_LOCALAPPDATA) out.LOCALAPPDATA = env.GUPPY_SHARED_LOCALAPPDATA;
  return { ...out, ...extra };
}

function step(what, cmd, args, opts) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: STEP_MS, maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.status === 0) return r;
  const tail = String(`${r.stdout || ''}\n${r.stderr || ''}`).trim().split(/\r?\n/).slice(-25).join('\n');
  throw new Error(`${what} failed (exit ${r.status}${r.signal ? `, ${r.signal}` : ''}${r.error ? `, ${r.error.message}` : ''}):\n${tail}`);
}

/** The pinned commit must be in this repository, and the tag (when present) must still name it. */
function assertSource() {
  const has = spawnSync('git', ['-C', ROOT, 'cat-file', '-e', `${COMMIT}^{commit}`], { windowsHide: true });
  if (has.status !== 0) throw new Error(`commit ${COMMIT} (tag ${TAG}) is not in this repository: run \`git fetch origin tag ${TAG}\` and try again`);
  const tag = spawnSync('git', ['-C', ROOT, 'rev-parse', '-q', '--verify', `refs/tags/${TAG}^{commit}`], { encoding: 'utf8', windowsHide: true });
  const at = String(tag.stdout || '').trim();
  if (tag.status === 0 && at !== COMMIT) throw new Error(`tag ${TAG} names ${at}, this fixture pins ${COMMIT}: the tag moved, or the pin is wrong`);
}

/** A local copy of the model whose files all match the manifest, or null (the tree then downloads). */
function localModel(manifest, env) {
  const local = env.GUPPY_SHARED_LOCALAPPDATA || env.LOCALAPPDATA;
  const dirs = [
    env.MUNDER_MODEL_CACHE,
    path.join(ROOT, 'resources', 'models', manifest.model.dir),
    local && path.join(local, 'Programs', 'Guppy', 'resources', 'models', manifest.model.dir),
  ].filter(Boolean);
  for (const d of dirs) {
    try {
      if (Object.entries(manifest.model.files).every(([rel, want]) => sha256(path.join(d, ...rel.split('/'))) === want)) return d;
    } catch { /* not a complete copy */ }
  }
  return null;
}

function rmTree(p) { fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }

function build(tree, env, log) {
  assertSource();
  const parent = path.dirname(tree);
  const work = path.join(parent, `.building-${NAME}-${process.pid}`);
  const tmp = path.join(parent, `.tmp-${NAME}-${process.pid}`);
  rmTree(work); rmTree(tmp);
  fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(tmp, { recursive: true });
  const cenv = baseEnv(env, { TEMP: tmp, TMP: tmp, TMPDIR: tmp });
  const node = process.execPath;
  const t0 = Date.now();
  try {
    log(`exporting ${TAG} (${COMMIT.slice(0, 8)}) to ${work}`);
    const genv = { ...cenv, GIT_INDEX_FILE: path.join(tmp, 'index') };
    step('git read-tree', 'git', ['-C', ROOT, 'read-tree', COMMIT], { env: genv });
    step('git checkout-index', 'git', ['-C', ROOT, `--work-tree=${work}`, 'checkout-index', '-a', `--prefix=${work.replace(/\\/g, '/')}/`], { env: genv });
    if (!fs.existsSync(path.join(work, 'package-lock.json'))) throw new Error('the export has no package-lock.json');

    log('npm ci --ignore-scripts (the tree\'s own lockfile)');
    const npmCli = process.env.npm_execpath && /npm-cli\.js$/i.test(process.env.npm_execpath) ? process.env.npm_execpath : path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.existsSync(npmCli)) throw new Error(`npm is not next to node (${npmCli})`);
    step('npm ci', node, [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: work, env: cenv });

    log('Electron binary');
    // Not the package's own install.js: its extract-zip 2.0.1 on a current Node ends with exit 0 and
    // nothing extracted (measured on Node 26: no error, no files). The tree's own downloader fetches the
    // zip against the package's checksums; the system's archive tool unpacks it; path.txt is what
    // install.js would have written.
    const edir = path.join(work, 'node_modules', 'electron');
    const fetchZip = "const {downloadArtifact}=require('@electron/get');const v=require('./node_modules/electron/package.json').version;"
      + "downloadArtifact({version:v,artifactName:'electron',checksums:require('./node_modules/electron/checksums.json')})"
      + ".then((z)=>process.stdout.write('ZIP='+z),(e)=>{console.error(e&&e.stack||e);process.exitCode=1;});";
    const zip = (/ZIP=(.+)/.exec(step('electron download', node, ['-e', fetchZip], { cwd: work, env: cenv }).stdout) || [])[1];
    if (!zip || !fs.existsSync(zip.trim())) throw new Error('the Electron download gave no zip');
    const dist = path.join(edir, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    if (process.platform === 'win32') step('electron unpack', path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip.trim(), '-C', dist], { env: cenv });
    else step('electron unpack', 'unzip', ['-q', '-o', zip.trim(), '-d', dist], { env: cenv });
    const exeRel = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
    if (!fs.existsSync(path.join(dist, exeRel))) throw new Error(`the Electron zip unpacked without ${exeRel}`);
    fs.writeFileSync(path.join(edir, 'path.txt'), exeRel);

    log('better-sqlite3 for that Electron');
    const rebuild = path.join(work, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
    // On the tree's own Electron as Node (Node 20), not the host's: the 1.1.83 rebuild command loads
    // yargs 17 through an extensionless file in a "type": "module" package, which a current Node reads
    // as an ES module ("require is not defined in ES module scope"). The old toolchain runs on its runtime.
    const electronExe = require(path.join(work, 'node_modules', 'electron'));
    step('electron-rebuild better-sqlite3', electronExe, [rebuild, '-f', '-o', 'better-sqlite3'], { cwd: work, env: { ...cenv, ELECTRON_RUN_AS_NODE: '1' } });

    const manifest = JSON.parse(fs.readFileSync(path.join(work, 'resources', 'models', 'native-memory-manifest.json'), 'utf8'));
    const from = localModel(manifest, env);
    log(from ? `model from ${from}` : `model from ${manifest.model.source} (no matching local copy)`);
    step('fetch-memory-model', node, [path.join(work, 'scripts', 'fetch-memory-model.cjs'), ...(from ? ['--from', from] : [])], { cwd: work, env: { ...cenv, MUNDER_MODEL_CACHE: '' } });

    const fault = treeFault(work, { stamped: false });
    if (fault) throw new Error(`the built tree does not verify: ${fault}`);
    fs.writeFileSync(path.join(work, STAMP), JSON.stringify({ v: 1, recipe: RECIPE, tag: TAG, commit: COMMIT, builtAt: new Date().toISOString(), node: process.version }, null, 2));
    rmTree(tree);
    let moved = null;
    for (let i = 0; i < 20 && moved !== true; i++) {
      try { fs.renameSync(work, tree); moved = true; } catch (e) { moved = e; sleep(500); } // a scanner can hold a new folder for a moment
    }
    if (moved !== true) throw new Error(`could not move the built tree into place: ${moved.message}`);
    log(`built in ${Math.round((Date.now() - t0) / 1000)} s: ${tree}`);
  } finally {
    rmTree(tmp);
    try { rmTree(work); } catch { /* reported by the next build, which clears it first */ }
  }
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/** One builder at a time. A lock whose owner has gone is taken over. */
function withLock(tree, log, fn) {
  const lock = path.join(path.dirname(tree), `.lock-${NAME}`);
  const owner = path.join(lock, 'owner.json');
  fs.mkdirSync(path.dirname(tree), { recursive: true });
  const t0 = Date.now();
  let said = false;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    let pid = null;
    try { pid = JSON.parse(fs.readFileSync(owner, 'utf8')).pid; } catch { /* just made, or left half-made */ }
    let age = 0;
    try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
    if ((pid && !alive(pid)) || (!pid && age > 30_000)) { rmTree(lock); continue; }
    if (Date.now() - t0 > LOCK_WAIT_MS) throw new Error(`another process (pid ${pid}) has been building the ${VERSION} tree for over ${LOCK_WAIT_MS / 60_000} minutes (${lock})`);
    if (!said) { log(`waiting for pid ${pid}, which is building the tree`); said = true; }
    sleep(1000);
  }
  try {
    fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return fn();
  } finally { rmTree(lock); }
}

/**
 * The verified tree's path. Builds it when it is absent or does not verify (managed locations only).
 * `env`: where to look and what the build's children inherit (pass the unjailed one from a test that
 * jails HOME). Throws with the reason; never returns an unverified path.
 */
const settled = new Map();
/** ensureTree, once per process and tree: the same path, or the same failure, every time it is asked. */
function drillTree(opts = {}) {
  const key = treeLocation(opts.env || process.env).tree;
  if (!settled.has(key)) { try { settled.set(key, { tree: ensureTree(opts) }); } catch (error) { settled.set(key, { error }); } }
  const s = settled.get(key);
  if (s.error) throw s.error;
  return s.tree;
}

function ensureTree({ env = process.env, log = (m) => process.stderr.write(`[drill-tree-183] ${m}\n`), build: mayBuild = true } = {}) {
  const { tree, managed, from } = treeLocation(env);
  if (!managed) {
    const fault = treeFault(tree, { stamped: false });
    if (fault) throw new Error(`${from}=${tree} is not a usable ${VERSION} tree: ${fault}. It is the caller's own tree and is not built here; unset ${from} to use the self-building fixture.`);
    return tree;
  }
  let fault = treeFault(tree);
  if (!fault) return tree;
  if (!mayBuild) throw new Error(`the ${VERSION} drill tree at ${tree} is not ready: ${fault}. Build it: node test/tools/drill-tree-183-build.cjs`);
  return withLock(tree, log, () => {
    fault = treeFault(tree); // another process may have just built it
    if (!fault) return tree;
    log(`${tree}: ${fault}; building`);
    try { build(tree, env, log); } catch (e) { throw new Error(`the ${VERSION} drill tree could not be built at ${tree}: ${e.message}`); }
    fault = treeFault(tree);
    if (fault) throw new Error(`the ${VERSION} drill tree was built at ${tree} and does not verify: ${fault}`);
    // The reaper never manages cache/fixtures; the registry entry (SCRATCH-DISK-REAP-108) records who owns it.
    if (from === 'HIVE_ROOT') log(`register it once: scratch register-fixture "${tree}" --card DRILL-TREE-SELF-BUILD-108`);
    return tree;
  });
}

module.exports = { drillTree, ensureTree, treeLocation, treeFault, baseEnv, TAG, COMMIT, VERSION, NAME, STAMP, RECIPE };
