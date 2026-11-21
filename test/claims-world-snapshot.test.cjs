'use strict';
require('./tools/own-job.cjs');

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const { rmTree } = require('./tools/rm-tree.cjs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
function loadTs(relative) {
  const filename = path.resolve(ROOT, relative);
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  const localRequire = (specifier) => {
    if (!specifier.startsWith('.')) return require(specifier);
    const target = path.resolve(path.dirname(filename), specifier);
    const tsTarget = target.endsWith('.ts') ? target : `${target}.ts`;
    return fs.existsSync(tsTarget) ? loadTs(path.relative(ROOT, tsTarget)) : require(target);
  };
  new Function('exports', 'require', 'module', js)(loaded.exports, localRequire, loaded);
  return loaded.exports;
}
const { buildClaimsWorldSnapshot, runGit } = loadTs('src/main/claims/worldSnapshot.ts');
const { worldView } = loadTs('src/main/claims/world.ts');

function git(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com', ...env } }).trim();
}

// FLAKE-CLAIMS-WORLD-SNAPSHOT-34-108: the cell's verdicts must not hang on the wall clock. Under
// suite load the real git children could use up the product's 1.5 s snapshot deadline, or one
// child could outlive runGit's per-child timer (left(), so 1.5 s); either way the product rightly
// leaves that ref unknown (no flag), and the cell read it as '+ undefined - [changed-since]'.
// So the cell checks the snapshot's own logic on REAL git answers with no wall clock anywhere:
// a frozen now (no deadline) and an injected GitRunner with no timer. The transport (gitSafeCall,
// its timer, the kill, the 1 MB cap) is pinned in git-run-harden-108.test.cjs, and the deadline
// cut on an injected clock in claims-w4-delivery.test.cjs.

/** GitRunner contract (stdout on exit 0, else null, never throws) over the REAL git binary as an
 *  async child, with no timer: timeoutMs is ignored on purpose. No 1 MB stdout cap either: the
 *  repo is 2 files and 2 commits, so the output is a few lines. `calls` records every call and its
 *  real stdout; `onClose(args)` runs as each child closes. */
function realGitRunner(onClose = () => {}) {
  const calls = [];
  const run = (cwd, args, input) => new Promise((resolve) => {
    const call = { args: [...args], out: null };
    calls.push(call);
    let child;
    try { child = spawn('git', args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { resolve(null); return; }
    let stdout = '';
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; call.out = v; onClose(args); resolve(v); };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? stdout : null));
    child.stdin.on('error', () => { /* the child exited first */ });
    child.stdin.end(input);
  });
  return { run, calls };
}

async function worldCell(t, o = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-world-'));
  t.after(() => rmTree(cwd));
  git(cwd, ['init', '-q']);
  fs.writeFileSync(path.join(cwd, 'changed.txt'), 'before');
  fs.writeFileSync(path.join(cwd, 'touched.txt'), 'same');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-qm', 'baseline'], { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' });
  const existing = git(cwd, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(cwd, 'changed.txt'), 'after');
  git(cwd, ['add', 'changed.txt']);
  git(cwd, ['commit', '-qm', 'change'], { GIT_AUTHOR_DATE: '2026-02-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-02-01T00:00:00Z' });
  fs.utimesSync(path.join(cwd, 'touched.txt'), new Date('2026-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'));

  const since = '2026-01-15T00:00:00.000Z';
  const claims = [
    { v: 1, id: 'existing', t: 'claim', kind: 'fact', text: 'a', at: since, wt: since, agent: 'a', mac: 'm', prev: '', source: 'self', refs: [{ type: 'commit', value: existing }] },
    { v: 1, id: 'missing', t: 'claim', kind: 'fact', text: 'b', at: since, wt: since, agent: 'a', mac: 'm', prev: '', source: 'self', refs: [{ type: 'commit', value: '0'.repeat(40) }] },
    { v: 1, id: 'changed', t: 'claim', kind: 'fact', text: 'c', at: since, wt: since, agent: 'a', mac: 'm', prev: '', source: 'self', refs: [{ type: 'file', value: 'changed.txt' }] },
    { v: 1, id: 'touched', t: 'claim', kind: 'fact', text: 'd', at: since, wt: since, agent: 'a', mac: 'm', prev: '', source: 'self', refs: [{ type: 'file', value: 'touched.txt' }] },
  ];
  const state = { v: 1, agent: 'a', registryHash: '', ledgerHead: '', conflicts: [], claims: Object.fromEntries(claims.map(c => [c.id, { id: c.id, status: 'live', sightings: 1, firstAt: since, lastAt: since, pinned: false, reasons: [] }])) };
  // A test clock that never moves (the shared deadline cannot run out) and the timer-free real-git
  // runner (no per-child cut). The product's deadline/default stay as they are (deadlineMs is not set).
  const runner = realGitRunner(o.onClose);
  const clock = { now: () => 0, git: o.git ?? runner.run };
  const snapshot = await buildClaimsWorldSnapshot(claims, state, cwd, clock);
  if (!o.git) {
    // Jim MUST 2: the runner is real git, not a fake: it ran cat-file and log, and the 'changed'
    // verdict comes from real `git log --since` output naming the 'change' commit.
    const head = git(cwd, ['rev-parse', 'HEAD']);
    const cats = runner.calls.filter((c) => c.args[0] === 'cat-file');
    const logs = runner.calls.filter((c) => c.args[0] === 'log');
    assert.ok(cats.length >= 1 && logs.length >= 1, `runner ran cat-file (${cats.length}) and log (${logs.length})`);
    const changedLog = logs.find((c) => c.args.includes('changed.txt') && c.args.includes(`--since=${since}`));
    assert.equal(changedLog?.out?.trim(), head, 'the changed verdict is real git log --since output');
    assert.equal(snapshot.changedFiles.get(`changed.txt\0${since}`), true);
  }
  const world = { now: since, taskStatus: () => null, fileExists: p => fs.existsSync(path.join(cwd, p)), commitExists: sha => snapshot.commits.get(sha) ?? true, fileChangedSince: (p, at) => snapshot.changedFiles.get(`${p}\0${at}`) ?? false, cardOutcomes: {} };
  const view = worldView(state, claims, [], world);
  assert.equal(view.flags.existing, undefined);
  assert.deepEqual(view.flags.missing, ['stale-ref']);
  assert.deepEqual(view.flags.changed, ['changed-since']);
  assert.equal(view.flags.touched, undefined);

  const unknown = await buildClaimsWorldSnapshot(claims, state, path.join(cwd, 'not-a-repository'), clock);
  const unknownView = worldView(state, claims, [], { ...world, commitExists: sha => unknown.commits.get(sha) ?? true, fileChangedSince: (p, at) => unknown.changedFiles.get(`${p}\0${at}`) ?? false });
  assert.equal(unknownView.flags.existing, undefined);
  assert.equal(unknownView.flags.missing, undefined);
  assert.equal(unknownView.flags.changed, undefined);
}

test('async world snapshot confirms refs, flags missing refs and git changes, and ignores unknown/touch-only state', async (t) => {
  await worldCell(t);
});

test('FLAKE-34: the same cell holds when the wall clock jumps past the snapshot deadline right after the first git call (cat-file)', async (t) => {
  // A loaded machine, made exact: the moment the runner's cat-file child closes, Date.now() is 10 s
  // later. The deadline is no longer this cell's input, so the cell stays green.
  const realNow = Date.now;
  let jumped = false;
  let catFiles = 0;
  const onClose = (args) => { if (args[0] === 'cat-file') { catFiles++; jumped = true; } };
  Date.now = () => realNow() + (jumped ? 10_000 : 0);
  try { await worldCell(t, { onClose }); }
  finally { Date.now = realNow; }
  assert.ok(catFiles >= 1, `the jump hook saw the cat-file child (${catFiles})`);
});

test('FLAKE-34 (Jim MUST 1): the cell would go red if it hung on the per-child timer: log through the real runGit with timeoutMs 1 leaves changed-since undefined', async (t) => {
  // cat-file goes through the timer-free runner, so the only cut is the per-child timer on log.
  const own = realGitRunner();
  const git = (cwd, args, input, timeoutMs) => (args[0] === 'log' ? runGit(cwd, args, input, 1) : own.run(cwd, args, input, timeoutMs));
  await assert.rejects(worldCell(t, { git }), (e) => {
    assert.equal(e.code, 'ERR_ASSERTION', String(e));
    assert.equal(e.actual, undefined, '+ undefined');
    assert.deepEqual(e.expected, ['changed-since']);
    return true;
  });
});
