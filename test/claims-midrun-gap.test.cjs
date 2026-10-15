'use strict';
/**
 * CL-READERWATCHER MUST-1 (Jim): a mid-run raise leaves NO search gap at all. The worker's first
 * claims sync used to drop the replaced markdown when it planned the claims, embed them one queue
 * step each, and apply them at the end: searches in between saw neither (41 of 42 missed in Jim's
 * drill; tens of seconds at 1,390 entries). Now the markdown leaves in the step that applies the
 * claims, and a reconcile keeps it while the wing has no claims applied. The drill searches DURING
 * the sync (paced, 5 ms per embed): test/claims-midrun/gap-scenario.cjs, Jim's drill.
 * Also SHOULD-1 (the 1.1.88 upgrade settles) and SHOULD-2 (all of memory/ deleted, A-2).
 * Invented text only. HOME and USERPROFILE are jailed before any product code loads.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-gap-'));
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
  const res = await runDrill({ tree: TREE, hive, home: path.join(dir, 'home'), script: path.join(__dirname, 'claims-midrun', 'gap-scenario.cjs'), needModel: false, args, timeoutMs: 180_000 });
  assert.equal(res.ok, true, JSON.stringify(res, null, 2).slice(0, 3000));
  return res;
}

const noGap = (r, legacy) => {
  const s = JSON.stringify(r);
  assert.equal(r.before, true, s); assert.equal(r.raised, true, s); assert.equal(r.settled, true, s);
  assert.ok(r.samples >= 3, `searches ran during the sync: ${s}`);
  assert.equal(r.misses, 0, `NO GAP: every search during the sync finds the note: ${s}`);
  assert.equal(r.last.found, true, s);
  assert.equal(r.legacyClaims, legacy, s);
  assert.ok(r.claimAfter > 0, `after the sync the note is found as a claim: ${s}`);
  assert.equal(r.mdAfter, 0, `and the markdown itself is out of search: ${s}`);
};

test('MUST-1: a mid-run writer raise: every search during the first claims sync finds the legacy note', { timeout: 5 * 60_000 }, async () => {
  noGap(await drill({ mode: 'sync', filler: 40, delayMs: 5 }), 41);
});

test('MUST-1: a shadow-to-reader raise: no gap during the sync, and the shadow-time edit is searchable throughout', { timeout: 5 * 60_000 }, async () => {
  const r = await drill({ mode: 'shadow', filler: 40, delayMs: 5 });
  assert.equal(r.shadowFile, false, 'shadow at the start import writes no settled file');
  assert.equal(r.yakBefore, true);
  noGap(r, 42);
  assert.equal(r.yakAfter, true);
});

test('MUST-1: a worker reconcile between the settled file and the sync keeps the markdown until the claims are applied', { timeout: 5 * 60_000 }, async () => {
  const r = await drill({ mode: 'backfill', filler: 40 });
  const s = JSON.stringify(r);
  assert.equal(r.misses, 0, `found after the reconcile and after the sync: ${s}`);
  assert.deepEqual(r.phases, [], s);
  assert.equal(r.mdAfter, 0, s); assert.ok(r.claimAfter > 0, s);
  assert.equal(r.otherIndexed, true, s);
  assert.equal(r.otherGone, true, 'a deleted file of another agent still leaves the index while this wing is pending');
});

test('SHOULD-1: the 1.1.88 upgrade: an established ledger that appends nothing settles; so does a read-only established one; a torn NEW ledger does not', { timeout: 5 * 60_000 }, async () => {
  const r = await drill({ mode: 'upgrade', filler: 40 });
  const s = JSON.stringify(r);
  assert.deepEqual(r.noop, { appended: 0, offered: 0, settled: true }, s);
  assert.ok(r.ro.readOnly, s); assert.equal(r.ro.settled, true, s);
  assert.equal(r.unchanged, true, 'a later start leaves the settled file as it is');
  assert.ok(r.torn.readOnly, s); assert.equal(r.torn.records, 0, s);
  assert.equal(r.torn.settled, false, 'read-only with nothing in it: its memory.md stays searched');
});

test('SHOULD-2: case 3(ii), all of memory/ deleted for an anchored agent: the claims stay the source (A-2), one re-import, then settled', { timeout: 5 * 60_000 }, async () => {
  const r = await drill({ mode: 'deleted', filler: 40, whole: true });
  const s = JSON.stringify(r);
  assert.equal(r.settled0, true, s); assert.equal(r.found0, true, s);
  assert.equal(r.foundDeleted, true, s);
  assert.ok(r.deletedSources.claims > 0 && r.deletedSources.markdown === 0, `A-2: no swap back to the markdown: ${s}`);
  assert.ok(r.syncs.every((x) => x.found), `found at every sync: ${s}`);
  assert.equal(r.syncs[0].settled, true, s);
  assert.equal(r.syncs.at(-1).imports, r.syncs[0].imports, `one re-import, not one per sync: ${s}`);
});
