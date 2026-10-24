'use strict';
require('./tools/own-job.cjs');
// @heavy-lock live: sustained work: real git worktrees and junctions. One run of this file takes the heavy slot.
/**
 * RELEASE-WORKTREE-PRUNE (1.1.98): scripts/release-worktrees.cjs, step 8 of docs/release-checklist.md.
 * - The pure parts: who holds the heavy lock for a cut, which processes are a cut, the overlay on
 *   the reaper's plan, the dist-vs-release digest check, the model cache check and seed.
 * - main() on a REAL fixture under a temp folder: a git repo with tags v1.1.94..97, cut trees as
 *   detached worktrees at those tags (package.json version, dist, a junctioned node_modules), a
 *   non-cut worktree, a hive log and a fake gh. Never the live _work, never the real gh or hive.
 * Census: test/tools/release-worktrees-mutants.cjs (each mutant must die at its named test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const P = require(path.join(__dirname, '..', 'scripts', 'release-worktrees.cjs'));
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];   // never the caller's repo
delete process.env.HIVE_ROOT;   // never the live hive log
const DAY = 24 * 60 * 60 * 1000;
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'relprune-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const write = (p, s = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const link = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ─── Heavy lock and processes (pure) ─────────────────────────────────────────

const NOW = 100 * DAY;
const acq = (agentId, heavyKind, command, ts = NOW - 60_000) => ({ ts, kind: 'heavy-lock', action: 'acquire', agentId, heavyKind, command });

test('cutHolds: an install or build holder is a cut; a bench holder only with a cut command', () => {
  assert.deepEqual(P.cutHolds([acq('creed', 'install', 'npm ci')], NOW).map((h) => h.agentId), ['creed']);
  assert.deepEqual(P.cutHolds([acq('creed', 'build', 'bash run.sh')], NOW).map((h) => h.agentId), ['creed']);
  assert.deepEqual(P.cutHolds([acq('jim', 'bench', 'node --test test/a.test.cjs')], NOW), []);
  assert.deepEqual(P.cutHolds([acq('jim', 'suite', 'cd x && npm run cut:win')], NOW).map((h) => h.agentId), ['jim']);
});

test('cutHolds: release frees, app-start clears, an untouched holder lapses, a reenter refreshes', () => {
  assert.deepEqual(P.cutHolds([acq('creed', 'install', 'npm ci'), { ts: NOW - 1000, kind: 'heavy-lock', action: 'release', agentId: 'creed' }], NOW), []);
  assert.deepEqual(P.cutHolds([acq('creed', 'install', 'npm ci'), { ts: NOW - 1000, kind: 'app-start' }], NOW), []);
  const old = NOW - P.HEAVY_TTL_MS - 1;
  assert.deepEqual(P.cutHolds([acq('creed', 'install', 'npm ci', old)], NOW), []);
  assert.equal(P.cutHolds([acq('creed', 'install', 'npm ci', old), { ts: NOW - 1000, kind: 'heavy-lock', action: 'reenter', agentId: 'creed', heavyKind: 'install' }], NOW).length, 1);
  // a reenter whose acquire rotated out of the log still holds
  assert.equal(P.cutHolds([{ ts: NOW - 1000, kind: 'heavy-lock', action: 'reenter', agentId: 'dwight', heavyKind: 'build', command: 'npm run dist:win' }], NOW).length, 1);
});

test('cutHolds: this prune\'s own hold is not a cut', () => {
  assert.deepEqual(P.cutHolds([acq('andy', 'build', 'npm run cut:prune -- --root C:/w --apply')], NOW), []);
});

test('cutProcesses: npm ci, electron-builder and the cut script are cuts; this process and the prune are not', () => {
  const procs = [
    { pid: 1, commandLine: '"node.exe" "C:\\npm\\bin\\npm-cli.js" ci' },
    { pid: 2, commandLine: 'node node_modules/electron-builder/cli.js --win' },
    { pid: 3, commandLine: 'node scripts/cut-cmd-natives.cjs' },
    { pid: 4, commandLine: 'npm.cmd ci' },
    { pid: 5, commandLine: 'node scripts/release-worktrees.cjs --root C:/w' },
    { pid: 6, commandLine: 'node --test test/a.test.cjs' },
    { pid: 7, commandLine: 'node scripts/cut-cmd-natives.cjs' }
  ];
  assert.deepEqual(P.cutProcesses(procs, 7).map((p) => p.pid), [1, 2, 3, 4]);
});

// ─── The overlay on the reaper's plan (pure) ─────────────────────────────────

test('planCutPrune: a reaped tree stays only if verified; kept rows are never verified', () => {
  const rows = [
    { name: 'a', path: path.resolve('/w/a'), kind: 'worktree', action: 'reap', reason: 'shipped' },
    { name: 'b', path: path.resolve('/w/b'), kind: 'worktree', action: 'reap', reason: 'shipped' },
    { name: 'c', path: path.resolve('/w/c'), kind: 'worktree', action: 'keep', reason: 'newest-two-shipped' },
    { name: 'd', path: path.resolve('/w/d'), kind: 'folder', action: 'reap', reason: 'obsolete-build-folder' },
    { name: 'e', path: path.resolve('/w/e'), kind: 'worktree', action: 'reap', reason: 'shipped' }
  ];
  const asked = [];
  const plan = P.planCutPrune(rows, { verify: (r) => { asked.push(r.name); return r.name === 'a' ? { ok: true, why: '3 assets = release' } : { ok: false, why: 'dist differs' }; }, own: [path.resolve('/w/e/scripts')] });
  assert.deepEqual(plan.map((r) => [r.name, r.action]), [['a', 'reap'], ['b', 'keep'], ['c', 'keep'], ['d', 'keep'], ['e', 'keep']]);
  assert.match(plan[1].reason, /^unverified: dist differs/);
  assert.equal(plan[3].reason, 'not-a-worktree');
  assert.equal(plan[4].reason, 'own-tree');
  assert.deepEqual(asked, ['a', 'b']);
});

// ─── dist against the release ────────────────────────────────────────────────

test('verifyTree: every setup.exe, blockmap and latest.yml must equal the release digest', () => {
  const dir = path.join(JAIL, 'vt');
  write(path.join(dir, 'dist', 'G-1-setup.exe'), 'EXE'); write(path.join(dir, 'dist', 'G-1-setup.exe.blockmap'), 'MAP'); write(path.join(dir, 'dist', 'latest.yml'), 'YML');
  const assets = { 'G-1-setup.exe': sha('EXE'), 'G-1-setup.exe.blockmap': sha('MAP'), 'latest.yml': sha('YML'), 'G-1-portable.exe': sha('other') };
  assert.equal(P.verifyTree(dir, assets).ok, true);
  assert.match(P.verifyTree(dir, { ...assets, 'latest.yml': sha('NEW') }).why, /latest\.yml: dist differs/);
  assert.match(P.verifyTree(dir, { ...assets, 'G-1-setup.exe.blockmap': null }).why, /no sha256 digest/);
  const noExe = { ...assets }; delete noExe['G-1-setup.exe'];
  assert.match(P.verifyTree(dir, noExe).why, /no setup\.exe/);
  const noYml = { ...assets }; delete noYml['latest.yml'];
  assert.match(P.verifyTree(dir, noYml).why, /no latest\.yml/);
  fs.rmSync(path.join(dir, 'dist', 'G-1-setup.exe.blockmap'));
  assert.match(P.verifyTree(dir, assets).why, /blockmap: not in dist/);
});

// ─── Model cache ─────────────────────────────────────────────────────────────

const MANIFEST = { model: { dir: 'mini', files: { 'onnx/model.onnx': sha('ONNX'), 'tokenizer.json': sha('TOK') } } };
const model = (dir, onnx = 'ONNX') => { write(path.join(dir, 'onnx', 'model.onnx'), onnx); write(path.join(dir, 'tokenizer.json'), 'TOK'); return dir; };

test('verifyModel / seedModel: a bad source is skipped, the copy is verified', () => {
  const bad = model(path.join(JAIL, 'm-bad'), 'WRONG');
  const good = model(path.join(JAIL, 'm-good'));
  const cache = path.join(JAIL, 'm-cache', 'mini');
  assert.match(P.verifyModel(cache, MANIFEST).why, /missing/);
  assert.match(P.verifyModel(bad, MANIFEST).why, /onnx\/model\.onnx: sha256 differs/);
  const s = P.seedModel(cache, MANIFEST, [path.join(JAIL, 'nowhere'), bad, good]);
  assert.equal(s.from, good);
  assert.equal(P.verifyModel(cache, MANIFEST).ok, true);
  assert.equal(P.seedModel(path.join(JAIL, 'm-cache2', 'mini'), MANIFEST, [bad]).ok, false);
});

// ─── main() on a real fixture ────────────────────────────────────────────────

function fixture(tag) {
  const base = path.join(JAIL, tag); const repo = path.join(base, 'repo'); const work = path.join(base, 'work'); const hive = path.join(base, 'hive');
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(work); fs.mkdirSync(hive);
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't'); git(repo, 'config', 'core.autocrlf', 'false');
  write(path.join(repo, '.gitignore'), 'dist/\nnode_modules\nresources/models/*/\n');
  for (const v of [94, 95, 96, 97]) {
    write(path.join(repo, 'package.json'), JSON.stringify({ name: 'g', version: `1.1.${v}` }));
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', `v${v}`); git(repo, 'tag', `v1.1.${v}`);
  }
  git(repo, 'checkout', '-q', '-b', 'topic');
  const releases = {};
  const cut = (name, v, { exe = `EXE${v}`, junction = null, models = false } = {}) => {
    const p = path.join(work, name);
    git(repo, 'worktree', 'add', '-q', '--detach', p, `v1.1.${v}`);
    write(path.join(p, 'dist', `G-1.1.${v}-setup.exe`), exe); write(path.join(p, 'dist', `G-1.1.${v}-setup.exe.blockmap`), `MAP${v}`); write(path.join(p, 'dist', 'latest.yml'), `YML${v}`);
    if (junction) link(junction, path.join(p, 'node_modules'));
    if (models) model(path.join(p, 'resources', 'models', 'mini'));
    return p;
  };
  for (const v of [94, 95, 96, 97]) releases[`v1.1.${v}`] = { [`G-1.1.${v}-setup.exe`]: sha(`EXE${v}`), [`G-1.1.${v}-setup.exe.blockmap`]: sha(`MAP${v}`), 'latest.yml': sha(`YML${v}`) };
  const shared = path.join(base, 'shared-deps');
  write(path.join(shared, 'dep', 'index.js'), 'KEEP ME');
  cut('cut194', 94, { junction: shared });
  cut('cut195', 95);
  cut('cut195b', 95, { exe: 'RECUT' });
  cut('cut196', 96);
  cut('cut197', 97, { models: true });
  cut('recut-latest', 97);   // no version in its name: package.json says 1.1.97, the newest shipped
  git(repo, 'worktree', 'add', '-q', '-b', 'fix/195-x', path.join(work, 'fix-195'), 'v1.1.95');   // not a cut tree: no dist
  write(path.join(hive, 'log.jsonl'), '');
  const manifest = path.join(base, 'manifest.json'); write(manifest, JSON.stringify(MANIFEST));
  const now = Date.now() + 2 * DAY;
  const args = ['--root', work, '--repo', repo, '--release-repo', 'o/r', '--hive', hive, '--now', String(now)];
  const deps = { manifest, gh: (t) => { if (!releases[t]) throw new Error(`release not found: ${t}`); return releases[t]; }, procs: () => [], exes: () => [] };
  return { repo, work, hive, shared, args, deps, cache: path.join(work, 'release-cache', 'models', 'mini') };
}
const rowsOf = (r) => Object.fromEntries(r.plan.map((x) => [x.name, [x.action, x.reason]]));

test('main dry run: prunes only verified, older cut trees; prints the cache; removes nothing', () => {
  const fx = fixture('dry');
  const lines = [];
  const r = P.main(fx.args, (s) => lines.push(s), fx.deps);
  const rows = rowsOf(r);
  assert.deepEqual(Object.keys(rows).sort(), ['cut194', 'cut195', 'cut195b', 'cut196', 'cut197', 'recut-latest']);   // fix-195 is not a cut tree
  assert.equal(rows.cut194[0], 'reap'); assert.equal(rows.cut195[0], 'reap');
  assert.deepEqual(rows.cut195b, ['keep', 'unverified: G-1.1.95-setup.exe: dist differs from the release']);
  assert.deepEqual(rows.cut196, ['keep', 'newest-two-shipped']);
  assert.deepEqual(rows.cut197, ['keep', 'newest-two-shipped']);
  assert.deepEqual(rows['recut-latest'], ['keep', 'newest-two-shipped']);
  assert.equal(r.results, null);
  assert.ok(fs.existsSync(path.join(fx.work, 'cut195', 'dist')));
  assert.ok(lines.some((l) => l === `MODEL CACHE\tNOT VERIFIED\t${fx.cache}\tonnx/model.onnx: missing`), lines.join('\n'));
  assert.ok(!fs.existsSync(fx.cache), 'a dry run writes no cache');
  assert.ok(lines.at(-1).endsWith(`MUNDER_MODEL_CACHE=${fx.cache}`));
  // --seed-cache fills and verifies the cache; still a dry run with nothing in its way
  const seeded = P.main([...fx.args, '--seed-cache'], () => {}, fx.deps);
  assert.equal(seeded.cache.ok, true); assert.equal(P.verifyModel(fx.cache, MANIFEST).ok, true);
  assert.equal(seeded.refused, null); assert.equal(seeded.results, null);
  for (const n of ['cut194', 'cut195']) assert.ok(fs.existsSync(path.join(fx.work, n, 'dist')), n);
});

test("main: a cut tree of a second --repo (the cuts' clone) is judged only when named", () => {
  const fx = fixture('repos');
  const clone = path.join(path.dirname(fx.repo), 'clone');
  git(path.dirname(fx.repo), 'clone', '-q', fx.repo, clone);
  const p = path.join(fx.work, 'clone-cut194');
  git(clone, 'worktree', 'add', '-q', '--detach', p, 'v1.1.94');
  write(path.join(p, 'dist', 'G-1.1.94-setup.exe'), 'EXE94'); write(path.join(p, 'dist', 'G-1.1.94-setup.exe.blockmap'), 'MAP94'); write(path.join(p, 'dist', 'latest.yml'), 'YML94');
  assert.equal(rowsOf(P.main(fx.args, () => {}, fx.deps))['clone-cut194'][1], 'not-a-candidate');
  const both = rowsOf(P.main([...fx.args, '--repo', clone], () => {}, fx.deps));
  assert.deepEqual(both['clone-cut194'][0], 'reap');
  assert.deepEqual(both.cut195[0], 'reap');
});

test('main: gh that cannot answer keeps every tree (fail closed)', () => {
  const fx = fixture('gh');
  const r = P.main(fx.args, () => {}, { ...fx.deps, gh: () => { throw new Error('HTTP 401: Bad credentials'); } });
  assert.deepEqual(r.plan.filter((x) => x.action === 'reap'), []);
  assert.match(rowsOf(r).cut195[1], /^unverified: gh release v1\.1\.95: HTTP 401/);
});

test('main --apply refuses while a cut holds the heavy lock (log or newest rotated log), a cut process runs, or no hive is known', () => {
  const fx = fixture('held');
  const at = Number(fx.args[fx.args.indexOf('--now') + 1]) - 60_000;
  const held = (agentId) => JSON.stringify({ ts: at, kind: 'heavy-lock', action: 'acquire', agentId, heavyKind: 'install', command: 'npm ci' }) + '\n';
  fs.writeFileSync(path.join(fx.hive, 'log.jsonl'), held('creed'));
  const lines = [];
  const r = P.main([...fx.args, '--apply'], (s) => lines.push(s), fx.deps);
  assert.match(r.refused, /a cut may be in progress: heavy lock held by creed \(install: npm ci\)/);
  assert.equal(r.results, null);
  assert.ok(fs.existsSync(path.join(fx.work, 'cut195')));
  assert.ok(lines.some((l) => l.startsWith('REFUSED\t')));
  assert.ok(!fs.existsSync(fx.cache), 'a refused apply seeds no cache (cut197 has the model)');
  // the acquire was before the 8 MB rotation: only the NEWEST rotated log is replayed
  fs.writeFileSync(path.join(fx.hive, 'log.jsonl'), '');
  fs.writeFileSync(path.join(fx.hive, 'log.900.jsonl'), held('stale'));
  fs.writeFileSync(path.join(fx.hive, 'log.1000.jsonl'), held('creed'));
  const rot = P.main([...fx.args, '--apply'], () => {}, fx.deps);
  assert.match(rot.refused, /heavy lock held by creed/); assert.doesNotMatch(rot.refused, /stale/);
  for (const n of ['log.900.jsonl', 'log.1000.jsonl']) fs.rmSync(path.join(fx.hive, n));
  // no --hive and no HIVE_ROOT: the lock cannot be checked, so --apply refuses and the dry run says so
  const noHive = fx.args.filter((a, i, all) => a !== '--hive' && all[i - 1] !== '--hive');
  const out = [];
  assert.equal(P.main(noHive, (s) => out.push(s), fx.deps).refused, null);
  assert.ok(out.includes('HEAVY\tCUT MAY BE IN PROGRESS: no hive known (--hive <hive> or HIVE_ROOT): heavy lock unknown'), out.join('\n'));
  assert.match(P.main([...noHive, '--apply'], () => {}, fx.deps).refused, /no hive known/);
  const p = P.main([...fx.args, '--apply'], () => {}, { ...fx.deps, procs: () => [{ pid: 42, commandLine: 'node node_modules/electron-builder/cli.js --win' }] });
  assert.match(p.refused, /cut process 42/);
  const noLog = P.main([...fx.args.filter((a, i, all) => a !== '--hive' && all[i - 1] !== '--hive'), '--hive', path.join(fx.hive, 'missing'), '--apply'], () => {}, fx.deps);
  assert.match(noLog.refused, /no hive log under .*: heavy lock unknown/);
  const ps = P.main([...fx.args, '--apply'], () => {}, { ...fx.deps, procs: () => { throw new Error('WMI down'); } });
  assert.match(ps.refused, /cannot list processes: WMI down/);
  assert.ok(fs.existsSync(path.join(fx.work, 'cut195')));
});

test('main: every link under --root outside the cut trees protects its target (audit-tree junctions, top-level links, --protect)', () => {
  const fx = fixture('links');
  write(path.join(fx.work, 'cut195', 'node_modules', 'dep', 'index.js'), 'CUT195 DEPS');
  assert.deepEqual(rowsOf(P.main([...fx.args, '--protect', path.join(fx.work, 'cut195', 'dist')], () => {}, fx.deps)).cut195, ['keep', 'junction-target']);
  // fix-195 (a worktree, not a cut) borrows cut195's node_modules; a top-level alias links to cut194
  link(path.join(fx.work, 'cut195', 'node_modules'), path.join(fx.work, 'fix-195', 'node_modules'));
  link(path.join(fx.work, 'cut194'), path.join(fx.work, 'alias194'));
  const rows = rowsOf(P.main(fx.args, () => {}, fx.deps));
  assert.deepEqual(rows.cut195, ['keep', 'junction-target']); assert.deepEqual(rows.cut194, ['keep', 'junction-target']);
  assert.equal(rows.alias194, undefined);   // a link is never a cut tree
  const r = P.main([...fx.args, '--apply'], () => {}, fx.deps);
  assert.equal(r.refused, null);
  assert.deepEqual(r.results.filter((x) => x.name !== '(git worktree prune)'), []);
  assert.equal(fs.readFileSync(path.join(fx.work, 'fix-195', 'node_modules', 'dep', 'index.js'), 'utf8'), 'CUT195 DEPS');
  assert.ok(fs.existsSync(path.join(fx.work, 'alias194', 'dist')));
});

test('main --apply refuses when the model cache cannot be verified', () => {
  const fx = fixture('nocache');
  fs.rmSync(path.join(fx.work, 'cut197', 'resources', 'models'), { recursive: true });
  const r = P.main([...fx.args, '--apply'], () => {}, fx.deps);
  assert.match(r.refused, /^model cache .* not verified: no verified source/);
  assert.ok(fs.existsSync(path.join(fx.work, 'cut194')));
});

test('main --apply: seeds the cache, removes verified old trees, never through a junction', () => {
  const fx = fixture('apply');
  const r = P.main([...fx.args, '--apply'], () => {}, fx.deps);
  assert.equal(r.refused, null);
  assert.equal(r.cache.ok, true); assert.equal(P.verifyModel(fx.cache, MANIFEST).ok, true);
  assert.deepEqual(r.results.filter((x) => x.name !== '(git worktree prune)').map((x) => [x.name, x.result]).sort(), [['cut194', 'deleted'], ['cut195', 'deleted']]);
  for (const n of ['cut194', 'cut195']) assert.ok(!fs.existsSync(path.join(fx.work, n)), n);
  for (const n of ['cut195b', 'cut196', 'cut197', 'fix-195']) assert.ok(fs.existsSync(path.join(fx.work, n)), n);
  assert.equal(fs.readFileSync(path.join(fx.shared, 'dep', 'index.js'), 'utf8'), 'KEEP ME');
  const listed = git(fx.repo, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => path.basename(l.slice(9)));
  assert.deepEqual(listed.filter((n) => n !== 'repo').sort(), ['cut195b', 'cut196', 'cut197', 'fix-195', 'recut-latest']);
});

test('cli: usage and unknown arguments', () => {
  assert.throws(() => P.main([], () => {}), /usage/);
  assert.throws(() => P.main(['--root', 'x', '--force'], () => {}), /unknown argument: --force/);
});
