#!/usr/bin/env node
'use strict';
/**
 * WORKTREE-NATIVE-BUILD-GAP: a fresh worktree has the tracked sources but none of the untracked
 * build outputs the suite depends on, and a worktree that junctions a shared node_modules never
 * ran postinstall either. Missing pieces did not fail anything loudly:
 *   - resources/fs-handle/bin/guppy_fs_handle.node (tools/build-fs-handle.cjs, postinstall):
 *     19 false reds (fs-path-containment 13, ide-image 6);
 *   - resources/heavyjob/bin/guppy-heavyjob.exe (tools/build-heavyjob.cjs, `npm run build` only):
 *     the runner ran uncapped ("CPU cap unknown, using visible-core concurrency");
 *   - a patched @xterm/addon-webgl (tools/patch-xterm-webgl-font.cjs, postinstall): term-font-105
 *     red, and patching a shared node_modules would change every other tree that junctions it;
 *   - a root-handle patched and rebuilt node-pty (tools/patch-node-pty-root-handle.cjs,
 *     postinstall): pty-hold-nodepty-handoff red in 10 tests on a junction into an older tree.
 *     Reported, never filled here: it needs the tree's own `npm ci`.
 *   - the gitignored embedding model resources/models/<dir>/ (WORKTREE-SETUP-MODEL-108): the
 *     claims drill failed after 350 s on 'missing model (onnx/model.onnx)' in a tree this tool had
 *     called complete. Every file must match its SHA-256 in resources/models/native-memory-manifest.json
 *     (a missing or corrupt file is a gap). It is filled by scripts/fetch-memory-model.cjs --from
 *     the first VERIFIED local source: --copy-from <tree>/resources/models/<dir>, MUNDER_MODEL_CACHE,
 *     then <dir of this tree>/release-cache/models/<dir> (npm run cut:prune -- --seed-cache). This
 *     tool never downloads: with no verified source the gap stays and names the fix. A base with no
 *     manifest (from before NATIVE-MEMORY) has no model gap.
 *
 *   node tools/worktree-setup.cjs [--copy-from <built tree>]   fill the gaps, then re-check
 *   node tools/worktree-setup.cjs --check                       report only (exit 1 on a gap)
 *   node tools/worktree-setup.cjs --teardown                    unlink every junction/symlink in
 *                                                               the tree (before `git worktree remove`)
 *
 * Natives: every copy or build (this tool's, and the canonical build tools' own: postinstall's
 * build-fs-handle, `npm run build`'s build-heavyjob) records the digest of the sources it came from in .worktree-setup.json
 * (gitignored; not under bin/, which ships). A binary whose stamp is missing or differs from the
 * current sources is STALE, a gap like a missing one. --copy-from copies a binary only when the
 * source tree's stamp matches its sources AND those sources are byte-identical to this tree's
 * (bin/ and build/ excluded); otherwise, or with no --copy-from, the item's own build tool runs.
 * xterm: this tool never creates a link (no new junction debt, test/no-nm-junction-198). A
 * node_modules or @xterm that is a link into another tree is refused untouched: give the tree its
 * own `npm ci`. An addon-webgl that is itself a link, or a real addon holding a link (lib/, a
 * file), has each link replaced by a dereferenced copy; then the local copy is patched. Nothing is
 * ever written through a link: every write target is checked to resolve inside this tree, and no
 * link may remain under the addon before the patch.
 *
 * test/tools/run-tests.cjs calls preflight() before a suite and refuses to start on a gap
 * (GUPPY_ALLOW_INCOMPLETE_TREE=1 runs anyway, with the gaps printed before the run and repeated
 * after its summary).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const NATIVES = [
  { id: 'fs-handle', dir: 'resources/fs-handle', out: 'resources/fs-handle/bin/guppy_fs_handle.node', build: 'tools/build-fs-handle.cjs', platforms: ['win32', 'darwin'] },
  { id: 'heavyjob', dir: 'resources/heavyjob', out: 'resources/heavyjob/bin/guppy-heavyjob.exe', build: 'tools/build-heavyjob.cjs', platforms: ['win32'] }
];
const ADDON = path.join('node_modules', '@xterm', 'addon-webgl');
const XTERM_PATCH = 'tools/patch-xterm-webgl-font.cjs';
const NODE_PTY = path.join('node_modules', 'node-pty');
const NODE_PTY_PATCH = 'tools/patch-node-pty-root-handle.cjs';
const NODE_PTY_BINARY = path.join(NODE_PTY, 'build', 'Release', 'conpty.node');
const STAMP = '.worktree-setup.json';
const MODEL_MANIFEST = 'resources/models/native-memory-manifest.json';
const MODEL_FETCH = 'scripts/fetch-memory-model.cjs';

function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }

/** True when `p` (resolved through every link) is `root` or below it. */
function resolvesInside(p, root) {
  let real;
  try { real = fs.realpathSync.native(p); } catch { real = path.resolve(p); }
  const rel = path.relative(fs.realpathSync.native(root), real);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertWritable(p, root) {
  if (!resolvesInside(p, root)) throw new Error(`[worktree-setup] refusing to write ${p}: it resolves outside ${root}`);
}

/** sha256 of every source file under `dir` (relative paths), bin/ and build/ excluded. */
function sourceDigests(root, dir) {
  const base = path.join(root, dir);
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && (e.name === 'bin' || e.name === 'build')) continue;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(base, r))).digest('hex');
    }
  };
  if (fs.existsSync(base)) walk('');
  return out;
}

function sameSources(rootA, rootB, dir) {
  const a = sourceDigests(rootA, dir);
  const b = sourceDigests(rootB, dir);
  const keys = Object.keys(a);
  return keys.length > 0 && keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** One digest over a folder's sources: what a native binary was built from. */
function sourcesDigest(root, dir) {
  const d = sourceDigests(root, dir);
  const keys = Object.keys(d).sort();
  if (!keys.length) return null;
  return crypto.createHash('sha256').update(keys.map((k) => `${k}:${d[k]}\n`).join('')).digest('hex');
}

function readStamp(root) {
  try { const j = JSON.parse(fs.readFileSync(path.join(root, STAMP), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}

function writeStamp(root, id, digest) {
  const p = path.join(root, STAMP);
  if (fs.existsSync(p)) assertWritable(p, root);
  const j = readStamp(root);
  j[id] = digest;
  fs.writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`);
}

/**
 * The ONE stamp path, shared by this tool and the canonical build tools (tools/build-fs-handle.cjs,
 * tools/build-heavyjob.cjs): digest the native's sources now, before the build, and return the call
 * that records that digest once the build has succeeded.
 */
function buildStamp(root, id) {
  const n = NATIVES.find((x) => x.id === id);
  if (!n) throw new Error(`[worktree-setup] unknown native ${id}`);
  const digest = sourcesDigest(root, n.dir);
  return () => writeStamp(root, id, digest);
}

/** True when the native's binary exists and its stamp matches the tree's current sources. */
function nativeFresh(n, root) {
  if (!fs.existsSync(path.join(root, n.out))) return false;
  const digest = sourcesDigest(root, n.dir);
  return digest !== null && readStamp(root)[n.id] === digest;
}

/** Every link (junction/symlink) at or below `p`, never following one. */
function linksUnder(p) {
  const found = [];
  const walk = (q) => {
    if (isLink(q)) { found.push(q); return; }
    let st; try { st = fs.lstatSync(q); } catch { return; }
    if (st.isDirectory()) for (const e of fs.readdirSync(q)) walk(path.join(q, e));
  };
  walk(p);
  return found;
}

function xtermState(root, { spawnSyncFn = spawnSync } = {}) {
  const addon = path.join(root, ADDON);
  if (!fs.existsSync(addon)) return { ok: false, problem: `${ADDON} is missing (no node_modules: run npm ci in this tree)` };
  const tool = path.join(root, XTERM_PATCH);
  if (!fs.existsSync(tool)) return { ok: true };
  const r = spawnSyncFn(process.execPath, [tool, '--check', '--root', addon], { encoding: 'utf8', windowsHide: true });
  if (r.status === 0) return { ok: true };
  const shared = !resolvesInside(addon, root) || linksUnder(addon).length > 0;
  return { ok: false, shared, problem: `${ADDON} is not TERM-FONT-105 patched${shared ? ' (it, or a link under it, resolves into another tree; a shared node_modules or @xterm needs this tree\'s own npm ci)' : ''}` };
}

/**
 * PTY-HOLD-NODEPTY-HANDOFF: is this tree's node-pty the one postinstall leaves (root-handle patched
 * source and agent, and a conpty.node rebuilt from them)? A tree that junctions an older tree's
 * node_modules is not, and nothing said so: pty-hold-nodepty-handoff alone went red in 10 tests.
 * Report only. The fix rebuilds a native module, which is this tree's own `npm ci`.
 */
function nodePtyState(root, { platform = process.platform, spawnSyncFn = spawnSync } = {}) {
  const tool = path.join(root, NODE_PTY_PATCH);
  const np = path.join(root, NODE_PTY);
  if (platform !== 'win32' || !fs.existsSync(tool) || !fs.existsSync(np)) return { ok: true };
  const shared = !resolvesInside(np, root);
  const fix = shared
    ? " (it resolves into another tree; a shared node_modules needs this tree's own npm ci)"
    : ' (run `npm run postinstall` in this tree)';
  const r = spawnSyncFn(process.execPath, [tool, '--check', '--root', np], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return { ok: false, shared, problem: `${NODE_PTY} is not PTY-HOLD-NODEPTY-HANDOFF patched${fix}` };
  const binary = path.join(root, NODE_PTY_BINARY);
  const rebuilt = fs.existsSync(binary) && fs.readFileSync(binary).includes('DuplicateHandle');
  if (!rebuilt) return { ok: false, shared, problem: `${NODE_PTY_BINARY} was not rebuilt from the patched source${fix}` };
  return { ok: true };
}

/** The manifest's model section, or { error } when the tree's manifest cannot be used; null = no manifest. */
function readModelManifest(root) {
  const p = path.join(root, MODEL_MANIFEST);
  if (!fs.existsSync(p)) return null;
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return { error: `${MODEL_MANIFEST} is unreadable: ${e.message}` }; }
  const m = j && j.model;
  if (!m || typeof m.dir !== 'string' || !m.dir || !m.files || typeof m.files !== 'object' || !Object.keys(m.files).length) return { error: `${MODEL_MANIFEST} has no model.dir/model.files` };
  return { manifest: j, dir: m.dir };
}

/** Every manifest file of the model under `dir` against its pinned SHA-256 (the cut prune's own check). */
function verifyModelDir(dir, manifest) {
  return require('../scripts/release-worktrees.cjs').verifyModel(dir, manifest);
}

/** verifyModelDir, but a file that cannot be read (EISDIR, EBUSY, EPERM) is a failed check, not a throw. */
function safeVerify(dir, manifest) {
  try { return verifyModelDir(dir, manifest); } catch (e) { return { ok: false, why: `cannot read it (${e.code || e.message})` }; }
}

/**
 * The first level of the model target that resolves out of `root`, or null: resources/, models/,
 * the model dir, then each manifest file's folders and the file itself (Jim NIT on 3c5ca488: old
 * setups junctioned onnx/ to another tree, and checking only the nearest existing ancestor wrote
 * through it). A link whose target cannot be resolved counts as outside.
 */
function modelLevelOutside(root, own, manifest) {
  const levels = [path.join(root, 'resources'), path.join(root, 'resources', 'models'), own];
  for (const rel of Object.keys(manifest.model.files)) {
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) levels.push(path.join(own, ...parts.slice(0, i)));
  }
  for (const p of levels) {
    const link = isLink(p);
    if (!link && !fs.existsSync(p)) continue;
    if (link) { try { fs.realpathSync.native(p); } catch { return p; } }
    if (!resolvesInside(p, root)) return p;
  }
  return null;
}

/** WORKTREE-SETUP-MODEL-108: is resources/models/<dir>/ the manifest's model, file for file? */
function modelState(root) {
  const m = readModelManifest(root);
  if (m === null) return { ok: true };
  if (m.error) return { ok: false, problem: m.error };
  const rel = `resources/models/${m.dir}`;
  const v = safeVerify(path.join(root, rel), m.manifest);
  if (v.ok) return { ok: true };
  return { ok: false, problem: `${rel} is not the manifest's model (${v.why}); fill it with node tools/worktree-setup.cjs --copy-from <tree with the model>, or MUNDER_MODEL_CACHE=<verified model dir> (this tool never downloads)` };
}

/** The local places a verified model may come from, in order. Never a download. */
function modelSources(root, dir, { copyFrom, env = process.env, releaseCache } = {}) {
  const cache = releaseCache === undefined ? path.join(path.dirname(path.resolve(root)), 'release-cache', 'models') : releaseCache;
  const out = [];
  if (copyFrom) out.push({ from: '--copy-from', dir: path.join(copyFrom, 'resources', 'models', dir) });
  if (env.MUNDER_MODEL_CACHE) out.push({ from: 'MUNDER_MODEL_CACHE', dir: path.resolve(env.MUNDER_MODEL_CACHE) });
  if (cache) out.push({ from: 'release-cache', dir: path.join(cache, dir) });
  return out;
}

/**
 * Fill the model gap: scripts/fetch-memory-model.cjs --from the first source whose every file
 * verifies (the script checks each digest again as it copies). Returns false, having spawned
 * nothing, when no source verifies or the target resolves out of the tree.
 */
function fillModel(root, { copyFrom, env = process.env, releaseCache, spawnSyncFn = spawnSync, log = console.log } = {}) {
  const m = readModelManifest(root);
  if (!m || m.error) { log(`[worktree-setup] model: ${m ? m.error : 'no manifest'}; nothing to fill`); return false; }
  const fetch = path.join(root, MODEL_FETCH);
  if (!fs.existsSync(fetch)) { log(`[worktree-setup] model: ${MODEL_FETCH} is missing in this tree`); return false; }
  // every level of the target must be this tree's own: never write through a link at any depth
  const own = path.join(root, 'resources', 'models', m.dir);
  const outside = modelLevelOutside(root, own, m.manifest);
  if (outside) { log(`[worktree-setup] model: refusing to write ${own}: ${outside} resolves outside ${root}`); return false; }
  const tried = [];
  for (const s of modelSources(root, m.dir, { copyFrom, env, releaseCache })) {
    if (path.resolve(s.dir) === path.resolve(own)) continue;
    const v = safeVerify(s.dir, m.manifest);
    if (!v.ok) { tried.push(`${s.from} ${s.dir}: ${v.why}`); continue; }
    // the source dir is passed explicitly, so the script has no path to a download
    const r = spawnSyncFn(process.execPath, [fetch, '--from', s.dir], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`[worktree-setup] ${MODEL_FETCH} --from ${s.dir} failed (${r.status}): ${String(r.stderr || r.stdout || '').trim()}`);
    log(`[worktree-setup] resources/models/${m.dir}: copied from ${s.from} ${s.dir} (every file = manifest)`);
    return true;
  }
  log(`[worktree-setup] model: no verified local source${tried.length ? ` (${tried.join('; ')})` : ''}; not downloading`);
  return false;
}

/** Every gap that would make the suite wrong in this tree: [{ id, problem }]. */
function inspect(root = REPO, { platform = process.platform, spawnSyncFn = spawnSync } = {}) {
  const gaps = [];
  for (const n of NATIVES) {
    if (!n.platforms.includes(platform)) continue;
    if (!fs.existsSync(path.join(root, n.out))) gaps.push({ id: n.id, problem: `${n.out} is not built (${n.build})` });
    else if (!nativeFresh(n, root)) gaps.push({ id: n.id, stale: true, problem: `${n.out} is stale: ${STAMP} does not record it as built from the current ${n.dir} sources (${n.build})` });
  }
  const x = xtermState(root, { spawnSyncFn });
  if (!x.ok) gaps.push({ id: 'xterm', problem: x.problem });
  const p = nodePtyState(root, { platform, spawnSyncFn });
  if (!p.ok) gaps.push({ id: 'node-pty', problem: p.problem });
  const mo = modelState(root);
  if (!mo.ok) gaps.push({ id: 'model', problem: mo.problem });
  return gaps;
}

/**
 * Give this tree its own patched addon-webgl without writing into a shared node_modules. Returns
 * false, having written nothing, when node_modules or @xterm is a link (or resolves out of the
 * tree): only a real install of this tree's own can fix that, and this tool creates no links.
 */
function localizeXterm(root, { spawnSyncFn = spawnSync, log = console.log } = {}) {
  for (const rel of ['node_modules', path.join('node_modules', '@xterm')]) {
    const dir = path.join(root, rel);
    if (isLink(dir) || !resolvesInside(dir, root)) {
      log(`[worktree-setup] refusing to patch: ${rel} is a link or resolves into another tree; run npm ci in this tree`);
      return false;
    }
  }
  const addon = path.join(root, ADDON);
  if (isLink(addon)) {
    const target = fs.realpathSync.native(addon);
    fs.unlinkSync(addon);
    fs.cpSync(target, addon, { recursive: true, dereference: true });
    log(`[worktree-setup] ${ADDON}: local copy of ${target}`);
  }
  assertWritable(addon, root);
  // A real addon folder can still hold a link (lib/ junctioned to a shared copy): replace each with
  // a dereferenced copy so the patch writes only this tree's bytes.
  for (const link of linksUnder(addon)) {
    const target = fs.realpathSync.native(link);
    fs.unlinkSync(link);
    fs.cpSync(target, link, { recursive: true, dereference: true });
    log(`[worktree-setup] ${path.relative(root, link)}: local copy of ${target}`);
  }
  const left = linksUnder(addon);
  if (left.length) throw new Error(`[worktree-setup] refusing to patch: ${left[0]} is still a link`);
  const tool = path.join(root, XTERM_PATCH);
  const r = spawnSyncFn(process.execPath, [tool, '--root', addon], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`[worktree-setup] ${XTERM_PATCH} failed (${r.status}): ${String(r.stderr || r.stdout || '').trim()}`);
  return true;
}

function fillNative(n, root, { copyFrom, spawnSyncFn = spawnSync, log = console.log } = {}) {
  const out = path.join(root, n.out);
  const stamp = buildStamp(root, n.id);
  if (copyFrom) {
    const src = path.join(copyFrom, n.out);
    const why = !fs.existsSync(src) ? 'is not built in'
      : !nativeFresh(n, copyFrom) ? `is not stamped as built from its own ${n.dir} sources in`
        : !sameSources(root, copyFrom, n.dir) ? `was built from ${n.dir} sources that differ in` : '';
    if (!why) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      assertWritable(path.dirname(out), root);
      fs.copyFileSync(src, out);
      stamp();
      log(`[worktree-setup] ${n.out}: copied from ${copyFrom} (stamped, sources under ${n.dir} identical)`);
      return;
    }
    log(`[worktree-setup] ${n.out} ${why} ${copyFrom}; building instead`);
  }
  const r = spawnSyncFn(process.execPath, [path.join(root, n.build)], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`[worktree-setup] ${n.build} did not produce ${n.out} (status ${r.status})`);
  stamp(); // the build tool stamps too (same helper, same digest); this covers an injected spawn
}

/** Fill every gap inspect() reports; returns the gaps left afterwards. */
function setup(root = REPO, { copyFrom, platform = process.platform, spawnSyncFn = spawnSync, log = console.log, env = process.env, releaseCache } = {}) {
  for (const gap of inspect(root, { platform, spawnSyncFn })) {
    if (gap.id === 'xterm') { if (fs.existsSync(path.join(root, ADDON))) localizeXterm(root, { spawnSyncFn, log }); continue; }
    if (gap.id === 'node-pty') continue; // report only: see nodePtyState
    if (gap.id === 'model') { fillModel(root, { copyFrom, env, releaseCache, spawnSyncFn, log }); continue; }
    fillNative(NATIVES.find((n) => n.id === gap.id), root, { copyFrom, spawnSyncFn, log });
  }
  return inspect(root, { platform, spawnSyncFn });
}

/** Unlink every link in the tree (never following one), so `git worktree remove` cannot reach a target. */
function teardown(root = REPO, { log = console.log } = {}) {
  let n = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (dir === root && e.name === '.git') continue;
      if (isLink(p)) { fs.unlinkSync(p); n += 1; } else if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  log(`[worktree-setup] teardown: unlinked ${n} link(s) in ${root}`);
  return n;
}

/** run-tests.cjs gate: 0 = go, 2 = refuse. On the opt-out, the gap ids are pushed to `optedOut`. */
function preflight({ root = REPO, env = process.env, log = (l) => process.stderr.write(`${l}\n`), inspectFn = inspect, optedOut = [] } = {}) {
  // a check that throws refuses cleanly (2), never a crash of run-tests (Jim NIT on 3c5ca488)
  let gaps;
  try { gaps = inspectFn(root); } catch (e) {
    log(`[test-runner] TREE CHECK FAILED: ${e.message}`);
    log('[test-runner] this tree cannot be checked; fix it with: node tools/worktree-setup.cjs [--copy-from <built tree>]');
    return 2;
  }
  if (!gaps.length) return 0;
  for (const g of gaps) log(`[test-runner] TREE GAP ${g.id}: ${g.problem}`);
  if (env.GUPPY_ALLOW_INCOMPLETE_TREE === '1') {
    log('[test-runner] GUPPY_ALLOW_INCOMPLETE_TREE=1: running anyway; expect reds and an uncapped run from the gaps above');
    optedOut.push(...gaps.map((g) => g.id));
    return 0;
  }
  log('[test-runner] this tree is incomplete; fix it with: node tools/worktree-setup.cjs [--copy-from <built tree>]  (or GUPPY_ALLOW_INCOMPLETE_TREE=1 to run anyway)');
  return 2;
}

/** The line run-tests.cjs repeats after its summary on an opted-out run. */
function optOutLine(ids) { return `[test-runner] INCOMPLETE TREE (opt-out): ${ids.join(', ')}`; }

module.exports = { NATIVES, ADDON, NODE_PTY, NODE_PTY_PATCH, NODE_PTY_BINARY, nodePtyState, MODEL_MANIFEST, MODEL_FETCH, modelState, modelSources, fillModel, modelLevelOutside, STAMP, buildStamp, inspect, optOutLine, sourcesDigest, readStamp, linksUnder, setup, preflight, teardown, localizeXterm, sameSources, sourceDigests, resolvesInside };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (f) => argv.includes(f);
  const at = argv.indexOf('--copy-from');
  const copyFrom = at >= 0 ? path.resolve(argv[at + 1] || '') : undefined;
  if (flag('--teardown')) { teardown(REPO); process.exit(0); }
  const gaps = flag('--check') ? inspect(REPO) : setup(REPO, { copyFrom });
  for (const g of gaps) console.error(`[worktree-setup] GAP ${g.id}: ${g.problem}`);
  if (!gaps.length) console.log('[worktree-setup] tree complete');
  process.exit(gaps.length ? 1 : 0);
}
