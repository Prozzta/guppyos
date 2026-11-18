'use strict';
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE: this suite loads scripts/release-worktrees.cjs, a file a census mutates in
// place (one load-ts never sees); refuse a tree a killed census left mutated.
require('./tools/mutant-runner-helper.cjs').gate(__filename);

/**
 * ELECTRON-RMSYNC-LINK-SAFE-108: four places removed a folder with a recursive rmSync. Under
 * Electron 45 (the runtime the app's main process and its release scripts' Electron-as-Node runs
 * have) that deletes THROUGH a Windows junction: the files the link points at go too. Plain Node
 * removes the link only, so a test in this process alone cannot see the defect.
 *
 * Each site therefore runs twice on the same fixture: here, and in the installed Guppy.exe as
 * Node (ELECTRON_RUN_AS_NODE=1, electron-rmsync-link-safe-child.cjs). Every fixture is under one
 * temp folder; the "live" folders the links point at are in it too.
 *
 *   skills.ts uninstallSkill          the real function
 *   release-worktrees.cjs seedModel   the real function
 *   index.ts removeWorkerScratch      index.ts cannot be loaded here: the call it makes
 *   index.ts app:resetAll             (removePathLinkSafe) is run on the folder the site
 *                                     removes, and the site is pinned to make and await it
 *
 * MUTANTS (each kills the test named beside it):
 *   M1 skills.ts: rmSync(target, recursive) again              -> skills, Electron
 *   M2 release-worktrees.cjs: fs.rmSync(tmp, recursive) again  -> seed-model, Electron
 *   M3 release-worktrees.cjs: fs.rmSync(cacheDir, ...) again   -> seed-model, Electron
 *   M4 index.ts removeWorkerScratch: rmSync(dir, ...) again    -> WIRING worker scratch
 *   M5 index.ts reset: rmSync(hiveDir, ...) again              -> WIRING reset
 *   M6 linkSafeRemove.ts removePathLinkSafe: a recursive rmSync -> worker-scratch and reset, Electron
 *   M7 linkSafeRemove.ts removePathLinkSafeSync: the same      -> seed-model, Electron
 *   M8 index.ts: removeWorkerScratch is not awaited            -> WIRING worker scratch
 *
 * RUNTIME PIN: what the runtime's own recursive rm does to a path that IS a junction, with no
 * product code in the way. It is the measurement the remover's design rests on, so a new
 * Electron that behaves differently turns it red and the remover is looked at again.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const child = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./electron-rmsync-link-safe-child.cjs');

const jail = fs.mkdtempSync(path.join(os.tmpdir(), 'rmsync-link-safe-'));
// The jail holds junctions when a test fails half way: remove them as links before the folder.
test.after(() => {
  const walk = (p) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { try { fs.rmdirSync(p); } catch { fs.unlinkSync(p); } return; }
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n));
  };
  walk(jail);
  fs.rmSync(jail, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const link = (target, at) => { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.symlinkSync(target, at, 'junction'); };
/** A folder outside what the site removes, holding one file. */
const live = (base, name) => { const d = path.join(base, 'live', name); write(path.join(d, 'keep.txt'), `live ${name}`); return d; };
const assertLive = (base, names) => {
  for (const name of names) {
    const f = path.join(base, 'live', name, 'keep.txt');
    assert.equal(fs.existsSync(f) && fs.readFileSync(f, 'utf8'), `live ${name}`, `THE LINK TARGET live/${name} SURVIVES WITH ITS FILE`);
  }
};

const MODEL_FILES = { 'onnx/model.onnx': 'ONNX', 'tokenizer.json': 'TOK' };
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** site -> { build(base), check(base, out) }. build makes the fixture; check is what must hold after. */
const SITES = {
  skills: {
    build(base) {
      const skills = path.join(base, 'proj', '.claude', 'skills');
      // A skill installed as a junction to a folder elsewhere.
      write(path.join(live(base, 'skill'), 'SKILL.md'), '# linked skill');
      link(path.join(base, 'live', 'skill'), path.join(skills, 'linked'));
      // A real skill folder with a junction inside it, two levels down.
      write(path.join(skills, 'real', 'SKILL.md'), '# real skill');
      write(path.join(skills, 'real', 'notes', 'a.txt'), 'a');
      link(live(base, 'assets'), path.join(skills, 'real', 'notes', 'assets'));
    },
    check(base, out) {
      const skills = path.join(base, 'proj', '.claude', 'skills');
      assert.deepEqual(out, { linked: { ok: true }, real: { ok: true } });
      assert.equal(fs.existsSync(path.join(skills, 'linked')), false, 'the linked skill is gone from the skills folder');
      assert.equal(fs.existsSync(path.join(skills, 'real')), false, 'the real skill folder is gone');
      assert.equal(fs.existsSync(skills), true, 'the skills folder itself stays');
      assertLive(base, ['skill', 'assets']);
      assert.equal(fs.readFileSync(path.join(base, 'live', 'skill', 'SKILL.md'), 'utf8'), '# linked skill', 'the linked skill\'s own files are untouched');
    }
  },
  'worker-scratch': {
    build(base) {
      const dir = path.join(base, 'hive', 'agents', 'worker-1');
      write(path.join(dir, 'memory.md'), 'notes'); write(path.join(dir, 'outbox', 'm.json'), '{}');
      link(live(base, 'shared'), path.join(dir, 'node_modules'));
      link(live(base, 'scoped'), path.join(dir, 'work', 'node_modules', '@scope', 'pkg'));
      write(path.join(base, 'hive', 'agents', 'worker-2', 'memory.md'), 'other');
    },
    check(base) {
      assert.equal(fs.existsSync(path.join(base, 'hive', 'agents', 'worker-1')), false, 'the worker\'s folder is gone');
      assert.equal(fs.readFileSync(path.join(base, 'hive', 'agents', 'worker-2', 'memory.md'), 'utf8'), 'other', 'another worker\'s folder is untouched');
      assertLive(base, ['shared', 'scoped']);
    }
  },
  reset: {
    build(base) {
      const hive = path.join(base, 'hive');
      write(path.join(hive, 'board.md'), 'board'); write(path.join(hive, 'agents', 'a', 'memory.md'), 'notes');
      link(live(base, 'modules'), path.join(hive, 'agents', 'a', 'node_modules'));
      link(live(base, 'cache'), path.join(hive, 'cache'));
      // A hive root that is itself a junction to a folder elsewhere.
      link(live(base, 'linked-hive'), path.join(base, 'hive-link'));
    },
    check(base) {
      assert.equal(fs.existsSync(path.join(base, 'hive')), false, 'the hive is gone');
      assert.equal(fs.existsSync(path.join(base, 'hive-link')), false, 'a hive root that is a link is gone, as a link');
      assertLive(base, ['modules', 'cache', 'linked-hive']);
    }
  },
  'seed-model': {
    build(base) {
      const manifest = { model: { dir: 'mini', files: Object.fromEntries(Object.entries(MODEL_FILES).map(([rel, text]) => [rel, sha(text)])) } };
      write(path.join(base, 'manifest.json'), JSON.stringify(manifest));
      for (const [rel, text] of Object.entries(MODEL_FILES)) write(path.join(base, 'src-model', ...rel.split('/')), text);
      // An old cache: a real folder with a stale file and a junction inside it. (The child adds a
      // left-over `<cache>.seeding-<its pid>` folder holding a junction to live/stale.)
      write(path.join(base, 'cache', 'mini', 'onnx', 'model.onnx'), 'OLD');
      link(live(base, 'old'), path.join(base, 'cache', 'mini', 'onnx', 'old'));
      live(base, 'stale');
      // An old cache that is itself a junction to a folder elsewhere.
      link(live(base, 'cache-target'), path.join(base, 'cache-linked', 'mini'));
    },
    check(base, out) {
      assert.deepEqual([out.real.ok, out.linked.ok, out.verifyReal.ok, out.verifyLinked.ok], [true, true, true, true], 'both caches were seeded and verify');
      assert.equal(out.tmpLeft, false, 'the seeding folder was renamed into place');
      for (const dir of [path.join(base, 'cache', 'mini'), path.join(base, 'cache-linked', 'mini')]) {
        assert.equal(fs.lstatSync(dir).isSymbolicLink(), false, `${dir} is a real folder now`);
        assert.deepEqual(fs.readdirSync(path.join(dir, 'onnx')), ['model.onnx'], 'only the model, nothing of the old cache');
        assert.equal(fs.readFileSync(path.join(dir, 'onnx', 'model.onnx'), 'utf8'), 'ONNX');
      }
      assertLive(base, ['stale', 'old', 'cache-target']);
      assert.deepEqual(fs.readdirSync(path.join(base, 'live', 'cache-target')), ['keep.txt'], 'nothing was seeded through the link');
    }
  }
};

// The runner jails LOCALAPPDATA; the shared helper finds the installed app read-only or gives a skip reason.
const guppy = require('./tools/installed-guppy.cjs').installedGuppy();
const exe = guppy.exe;
/** Run one child site in the installed Guppy.exe as Node; what it returned. */
const inElectron = (site, base) => {
  assert.equal(fs.existsSync(exe), true, `installed Guppy executable missing: ${exe}`);
  const r = child.spawnSync(exe, [path.join(__dirname, 'electron-rmsync-link-safe-child.cjs'), site, base],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.equal(r.status, 0, `child exit ${r.status}: ${r.stderr || r.stdout}`);
  const res = JSON.parse(r.stdout);
  assert.equal(res.ok, true, res.error);
  assert.match(res.electron, /^\d+\./, 'the child really ran in Electron');
  return res.out;
};

for (const [site, { build, check }] of Object.entries(SITES)) {
  test(`${site}: links are removed as links, their targets survive (this process)`, async () => {
    const base = path.join(jail, `${site}-node`);
    build(base);
    check(base, await run(site, base));
  });

  test(`${site}: links are removed as links, their targets survive, in the installed Electron as Node`, { skip: guppy.skip }, () => {
    const base = path.join(jail, `${site}-electron`);
    build(base);
    check(base, inElectron(site, base));
  });
}

// ─── RUNTIME PIN: the runtime's own recursive rm on a path that is a junction ────────────────────

const buildRuntimeRm = (base) => {
  for (const name of ['sync', 'async']) {
    write(path.join(live(base, name), 'sub', 'x.txt'), 'x');
    link(path.join(base, 'live', name), path.join(base, `link-${name}`));
  }
};
const UNTOUCHED = ['keep.txt', 'sub'];

test('RUNTIME PIN, plain Node: a recursive rm of a junction removes the link only, sync and async', async () => {
  const base = path.join(jail, 'runtime-rm-node');
  buildRuntimeRm(base);
  assert.deepEqual(await run('runtime-rm', base), {
    sync: { linkGone: true, target: UNTOUCHED },
    async: { linkGone: true, target: UNTOUCHED }
  });
});

test('RUNTIME PIN, installed Electron as Node: rmSync EMPTIES the junction\'s target; fs.promises.rm removes the link only', { skip: guppy.skip }, () => {
  const base = path.join(jail, 'runtime-rm-electron');
  buildRuntimeRm(base);
  const out = inElectron('runtime-rm', base);
  // Measured on Electron 45.3.0. If either line changes with a new Electron, read
  // src/main/linkSafeRemove.ts again before changing the pin: its link handling exists because of the
  // first line, and is kept on the async path whatever the second says.
  assert.deepEqual(out.sync, { linkGone: true, target: [] }, 'rmSync(recursive) on a junction deletes what the link points at');
  assert.deepEqual(out.async, { linkGone: true, target: UNTOUCHED }, 'fs.promises.rm(recursive) on a junction leaves the target alone');
});

// ─── WIRING: the two index.ts sites make the call run above ──────────────────────────────────────

// Line endings are normalised: a Windows checkout has CRLF.
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');
const slice = (from, to) => {
  const a = INDEX.indexOf(from); assert.ok(a >= 0, `index.ts has ${from}`);
  const b = INDEX.indexOf(to, a); assert.ok(b > a, `${from} ends`);
  return INDEX.slice(a, b);
};

test('WIRING worker scratch: removeWorkerScratch removes its folder with removePathLinkSafe, awaited, never a recursive rmSync', () => {
  const body = slice('async function removeWorkerScratch(workerId: string): Promise<void> {', '\n}\n');
  assert.match(body, /try \{ await removePathLinkSafe\(dir\); \}/);
  assert.doesNotMatch(body, /rmSync\(/);
  // Both callers wait for it: the sweep drops its record of the worker only after the folder is gone.
  const calls = INDEX.match(/^.*\bremoveWorkerScratch\(e\.workerId\);/gm) ?? [];
  assert.deepEqual(calls.map((c) => c.trim()), ['await removeWorkerScratch(e.workerId);', 'await removeWorkerScratch(e.workerId);']);
});

test('WIRING reset: app:resetAll removes the hive with removePathLinkSafe, awaited, never a recursive rmSync', () => {
  const body = slice("ipcMain.handle('app:resetAll', async () => {", '\n});\n');
  assert.match(body, /try \{ await removePathLinkSafe\(hiveDir\); \}/);
  assert.doesNotMatch(body, /rmSync\(/);
});

test('WIRING: index.ts and skills.ts import the remover from linkSafeRemove, which uses fsSafeRemove and has no tree walk of its own', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', ...rel.split('/')), 'utf8');
  for (const rel of ['src/main/index.ts', 'src/main/skills.ts']) {
    assert.match(read(rel), /import \{ removePathLinkSafe \} from '\.\/linkSafeRemove';/, rel);
  }
  const mod = read('src/main/linkSafeRemove.ts');
  assert.match(mod, /import \{ removeReparsePoint, removeReparsePointSync, safeRemoveTree, safeRemoveTreeSync \} from '\.\/fsSafeRemove';/);
  // The code after the header comment (the comment names the recursive rmSync it replaces).
  const code = mod.slice(mod.indexOf('*/'));
  assert.doesNotMatch(code, /recursive|readdir/);
});
