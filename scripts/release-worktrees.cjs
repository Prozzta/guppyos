#!/usr/bin/env node
'use strict';
/**
 * RELEASE-WORKTREE-PRUNE (1.1.98; design to god 3d78dd, GO 922b23).
 *
 * Every cut is a fresh worktree (npm ci 1.4 GB + dist 1.3 GB) and nothing removed them: 19 cut trees,
 * about 50 GB, by 1.1.97. This is step 8 of docs/release-checklist.md: after step 7's digest check,
 *
 *   npm run cut:prune -- --root C:/Dunder/_work [--apply] [--seed-cache] [--keep <name>]...
 *        [--repo <repo>] [--release-repo <owner>/<repo>] [--model-cache <dir>] [--hive <dir>] [--json]
 *
 * A DRY RUN is the default. Only CUT TREES are judged: a top-level folder of --root with
 * dist/*-setup.exe. scripts/worktree-reaper.cjs decides first (git worktree of --repo, clean,
 * shipped; keeps the newest two shipped, anything newer, anything changed in 24 h, a running exe,
 * a junction target, --keep), and its apply removes (rename to a tombstone, links removed AS links,
 * never through them, then `git worktree prune`). On top of it, a tree it would reap is KEPT when:
 *   - unverified: its dist setup.exe, blockmap and latest.yml are not ALL byte-equal (sha256) to the
 *     GitHub release v<package.json version> (an abandoned recut, a branch build, gh unreachable);
 *   - own-tree: the tree this tool or its caller runs in.
 * --apply REFUSES (exit 3, nothing removed) when:
 *   - a cut holds the heavy lock (the hive log: an install/build holder, other than this prune) or a
 *     cut process runs (npm ci, electron-builder, cut-cmd-natives, ...): a tree mid-cut has no
 *     verified digest yet, and a running cut may depend on a tree being pruned;
 *   - the model cache is not verified. The cut recipe copied the model from an old cut tree
 *     (--from andy-cut191); the cache (<root>/release-cache/models/<dir>, every file against
 *     resources/models/native-memory-manifest.json) replaces it: MUNDER_MODEL_CACHE=<that dir>.
 *     --seed-cache (implied by --apply) fills it from a kept cut tree's verified model first.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const reaper = require('./worktree-reaper.cjs');

const HEAVY_TTL_MS = 60 * 60_000;   // src/main/heavyJob.ts HEAVY_TTL_MS: an untouched holder lapses
const CUT_KINDS = new Set(['install', 'build']);
const CUT_COMMAND = /cut:win|dist:win|cut-cmd-natives|electron-builder|electron-rebuild|npm(?:\.cmd|-cli\.js"?)?\s+ci\b/i;
const CUT_PROCESS = /cut-cmd-natives|electron-builder|app-builder|electron-rebuild|dist:win|cut:win|fetch-memory-model|npm(?:\.cmd|-cli\.js)?"?\s+ci\b/i;
const SELF_COMMAND = /cut:prune|release-worktrees/i;
const RELEASE_ASSET = /-setup\.exe$|-setup\.exe\.blockmap$|^latest\.yml$/;

function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/** A cut tree: dist/ holds a setup.exe. Returns its package.json version ('1.1.97') or '' when unreadable. */
function cutVersion(dir) {
  let names; try { names = fs.readdirSync(path.join(dir, 'dist')); } catch { return null; }
  if (!names.some((n) => /-setup\.exe$/.test(n))) return null;
  try { return String(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || ''); } catch { return ''; }
}

/** The release's asset digests { name: hex } (gh release view). Throws when gh cannot answer. */
function ghAssets(releaseRepo, tag) {
  const out = execFileSync('gh', ['release', 'view', tag, '-R', releaseRepo, '--json', 'assets'],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  const assets = {};
  for (const a of JSON.parse(out).assets || []) {
    const m = /^sha256:([0-9a-f]{64})$/.exec(String(a.digest || ''));
    assets[a.name] = m ? m[1] : null;
  }
  return assets;
}

/**
 * The tree's dist against the release: every release asset that is a setup.exe, its blockmap or
 * latest.yml must exist in dist with the same sha256, and there must be a setup.exe among them.
 * Returns { ok, why }.
 */
function verifyTree(dir, assets, sha = sha256File) {
  const want = Object.keys(assets).filter((n) => RELEASE_ASSET.test(n));
  if (!want.some((n) => /-setup\.exe$/.test(n))) return { ok: false, why: 'the release has no setup.exe' };
  if (!want.includes('latest.yml')) return { ok: false, why: 'the release has no latest.yml' };
  for (const n of want) {
    if (!assets[n]) return { ok: false, why: `${n}: the release gives no sha256 digest` };
    const p = path.join(dir, 'dist', n);
    if (!fs.existsSync(p)) return { ok: false, why: `${n}: not in dist` };
    if (sha(p) !== assets[n]) return { ok: false, why: `${n}: dist differs from the release` };
  }
  return { ok: true, why: `${want.length} assets = release` };
}

/**
 * PURE: who holds the heavy lock for a cut, from hive log rows (oldest first). acquire/reenter hold,
 * release frees, app-start clears; a holder untouched for HEAVY_TTL_MS has lapsed. A cut is an
 * install/build holder or a cut command; this prune's own hold is not.
 */
function cutHolds(rows, now) {
  const held = new Map();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    if (r.kind === 'app-start') { held.clear(); continue; }
    if (r.kind !== 'heavy-lock' || typeof r.agentId !== 'string') continue;
    if (r.action === 'acquire') held.set(r.agentId, { agentId: r.agentId, kind: r.heavyKind, command: String(r.command || ''), ts: r.ts });
    else if (r.action === 'reenter') {
      const h = held.get(r.agentId);
      if (h) h.ts = r.ts; else held.set(r.agentId, { agentId: r.agentId, kind: r.heavyKind, command: String(r.command || ''), ts: r.ts });
    } else if (r.action === 'release') held.delete(r.agentId);
  }
  return [...held.values()].filter((h) => now - h.ts < HEAVY_TTL_MS && !SELF_COMMAND.test(h.command)
    && (CUT_KINDS.has(h.kind) || CUT_COMMAND.test(h.command)));
}

/** The hive log's rows (log.jsonl), or null when there is no hive log. */
function readHiveLog(hive) {
  let text; try { text = fs.readFileSync(path.join(hive, 'log.jsonl'), 'utf8'); } catch { return null; }
  const rows = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch { /* torn line */ } }
  return rows;
}

/** Every running process { pid, commandLine } (Windows: Win32_Process). Throws when it cannot list them. */
function processes() {
  if (process.platform !== 'win32') {
    const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    return out.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), commandLine: m[2] }));
  }
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000, maxBuffer: 64 << 20 });
  const rows = JSON.parse(out);
  return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ pid: r.ProcessId, commandLine: String(r.CommandLine || '') }));
}

/** PURE: the running cut processes (not this one). */
function cutProcesses(procs, selfPid = process.pid) {
  return procs.filter((p) => p.pid !== selfPid && CUT_PROCESS.test(p.commandLine));
}

// ─── Model cache ────────────────────────────────────────────────────────────

/** Every manifest file of the model under `dir` against its pinned sha256. Returns { ok, why }. */
function verifyModel(dir, manifest, sha = sha256File) {
  for (const [rel, want] of Object.entries(manifest.model.files)) {
    const p = path.join(dir, ...rel.split('/'));
    if (!fs.existsSync(p)) return { ok: false, why: `${rel}: missing` };
    if (sha(p) !== want) return { ok: false, why: `${rel}: sha256 differs from the manifest` };
  }
  return { ok: true, why: `${Object.keys(manifest.model.files).length} files = manifest` };
}

/** Fill `cacheDir` from the first source whose model verifies; the copy is verified again. */
function seedModel(cacheDir, manifest, sources) {
  for (const src of sources) {
    if (!verifyModel(src, manifest).ok) continue;
    const tmp = `${cacheDir}.seeding-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const rel of Object.keys(manifest.model.files)) {
      const to = path.join(tmp, ...rel.split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(src, ...rel.split('/')), to);
    }
    const v = verifyModel(tmp, manifest);
    if (!v.ok) { fs.rmSync(tmp, { recursive: true, force: true }); continue; }
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    fs.renameSync(tmp, cacheDir);
    return { ok: true, why: `seeded from ${src}`, from: src };
  }
  return { ok: false, why: `no verified source among ${sources.length} cut tree(s)` };
}

// ─── Plan ───────────────────────────────────────────────────────────────────

/**
 * PURE: the reaper's rows for the cut trees, overlaid with the release rules. `verify(row)` gives
 * { ok, why } for a row the reaper would reap; `own` are paths this run sits in.
 */
function planCutPrune(rows, { verify, own = [] }) {
  const inside = (child, parent) => { const rel = path.relative(path.resolve(parent), path.resolve(child)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  return rows.map((r) => {
    if (r.action !== 'reap') return r;
    if (r.kind !== 'worktree') return { ...r, action: 'keep', reason: 'not-a-worktree' };
    if (own.some((p) => inside(p, r.path))) return { ...r, action: 'keep', reason: 'own-tree' };
    const v = verify(r);
    if (!v.ok) return { ...r, action: 'keep', reason: `unverified: ${v.why}` };
    return { ...r, reason: `${r.reason}, verified: ${v.why}` };
  });
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { root: null, repo: null, releaseRepo: null, modelCache: null, hive: process.env.HIVE_ROOT || null, keep: [], apply: false, seed: false, json: false, now: Date.now() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') o.root = argv[++i];
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--release-repo') o.releaseRepo = argv[++i];
    else if (a === '--model-cache') o.modelCache = argv[++i];
    else if (a === '--hive') o.hive = argv[++i];
    else if (a === '--keep') o.keep.push(argv[++i]);
    else if (a === '--apply') { o.apply = true; o.seed = true; }
    else if (a === '--seed-cache') o.seed = true;
    else if (a === '--json') o.json = true;
    else if (a === '--now') o.now = Number(argv[++i]);   // tests: judge ages against another clock
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.root) throw new Error('usage: release-worktrees.cjs --root <dir of the cut trees> [--apply] [--seed-cache] [--keep <name>]... [--repo <repo>] [--release-repo <owner>/<repo>] [--model-cache <dir>] [--hive <dir>] [--json]');
  return o;
}

/** The main repository (the common git dir's parent) of the worktree `cwd` is in. */
function mainRepo(cwd) {
  const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return path.dirname(common);
}

/** owner/repo from the repo's origin URL (github.com/<owner>/<repo>[.git]). */
function originSlug(repo) {
  const url = execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (!m) throw new Error(`origin is not a GitHub URL: ${url}; pass --release-repo <owner>/<repo>`);
  return `${m[1]}/${m[2]}`;
}

function main(argv, out = (s) => process.stdout.write(s + '\n'), deps = {}) {
  const o = parseArgs(argv);
  const root = path.resolve(o.root);
  const repo = o.repo ? path.resolve(o.repo) : mainRepo(process.cwd());
  const releaseRepo = o.releaseRepo || originSlug(repo);
  const manifest = JSON.parse(fs.readFileSync(deps.manifest || path.join(__dirname, '..', 'resources', 'models', 'native-memory-manifest.json'), 'utf8'));
  const cacheDir = path.join(o.modelCache ? path.resolve(o.modelCache) : path.join(root, 'release-cache', 'models'), manifest.model.dir);
  const gh = deps.gh || ((tag) => ghAssets(releaseRepo, tag));

  // The cut trees, judged by the reaper first.
  const versions = new Map();
  const facts = reaper.collectFacts({ root, repos: [repo], now: o.now, ...(deps.exes ? { exes: deps.exes() } : {}),
    only: (name, p) => { const v = cutVersion(p); if (v === null) return false; versions.set(name, v); return true; } });
  for (const e of facts.entries) { const v = reaper.parseVersion(versions.get(e.name) || ''); if (v !== null) e.version = v; }
  const base = reaper.planReap(facts, { keep: o.keep });

  const ghCache = new Map();
  const verify = (r) => {
    const tag = `v${versions.get(r.name)}`;
    if (!versions.get(r.name)) return { ok: false, why: 'no package.json version' };
    if (!ghCache.has(tag)) { try { ghCache.set(tag, { assets: gh(tag) }); } catch (e) { ghCache.set(tag, { error: String((e.stderr || e.message || e)).trim().split(/\r?\n/)[0] }); } }
    const g = ghCache.get(tag);
    if (g.error) return { ok: false, why: `gh release ${tag}: ${g.error}` };
    return verifyTree(r.path, g.assets);
  };
  const own = [process.cwd(), __dirname].map((p) => path.resolve(p));
  const plan = planCutPrune(base, { verify, own });

  // Refusals: a cut in progress (heavy lock or process), an unverified model cache.
  const holds = [];
  const logRows = readHiveLog(o.hive || '');
  if (logRows === null) holds.push(o.hive ? `no hive log under ${o.hive}: heavy lock unknown` : null);
  else for (const h of cutHolds(logRows, o.now)) holds.push(`heavy lock held by ${h.agentId} (${h.kind}: ${h.command.slice(0, 80)})`);
  try { for (const p of cutProcesses((deps.procs || processes)())) holds.push(`cut process ${p.pid}: ${p.commandLine.slice(0, 100)}`); }
  catch (e) { holds.push(`cannot list processes: ${e.message}`); }
  const blocking = holds.filter(Boolean);

  let cache = verifyModel(cacheDir, manifest);
  if (!cache.ok && o.seed) {
    const sources = plan.filter((r) => r.action === 'keep').map((r) => path.join(r.path, 'resources', 'models', manifest.model.dir));
    cache = seedModel(cacheDir, manifest, sources);
  }

  let results = null; let refused = null;
  if (o.apply) {
    if (blocking.length) refused = `a cut is in progress: ${blocking.join('; ')}`;
    else if (!cache.ok) refused = `model cache ${cacheDir} not verified: ${cache.why}`;
    else results = reaper.applyReap(plan, { root, repos: [repo], now: o.now, ...(deps.exes ? { exes: deps.exes } : {}) });
  }

  const reap = plan.filter((r) => r.action === 'reap');
  if (o.json) {
    out(JSON.stringify({ shipped: facts.shipped, releaseRepo, modelCache: { path: cacheDir, ...cache }, holds: blocking, refused,
      plan: plan.map(({ name, kind, version, action, reason }) => ({ name, kind, version: versions.get(name) || null, minor: version, action, reason })), results }, null, 2));
  } else {
    out(`${o.apply ? 'APPLY' : 'DRY RUN (nothing deleted; --apply to prune)'}: ${releaseRepo}, shipped ${facts.shipped.slice(0, 2).map((v) => '1.1.' + v).join(', ')}`);
    out(`MODEL CACHE\t${cache.ok ? 'verified' : 'NOT VERIFIED'}\t${cacheDir}\t${cache.why}`);
    out(`HEAVY\t${blocking.length ? 'CUT IN PROGRESS: ' + blocking.join('; ') : 'no cut in progress'}`);
    for (const r of plan) out(`${r.action.toUpperCase()}\t${versions.get(r.name) || '?'}\t${r.name}\t${r.reason}`);
    if (refused) out(`REFUSED\t${refused}`);
    if (results) for (const r of results) out(`RESULT\t${r.result}\t${r.name}${r.error ? '\t' + r.error : ''}`);
    out(`${reap.length} to prune, ${plan.length - reap.length} kept; MUNDER_MODEL_CACHE=${cacheDir}`);
  }
  return { plan, results, refused, cache: { path: cacheDir, ...cache }, holds: blocking };
}

module.exports = { cutVersion, verifyTree, cutHolds, cutProcesses, verifyModel, seedModel, planCutPrune, main, sha256File, HEAVY_TTL_MS };

if (require.main === module) {
  try { const r = main(process.argv.slice(2)); if (r.refused) process.exit(3); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
}
