'use strict';
require('./tools/own-job.cjs');
/**
 * CL-READERWATCHER (god 886ed8): an agent made a writer WHILE THE APP RUNS (memory-sources.json
 * edited mid-run, then its first claim) never loses its memory.md or archive notes from search.
 * Before: the first claim made a ledger segment, discovery swapped the markdown out, and the notes
 * were gone until the next start's S0 import. Now discovery waits for the agent's import to settle
 * (claims-import.json), and main runs that import as soon as the agent is a reader or writer.
 * The drill (test/claims-midrun/scenario.cjs) runs the real store, import, index sync and engine.
 * Invented text only. HOME and USERPROFILE are jailed before any product code loads.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-midrun-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const { runDrill } = require('./claims-drill/runner.cjs');
const TREE = path.join(__dirname, '..');

let n = 0;
async function drill(args) {
  const dir = path.join(JAIL, `drill-${++n}`);
  const hive = path.join(dir, 'hive');
  fs.mkdirSync(hive, { recursive: true });
  const res = await runDrill({ tree: TREE, hive, home: path.join(dir, 'home'), script: path.join(__dirname, 'claims-midrun', 'scenario.cjs'), needModel: false, args });
  assert.equal(res.ok, true, JSON.stringify(res, null, 2).slice(0, 3000));
  return res;
}

const both = { zeppelin: true, gizmo: true };
const pick = (s) => ({ zeppelin: s.zeppelin, gizmo: s.gizmo });

test('mid-run writer: its legacy notes never leave search, and after its import they are found as claims', { timeout: 5 * 60_000 }, async () => {
  // hold: the import is still running while main syncs the first claim and the worker rediscovers
  const r = await drill({ hold: true });
  assert.equal(r.wired, true, 'main starts the import of an agent raised mid-run');
  assert.equal(r.firstOk, true);
  assert.equal(r.startImported, 0, 'off at claims start: no S0 import then');
  assert.deepEqual(pick(r.before), both);
  assert.deepEqual(pick(r.raised), both, 'the level edit alone changes nothing');
  assert.equal(r.settledDuring, false);
  assert.deepEqual(pick(r.during), both, 'NO GAP: with a segment but no settled import, memory.md and the archive stay searched');
  assert.ok(r.during.markdown > 0);
  assert.deepEqual(r.syncedDuring, [false], 'the worker refuses the claims until the import settles');
  assert.equal(r.settledAfter, true);
  assert.equal(r.legacyClaims, 2, 'memory.md and the archive were imported');
  assert.deepEqual(r.syncedAfter, [true]);
  assert.match(r.after.zeppelinTop, /^legacy: [\s\S]*the zeppelin hangar code is twelve/, 'the memory.md note, as an imported claim');
  assert.match(r.after.gizmoTop, /^legacy: [\s\S]*the gizmo relay uses crate seven/, 'the archive note, as an imported claim');
  assert.match(r.after.widgetTop, /the widget review moved to friday/, 'the first claim');
  assert.equal(r.after.markdown, 0, 'then the markdown itself is out of search');
  assert.equal(r.importRows, 1);
});

test('mid-run writer, import not held: the same end state', { timeout: 5 * 60_000 }, async () => {
  const r = await drill({});
  assert.deepEqual(pick(r.during), both);
  assert.equal(r.settledAfter, true);
  assert.deepEqual(pick(r.after), both);
  assert.equal(r.after.widget, true);
  assert.equal(r.after.markdown, 0);
  assert.equal(r.legacyClaims, 2);
});
