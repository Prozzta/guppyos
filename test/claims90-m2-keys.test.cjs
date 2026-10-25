'use strict';
/**
 * CLAIMS-90 M2 (rework after Jim's audit) on the real store (better-sqlite3 + sqlite-vec under
 * Electron as Node, through the C4 drill runner): the live view shows ONE row per CLAIM, its
 * best-ranked matched part, with the count of the superseded claims behind it along its own
 * supersession chain; same-key live claims are separate rows; --history and --all keep every part of
 * every version; the superseded_by column is added in place to an older index and a moved link is a
 * status change, never a re-embed. It fails (never skips) when Electron is missing. HEAVY: run it in
 * the heavy slot.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-m2-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));
const { runDrill } = require('./claims-drill/runner.cjs');
const TREE = path.join(__dirname, '..');
const SCRIPT = path.join(__dirname, 'claims-w3', 'scenarios.cjs');

const K1 = 'c-0000000000k1', K2 = 'c-0000000000k2', K3 = 'c-0000000000k3', K4 = 'c-0000000000k4', K5 = 'c-0000000000k5';
const K6 = 'c-0000000000k6', K7 = 'c-0000000000k7', S1 = 'c-0000000000s1', S2 = 'c-0000000000s2', D1 = 'c-0000000000d1', D2 = 'c-0000000000d2';
const O1 = 'c-0000000000o1', U1 = 'c-0000000000u1', LONG = 'c-00000000long';
const ids = (rows) => rows.map((r) => r[0]);
const row = (rows, id) => rows.filter((r) => r[0] === id);
const priors = (rows, id) => row(rows, id)[0]?.[1];

test('CLAIMS-90 M2: one row per claim (matched part, chain priors) in the live view, both branches; separate same-key facts stay; every version behind --history / --all; link upgrade and re-sync', { timeout: 5 * 60_000 }, async () => {
  const dir = path.join(JAIL, 'm2keys');
  const hive = path.join(dir, 'hive');
  fs.mkdirSync(hive, { recursive: true });
  const r = await runDrill({ tree: TREE, hive, home: path.join(dir, 'home'), script: SCRIPT, needModel: false, args: { scenario: 'm2keys' } });
  assert.equal(r.ok, true, JSON.stringify(r, null, 2).slice(0, 3000));
  assert.ok(r.parts >= 14, `parts embedded: ${r.parts}`);
  assert.ok(r.longParts >= 2, `the long claim has ${r.longParts} parts`);

  // Schema upgrade: an index without the column gets it on open (same file, nothing re-embedded).
  assert.ok(!r.colsBefore.includes('superseded_by'), 'the fixture dropped the column first');
  assert.ok(r.colsAfter.includes('superseded_by'), 'MUTANT: superseded_by is added in place on open');

  for (const [name, rows] of [['live (KNN fast path)', r.live], ['live, wing filter (scan)', r.liveFiltered]]) {
    assert.deepEqual(row(rows, K3), [[K3, 2]], `${name}: MUTANT: the chain head is one row and counts k1 and k2 (the chain), not k5 (retracted, no link) nor k4 (purged): ${JSON.stringify(rows)}`);
    for (const id of [K1, K2, K4, K5, D1, D2]) assert.equal(row(rows, id).length, 0, `${name}: ${id} is not a live row`);
    assert.deepEqual(row(rows, O1), [[O1, 0]], `${name}: a claim with no chain: priors 0`);
    assert.deepEqual(row(rows, U1), [[U1, 0]], `${name}: an unkeyed claim: priors 0`);
    assert.equal(ids(rows).filter((id) => id === K3).length, 1, `${name}: each claim once`);
  }
  assert.match(r.liveText, /Versions: 2 prior version\(s\) this claim supersedes; --history shows them\./, 'MUTANT: the text says how many versions sit behind --history');
  assert.doesNotMatch(r.liveText, /1\.1\.9[789]|1\.1\.101/, 'the live text shows live values only');
  assert.match(r.liveText, /1\.1\.100/);

  // Same-key live claims are SEPARATE facts (Jim's MUST 1): both rows, each found by its own query, no key collapse.
  assert.ok([K6, K7].every((id) => ids(r.legacy).includes(id)), `MUTANT: both live claims of release.legacy are rows: ${JSON.stringify(r.legacy)}`);
  assert.ok(r.legacy.every((x) => !([K6, K7].includes(x[0])) || x[1] === 0), 'neither is a prior of the other');
  assert.match(r.legacyText, /legacy current is 2\.0/); assert.match(r.legacyText, /legacy current is 2\.1/);
  assert.equal(ids(r.ibisLegacy)[0], K6, `MUTANT: the ibis query shows the ibis fact itself, never swapped for the newer same-key claim: ${JSON.stringify(r.ibisLegacy)}`);
  assert.equal(ids(r.egretLegacy)[0], K7, `the egret query shows the egret fact: ${JSON.stringify(r.egretLegacy)}`);

  // A superseded? (soft) link keeps both rows and counts nothing (god's (b)).
  assert.ok([S1, S2].every((id) => ids(r.soft).includes(id)), `both sides of a soft link are rows: ${JSON.stringify(r.soft)}`);
  assert.equal(priors(r.soft, S2), 0, 'MUTANT: an uncertain prior is not counted');
  assert.match(r.softText, /quail/); assert.match(r.softText, /quokka/);

  // A chain whose head is retracted (god's (a)): the live view shows no dead head and no superseded loser (G3.1); --history shows both.
  assert.deepEqual(ids(r.deadLive).filter((id) => [D1, D2].includes(id)), [], `no dead head in the live view: ${JSON.stringify(r.deadLive)}`);
  assert.ok([D1, D2].every((id) => ids(r.deadHistory).includes(id)), `--history shows the retracted head and its superseded prior: ${JSON.stringify(r.deadHistory)}`);

  assert.ok([K1, K2, K3, K5, K6, K7].every((id) => ids(r.history).includes(id)), `MUTANT: --history keeps every non-purged version: ${JSON.stringify(ids(r.history))}`);
  assert.ok(!ids(r.history).includes(K4), 'purged stays out of --history');
  assert.ok(r.history.every((x) => x[1] === null), 'no priors in history mode');
  assert.doesNotMatch(r.historyText, /Versions:/);
  assert.ok([K1, K2, K3, K4, K5].every((id) => ids(r.all).includes(id)), `--all keeps the purged one too: ${JSON.stringify(ids(r.all))}`);
  assert.equal(ids(r.history).filter((id) => id === K3).length, 1, 'each version once');

  assert.deepEqual(r.keyed, [[K3, 2]], `--key: the live claim of the key with its chain count: ${JSON.stringify(r.keyed)}`);
  assert.deepEqual(ids(r.sinceLate).filter((id) => [K1, K2, K3, K4, K5].includes(id)), [K3], '--since after the priors: still the head');

  // A long KEYED claim whose answer sits in its last part: one row, and it is the MATCHED part (Jim's MUST 2).
  assert.equal(ids(r.long).filter((id) => id === LONG).length, 1, `MUTANT: a long claim (several parts) is one row: ${JSON.stringify(r.long)}`);
  assert.equal(ids(r.long)[0], LONG, 'the long claim ranks first for its own words');
  assert.match(r.longText, /tip sha is 1234abcd/, 'MUTANT: the row shows the part that matched, not part 0');
  assert.ok(ids(r.longHistory).filter((id) => id === LONG).length >= 2, `--history keeps the parts as retrieved (no collapse there): ${JSON.stringify(r.longHistory)}`);

  // A later sync that moves links is a status change only (no re-embed); the chain count follows it.
  assert.deepEqual(r.resync, { embedded: 0, statusChanges: 1 }, `MUTANT: k5 superseded by k3 is one status row: ${JSON.stringify(r.resync)}`);
  assert.equal(priors(r.liveRelinked, K3), 3, `MUTANT: k5 now counts in k3's chain: ${JSON.stringify(r.liveRelinked)}`);
  assert.deepEqual(r.resync2, { embedded: 0, statusChanges: 1 }, `MUTANT: a link-only change (k1 -> k3, status unchanged) is a status row: ${JSON.stringify(r.resync2)}`);
  assert.equal(priors(r.liveLinkOnly, K3), 3, `k1 is still in k3's chain (directly now): ${JSON.stringify(r.liveLinkOnly)}`);
});
