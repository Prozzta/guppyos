'use strict';

// NEW-FLOOR-CLEAN-SLATE: a new floor starts with no agents but its own god. The renderer's
// localStorage roster cache is one cache for every home (one Electron userData origin), and a
// new floor's roster.json is empty, so the store used to start the new floor from the LAST
// floor's cache: it restored those agents there and they registered with their original cwds
// (C:/Meta and C:/Coating). The cache is now stamped with its home and stands in only for it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
const C = loadTs('src/shared/rosterCacheHome.ts');

const OLD_HOME = 'C:/Dunder';
const NEW_HOME = 'C:/NewFloor';
const agent = (id, cwd) => ({ id, name: id, cwd, role: 'builder', status: 'idle', progress: 0, accent: 'sky' });
const DUNDER = {
  agents: [agent('god-d', OLD_HOME)],
  archived: [agent('old-dwight', 'C:/PrzEdit')],
  restorable: [agent('jim', 'C:/PrzEdit'), agent('creed', OLD_HOME)]
};

function fakeStorage(init = {}, throws = false) {
  const map = new Map(Object.entries(init));
  const guard = () => { if (throws) throw new Error('blocked site data'); };
  return {
    map,
    get length() { guard(); return map.size; },
    key(i) { guard(); return [...map.keys()][i] ?? null; },
    getItem(k) { guard(); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { guard(); map.set(k, String(v)); },
    removeItem(k) { guard(); map.delete(k); }
  };
}

/** The cache as the old floor's renderer left it. */
const cacheOf = (roster, home) => ({
  'cth.agents': JSON.stringify(roster.agents),
  'cth.archivedAgents': JSON.stringify(roster.archived),
  'cth.restorableAgents': JSON.stringify(roster.restorable),
  'cth.selectedId': roster.agents[0]?.id ?? '',
  // A parked message the user wrote on the old floor: it must not reach the new one.
  'cth.messageQueues': JSON.stringify(roster.agents[0] ? { [roster.agents[0].id]: [{ id: 'q-old', text: 'old floor note' }] } : {}),
  'cth.theme': 'night',
  ...(home ? { 'cth.rosterHome': home } : {})
});
const fileOf = (roster) => ({ version: 1, savedAt: '2026-10-22T10:00:00.000Z', queues: {}, selectedId: null, ...roster });

const { RosterStore, rosterBackupDir } = loadTs('src/main/roster.ts');

let run = 0;
/** Boot the real store module once, as a renderer would at load, against a stubbed window. The
 *  foreign-cache backup goes through main's real RosterStore into a temp home of its own:
 *  `backups` is what landed in its roster-backups/ (parsed), keyed by file name. */
function bootStore({ storage, home, file }) {
  const writes = [];
  const backupHome = fs.mkdtempSync(path.join(os.tmpdir(), 'md-nfcs-bk-'));
  const store = new RosterStore(() => backupHome);
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  globalThis.window = {
    localStorage: storage,
    cth: {
      rosterReadSync: () => file ?? null,
      rosterHomeSync: () => home,
      rosterBackupForeignSync: (snap) => store.backupSnapshot(JSON.parse(JSON.stringify(snap)), 'foreign-cache'),
      rosterWrite: async (snap) => { writes.push(snap); return { ok: true }; }
    },
    addEventListener() {}
  };
  try {
    const src = fs.readFileSync(path.join(REPO, 'src/renderer/src/store/store.ts'), 'utf8') + `\n// boot ${++run}\n`;
    const { useStore, flushRosterNow } = loadTs.fromText('src/renderer/src/store/store.ts', src);
    const s = useStore.getState();
    flushRosterNow();
    const dir = rosterBackupDir(backupHome);
    const backups = fs.existsSync(dir)
      ? fs.readdirSync(dir).map((f) => ({ file: f, body: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }))
      : [];
    return { agents: s.agents.map((a) => a.id), archived: s.archivedAgents.map((a) => a.id), restorable: s.restorableAgents.map((a) => a.id), writes, backups };
  } finally {
    fs.rmSync(backupHome, { recursive: true, force: true });
    if (saved) Object.defineProperty(globalThis, 'window', saved); else delete globalThis.window;
  }
}

test('rosterSource: the file wins; else the cache only for its own home; else none', () => {
  assert.equal(C.rosterSource({ fileEntries: 3, home: NEW_HOME, cacheHome: OLD_HOME }), 'file');
  assert.equal(C.rosterSource({ fileEntries: 0, home: OLD_HOME, cacheHome: OLD_HOME }), 'cache');
  assert.equal(C.rosterSource({ fileEntries: 0, home: NEW_HOME, cacheHome: OLD_HOME }), 'none', 'another home\'s cache');
  assert.equal(C.rosterSource({ fileEntries: 0, home: NEW_HOME, cacheHome: null }), 'none', 'an unstamped cache');
  assert.equal(C.rosterSource({ fileEntries: 0, home: null, cacheHome: OLD_HOME }), 'none', 'no home');
  assert.equal(C.sameHome('C:\\Dunder\\', 'c:/dunder', true), true);
  assert.equal(C.sameHome('C:/Dunder', 'C:/Dunder2', true), false);
  assert.equal(C.sameHome('/home/a', '/home/A', false), false);
  assert.equal(C.sameHome('', ''), false);
});

test('clearRosterCache removes the roster keys and the stamp, and nothing else; never throws', () => {
  const s = fakeStorage(cacheOf(DUNDER, OLD_HOME));
  C.clearRosterCache(s);
  assert.deepEqual([...s.map.keys()], ['cth.theme']);
  assert.doesNotThrow(() => C.clearRosterCache(fakeStorage({}, true)));
  assert.doesNotThrow(() => C.clearRosterCache(null));
});

test('a new floor (no roster.json) does not start from the last floor\'s cache', () => {
  const storage = fakeStorage(cacheOf(DUNDER, OLD_HOME));
  const r = bootStore({ storage, home: NEW_HOME, file: null });
  assert.deepEqual([r.agents, r.archived, r.restorable], [[], [], []], 'nothing to restore or register on the new floor');
  assert.equal(r.writes.length, 1, 'one flush');
  assert.deepEqual([r.writes[0].agents, r.writes[0].archived, r.writes[0].restorable], [[], [], []], 'its roster.json starts empty');
  assert.deepEqual(r.writes[0].queues, {}, 'NFCS QUEUES: the old floor\'s parked messages do not reach the new floor');
  assert.equal(storage.getItem('cth.messageQueues'), '{}', 'NFCS QUEUES: nor its cache');
  assertKept(r.backups, OLD_HOME);
  // The cache now belongs to the new floor, and no slice of the old one outlives the switch.
  assert.equal(storage.getItem('cth.rosterHome'), NEW_HOME);
  for (const k of ['cth.agents', 'cth.archivedAgents', 'cth.restorableAgents']) assert.equal(storage.getItem(k), '[]', k);
  assert.equal(storage.getItem('cth.theme'), 'night', 'user settings stay');
});

/** NFCS BACKUP: exactly one foreign-cache backup, holding the whole cache it replaced. */
function assertKept(backups, cacheHome) {
  assert.equal(backups.length, 1, 'NFCS BACKUP: the cleared cache is kept in roster-backups/');
  assert.match(backups[0].file, /^roster-.+-foreign-cache\.json$/, 'NFCS BACKUP: named for its reason');
  const b = backups[0].body;
  assert.deepEqual([b.agents.map((a) => a.id), b.archived.map((a) => a.id), b.restorable.map((a) => a.id)],
    [['god-d'], ['old-dwight'], ['jim', 'creed']], 'NFCS BACKUP: it holds the old entries');
  assert.deepEqual(b.queues, { 'god-d': [{ id: 'q-old', text: 'old floor note' }] }, 'NFCS BACKUP: and its parked messages');
  assert.equal(b.cacheHome, cacheHome, 'NFCS BACKUP: and the home it was written for');
}

test('an unstamped (pre-fix) cache does not seed a new floor either, and is kept', () => {
  const r = bootStore({ storage: fakeStorage(cacheOf(DUNDER, null)), home: NEW_HOME, file: null });
  assert.deepEqual([r.agents, r.archived, r.restorable], [[], [], []]);
  assertKept(r.backups, null);
});

test('U1 upgrade from 1.1.98: an unstamped cache on the same floor with a populated roster.json restores in full', () => {
  const storage = fakeStorage(cacheOf(DUNDER, null));
  const r = bootStore({ storage, home: OLD_HOME, file: fileOf(DUNDER) });
  assert.deepEqual([r.agents, r.archived, r.restorable], [['god-d'], ['old-dwight'], ['jim', 'creed']], 'NFCS U1: nothing lost');
  assert.equal(storage.getItem('cth.rosterHome'), OLD_HOME, 'NFCS U1: stamped from now on');
  assert.deepEqual(JSON.parse(storage.getItem('cth.restorableAgents')).map((a) => a.id), ['jim', 'creed'], 'NFCS U1: the cache mirrors the file');
});

test('U2/U3 upgrade from 1.1.98: an unstamped cache on the same floor with a missing or blank roster.json starts empty but is kept', () => {
  for (const file of [null, fileOf({ agents: [], archived: [], restorable: [] })]) {
    const storage = fakeStorage(cacheOf(DUNDER, null));
    const r = bootStore({ storage, home: OLD_HOME, file });
    assert.deepEqual([r.agents, r.archived, r.restorable], [[], [], []], 'NFCS U2/U3: an unstamped cache cannot be told from another home\'s');
    assertKept(r.backups, null);
    assert.equal(storage.getItem('cth.restorableAgents'), '[]', 'NFCS U2/U3: cleared only after the backup');
  }
});

test('no home (legacy config): the cache is not loaded, cleared or stamped; it is set aside once and kept on the next boot with a home', () => {
  const storage = fakeStorage(cacheOf(DUNDER, null));
  const before = new Map(storage.map);
  const r = bootStore({ storage, home: null, file: null });
  assert.deepEqual([r.agents, r.archived, r.restorable], [[], [], []], 'NFCS NO HOME: onboarding must not inherit it');
  for (const [k, v] of before) assert.equal(storage.getItem(k), v, `NFCS NO HOME: ${k} is left as it was`);
  assert.equal(storage.getItem('cth.rosterHome'), null, 'NFCS NO HOME: nothing to stamp');
  assert.deepEqual(r.backups, [], 'NFCS NO HOME: main has no home to back up into');
  const held = JSON.parse(storage.getItem('cth.rosterCacheKept'));
  assert.deepEqual(held.restorable.map((a) => a.id), ['jim', 'creed'], 'NFCS NO HOME: the entries are set aside');

  // Onboarding's first spawn overwrites a slice; a second boot with no home keeps the first copy.
  storage.setItem('cth.agents', JSON.stringify([agent('god-new', NEW_HOME)]));
  bootStore({ storage, home: null, file: null });
  assert.deepEqual(JSON.parse(storage.getItem('cth.rosterCacheKept')).agents.map((a) => a.id), ['god-d'], 'NFCS NO HOME: set aside once, never overwritten');

  // The next boot with a home keeps the set-aside copy in roster-backups/ and drops it.
  const next = bootStore({ storage, home: NEW_HOME, file: fileOf({ agents: [agent('god-new', NEW_HOME)], archived: [], restorable: [] }) });
  assert.deepEqual(next.agents, ['god-new']);
  const kept = next.backups.filter((b) => b.body.agents.some((a) => a.id === 'god-d'));
  assert.equal(kept.length, 1, 'NFCS NO HOME: the set-aside copy lands in roster-backups/');
  assert.deepEqual(kept[0].body.restorable.map((a) => a.id), ['jim', 'creed']);
  assert.equal(storage.getItem('cth.rosterCacheKept'), null, 'NFCS NO HOME: and is dropped once kept');
  assert.equal(storage.getItem('cth.rosterHome'), NEW_HOME);
});

test('this floor\'s own cache is never backed up: a normal launch writes no foreign-cache file', () => {
  const r = bootStore({ storage: fakeStorage(cacheOf(DUNDER, OLD_HOME)), home: OLD_HOME, file: fileOf(DUNDER) });
  assert.deepEqual(r.restorable, ['jim', 'creed']);
  assert.deepEqual(r.backups, [], 'NFCS BACKUP: one per launch would fill roster-backups/');
  const empty = bootStore({ storage: fakeStorage(), home: NEW_HOME, file: null });
  assert.deepEqual(empty.backups, [], 'NFCS BACKUP: an empty cache holds nothing to keep');
});

test('RosterStore.backupSnapshot: writes a snapshot into roster-backups/ under its reason; refuses no home and a non-roster', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-nfcs-rs-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const rs = new RosterStore(() => home);
  const snap = { ...fileOf(DUNDER), cacheHome: null };
  assert.deepEqual(rs.backupSnapshot(snap, 'foreign-cache'), { ok: true });
  assert.deepEqual(rs.backupSnapshot(snap, 'foreign-cache'), { ok: true });
  const files = fs.readdirSync(rosterBackupDir(home));
  assert.equal(files.length, 2, 'NFCS BACKUP: two in one millisecond do not collide');
  assert.deepEqual(files.map((f) => /-(\d+)-foreign-cache\.json$/.exec(f)?.[1]).sort(), ['1', '2'], 'NFCS BACKUP: each carries the store\'s sequence number');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rosterBackupDir(home), files[0]), 'utf8')), snap);
  assert.equal(fs.existsSync(path.join(home, 'roster.json')), false, 'NFCS BACKUP: the live roster is not touched');
  assert.equal(rs.backupSnapshot({ agents: 'x' }, 'foreign-cache').ok, false);
  assert.equal(new RosterStore(() => null).backupSnapshot(snap, 'foreign-cache').ok, false);
});

test('an existing floor is untouched: its roster.json restores its agents and stamps the cache', () => {
  const storage = fakeStorage(cacheOf({ agents: [agent('other', 'C:/Meta')], archived: [], restorable: [] }, 'C:/Meta'));
  const r = bootStore({ storage, home: OLD_HOME, file: fileOf(DUNDER) });
  assert.deepEqual(r.agents, ['god-d']);
  assert.deepEqual(r.archived, ['old-dwight']);
  assert.deepEqual(r.restorable, ['jim', 'creed'], 'a restart still restores this floor\'s agents');
  assert.equal(storage.getItem('cth.rosterHome'), OLD_HOME);
  assert.deepEqual(JSON.parse(storage.getItem('cth.restorableAgents')).map((a) => a.id), ['jim', 'creed'], 'the cache now mirrors this floor');
});

test('the same floor with a blank roster.json still falls back to its own stamped cache', () => {
  const storage = fakeStorage(cacheOf(DUNDER, 'c:\\dunder'));
  const blank = fileOf({ agents: [], archived: [], restorable: [] });
  const r = bootStore({ storage, home: OLD_HOME, file: blank });
  assert.deepEqual([r.agents, r.archived, r.restorable], [['god-d'], ['old-dwight'], ['jim', 'creed']]);
  assert.deepEqual(r.writes[0].restorable.map((a) => a.id), ['jim', 'creed'], 'and re-seeds the file from it');
});

test('a throwing or empty localStorage starts empty on a new floor and never throws', () => {
  for (const storage of [fakeStorage({}, true), fakeStorage()]) {
    const r = bootStore({ storage, home: NEW_HOME, file: null });
    assert.deepEqual([r.agents, r.archived, r.restorable], [[], [], []]);
  }
  const r = bootStore({ storage: fakeStorage({}, true), home: OLD_HOME, file: fileOf(DUNDER) });
  assert.deepEqual(r.restorable, ['jim', 'creed'], 'the file alone still restores an existing floor');
});

test('both fresh-home paths clear the roster cache with the one helper', () => {
  const picker = read('src/renderer/src/components/HivePicker.tsx');
  assert.match(picker, /try \{ clearRosterCache\(window\.localStorage\); \} catch \{ \/\* no localStorage \*\/ \}\n\s+window\.localStorage\.setItem\(SKIP_KEY, '1'\);\n\s+const res = await window\.cth\.changeHome\(path, 'fresh', projectTheme\);/,
    'cleared before the skip flag is set, so the flag survives');
  const settings = read('src/renderer/src/components/SettingsModal.tsx');
  assert.match(settings, /if \(changeMode === 'fresh'\) \{ try \{ clearRosterCache\(window\.localStorage\); \}/);
  for (const k of C.ROSTER_CACHE_KEYS) assert.ok(read('src/renderer/src/store/store.ts').includes(`'${k}'`) || k === C.ROSTER_CACHE_HOME_KEY, `${k} is a store key`);
  assert.match(read('src/main/index.ts'), /ipcMain\.on\('roster:homeSync', \(evt\) => \{ evt\.returnValue = readConfig\(\)\.harnessHome \?\? null; \}\);/);
  assert.match(read('src/main/index.ts'), /const roster = new RosterStore\(\(\) => readConfig\(\)\.harnessHome\);/, 'the same home the roster file is read from');
  // The reason is main's, not the renderer's; the preload answers synchronously so the copy is on disk first.
  assert.match(read('src/main/index.ts'), /ipcMain\.on\('roster:backupForeignSync', \(evt, snap: unknown\) => \{ evt\.returnValue = roster\.backupSnapshot\(snap, 'foreign-cache'\); \}\);/, 'NFCS BACKUP: main wiring');
  assert.match(read('src/preload/index.ts'), /ipcRenderer\.sendSync\('roster:backupForeignSync', snap\)/, 'NFCS BACKUP: preload wiring');
  // The bridge the same-home fallback rests on: a broken one reads as "no home" on every boot.
  assert.match(read('src/preload/index.ts'), /rosterHomeSync: \(\): string \| null => \{\n\s+try \{ const h = ipcRenderer\.sendSync\('roster:homeSync'\); return typeof h === 'string' && h \? h : null; \} catch \{ return null; \}/, 'NFCS HOME BRIDGE: preload sends roster:homeSync and returns the string');
  assert.match(read('src/renderer/src/store/store.ts'), /try \{ return window\.cth\?\.rosterHomeSync\?\.\(\) \?\? null; \} catch \{ return null; \}/, 'NFCS HOME BRIDGE: the store reads it');
});

test('main seeds a new floor with no agents and the floor docs, and leaves the existing floor alone', (t) => {
  const { HiveManager } = loadTs('src/main/hive.ts');
  const oldHome = fs.mkdtempSync(path.join(os.tmpdir(), 'md-nfcs-old-'));
  const newHome = fs.mkdtempSync(path.join(os.tmpdir(), 'md-nfcs-new-'));
  const oldHive = new HiveManager(() => oldHome);
  t.after(() => { oldHive.dispose(); fs.rmSync(oldHome, { recursive: true, force: true }); fs.rmSync(newHome, { recursive: true, force: true }); });
  oldHive.ensureHive();
  const oldReg = path.join(oldHive.root(), 'registry.json');
  fs.writeFileSync(oldReg, JSON.stringify({ godId: 'god-d', agents: { 'god-d': { id: 'god-d', cwd: oldHome }, jim: { id: 'jim', cwd: 'C:/PrzEdit' } } }, null, 2));
  const before = fs.readFileSync(oldReg);

  const newHive = new HiveManager(() => newHome);
  t.after(() => newHive.dispose());
  newHive.ensureHive();
  const reg = JSON.parse(fs.readFileSync(path.join(newHive.root(), 'registry.json'), 'utf8'));
  assert.deepEqual(Object.keys(reg.agents ?? {}), [], 'no agent is copied in; the god is the first one the renderer spawns');
  assert.equal(fs.existsSync(path.join(newHome, 'roster.json')), false, 'no roster is copied in');
  for (const doc of ['PROTOCOL.md', 'COMMANDS.md']) {
    assert.ok(fs.statSync(path.join(newHive.root(), doc)).size > 1000, `${doc} seeds`);
  }
  assert.match(fs.readFileSync(path.join(newHive.root(), 'PROTOCOL.md'), 'utf8'), /## The ledger command/);
  assert.deepEqual(fs.readFileSync(oldReg), before, 'the existing floor\'s registry is byte-identical');
});
