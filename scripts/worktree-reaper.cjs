#!/usr/bin/env node
'use strict';
/**
 * WORKTREE-REAPER (1.1.80 candidate; card WORKTREE-REAPER, design in _work/DISK-USAGE-2026-10-01.md).
 *
 * _work regrew by ~100 GB because every release, rc, fix and audit left a full worktree (with its
 * node_modules, dist and out) behind once the release shipped. This tool lists what is obsolete and,
 * only with --apply, removes it. A DRY RUN is the default.
 *
 *   node scripts/worktree-reaper.cjs --root C:/Dunder/_work --repo C:/Dunder/MunderDev [--repo <other>]
 *        [--keep <name>]... [--protect <path>]... [--shipped 78,77,76] [--apply] [--json]
 *
 * What it may reap (each must also pass every KEEP rule below):
 *   - a git WORKTREE (a `.git` FILE) of one of the --repo repositories, with no uncommitted tracked
 *     change, no untracked file that .gitignore does not cover, a HEAD held by a branch or tag, and work that has shipped: its version (from the branch,
 *     else the folder name) is at most the newest shipped tag, or its HEAD is in that tag;
 *   - a non-git FOLDER whose name carries a shipped version (andy-cut176-dist-x, rc-1176, gate-177);
 *   - a top-level `*.log` file.
 * KEEP rules, in order (the first that matches names the reason):
 *   keep-list (named by --keep, plus the defaults), git-repo (a `.git` DIRECTORY, or a bare repo:
 *   a clone another worktree may depend on), running-exe (a running process's executable is inside:
 *   Windows still renames such a folder), recent-24h (anything inside changed in the last 24 h), current-release
 *   (a version newer than the newest shipped tag: the rc and next-release trees), newest-two-shipped,
 *   junction-target (a kept entry links into it, as the 1.1.78 trees' node_modules did into
 *   andy-cut177; also --protect <path> and the target of a top-level link), uncommitted-changes,
 *   untracked-work, unreachable-head, not-shipped, contains-git (a folder holding
 *   a repo or worktree anywhere inside), unversioned-folder.
 * Applying, per reaped entry:
 *   1. re-list the running executables, then rename it to `<name>.reaping-<ts>`: on Windows a folder
 *      with an open file or an agent's cwd inside cannot be renamed, so it is kept ('in-use') with
 *      nothing deleted (a running exe does NOT block the rename, hence the re-list);
 *   2. copy its untracked `*.md` notes to `<root>/_reaped-md/<name>/` (outside node_modules);
 *   3. remove every junction/symlink inside it as a LINK (never through it), then delete the rest;
 *   4. `git worktree prune` in each repo afterwards, unless a worktree ended 'partial' (prune would
 *      orphan its tombstone).
 * Shipped versions are the v1.1.N tags on the first --repo's origin (git ls-remote), so an unpushed
 * local tag never counts; local tags only when that repo has no origin; or name them with --shipped.
 * Never forced: a file that cannot be deleted leaves the entry 'partial'.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DAY_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_DIR = '_reaped-md';
const DEFAULT_KEEP = ['_audit-md-kept', ARCHIVE_DIR, 'hive-backups', 'tos-art'];
const TOMBSTONE = /\.reaping-\d+$/;

/** The 1.1.N minor a name or branch carries (1.1.77, rc-1176, cut177, fix/177-x), or null. A hash
 *  such as a170e is not a version: the number must end the name or be followed by - _ . or /. */
function parseVersion(s) {
  if (typeof s !== 'string' || !s) return null;
  let m = /1\.1\.(\d{1,3})(?![0-9])/.exec(s);
  if (m) return Number(m[1]);
  m = /(?:^|[^0-9.])11(\d{2})(?=$|[-_./])/.exec(s);
  if (m) return Number(m[1]);
  m = /(?:^|[^0-9.])1(\d{2})(?=$|[-_./])/.exec(s);
  return m ? Number(m[1]) : null;
}

/** The shipped minors from tags v1.1.N, newest first. */
function shippedVersions(tags) {
  const out = new Set();
  for (const t of tags) { const m = /^v1\.1\.(\d+)$/.exec(String(t).trim()); if (m) out.add(Number(m[1])); }
  return [...out].sort((a, b) => b - a);
}

function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * PURE: the plan. `facts` = { root, now, shipped: [newest first], entries: [{ name, path, kind:
 * 'worktree'|'repo'|'folder'|'log'|'other', newestMs, version, links: [{ path, target }],
 * worktree?: { repo, dirty, untracked, headOnRef, shippedAncestor }, nestedGit?, runningExe? }] }.
 * opts: { keep: [names], protect: [paths kept as if a kept entry linked into them] }. Returns entries with
 * { action: 'reap'|'keep', reason }.
 */
function planReap(facts, opts = {}) {
  const keepNames = new Set([...DEFAULT_KEEP, ...(opts.keep || [])]);
  const latest = facts.shipped.length ? facts.shipped[0] : null;
  const newestTwo = new Set(facts.shipped.slice(0, 2));
  const cutoff = facts.now - DAY_MS;
  const decide = (e) => {
    if (keepNames.has(e.name)) return ['keep', 'keep-list'];
    if (e.kind === 'repo') return ['keep', 'git-repo'];
    if (e.kind === 'other') return ['keep', 'not-a-candidate'];
    if (e.runningExe) return ['keep', 'running-exe'];
    if (!(e.newestMs <= cutoff)) return ['keep', 'recent-24h'];
    if (TOMBSTONE.test(e.name)) return ['reap', 'leftover-tombstone'];
    if (e.version !== null && latest !== null && e.version > latest) return ['keep', 'current-release'];
    if (e.version !== null && newestTwo.has(e.version)) return ['keep', 'newest-two-shipped'];
    if (e.kind === 'log') return ['reap', 'old-log'];
    if (e.kind === 'worktree') {
      const w = e.worktree || {};
      if (w.dirty) return ['keep', 'uncommitted-changes'];
      if (w.untracked) return ['keep', 'untracked-work'];
      if (!w.headOnRef) return ['keep', 'unreachable-head'];
      if ((e.version !== null && latest !== null && e.version <= latest) || w.shippedAncestor) return ['reap', 'shipped'];
      return ['keep', 'not-shipped'];
    }
    // A folder holding a repo or a worktree (creed-176/src: the main repo of Creed's worktrees) is
    // never deleted as a folder: its git contents are judged by the git rules, or by a person.
    if (e.nestedGit) return ['keep', 'contains-git'];
    if (e.version !== null && latest !== null && e.version <= latest) return ['reap', 'obsolete-build-folder'];
    return ['keep', 'unversioned-folder'];
  };
  const rows = facts.entries.map((e) => { const [action, reason] = decide(e); return { ...e, action, reason }; });
  // A kept entry's links must keep their targets (to a fixpoint: a target kept may link on).
  for (let changed = true; changed;) {
    changed = false;
    const targets = [...(opts.protect || []), ...rows.filter((r) => r.action === 'keep').flatMap((r) => r.links.map((l) => l.target))].filter(Boolean);
    for (const r of rows) {
      if (r.action === 'reap' && targets.some((t) => inside(t, r.path))) { r.action = 'keep'; r.reason = 'junction-target'; changed = true; }
    }
  }
  return rows;
}

// ─── Facts (reads only) ──────────────────────────────────────────────────────

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
function gitOk(cwd, args) {
  try { execFileSync('git', ['-C', cwd, ...args], { windowsHide: true, stdio: 'ignore' }); return true; } catch { return false; }
}

/** A bare or mirror repo: HEAD, objects/ and refs/ with no .git. */
function isBare(dir) {
  try { return fs.statSync(path.join(dir, 'HEAD')).isFile() && fs.statSync(path.join(dir, 'objects')).isDirectory() && fs.statSync(path.join(dir, 'refs')).isDirectory(); } catch { return false; }
}

/** Every running process's executable path (Windows: Win32_Process). Throws when it cannot list them:
 *  a reaper that cannot see running apps must not run. */
function runningExes() {
  if (process.platform !== 'win32') return [];   // POSIX: a running exe does not block deletion either; only recent-24h guards
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { $_.ExecutablePath }'],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** The v1.1.N tags of `repo`'s origin (ls-remote), or its local tags when it has no origin. */
function shippedTags(repo) {
  const remotes = git(repo, ['remote']).split(/\r?\n/);
  if (!remotes.includes('origin')) return git(repo, ['tag', '-l', 'v1.1.*']).split(/\r?\n/).filter(Boolean);
  return git(repo, ['ls-remote', '--tags', 'origin', 'refs/tags/v1.1.*']).split(/\r?\n/)
    .map((l) => (/refs\/tags\/(v[^\s^]+)$/.exec(l) || [])[1]).filter(Boolean);
}

/** Newest mtime under `p` (links are recorded, never followed) and every link found. */
function walk(p) {
  let newestMs = fs.lstatSync(p).mtimeMs; const links = []; let nestedGit = false;
  const stack = [p];
  while (stack.length) {
    const dir = stack.pop();
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const c = path.join(dir, n);
      let st; try { st = fs.lstatSync(c); } catch { continue; }
      if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
      if (n === '.git' && dir !== p) nestedGit = true;
      if (n === 'HEAD' && dir !== p && st.isFile() && isBare(dir)) nestedGit = true;
      if (st.isSymbolicLink()) {
        let target = null; try { target = path.resolve(dir, fs.readlinkSync(c)); } catch { /* unreadable */ }
        links.push({ path: c, target });
      } else if (st.isDirectory()) stack.push(c);
    }
  }
  return { newestMs, links, nestedGit };
}

function collectFacts({ root, repos, now = Date.now(), shipped: named = null, exes = runningExes() }) {
  const repoSet = repos.map((r) => path.resolve(r).toLowerCase());
  const shipped = named ? [...named].sort((a, b) => b - a) : shippedVersions(repos.length ? shippedTags(repos[0]) : []);
  const latestTag = shipped.length ? `v1.1.${shipped[0]}` : null;
  const entries = [];
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) {   // its target is protected like any kept entry's link target
      let target = null; try { target = path.resolve(root, fs.readlinkSync(p)); } catch { /* unreadable */ }
      entries.push({ name, path: p, kind: 'other', newestMs: st.mtimeMs, version: null, links: [{ path: p, target }] }); continue;
    }
    if (st.isFile()) {
      entries.push({ name, path: p, kind: name.endsWith('.log') ? 'log' : 'other', newestMs: st.mtimeMs, version: parseVersion(name), links: [] });
      continue;
    }
    const { newestMs, links, nestedGit } = walk(p);
    const dotGit = path.join(p, '.git');
    let kind = 'folder'; let worktree; let version = parseVersion(name);
    if ((fs.existsSync(dotGit) && fs.lstatSync(dotGit).isDirectory()) || isBare(p)) kind = 'repo';
    else if (fs.existsSync(dotGit)) {
      let common = null;
      try { common = path.dirname(path.resolve(p, git(p, ['rev-parse', '--git-common-dir']))).toLowerCase(); } catch { /* broken */ }
      if (common && repoSet.includes(common)) {
        kind = 'worktree';
        let branch = 'HEAD'; try { branch = git(p, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch { /* keep */ }
        version = parseVersion(branch) ?? version;
        worktree = {
          repo: common,
          branch,
          dirty: (() => { try { return git(p, ['status', '--porcelain', '--untracked-files=no']).length > 0; } catch { return true; } })(),
          // new work nobody has added yet (a .ts, a test, evidence); .gitignore'd build output does not count
          untracked: (() => { try { return git(p, ['ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter((f) => f && !f.split('/').includes('node_modules')).length; } catch { return 1; } })(),
          headOnRef: (() => { try { return git(p, ['for-each-ref', '--contains', 'HEAD', '--count=1', 'refs/heads', 'refs/tags', 'refs/remotes']).length > 0; } catch { return false; } })(),
          shippedAncestor: latestTag ? gitOk(p, ['merge-base', '--is-ancestor', 'HEAD', latestTag]) : false,
          // tracked *.md are in git; only the untracked (or ignored) notes need saving
          untrackedMd: (() => { try { return git(p, ['ls-files', '--others', '--', '*.md']).split(/\r?\n/).filter((f) => f && !f.split('/').includes('node_modules')); } catch { return []; } })()
        };
      } else kind = 'other';   // a worktree of a repo nobody named: not ours to judge
    }
    const runningExe = exes.find((x) => inside(x, p)) || null;
    entries.push({ name, path: p, kind, newestMs, version, links, worktree, nestedGit, runningExe });
  }
  return { root, now, shipped, entries };
}

// ─── Apply (only with --apply) ───────────────────────────────────────────────

/** Copy untracked *.md (not under node_modules, never through a link) to `dest`. */
function archiveMd(src, dest, ops) {
  let n = 0; const stack = [src];
  while (stack.length) {
    const dir = stack.pop();
    let names = []; try { names = ops.readdirSync(dir); } catch { continue; }
    for (const nm of names) {
      const c = path.join(dir, nm);
      let st; try { st = ops.lstatSync(c); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (nm !== 'node_modules' && nm !== '.git') stack.push(c); continue; }
      if (nm.endsWith('.md')) {
        const to = path.join(dest, path.relative(src, c));
        ops.mkdirSync(path.dirname(to), { recursive: true }); ops.copyFileSync(c, to); n++;
      }
    }
  }
  return n;
}

/** Remove every link under `dir` as a LINK (a junction is a directory link on Windows). */
function removeLinks(dir, ops) {
  let n = 0; const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let names = []; try { names = ops.readdirSync(d); } catch { continue; }
    for (const nm of names) {
      const c = path.join(d, nm);
      let st; try { st = ops.lstatSync(c); } catch { continue; }
      if (st.isSymbolicLink()) { try { ops.unlinkSync(c); } catch { ops.rmdirSync(c); } n++; }
      else if (st.isDirectory()) stack.push(c);
    }
  }
  return n;
}

function applyReap(plan, { root, repos = [], now = Date.now(), ops = fs, prune = (r) => gitOk(r, ['worktree', 'prune']), exes = runningExes } = {}) {
  const results = [];
  const running = plan.some((e) => e.action === 'reap') ? exes() : [];   // re-listed: an app may have started since the plan
  for (const e of plan) {
    if (e.action !== 'reap') continue;
    const exe = running.find((x) => inside(x, e.path));
    if (exe) { results.push({ name: e.name, result: 'in-use', error: `running-exe ${exe}` }); continue; }
    const tomb = TOMBSTONE.test(e.path) ? e.path : `${e.path}.reaping-${now}`;
    try { if (tomb !== e.path) ops.renameSync(e.path, tomb); } catch (err) { results.push({ name: e.name, result: 'in-use', error: err.code || String(err) }); continue; }
    let md = 0; let links = 0;
    try {
      if (e.kind === 'log') { ops.unlinkSync(tomb); results.push({ name: e.name, result: 'deleted', md, links }); continue; }
      const dest = path.join(root, ARCHIVE_DIR, e.name);
      if (e.kind === 'worktree') {
        for (const rel of (e.worktree && e.worktree.untrackedMd) || []) {
          const to = path.join(dest, rel);
          ops.mkdirSync(path.dirname(to), { recursive: true }); ops.copyFileSync(path.join(tomb, rel), to); md++;
        }
      } else md = archiveMd(tomb, dest, ops);
      links = removeLinks(tomb, ops);
      ops.rmSync(tomb, { recursive: true, force: false, maxRetries: 2 });
      results.push({ name: e.name, result: 'deleted', md, links });
    } catch (err) {
      results.push({ name: e.name, result: 'partial', md, links, error: err.code || String(err) });
    }
  }
  // a 'partial' worktree's tombstone still has its .git file: prune would drop its admin dir and orphan it
  const partialWt = results.some((r) => r.result === 'partial' && plan.find((e) => e.name === r.name).kind === 'worktree');
  if (plan.some((e) => e.action === 'reap' && e.kind === 'worktree')) {
    if (partialWt) results.push({ name: '(git worktree prune)', result: 'skipped', error: 'a worktree is partial; prune by hand after clearing it' });
    else for (const r of repos) prune(r);
  }
  return results;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { root: null, repos: [], keep: [], protect: [], shipped: null, apply: false, json: false, now: Date.now() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') o.root = argv[++i];
    else if (a === '--repo') o.repos.push(argv[++i]);
    else if (a === '--keep') o.keep.push(argv[++i]);
    else if (a === '--protect') o.protect.push(path.resolve(argv[++i]));   // e.g. a link INTO root from outside it
    else if (a === '--shipped') o.shipped = String(argv[++i]).split(',').map((v) => parseVersion(v.trim()) ?? Number(v)).filter(Number.isInteger);
    else if (a === '--apply') o.apply = true;
    else if (a === '--json') o.json = true;
    else if (a === '--now') o.now = Number(argv[++i]);   // tests: judge ages against another clock
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.root || !o.repos.length) throw new Error('usage: worktree-reaper.cjs --root <dir> --repo <repo> [--repo <repo>] [--keep <name>] [--protect <path>] [--shipped 78,77] [--apply] [--json]');
  return o;
}

function main(argv, out = (s) => process.stdout.write(s + '\n'), opts = {}) {
  const o = parseArgs(argv);
  const facts = collectFacts({ root: o.root, repos: o.repos, now: o.now, shipped: o.shipped, ...(opts.exes ? { exes: opts.exes() } : {}) });
  const plan = planReap(facts, { keep: o.keep, protect: o.protect });
  const results = o.apply ? applyReap(plan, { root: o.root, repos: o.repos, now: o.now, ...(opts.exes ? { exes: opts.exes } : {}) }) : null;
  if (o.json) out(JSON.stringify({ shipped: facts.shipped, plan: plan.map(({ name, kind, version, action, reason }) => ({ name, kind, version, action, reason })), results }, null, 2));
  else {
    out(`${o.apply ? 'APPLY' : 'DRY RUN (nothing deleted; --apply to reap)'}: shipped ${facts.shipped.slice(0, 3).map((v) => '1.1.' + v).join(', ')}`);
    for (const r of plan) out(`${r.action.toUpperCase()}\t${r.reason}\t${r.kind}\t${r.name}`);
    if (results) for (const r of results) out(`RESULT\t${r.result}\t${r.name}${r.error ? '\t' + r.error : ''}`);
    out(`${plan.filter((r) => r.action === 'reap').length} to reap, ${plan.filter((r) => r.action === 'keep').length} kept`);
  }
  return { plan, results };
}

module.exports = { parseVersion, shippedVersions, shippedTags, runningExes, isBare, planReap, collectFacts, applyReap, archiveMd, removeLinks, main, DAY_MS, DEFAULT_KEEP, ARCHIVE_DIR };

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
}
