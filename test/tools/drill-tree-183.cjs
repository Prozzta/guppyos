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
 *   node test/tools/drill-tree-183-build.cjs --rebuild  build a new tree and replace the one there (by hand only)
 *
 * WHEN IT BUILDS. Only on a structural fault: the tree is absent, has no stamp or another recipe's
 * stamp, is the wrong version, lacks a required file, or a model file does not match its digest. A
 * stamped tree whose native modules fail to load is NOT rebuilt: a loaded machine fails that probe
 * now and then (a slow spawn, a scanner holding a .node file), and a rebuild would delete the tree
 * from under another test file that is running from it. The probe is tried once more; if it still
 * fails this throws, deletes nothing, and names the by-hand command (--rebuild).
 *
 * WHERE. Never under a _work folder (the scratch reaper manages those): such a location is refused.
 * The first of:
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
 * two test files from building it at once; a lock older than LOCK_STALE_MS is taken over whatever
 * its owner's pid says (a dead owner's pid can belong to a live process). If the old tree cannot be
 * moved aside because something has it open, the finished build stays in its .building-* folder,
 * the error names it, and the next run adopts it instead of building again.
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
const STEP_MS = 20 * 60_000;
/** Longer than the longest build seen (about 10 minutes cold) by a wide margin. A lock older than this is taken over. */
const LOCK_STALE_MS = 40 * 60_000;
/** Longer than LOCK_STALE_MS, so a waiter takes a stale lock over before it gives up. */
const LOCK_WAIT_MS = 45 * 60_000;
/** What Windows answers when a folder or a file in it is open elsewhere. */
const HELD = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Where the tree lives, and whether this file owns it (builds and repairs it). */
function treeLocation(env = process.env) {
  if (env.CLAIMS_DRILL_TREE_183) return { tree: path.resolve(env.CLAIMS_DRILL_TREE_183), managed: false, from: 'CLAIMS_DRILL_TREE_183' };
  if (env.GUPPY_FIXTURE_ROOT) return managedAt(path.resolve(env.GUPPY_FIXTURE_ROOT, NAME), 'GUPPY_FIXTURE_ROOT');
  if (env.HIVE_ROOT) return managedAt(path.resolve(env.HIVE_ROOT, 'cache', 'fixtures', NAME), 'HIVE_ROOT');
  // The suite's temp jail moves LOCALAPPDATA into a per-file folder and keeps the real one here.
  const local = env.GUPPY_SHARED_LOCALAPPDATA || env.LOCALAPPDATA;
  if (local) return managedAt(path.resolve(local, 'guppy-test-fixtures', NAME), 'LOCALAPPDATA');
  throw new Error(`the ${VERSION} drill tree has no location: set GUPPY_FIXTURE_ROOT (or HIVE_ROOT, or CLAIMS_DRILL_TREE_183 for a tree of your own)`);
}

/** The path with its nearest existing folder resolved through links, so a junction into _work is seen. */
function realish(p) {
  const rest = [];
  let at = path.resolve(p);
  for (;;) {
    try { return path.join(fs.realpathSync.native(at), ...rest); } catch { /* not there yet */ }
    const up = path.dirname(at);
    if (up === at) return path.resolve(p);
    rest.unshift(path.basename(at));
    at = up;
  }
}

/** A tree this file builds. Refused under any _work folder: the scratch reaper manages those and would take it. */
function managedAt(tree, from) {
  const under = (p) => p.split(/[\\/]+/).some((seg) => seg.toLowerCase() === '_work');
  if (under(tree) || under(realish(tree))) {
    throw new Error(`${from} puts the ${VERSION} drill tree at ${tree}, which is under a _work folder. The scratch reaper manages _work and would delete the fixture: point ${from === 'LOCALAPPDATA' ? 'GUPPY_FIXTURE_ROOT' : from} at a folder outside _work.`);
  }
  return { tree, managed: true, from };
}

/** The first thing wrong with the tree, or null: structure first, then the natives (`nativeProbe`). */
function treeFault(tree, { stamped = true, nativeProbe = nativeFault } = {}) {
  return structuralFault(tree, { stamped }) || nativeProbe(tree);
}

/**
 * The first thing wrong with what the tree HOLDS, or null; nothing is run. `stamped`: the tree must
 * carry this recipe's stamp. These are the faults a build repairs.
 */
function structuralFault(tree, { stamped = true } = {}) {
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
  return null;
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

/**
 * Remove a folder WITHOUT following links. Not fs.rmSync: under Electron its recursive delete goes
 * through a junction and empties the folder it points at, and the fixture folder is one agents can write
 * to. Every entry is lstat'ed just before it is touched; a link (junction, symlink) is unlinked, never
 * entered.
 *
 * A folder is first moved, in one rename, to a tomb name only this call knows (`.rm-<NAME>-<pid>-<n>`
 * beside it), and the tomb is what gets walked: no other run renames a name it does not know. Every
 * path under a folder resolves through that folder again, so a folder swapped for a junction partway
 * through would send every remaining name into the junction's target (measured by Jim: victim files
 * lost in 25 of 150 runs). So before EACH child the folder is lstat'ed again (bigint file id: a
 * double rounds a 64-bit NTFS id) and the removal stops (ESWAPPED) on a link or another folder; a
 * child folder is entered only if it is still the one that was just looked at. What stays open is one
 * entry: a swap after that look and before the single unlink or rmdir that follows it.
 * A removal that fails moves the tomb back to its name, so the leftover keeps the name callers report.
 */
const RM_RETRY = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);
function dropEntry(p, isLink) {
  try { fs.unlinkSync(p); return; } catch (e) {
    if (e.code === 'ENOENT') return;
    if (!['EPERM', 'EACCES', 'EISDIR'].includes(e.code)) throw e;
  }
  if (isLink) { try { fs.rmdirSync(p); } catch (e) { if (e.code !== 'ENOENT') throw e; } return; } // rmdir of a junction removes the link only
  fs.chmodSync(p, 0o666); // a read-only file
  try { fs.unlinkSync(p); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
const entryAt = (p) => { try { return fs.lstatSync(p, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const isFolder = (st) => st.isDirectory() && !st.isSymbolicLink();
const sameEntry = (a, b) => a.ino === b.ino && a.dev === b.dev;
const swapped = (p) => Object.assign(new Error(`${p} was swapped for another entry while it was being removed; the removal stopped there`), { code: 'ESWAPPED' });
/** `was`: what the caller saw at p just before. `beforeChild(folder, name)`: a test seam, called before each child. */
function rmNoFollow(p, was, beforeChild) {
  const st = entryAt(p);
  if (!st) { if (was) throw swapped(p); return; }
  if (was && !sameEntry(st, was)) throw swapped(p);
  if (!isFolder(st)) { dropEntry(p, st.isSymbolicLink()); return; }
  const still = () => { const now = entryAt(p); if (!now || !isFolder(now) || !sameEntry(now, st)) throw swapped(p); };
  let names;
  try { names = fs.readdirSync(p); } catch (e) { throw e.code === 'ENOENT' ? swapped(p) : e; } // it was there a moment ago
  for (const n of names) {
    const c = path.join(p, n);
    const cst = entryAt(c);
    if (beforeChild) beforeChild(p, n);
    still(); // p is still the folder that was listed, so c is still under it
    if (!cst) continue;
    if (isFolder(cst)) rmNoFollow(c, cst, beforeChild); else dropEntry(c, cst.isSymbolicLink());
  }
  still();
  try { fs.rmdirSync(p); } catch (e) { throw e.code === 'ENOENT' ? swapped(p) : e; }
}
let rmSeq = 0;
function rmTree(p, { tries = 10, beforeChild = null } = {}) {
  const hadNoAsar = process.noAsar;
  process.noAsar = true; // on Electron an .asar file would otherwise be listed as a folder
  try {
    const retry = (fn) => {
      for (let i = 1; ; i++) {
        try { return fn(); } catch (e) { if (!RM_RETRY.has(e.code) || i >= tries) throw e; sleep(300); }
      }
    };
    const st = entryAt(p);
    if (!st) return;
    if (!isFolder(st)) { retry(() => dropEntry(p, st.isSymbolicLink())); return; }
    const tomb = path.join(path.dirname(p), `.rm-${NAME}-${process.pid}-${Date.now()}${++rmSeq}`);
    try { retry(() => fs.renameSync(p, tomb)); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    try {
      // Whatever was moved is checked again inside: a link is unlinked, and only the folder seen above is walked.
      retry(() => { if (entryAt(tomb)) rmNoFollow(tomb, st, beforeChild); });
    } catch (e) {
      try { if (!entryAt(p)) fs.renameSync(tomb, p); else e.message += ` (what is left of it is at ${tomb})`; } catch { e.message += ` (what is left of it is at ${tomb})`; }
      throw e;
    }
  } finally { process.noAsar = hadNoAsar; }
}

/**
 * Put the finished, stamped build at the fixture path. The old tree is moved aside in one rename, so
 * it is whole or gone, never half deleted. When it cannot be moved because something has it open, or
 * the build cannot be moved in, the build is KEPT where it is and the error names it (`keptBuild`).
 */
function replaceTree(work, tree, { rename = fs.renameSync, pause = sleep, log = () => {} } = {}) {
  const kept = (why) => Object.assign(new Error(`${why}. The finished build is kept at ${work}; the next run adopts it instead of building again.`), { keptBuild: work });
  let old = null;
  if (fs.existsSync(tree)) {
    old = path.join(path.dirname(tree), `.old-${NAME}-${process.pid}-${Date.now()}`);
    let err = null;
    for (let i = 0; i < 6; i++) {
      try { rename(tree, old); err = null; break; } catch (e) { err = e; if (!HELD.has(e.code)) break; pause(500); }
    }
    if (err && HELD.has(err.code)) throw kept(`the tree at ${tree} is in use and could not be replaced (${err.code}: another process has it open)`);
    if (err) throw err;
  }
  let moved = null;
  for (let i = 0; i < 20 && moved !== true; i++) {
    try { rename(work, tree); moved = true; } catch (e) { moved = e; pause(500); } // a scanner can hold a new folder for a moment
  }
  if (moved !== true) {
    if (old) { try { rename(old, tree); } catch { /* the kept build is the way back */ } }
    throw kept(`could not move the built tree into place at ${tree} (${moved.code || moved.message})`);
  }
  if (old) { try { rmTree(old); } catch (e) { log(`the replaced tree is left at ${old} (${e.code || e.message}); the next build clears it`); } }
}

/** What runs leave beside the tree: a build, its temp folder, a replaced tree, a removal's tomb, a lock moved aside. */
const LEFTOVERS = [`.building-${NAME}-`, `.tmp-${NAME}-`, `.old-${NAME}-`, `.rm-${NAME}-`, `.lock-${NAME}.dead-`];
const leftoverPid = (name) => Number((/-(\d+)(?:-\d+)?$/.exec(name) || [])[1]) || null;

/**
 * Under the lock: adopt a finished build an earlier run had to keep (replaceTree), and clear what dead
 * runs left beside the tree. Returns true when a kept build is now the tree. A leftover whose process
 * is alive is left alone unless it is a finished build: under the lock nobody else is building.
 */
function adoptOrClear(tree, { adopt, nativeProbe = nativeFault, log = () => {}, rename, tries } = {}) {
  const parent = path.dirname(tree);
  let names = [];
  try { names = fs.readdirSync(parent); } catch { return false; }
  let adopted = false;
  for (const name of names.sort()) {
    const p = path.join(parent, name);
    if (name.startsWith(`.building-${NAME}-`)) {
      if (adopt && !adopted && !treeFault(p, { nativeProbe })) {
        log(`adopting the finished build an earlier run kept: ${p}`);
        replaceTree(p, tree, { rename, log });
        adopted = true;
        continue;
      }
    } else if (!LEFTOVERS.slice(1).some((pre) => name.startsWith(pre))) continue;
    const pid = leftoverPid(name);
    if (pid && pid !== process.pid && alive(pid)) continue;
    try { rmTree(p, { tries }); } catch (e) { log(`could not clear ${p} (${e.code || e.message})`); }
  }
  return adopted;
}

/**
 * The build's npm and download steps run on this process's own executable with ELECTRON_RUN_AS_NODE
 * taken out of their environment (baseEnv). Under Electron as Node that executable is Electron, so each
 * step would open an Electron app instead of running a script (seen: a hung window process, no output).
 * The build is refused there. ensureTree asks this BEFORE it takes the lock, so on Electron as Node
 * nothing is written and nothing is deleted (no leftover cleared, no kept build moved in); build() asks
 * again for a caller that reaches it another way. Using a tree that is ready needs no build.
 */
function hostFault(versions = process.versions) {
  return versions.electron ? 'the 1.1.83 tree is built on node, not on Electron as Node. Build it first: node test/tools/drill-tree-183-build.cjs' : null;
}

function build(tree, env, log) {
  const host = hostFault();
  if (host) throw new Error(host);
  assertSource();
  const parent = path.dirname(tree);
  const work = path.join(parent, `.building-${NAME}-${process.pid}`);
  const tmp = path.join(parent, `.tmp-${NAME}-${process.pid}`);
  rmTree(work); rmTree(tmp);
  fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(tmp, { recursive: true });
  const cenv = baseEnv(env, { TEMP: tmp, TMP: tmp, TMPDIR: tmp });
  const node = process.execPath;
  const t0 = Date.now();
  let keep = false;
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
    try { replaceTree(work, tree, { log }); } catch (e) { keep = !!e.keptBuild; throw e; }
    log(`built in ${Math.round((Date.now() - t0) / 1000)} s: ${tree}`);
  } finally {
    rmTree(tmp);
    if (!keep) { try { rmTree(work); } catch { /* cleared under the lock by the next build */ } }
  }
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/**
 * One builder at a time. owner.json records who holds the lock and WHEN IT STARTED. The lock is taken
 * over when its owner's process has gone, and also once it is older than `staleMs` whatever the pid
 * says: a dead owner's pid can have been given to another live process, and no build takes that long.
 */
function withLock(tree, log, fn, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, now = Date.now, pause = sleep } = {}) {
  const lock = path.join(path.dirname(tree), `.lock-${NAME}`);
  const owner = path.join(lock, 'owner.json');
  const token = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  fs.mkdirSync(path.dirname(tree), { recursive: true });
  const t0 = now();
  let said = false;
  // Which lock a folder is: its owner record and the folder's own time. A rename keeps both.
  const lockId = (dir) => {
    let text = null, at = null;
    try { text = fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'); } catch { /* just made, or left half-made */ }
    try { at = fs.statSync(dir).mtimeMs; } catch { /* gone */ }
    return `${at}|${text}`;
  };
  // Remove the lock that was judged dead, and only that one. Two waiters can judge the same dead lock:
  // the first removes it and makes its own, and the second must not then remove the first one's. So the
  // lock is looked at again, moved aside in one rename (one waiter wins it), and checked once more where
  // it now is; a live lock that got moved is put back.
  const takeOver = (judged) => {
    if (lockId(lock) !== judged) return;
    const tomb = `${lock}.dead-${token}`;
    try { fs.renameSync(lock, tomb); } catch { return; }
    if (lockId(tomb) !== judged) {
      // Not removed: it may be a live run's lock. A later run that finds the tree ready clears it.
      try { fs.renameSync(tomb, lock); } catch (e) { log(`a lock that was not the stale one got moved aside and could not be put back (${e.code || e.message}); it is left at ${tomb}`); }
      return;
    }
    try { rmTree(tomb); } catch { /* an empty leftover name; it is not the lock */ }
  };
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const judged = lockId(lock);
    let o = null;
    try { o = JSON.parse(fs.readFileSync(owner, 'utf8')); } catch { /* just made, or left half-made */ }
    const pid = o && Number.isInteger(o.pid) ? o.pid : null;
    let age = 0;
    try { age = now() - fs.statSync(lock).mtimeMs; } catch { continue; }
    if (lockId(lock) !== judged) continue; // it changed while it was being read
    const held = o && Number.isFinite(o.startedMs) ? now() - o.startedMs : age;
    if (held > staleMs) {
      log(`the build lock of pid ${pid} is ${Math.round(held / 60_000)} minutes old, over the ${Math.round(staleMs / 60_000)} minute limit: taking it over`);
      takeOver(judged); continue;
    }
    if ((pid && !alive(pid)) || (!pid && age > 30_000)) { takeOver(judged); continue; }
    if (now() - t0 > waitMs) throw new Error(`another process (pid ${pid}) has been building the ${VERSION} tree for over ${Math.round(waitMs / 60_000)} minutes (${lock})`);
    if (!said) { log(`waiting for pid ${pid}, which is building the tree`); said = true; }
    pause(1000);
  }
  try {
    fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, token, startedMs: now(), at: new Date(now()).toISOString() }));
    return fn();
  } finally {
    // Only a lock that is still this run's: one taken over as stale belongs to the process that took it.
    let mine = false;
    try { mine = JSON.parse(fs.readFileSync(owner, 'utf8')).token === token; } catch { /* gone, or another's */ }
    if (mine) rmTree(lock);
  }
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

/**
 * `rebuild`: build a new tree and replace the one there, whatever its state (the by-hand command only).
 * `nativeProbe`, `builder`, `lock`, `pause`: seams for the tests; the defaults are the real ones.
 */
function ensureTree({ env = process.env, log = (m) => process.stderr.write(`[drill-tree-183] ${m}\n`), build: mayBuild = true, rebuild = false, nativeProbe = nativeFault, builder = build, lock = {}, pause = sleep, versions = process.versions } = {}) {
  const { tree, managed, from } = treeLocation(env);
  if (!managed) {
    if (rebuild) throw new Error(`${from}=${tree} is the caller's own tree and is not built here; unset ${from} to rebuild the self-building fixture.`);
    const fault = treeFault(tree, { stamped: false, nativeProbe });
    if (fault) throw new Error(`${from}=${tree} is not a usable ${VERSION} tree: ${fault}. It is the caller's own tree and is not built here; unset ${from} to use the self-building fixture.`);
    return tree;
  }
  // { structural } is repaired by a build. { native } on a stamped tree never is: see WHEN IT BUILDS.
  const look = () => {
    const structural = structuralFault(tree);
    if (structural) return { structural };
    let native = nativeProbe(tree);
    if (native) {
      log(`${tree} is stamped but its native probe failed (${native}); trying once more`);
      pause(2000);
      native = nativeProbe(tree);
    }
    return native ? { native } : null;
  };
  const nativeError = (native) => new Error(`the ${VERSION} drill tree at ${tree} is stamped but its native modules do not load: ${native}. Nothing was deleted: another test may be running from this tree. If it keeps failing, rebuild it by hand: node test/tools/drill-tree-183-build.cjs --rebuild`);
  const host = hostFault(versions);
  // A tree that is ready, and beside it a finished build an earlier run had to keep (replaceTree) or a
  // dead run's leftovers: nobody will adopt them, so they are cleared. Only on a host that may build,
  // only when no build is running, and never a reason to fail a run whose tree is ready.
  const reap = () => {
    if (host || !mayBuild) return;
    const parent = path.dirname(tree);
    try {
      const mine = (n) => LEFTOVERS.some((p) => n.startsWith(p));
      if (fs.existsSync(path.join(parent, `.lock-${NAME}`)) || !fs.readdirSync(parent).some(mine)) return;
      withLock(tree, log, () => {
        log(`clearing what earlier runs left beside the ready tree at ${tree}`);
        // One try each: a leftover something still has open is logged and left for a later run, not waited for.
        adoptOrClear(tree, { adopt: false, nativeProbe, log, tries: 1 });
      }, { ...lock, waitMs: 0 });
    } catch (e) { log(`leftovers beside ${tree} were not cleared (${e.code || e.message})`); }
  };
  let bad = rebuild ? { structural: 'a rebuild was asked for' } : look();
  if (!bad) { reap(); return tree; }
  if (bad.native) throw nativeError(bad.native);
  if (!mayBuild) throw new Error(`the ${VERSION} drill tree at ${tree} is not ready: ${bad.structural}. Build it: node test/tools/drill-tree-183-build.cjs`);
  // Before the lock and before any delete: see hostFault.
  if (host) throw new Error(`${host} (${tree} is not ready: ${bad.structural}; nothing was written or deleted)`);
  return withLock(tree, log, () => {
    if (!rebuild) {
      bad = look(); // another process may have just built it
      if (!bad) return tree;
      if (bad.native) throw nativeError(bad.native);
    }
    log(`building the ${VERSION} tree at ${tree} (location from ${from}): ${bad.structural}`);
    try {
      // A rebuild adopts a kept build that verifies too: it IS the rebuild, finished by a run whose
      // replace was blocked by a tree in use.
      if (!adoptOrClear(tree, { adopt: true, nativeProbe, log })) builder(tree, env, log);
    } catch (e) { throw new Error(`the ${VERSION} drill tree could not be built at ${tree}: ${e.message}`); }
    const fault = treeFault(tree, { nativeProbe });
    if (fault) throw new Error(`the ${VERSION} drill tree was built at ${tree} and does not verify: ${fault}`);
    // The reaper never manages cache/fixtures; the registry entry (SCRATCH-DISK-REAP-108) records who owns it.
    if (from === 'HIVE_ROOT') log(`register it once: scratch register-fixture "${tree}" --card DRILL-TREE-SELF-BUILD-108`);
    return tree;
  }, lock);
}

module.exports = { drillTree, ensureTree, treeLocation, treeFault, structuralFault, replaceTree, adoptOrClear, withLock, rmTree, baseEnv, hostFault, TAG, COMMIT, VERSION, NAME, STAMP, RECIPE, LOCK_STALE_MS, LOCK_WAIT_MS };
