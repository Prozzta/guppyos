'use strict';
require('./tools/own-job.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./tools/test-temp.cjs');
const loadTs = require('./load-ts.cjs');

const { RosterStore, rosterPath, rosterBackupDir } = loadTs('src/main/roster.ts');

function tmpHome() {
  return tempDir('md-roster-');
}

/** A store bound to `home`. A fresh instance is a fresh RUN — which is what the
 *  empty-guard keys off, so "another instance" is how a restart is simulated. */
function storeAt(home) {
  return new RosterStore(() => home);
}

function backupsIn(home) {
  const dir = rosterBackupDir(home);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function snapshot(agents = [], extra = {}) {
  return {
    version: 1,
    savedAt: new Date(0).toISOString(),
    agents,
    archived: [],
    restorable: [],
    queues: {},
    selectedId: null,
    ...extra
  };
}

test('a roster round-trips through the file', () => {
  const home = tmpHome();
  const store = storeAt(home);
  assert.equal(store.read(), null); // nothing written yet

  assert.equal(store.write(snapshot([{ id: 'a', name: 'Dwight', note: 'beets' }])).ok, true);

  const back = store.read();
  assert.equal(back.agents.length, 1);
  assert.equal(back.agents[0].note, 'beets');
  assert.equal(back.version, 1);
});

test('an empty first write cannot wipe a roster that is already on disk', () => {
  // The failure this exists for: opening the packaged build for the first time.
  // Its localStorage is a different origin, so the store boots with zero agents
  // and its first mirror write would otherwise flatten the real roster.
  const home = tmpHome();
  storeAt(home).write(snapshot([{ id: 'a', name: 'Dwight' }]));

  const nextRun = storeAt(home);
  const res = nextRun.write(snapshot([]));
  assert.equal(res.ok, false);
  assert.equal(res.skipped, 'empty-first-write');
  assert.equal(nextRun.read().agents.length, 1, 'the roster on disk survived');
});

test('emptying the roster is allowed once the run has written normally', () => {
  // Deleting every agent is a real thing a user does. Only the FIRST write of a
  // run is suspect; refusing later ones would make deletion impossible.
  const home = tmpHome();
  const store = storeAt(home);
  store.write(snapshot([{ id: 'a', name: 'Dwight' }]));
  assert.equal(store.write(snapshot([])).ok, true);
  assert.equal(store.read().agents.length, 0);
});

test('every previous version is kept, even within the same millisecond', () => {
  // Three writes back-to-back land in one tick, so a timestamp-only filename
  // collides and the later copy silently replaces the earlier one. A backup
  // folder that loses backups is worse than no backup folder.
  const home = tmpHome();
  const store = storeAt(home);
  store.write(snapshot([{ id: 'a' }]));
  store.write(snapshot([{ id: 'a' }, { id: 'b' }]));
  store.write(snapshot([{ id: 'a' }, { id: 'b' }, { id: 'c' }]));

  // Three writes, two of which had a previous file to copy first.
  assert.equal(backupsIn(home).length, 2);
  const sizes = backupsIn(home).map((f) =>
    JSON.parse(fs.readFileSync(path.join(rosterBackupDir(home), f), 'utf8')).agents.length);
  assert.deepEqual(sizes.sort(), [1, 2], 'both prior versions survived, not just the last');
});

test('a refused write still backs up whatever was on disk', () => {
  const home = tmpHome();
  storeAt(home).write(snapshot([{ id: 'a' }]));
  storeAt(home).write(snapshot([])); // declined
  assert.ok(backupsIn(home).some((f) => f.includes('declined')));
});

test('a refusal does not disarm the guard: repeated empty writes stay refused', () => {
  // Seen live 2026-08-16: the first empty write of a run was declined, but the
  // decline set the has-written flag — so when a renderer reload re-sent the
  // same empty snapshot, the second write went through and flattened the file.
  // The guard must hold until a NON-empty write proves the renderer has a roster.
  const home = tmpHome();
  storeAt(home).write(snapshot([{ id: 'a', name: 'Dwight' }]));

  const nextRun = storeAt(home);
  assert.equal(nextRun.write(snapshot([])).skipped, 'empty-first-write');
  const second = nextRun.write(snapshot([]));
  assert.equal(second.ok, false);
  assert.equal(second.skipped, 'empty-first-write');
  assert.equal(nextRun.read().agents.length, 1, 'the roster on disk survived both');

  // A non-empty write disarms it; a later empty write is then a real deletion.
  assert.equal(nextRun.write(snapshot([{ id: 'a', name: 'Dwight' }])).ok, true);
  assert.equal(nextRun.write(snapshot([])).ok, true);
  assert.equal(nextRun.read().agents.length, 0);
});

const GOD = { id: 'god', name: 'Michael', isGod: true };
const TEAM = ['jim', 'andy', 'dwight', 'creed', 'sele', 'uhera'].map((id) => ({ id, name: id }));

test('a god-only first write cannot wipe a team that is already on disk', () => {
  // Seen live 2026-11-15: an antivirus removed the renderer's Local Storage, the
  // store booted with god alone (it always has god), and its first mirror write
  // replaced a six-agent roster. One entry is not "empty", so the guard let it by.
  const home = tmpHome();
  storeAt(home).write(snapshot([GOD, ...TEAM]));

  const nextRun = storeAt(home);
  const res = nextRun.write(snapshot([GOD]));
  assert.equal(res.ok, false);
  assert.equal(res.skipped, 'empty-first-write');
  assert.equal(nextRun.read().agents.length, 7, 'god and all six workers survived');
  assert.equal(backupsIn(home).filter((f) => f.includes('declined')).length, 1,
    'the refused write still backed up the roster it protected');

  // A reload re-sends the same snapshot: the refusal must not disarm the guard.
  assert.equal(nextRun.write(snapshot([GOD])).skipped, 'empty-first-write');
  assert.equal(nextRun.read().agents.length, 7);

  // Once the renderer proves it holds the team, removing every worker is a real edit.
  assert.equal(nextRun.write(snapshot([GOD, ...TEAM])).ok, true);
  assert.equal(nextRun.write(snapshot([GOD])).ok, true);
  assert.equal(nextRun.read().agents.length, 1);
});

test('the god-only guard counts restorable workers and ignores archived ones', () => {
  // Workers that are only restorable on disk are still a team to protect.
  const parked = tmpHome();
  storeAt(parked).write(snapshot([GOD], { restorable: TEAM }));
  assert.equal(storeAt(parked).write(snapshot([GOD])).skipped, 'empty-first-write');
  assert.equal(storeAt(parked).read().restorable.length, 6);

  // A first write that still carries them, on the floor or restorable, goes through.
  assert.equal(storeAt(parked).write(snapshot([GOD], { restorable: TEAM.slice(0, 1) })).ok, true);
  const live = tmpHome();
  storeAt(live).write(snapshot([GOD, ...TEAM]));
  assert.equal(storeAt(live).write(snapshot([GOD, TEAM[0]])).ok, true);

  // An archive alone brings nobody back, so it does not stand in for the team.
  const kept = tmpHome();
  storeAt(kept).write(snapshot([GOD, ...TEAM]));
  assert.equal(storeAt(kept).write(snapshot([GOD], { archived: TEAM })).skipped, 'empty-first-write');
  assert.equal(storeAt(kept).read().agents.length, 7);
});

test('a god-only first write is fine when the file holds no workers', () => {
  // A floor whose roster really is god alone (or god plus an archive) must keep saving.
  const home = tmpHome();
  storeAt(home).write(snapshot([GOD], { archived: TEAM }));
  const nextRun = storeAt(home);
  assert.equal(nextRun.write(snapshot([GOD])).ok, true);
  assert.equal(nextRun.read().archived.length, 0);
  assert.equal(backupsIn(home).some((f) => f.includes('declined')), false);
});

test('god is told apart by its flag or by its id, and never counts as a worker', () => {
  // The renderer marks god with isGod; an older roster may only carry the id.
  for (const god of [{ id: 'god' }, { id: 'michael', isGod: true }]) {
    const home = tmpHome();
    storeAt(home).write(snapshot([god, ...TEAM]));
    assert.equal(storeAt(home).write(snapshot([god])).skipped, 'empty-first-write', JSON.stringify(god));
    assert.equal(storeAt(home).read().agents.length, 7);
  }
  // A malformed entry is not god: it counts as a worker, so the write is kept.
  const odd = tmpHome();
  storeAt(odd).write(snapshot([GOD, ...TEAM]));
  assert.equal(storeAt(odd).write(snapshot([GOD, null])).ok, true);
});

test('a corrupt file reads as "no opinion" rather than as an empty roster', () => {
  // The renderer treats null as "use localStorage". Returning an empty roster
  // instead would show a blank floor and then mirror that blank back to disk.
  const home = tmpHome();
  fs.writeFileSync(rosterPath(home), '{ this is not json');
  assert.equal(storeAt(home).read(), null);
});

test('a snapshot missing its arrays is rejected, not half-written', () => {
  const home = tmpHome();
  const store = storeAt(home);
  store.write(snapshot([{ id: 'a' }]));
  assert.equal(store.write({ version: 1, agents: 'nope' }).ok, false);
  assert.equal(store.read().agents.length, 1);
  assert.equal(fs.existsSync(`${rosterPath(home)}.tmp`), false, 'no temp file left behind');
});

test('no harnessHome means no file operations at all', () => {
  const store = new RosterStore(() => null);
  assert.equal(store.read(), null);
  assert.equal(store.write(snapshot([{ id: 'a' }])).ok, false);
  store.archive(); // must not throw
});

test('reset archives the roster instead of destroying it', () => {
  const home = tmpHome();
  const store = storeAt(home);
  store.write(snapshot([{ id: 'a', note: 'do not lose me' }]));

  store.archive();
  assert.equal(fs.existsSync(rosterPath(home)), false, 'active roster cleared');
  assert.equal(store.read(), null);

  const saved = backupsIn(home).filter((f) => f.includes('reset'));
  assert.equal(saved.length, 1);
  const body = JSON.parse(fs.readFileSync(path.join(rosterBackupDir(home), saved[0]), 'utf8'));
  assert.equal(body.agents[0].note, 'do not lose me');
});

test('worktree paths and notes survive the round trip verbatim', () => {
  // These two only ever lived in localStorage, so they are the whole reason the
  // file exists.
  const home = tmpHome();
  const agent = {
    id: 'w1',
    name: 'Jim',
    cwd: '/Users/x/HarnessAgents/worktrees/w1',
    worktreePath: '/Users/x/HarnessAgents/worktrees/w1',
    note: '- shipping the queue fix\n- then the roster'
  };
  const store = storeAt(home);
  store.write(snapshot([agent]));
  assert.deepEqual(store.read().agents[0], agent);
});

test('queues and selection round-trip, and a bad queues field degrades to empty', () => {
  const home = tmpHome();
  const store = storeAt(home);
  store.write(snapshot([{ id: 'a' }], {
    queues: { a: [{ id: 'q1', text: 'ship it' }] },
    selectedId: 'a'
  }));
  const back = store.read();
  assert.equal(back.queues.a[0].text, 'ship it');
  assert.equal(back.selectedId, 'a');

  store.write(snapshot([{ id: 'a' }], { queues: null, selectedId: 42 }));
  const coerced = store.read();
  assert.deepEqual(coerced.queues, {});
  assert.equal(coerced.selectedId, null);
});
