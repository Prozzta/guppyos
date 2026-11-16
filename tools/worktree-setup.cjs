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
 *     red, and patching a shared node_modules would change every other tree that junctions it.
 *
 *   node tools/worktree-setup.cjs [--copy-from <built tree>]   fill the gaps, then re-check
 *   node tools/worktree-setup.cjs --check                       report only (exit 1 on a gap)
 *   node tools/worktree-setup.cjs --teardown                    unlink every junction/symlink in
 *                                                               the tree (before `git worktree remove`)
 *
 * Natives: --copy-from copies the binary only when every source file under its resources folder
 * (bin/ and build/ excluded) is byte-identical in both trees; otherwise, or with no --copy-from,
 * the item's own build tool runs. xterm: a node_modules / @xterm / addon-webgl that is a link into
 * another tree is split (a real folder of per-entry junctions, files copied) down to a REAL local
 * copy of addon-webgl, which is then patched. Nothing is ever written through a link: every write
 * target is checked to resolve inside this tree first.
 *
 * test/tools/run-tests.cjs calls preflight() before a suite and refuses to start on a gap
 * (GUPPY_ALLOW_INCOMPLETE_TREE=1 runs anyway, with the gaps printed).
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

function xtermState(root, { spawnSyncFn = spawnSync } = {}) {
  const addon = path.join(root, ADDON);
  if (!fs.existsSync(addon)) return { ok: false, problem: `${ADDON} is missing (no node_modules: npm ci, or link a built tree's and run this tool)` };
  const tool = path.join(root, XTERM_PATCH);
  if (!fs.existsSync(tool)) return { ok: true };
  const r = spawnSyncFn(process.execPath, [tool, '--check', '--root', addon], { encoding: 'utf8', windowsHide: true });
  if (r.status === 0) return { ok: true };
  const shared = !resolvesInside(addon, root);
  return { ok: false, shared, problem: `${ADDON} is not TERM-FONT-105 patched${shared ? ' (it resolves into another tree)' : ''}` };
}

/** Every gap that would make the suite wrong in this tree: [{ id, problem }]. */
function inspect(root = REPO, { platform = process.platform, spawnSyncFn = spawnSync } = {}) {
  const gaps = [];
  for (const n of NATIVES) {
    if (n.platforms.includes(platform) && !fs.existsSync(path.join(root, n.out))) gaps.push({ id: n.id, problem: `${n.out} is not built (${n.build})` });
  }
  const x = xtermState(root, { spawnSyncFn });
  if (!x.ok) gaps.push({ id: 'xterm', problem: x.problem });
  return gaps;
}

/** Replace the link `dir` with a real folder: sub-folders become junctions to the link's target, files are copied. */
function splitLink(dir, root) {
  const target = fs.realpathSync.native(dir);
  fs.unlinkSync(dir); // removes the link only, never the target
  if (!fs.existsSync(target)) throw new Error(`[worktree-setup] ${target} vanished when ${dir} was unlinked`);
  fs.mkdirSync(dir);
  assertWritable(dir, root);
  for (const e of fs.readdirSync(target, { withFileTypes: true })) {
    const src = path.join(target, e.name);
    const dst = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = fs.statSync(src).isDirectory(); } catch { continue; } }
    if (isDir) fs.symlinkSync(fs.realpathSync.native(src), dst, 'junction');
    else fs.copyFileSync(src, dst);
  }
}

/** Give this tree its own patched addon-webgl without writing into a shared node_modules. */
function localizeXterm(root, { spawnSyncFn = spawnSync, log = console.log } = {}) {
  const chain = ['node_modules', path.join('node_modules', '@xterm')].map((p) => path.join(root, p));
  for (const dir of chain) if (isLink(dir)) { splitLink(dir, root); log(`[worktree-setup] ${path.relative(root, dir)}: now a real folder of junctions`); }
  const addon = path.join(root, ADDON);
  if (isLink(addon)) {
    const target = fs.realpathSync.native(addon);
    fs.unlinkSync(addon);
    fs.cpSync(target, addon, { recursive: true, dereference: true });
    log(`[worktree-setup] ${ADDON}: local copy of ${target}`);
  }
  assertWritable(addon, root);
  const tool = path.join(root, XTERM_PATCH);
  const r = spawnSyncFn(process.execPath, [tool, '--root', addon], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`[worktree-setup] ${XTERM_PATCH} failed (${r.status}): ${String(r.stderr || r.stdout || '').trim()}`);
}

function fillNative(n, root, { copyFrom, spawnSyncFn = spawnSync, log = console.log } = {}) {
  const out = path.join(root, n.out);
  if (copyFrom) {
    const src = path.join(copyFrom, n.out);
    if (fs.existsSync(src) && sameSources(root, copyFrom, n.dir)) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      assertWritable(path.dirname(out), root);
      fs.copyFileSync(src, out);
      log(`[worktree-setup] ${n.out}: copied from ${copyFrom} (sources under ${n.dir} identical)`);
      return;
    }
    log(`[worktree-setup] ${n.out}: ${fs.existsSync(src) ? `sources under ${n.dir} differ from` : 'not built in'} ${copyFrom}; building instead`);
  }
  const r = spawnSyncFn(process.execPath, [path.join(root, n.build)], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`[worktree-setup] ${n.build} did not produce ${n.out} (status ${r.status})`);
}

/** Fill every gap inspect() reports; returns the gaps left afterwards. */
function setup(root = REPO, { copyFrom, platform = process.platform, spawnSyncFn = spawnSync, log = console.log } = {}) {
  for (const gap of inspect(root, { platform, spawnSyncFn })) {
    if (gap.id === 'xterm') { if (fs.existsSync(path.join(root, ADDON))) localizeXterm(root, { spawnSyncFn, log }); continue; }
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

/** run-tests.cjs gate: 0 = go, 2 = refuse. */
function preflight({ root = REPO, env = process.env, log = (l) => process.stderr.write(`${l}\n`), inspectFn = inspect } = {}) {
  const gaps = inspectFn(root);
  if (!gaps.length) return 0;
  for (const g of gaps) log(`[test-runner] TREE GAP ${g.id}: ${g.problem}`);
  if (env.GUPPY_ALLOW_INCOMPLETE_TREE === '1') {
    log('[test-runner] GUPPY_ALLOW_INCOMPLETE_TREE=1: running anyway; expect reds and an uncapped run from the gaps above');
    return 0;
  }
  log('[test-runner] this tree is incomplete; fix it with: node tools/worktree-setup.cjs [--copy-from <built tree>]  (or GUPPY_ALLOW_INCOMPLETE_TREE=1 to run anyway)');
  return 2;
}

module.exports = { NATIVES, ADDON, inspect, setup, preflight, teardown, localizeXterm, splitLink, sameSources, sourceDigests, resolvesInside };

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
