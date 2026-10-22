#!/usr/bin/env node
'use strict';
/**
 * RELATED-TESTS (card BRANCH-RELATED-PINS-RUN, 1.1.98 stage 12).
 *
 * Stage 12 went red on 6 index.ts source pins and 3 mutant baselines that a PASS never ran: the
 * author and the auditor ran the focused files only. This tool computes the RELATED set of a
 * branch, so "related" is computed and never remembered, and its summary line goes in every
 * author report and every verdict.
 *
 *   node scripts/related-tests.cjs --base <sha> --tip <sha> [--repo <dir>] [--run] [--json]
 *
 * Changed set: `git diff --name-only --diff-filter=d base..tip` (deleted files have nothing to pin).
 * --base must be an ancestor of --tip (else the base side's own changes would count as changed).
 * A suite test file (run-tests' discoverTestFiles) or a test/tools/*.cjs runner is RELATED when:
 *   - the branch changed it itself, or
 *   - it names a changed file by its repo path: 'src/main/x.ts', '../src/main/x' (a require without
 *     the extension), path segments 'src', 'main', 'x.ts', or, for a changed file under test/, its
 *     './x' form. The PATH is matched, never the basename: 'index.ts' alone would match half the tree.
 *   - it names the changed file's directory (two segments or more: src/main, not src) AND either
 *     quotes the file's basename ('x.ts' or 'x', a dir + name list) or walks a directory
 *     (readdirSync, walk*()): the floor-wide bans over src/main must see a brand-new module there.
 *   - package.json: only when the test names package.json AND a top-level key the diff changed
 *     ('scripts' counts only through a changed script's name). The bare name matched 20+ files.
 *   - RELATED-TEST-INVENTORY-198: it is one of INVENTORY_TESTS (they pin the suite's file list, not
 *     a named file) AND the branch added, deleted or renamed a file the runner collects. 60dba590
 *     added 2 test files, the glob pin stayed 493, and stage 18 went red on 'got 495'. The A/D/R
 *     paths come from `git diff --name-status -M`, so a deleted test counts too.
 * Lanes:
 *   LIGHT    run serially, one file per process (never a parallel node --test: the Human's CPU);
 *   HEAVY    the file carries `// @heavy-lock`: it runs under the heavy slot;
 *   ELECTRON the file uses the electron harness (runScenario): a second Electron needs god's OK, so
 *            --run never starts it;
 *   CENSUS   test/tools/*-mutants.cjs naming a changed path (mutant censuses): always heavy;
 *   TOOLS    any other test/tools/*.cjs naming one (probes, helpers): listed, never run.
 * --run runs the LIGHT lane in --repo (tip checked out, node_modules installed), HIVE_LEDGER_URL,
 * HIVE_ROOT and AGENT_ID stripped. Every red file is run again at --base (a detached temp worktree,
 * the tip's node_modules on NODE_PATH). "same on base" only when every test failing at the tip also
 * fails at base, by NAME (counts can match while different tests fail); a file that failed before
 * any test ran compares its first error line instead. Otherwise "BRANCH RED" (base green) or
 * "base differs", both counted as branch. "new" means the file does not exist at base. Exit 1 when
 * any red is not same on base.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TEST_SUFFIX = '.test.cjs';
const STRIP_ENV = ['HIVE_LEDGER_URL', 'HIVE_ROOT', 'AGENT_ID'];
const FILE_TIMEOUT_MS = 300_000;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const noExt = (p) => p.replace(/\.(tsx?|[cm]?js)$/, '');

/** The patterns a test uses to name repo file `p` (forward slashes, repo-relative). */
function pathPatterns(p) {
  // A path boundary on both sides, so a MIRROR comment ("lives in src/main/hive.ts") counts and
  // src/main/hiveX.ts or test/src/main/hive.ts does not.
  const q = `['"\`]`;
  const before = `(^|[^\\w./-]|\\.\\./|\\./)`;
  const after = `(?![\\w./-])`;
  const ext = p === noExt(p) ? '' : `(${esc(p.slice(noExt(p).length))})?`;
  const out = [
    new RegExp(`${before}${esc(noExt(p))}${ext}${after}`, 'm'),
    new RegExp(p.split('/').map((s) => `${q}${esc(s)}${q}`).join('\\s*,\\s*'))
  ];
  if (p.startsWith('test/')) out.push(new RegExp(`${q}\\./${esc(noExt(p.slice(5)))}${ext}${q}`));
  return out;
}

const WALKS = /\breaddirSync\s*\(|\bwalk\w*\s*\(/;

/** `text` names p's directory and quotes p's basename, or names p's directory or an ancestor of it
 *  (a walk recurses) and walks a dir. Directories of two segments or more only. */
function namesViaDir(text, p) {
  const dir = path.posix.dirname(p);
  const base = path.posix.basename(p);
  const q = `['"\`]`;
  const walks = WALKS.test(text);
  for (let d = dir; d.split('/').length >= 2; d = path.posix.dirname(d)) {
    if (!pathPatterns(d).some((re) => re.test(text))) continue;
    if (walks) return true;
    if (d === dir && new RegExp(`${q}${esc(noExt(base))}(${esc(base.slice(noExt(base).length))})?${q}`).test(text)) return true;
  }
  return false;
}

/** The changed paths `text` names (package.json handled by packageNamed). */
function namedPaths(text, changed) {
  return changed.filter((p) => p !== 'package.json' && (pathPatterns(p).some((re) => re.test(text)) || namesViaDir(text, p)));
}

/** Top-level package.json keys whose value differs, and for 'scripts' the script names. */
function packageDiff(baseText, tipText) {
  let a = {}, b = {};
  try { a = JSON.parse(baseText || '{}'); } catch { a = {}; }
  try { b = JSON.parse(tipText || '{}'); } catch { return { keys: ['*'], scripts: [] }; }
  const differs = (x, y) => JSON.stringify(x) !== JSON.stringify(y);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => differs(a[k], b[k]));
  const sa = a.scripts || {}, sb = b.scripts || {};
  const scripts = [...new Set([...Object.keys(sa), ...Object.keys(sb)])].filter((k) => sa[k] !== sb[k]);
  return { keys, scripts };
}

function packageNamed(text, diff) {
  if (!/package\.json/.test(text)) return false;
  if (diff.keys.includes('*')) return true;
  return diff.keys.some((k) => {
    if (k === 'scripts') return diff.scripts.some((s) => new RegExp(`['"\`]${esc(s)}['"\`]|scripts\\.${esc(s)}\\b`).test(text));
    return new RegExp(`\\.${esc(k)}\\b|\\[['"\`]${esc(k)}['"\`]\\]`).test(text);
  });
}

function laneOf(file, text) {
  if (!file.endsWith(TEST_SUFFIX)) return /-mutants\.cjs$/.test(file) ? 'census' : 'tools';
  // A require of the harness, not a mention: icon-speck and ps-modcache-leak only read its files.
  if (/require\(\s*['"`][^'"`]*electron-harness/.test(text)) return 'electron';
  if (/^\s*\/\/\s*@heavy-lock\b/m.test(text)) return 'heavy';
  return 'light';
}

/** The tests over the suite's file list as a whole (its count, its lanes). */
const INVENTORY_TESTS = ['test/test-runner-glob.test.cjs', 'test/test-runner-perf-lane.test.cjs'];

/** Does repo path `p` have the shape run-tests collects: test/x.test.cjs, or under a feature dir. */
function collectedPath(p, featureDirs) {
  if (!p.startsWith('test/') || !p.endsWith(TEST_SUFFIX)) return false;
  const rest = p.slice('test/'.length).split('/');
  return rest.length === 1 || featureDirs.includes(rest[0]);
}

/** The collected test paths a `git diff --name-status -M` output adds, deletes or renames (both sides). */
function inventoryPaths(nameStatus, featureDirs) {
  const out = [];
  for (const line of nameStatus.split('\n')) {
    const [status, ...paths] = line.trim().split('\t');
    if (!status || !/^[ADR]/.test(status)) continue;
    for (const p of paths) if (collectedPath(p, featureDirs)) out.push(p);
  }
  return out;
}

/** run-tests' feature dirs, read from the repo's own runner. */
function featureDirsOf(repo) {
  try { return [...require(path.join(repo, 'test', 'tools', 'run-tests.cjs')).FEATURE_TEST_DIRS]; } catch { return []; }
}

/** The suite test files (repo-relative) plus the test/tools runners. */
function candidateFiles(repo) {
  const testDir = path.join(repo, 'test');
  let suite;
  try { suite = require(path.join(testDir, 'tools', 'run-tests.cjs')).discoverTestFiles(testDir); }
  catch { suite = fs.readdirSync(testDir).filter((f) => f.endsWith(TEST_SUFFIX)); }
  const tools = fs.readdirSync(path.join(testDir, 'tools')).filter((f) => f.endsWith('.cjs')).map((f) => `tools/${f}`);
  return [...suite, ...tools].map((f) => `test/${f.split(path.sep).join('/')}`);
}

/** { changed, lanes: {light, heavy, electron, census, tools}, why } for files read by `read`. */
function relatedSet({ changed, files, read, pkg, inventory = [] }) {
  const lanes = { light: [], heavy: [], electron: [], census: [], tools: [] };
  const why = {};
  for (const f of files) {
    const text = read(f);
    if (text === null) continue;
    const hits = changed.includes(f) ? ['(changed)'] : namedPaths(text, changed);
    if (pkg && changed.includes('package.json') && packageNamed(text, pkg)) hits.push('package.json');
    if (inventory.length && INVENTORY_TESTS.includes(f)) hits.push('(test inventory changed)');
    if (hits.length === 0) continue;
    why[f] = hits;
    lanes[laneOf(f, text)].push(f);
  }
  return { changed, lanes, why };
}

function summary(set, base, tip) {
  const l = set.lanes;
  return `related: ${l.light.length} light, ${l.heavy.length} heavy, ${l.electron.length} electron, ${l.census.length} census, ${l.tools.length} tools for ${set.changed.length} changed files (${base.slice(0, 8)}..${tip.slice(0, 8)})`;
}

/** pass/fail counts from node --test output; null when it printed none. */
function parseCounts(out) {
  const p = /^# pass (\d+)/m.exec(out), f = /^# fail (\d+)/m.exec(out);
  return p && f ? { pass: Number(p[1]), fail: Number(f[1]) } : null;
}

function runFile(cwd, file, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const k of STRIP_ENV) delete env[k];
  // Run from inside a node --test (its own pin test), the child would report to that parent
  // instead of printing totals and exiting with its own rc.
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', file], { cwd, env, encoding: 'utf8', timeout: FILE_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 << 20 });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const counts = parseCounts(out);
  return { rc: r.status === null ? 'timeout' : r.status, ...(counts || { pass: 0, fail: 0 }), ...parseFailures(out, file) };
}

/** Absolute paths differ between the tip and the base worktree; compare without them. */
const unpath = (s) => s.replace(/[A-Za-z]:(\\\\|\\|\/)[^\s'"`)]*/g, '<path>').trim();

/** The names of the failing tests ('not ok N - name', any depth; the file-level row itself
 *  excluded) and the first error line, for comparing a red at tip with the same file at base. */
function parseFailures(out, file) {
  const own = path.basename(file);
  const failed = [...new Set([...out.matchAll(/^\s*not ok \d+ - (.+?)\s*(#.*)?$/gm)].filter((m) => !/#\s*TODO/i.test(m[2] || '')).map((m) => m[1])
    .filter((n) => !n.endsWith(own)).map(unpath))];
  const err = /^.*\b(\w*Error|Cannot find module|failed)\b.*$/m.exec(out);
  return { failed, firstError: err ? unpath(err[0]) : '' };
}

/** A tip red is the environment only when every test failing at tip fails at base too. */
function sameOnBase(tip, base) {
  if (base.rc === 0) return false;
  const tf = tip.failed || [], bf = base.failed || [];
  // No names on either side (a crash at load, a timeout): the same rc and the same, non-empty, first error.
  if (tf.length === 0 && bf.length === 0) return tip.rc === base.rc && !!tip.firstError && tip.firstError === base.firstError;
  return tf.length > 0 && tf.every((n) => bf.includes(n));
}

const git = (repo, args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`);
  return r.stdout;
};

/** Runs the LIGHT lane; reds are re-run at base. Returns { rows, line, rc }. */
function runLight({ repo, base, light, run = runFile, log = () => {} }) {
  const rows = [];
  let baseTree = null;
  try {
    for (const f of light) {
      const r = run(repo, f);
      const row = { file: f, ...r, red: r.rc !== 0 };
      if (row.red) {
        if (baseTree === null) {
          baseTree = fs.mkdtempSync(path.join(os.tmpdir(), 'related-base-'));
          git(repo, ['worktree', 'add', '-q', '--detach', baseTree, base]);
        }
        if (!fs.existsSync(path.join(baseTree, f))) row.base = 'new';
        else {
          // The tip's node_modules first, then the caller's NODE_PATH (an audit tree with none of its own).
          const nodePath = [path.join(repo, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
          const b = run(baseTree, f, { NODE_PATH: nodePath });
          row.base = sameOnBase(r, b) ? 'same on base' : b.rc === 0 ? 'BRANCH RED' : `base differs: rc ${b.rc} fail ${b.fail}`;
        }
      }
      rows.push(row);
      log(`${row.red ? 'RED ' : 'ok  '} ${f} ${row.pass}/${row.fail}${row.base ? ` (${row.base})` : ''}`);
    }
  } finally {
    if (baseTree !== null) {
      try { git(repo, ['worktree', 'remove', '--force', baseTree]); } catch { fs.rmSync(baseTree, { recursive: true, force: true }); }
    }
  }
  const reds = rows.filter((r) => r.red);
  const same = reds.filter((r) => r.base === 'same on base').length;
  const branch = reds.length - same;
  const line = `light run: ${rows.length - reds.length} pass, ${reds.length} red (${same} same on base, ${branch} branch)`;
  return { rows, line, rc: branch > 0 ? 1 : 0 };
}

function parseArgs(argv) {
  const o = { repo: process.cwd(), run: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base' || a === '--tip' || a === '--repo') o[a.slice(2)] = argv[++i];
    else if (a === '--run') o.run = true;
    else if (a === '--json') o.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.base || !o.tip) throw new Error('usage: related-tests.cjs --base <sha> --tip <sha> [--repo <dir>] [--run] [--json]');
  return o;
}

function main(argv) {
  const o = parseArgs(argv);
  const repo = path.resolve(o.repo);
  const anc = spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', o.base, o.tip], { windowsHide: true });
  if (anc.status !== 0) throw new Error(`--base ${o.base} is not an ancestor of --tip ${o.tip}: pass the branch's base (git merge-base ${o.base} ${o.tip})`);
  const changed = git(repo, ['diff', '--name-only', '--diff-filter=d', `${o.base}..${o.tip}`]).split('\n').map((s) => s.trim()).filter(Boolean);
  const show = (rev) => { try { return git(repo, ['show', `${rev}:package.json`]); } catch { return ''; } };
  const pkg = changed.includes('package.json') ? packageDiff(show(o.base), show(o.tip)) : null;
  const read = (f) => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return null; } };
  const inventory = inventoryPaths(git(repo, ['diff', '--name-status', '-M', `${o.base}..${o.tip}`]), featureDirsOf(repo));
  const set = relatedSet({ changed, files: candidateFiles(repo), read, pkg, inventory });
  const line = summary(set, o.base, o.tip);
  const result = { base: o.base, tip: o.tip, ...set, summary: line };
  if (o.run) Object.assign(result, runLight({ repo, base: o.base, light: set.lanes.light, log: o.json ? () => {} : (s) => console.log(s) }));
  if (o.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const lane of ['light', 'heavy', 'electron', 'census', 'tools']) {
      if (set.lanes[lane].length) console.log(`${lane.toUpperCase()}: ${set.lanes[lane].join(' ')}`);
    }
    console.log(line);
    if (o.run) console.log(result.line);
  }
  return o.run ? result.rc : 0;
}

module.exports = { pathPatterns, namesViaDir, namedPaths, parseFailures, sameOnBase, packageDiff, packageNamed, laneOf, INVENTORY_TESTS, collectedPath, inventoryPaths, candidateFiles, relatedSet, summary, parseCounts, runFile, runLight, main };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(String(e.message || e)); process.exitCode = 2; }
}
