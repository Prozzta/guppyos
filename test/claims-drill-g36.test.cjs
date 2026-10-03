'use strict';
/**
 * CLAIM-LEDGER G3.6 (F6, C4): the OLD build (1.1.83) runs its own engine, under Electron as Node,
 * against a user-data memory folder that holds the new build's v2 index file and its own STALE index.
 * It reconciles its own file cleanly, and the v2 file is byte-unchanged.
 *
 * The 1.1.83 tree is _work/drill-trees/v1.1.83 (the v1.1.83 commit with its node_modules and model),
 * or CLAIMS_DRILL_TREE_183. A missing tree, Electron or model FAILS this test; it never skips (F7).
 * HOME and USERPROFILE are jailed and asserted before anything else.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-g36-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = path.join(JAIL, 'runner-home'); process.env.USERPROFILE = process.env.HOME;
fs.mkdirSync(process.env.HOME, { recursive: true });
assert.equal(os.homedir(), process.env.HOME, 'HOME must be jailed before anything runs');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const { runDrill } = require('./claims-drill/runner.cjs');
const TREE = process.env.CLAIMS_DRILL_TREE_183 || 'C:\\Dunder\\_work\\drill-trees\\v1.1.83';

function write(root, rel, text) {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

test('G3.6: 1.1.83 reconciles its own stale index next to a v2 index, and never touches the v2 file', { timeout: 10 * 60_000 }, async () => {
  const hive = path.join(JAIL, 'hive');
  const home = path.join(JAIL, 'home');
  write(hive, 'agents/a1/memory.md', '# Memory\n\n## 2026-09-01\n- the gizmo protocol uses port 4471 for the relay\n- widgets are packed in crates of twelve\n');
  write(hive, 'agents/a2/memory.md', '# Memory\n\n## 2026-09-02\n- the zeppelin hangar door code is 7781\n');
  // The app's user-data memory folder: the old build's own index (named as 1.1.83 names it) and the new v2 file.
  const memDir = path.join(home, 'AppData', 'Roaming', 'Guppy', 'memory');
  const key = crypto.createHash('sha256').update(hive.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16);
  const oldDb = path.join(memDir, `${key}.sqlite`);
  const v2File = path.join(memDir, `${key}-v2.sqlite`);
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(v2File, crypto.randomBytes(64 * 1024));
  const v2Sha = crypto.createHash('sha256').update(fs.readFileSync(v2File)).digest('hex');

  const res = await runDrill({
    tree: TREE, hive, home, script: path.join(__dirname, 'claims-drill', 'g36-old-build.cjs'),
    args: {
      oldDb, v2File,
      steps: { remove: ['agents/a2/memory.md'], append: { rel: 'agents/a1/memory.md', text: '\n## 2026-10-03\n- the frobnicator calibration offset is 9350\n' } },
      find: 'frobnicator calibration offset', findMarker: '9350',
      gone: 'zeppelin hangar door code', goneMarker: '7781',
    },
  });
  assert.equal(res.ok, true, JSON.stringify(res, null, 2));
  assert.deepEqual(res.checks, { harnessStarted: true, homeJailed: true, modelLoaded: true }, 'F7: started, jailed, model loaded');
  assert.ok(res.firstEmbedded > 0, 'the old build indexed the hive');
  assert.ok(res.secondRemoved >= 1, 'the stale chunks of the removed source were reconciled away');
  assert.equal(res.foundExit, 0);
  assert.equal(res.foundNew, true, 'what is in the hive now is found');
  assert.equal(res.goneFound, false, 'what was removed is not');
  assert.deepEqual(res.goneSources, []);
  assert.equal(res.v2Unchanged, true);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(v2File)).digest('hex'), v2Sha, 'the v2 file is byte-unchanged');
  const others = res.memDirFiles.filter((n) => !n.startsWith(`${key}.sqlite`) && n !== `${key}-v2.sqlite`);
  assert.deepEqual(others, [], 'the old build wrote nothing but its own index');
});

test('F7: a drill that does not assert the model (or the jail) fails, whatever it returns', { timeout: 5 * 60_000 }, async () => {
  const hive = path.join(JAIL, 'hive-f7');
  fs.mkdirSync(hive, { recursive: true });
  const lazy = path.join(JAIL, 'lazy.cjs');
  fs.writeFileSync(lazy, "module.exports = async (drill) => { drill.assert.harnessStarted(); drill.assert.homeJailed(); return { found: 50, total: 50 }; };\n");
  const res = await runDrill({ tree: TREE, hive, home: path.join(JAIL, 'home-f7'), script: lazy });
  assert.equal(res.ok, false);
  assert.match(res.reason, /F7 checks not asserted: modelLoaded/);
  const thrower = path.join(JAIL, 'thrower.cjs');
  fs.writeFileSync(thrower, "module.exports = async () => { throw new Error('boom'); };\n");
  const t = await runDrill({ tree: TREE, hive, home: path.join(JAIL, 'home-f7b'), script: thrower });
  assert.equal(t.ok, false);
  assert.match(t.reason, /the drill threw/);
});
