'use strict';

/**
 * TASKS-JSON-SPLIT: hot tasks.json (live + done < 48 h) and the append-only archive
 * (tasks-archive/YYYY-MM.jsonl). Every pass is called directly with an explicit clock.
 *
 * Mutants that must die (test/tools/tasks-json-split-mutants.cjs):
 *   A1 a done card younger than 48 h moves        A2 a doing/blocked card with doneAt moves
 *   A3 a waitingFor/parked card moves             A4 a done card with an open ask moves
 *   A5 a duplicate id moves                       A6 hot is rewritten before the archive append
 *   A7 the migration backup is skipped            A8 addTask ignores the archive
 *   A9 an archived patch does not revive          A10 the tombstone is written before hot
 *   A11 allTasks lets the archive copy win        A12 a tombstone is ignored on read
 *   A13 the ledger route reads hot only           A14 statusSince of a non-done status counts
 *   A15 a torn archive line is fatal              A16 the reader cache ignores a new archive file
 *   A17 a torn tail is not ended before an append A18 the pass drops cards that never read back
 *   A19 doneTime ignores revivedAt                A20 a revive stamps no revivedAt
 *   A21 unsplit runs while Guppy is live          A22 a dependency on an archived card warns
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const A = loadTs('src/main/taskArchive.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const cli = require('../resources/tasks-cli.cjs');

const H = 60 * 60_000;
const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const card = (id, extra = {}) => ({ id, title: `title ${id}`, status: 'todo', assignee: 'creed', priority: 'medium', ...extra });
const old = (id, extra = {}) => card(id, { status: 'done', doneAt: iso(NOW - 72 * H), result: `[${iso(NOW - 72 * H)}] did ${id}`, ...extra });

function rig(t, tasks) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-tjs-'));
  const root = path.join(home, 'hive');
  fs.mkdirSync(root, { recursive: true });
  const hotPath = path.join(root, 'tasks.json');
  if (tasks) fs.writeFileSync(hotPath, JSON.stringify({ tasks }, null, 2));
  const hive = new HiveManager(() => home);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }); });
  const hot = () => JSON.parse(fs.readFileSync(hotPath, 'utf8')).tasks;
  const archiveLines = () => {
    const dir = path.join(root, 'tasks-archive');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).sort().flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  };
  const backups = () => fs.readdirSync(root).filter((f) => f.startsWith('tasks.pre-split-'));
  const ids = (list) => list.map((c) => c.id).sort();
  return { home, root, hotPath, hive, hot, archiveLines, backups, ids };
}

test('planArchive: only status done, done >= 48 h, no open ask, no waitingFor/parked, unique id', () => {
  const tasks = [
    old('OLD'),
    card('YOUNG', { status: 'done', doneAt: iso(NOW - 47 * H) }),
    card('EDGE', { status: 'done', doneAt: iso(NOW - 48 * H) }),
    card('DOING', { status: 'doing', doneAt: iso(NOW - 99 * H) }),
    card('BLOCKED', { status: 'blocked', doneAt: iso(NOW - 99 * H) }),
    old('WAIT', { waitingFor: 'the Human' }),
    old('PARKED', { parked: true }),
    old('EMPTYWAIT', { waitingFor: '', parked: false }),
    old('ASK', { humanQA: [{ q: 'ship it?' }] }),
    old('ANSWERED', { humanQA: [{ q: 'ship it?', a: 'yes' }, { q: 'and?', dismissedAt: iso(NOW) }] }),
    old('DUP'), old('DUP'),
    card('NOTIME', { status: 'done' }),
    card('META', { status: 'done' }),
    card('METAOLDSTATUS', { status: 'done' })
  ];
  const meta = {
    META: { status: 'done', statusSince: NOW - 50 * H },
    // A14: the sidecar's statusSince is for another status (stale): it is no done time.
    METAOLDSTATUS: { status: 'doing', statusSince: NOW - 99 * H }
  };
  assert.deepEqual(A.planArchive(tasks, meta, NOW), ['OLD', 'EDGE', 'EMPTYWAIT', 'ANSWERED', 'META']);
});

test('the archive pass: append first, hot keeps live + young + asks, allTasks keeps every card, migration backup once', (t) => {
  const tasks = [old('A1'), card('LIVE'), old('A2'), card('ASKED', { status: 'done', doneAt: iso(NOW - 99 * H), humanQA: [{ q: 'ok?' }] }), card('YOUNG', { status: 'done', doneAt: iso(NOW - H) })];
  const r = rig(t, tasks);
  assert.deepEqual(r.hive.archivePass(NOW).sort(), ['A1', 'A2']);
  assert.deepEqual(r.ids(r.hot()), ['ASKED', 'LIVE', 'YOUNG']);
  assert.deepEqual(r.archiveLines().map((l) => l.card.id), ['A1', 'A2']);
  assert.ok(fs.existsSync(path.join(r.root, 'tasks-archive', '2026-10.jsonl')), 'the month file');
  // A7: the migration copy holds the whole pre-split ledger.
  assert.equal(r.backups().length, 1);
  assert.deepEqual(r.ids(JSON.parse(fs.readFileSync(path.join(r.root, r.backups()[0]), 'utf8')).tasks), r.ids(tasks));
  // hot readers see hot; allTasks sees every card, field for field.
  assert.deepEqual(r.ids(r.hive.tasks().tasks), ['ASKED', 'LIVE', 'YOUNG']);
  const all = r.hive.allTasks().tasks;
  assert.deepEqual(r.ids(all), r.ids(tasks));
  assert.deepEqual(all.find((c) => c.id === 'A1'), tasks[0]);
  // a later pass with more to move appends, and takes no second backup
  r.hive.patchTask('LIVE', { status: 'done', doneAt: iso(NOW - 60 * H) });
  assert.deepEqual(r.hive.archivePass(NOW), ['LIVE']);
  assert.equal(r.backups().length, 1);
  assert.deepEqual(r.hive.archivePass(NOW), [], 'nothing left to move');
});

test('crash between the append and the hot rewrite: the card is in both, nothing is lost, the hot copy wins', (t) => {
  const r = rig(t, [old('X', { result: 'hot copy' }), card('LIVE')]);
  A.appendArchived(r.root, [old('X', { result: 'archived copy' })], NOW); // the pass died here
  const all = r.hive.allTasks().tasks;
  assert.equal(all.filter((c) => c.id === 'X').length, 1);
  assert.equal(all.find((c) => c.id === 'X').result, 'hot copy');
  // the next pass finishes the move; the latest archive line is the hot copy
  assert.deepEqual(r.hive.archivePass(NOW), ['X']);
  assert.equal(r.hive.allTasks().tasks.find((c) => c.id === 'X').result, 'hot copy');
});

test('a patch of an archived card revives it (hot first, then the tombstone); addTask refuses an archived id', (t) => {
  const r = rig(t, [old('OLD1'), card('LIVE')]);
  r.hive.archivePass(NOW);
  assert.equal(r.hive.addTask(card('OLD1')), false, 'A8: ids stay unique across hot and the archive');
  assert.ok(r.hive.patchTask('OLD1', { notes: 'a late note' }));
  const revived = r.hot().find((c) => c.id === 'OLD1');
  assert.equal(revived.notes, 'a late note');
  assert.equal(revived.result, old('OLD1').result, 'the archived fields come back');
  const lines = r.archiveLines();
  assert.deepEqual(lines[lines.length - 1].revived, 'OLD1');
  assert.equal(A.readArchive(r.root).has('OLD1'), false);
  assert.equal(r.hive.allTasks().tasks.filter((c) => c.id === 'OLD1').length, 1);
  assert.equal(r.hive.patchTask('NEVER', { notes: 'x' }), false, 'an unknown id is still refused');
  // Jim SHOULD 1: revivedAt restarts the 48 h window; the next pass leaves it hot ...
  const revivedAt = Date.parse(revived.revivedAt);
  assert.ok(Math.abs(revivedAt - Date.now()) < 60_000, 'revivedAt is stamped at the revive');
  assert.deepEqual(r.hive.archivePass(revivedAt + H), []);
  assert.deepEqual(r.hive.archivePass(revivedAt + 47 * H), []);
  // ... and after the window it moves back, carrying the note
  assert.deepEqual(r.hive.archivePass(revivedAt + 49 * H), ['OLD1']);
  assert.equal(A.readArchive(r.root).get('OLD1').notes, 'a late note');
});

test('Jim MUST: a torn archive tail does not swallow the next append (exact fixture)', (t) => {
  const r = rig(t, [card('LIVE')]);
  A.appendArchived(r.root, [old('A-1')], NOW);
  fs.appendFileSync(path.join(r.root, 'tasks-archive', '2026-10.jsonl'), '{"v":1,"at":"x","card":{"id":"TORN-1"');
  A.appendArchived(r.root, [old('B-2'), old('C-3')], NOW);
  assert.deepEqual([...A.readArchive(r.root).keys()], ['A-1', 'B-2', 'C-3']);
});

test('Jim MUST: the pass drops from hot only cards that read back from the archive whole', (t) => {
  const r = rig(t, [old('W1'), old('W2'), card('LIVE')]);
  const realWrite = fs.writeSync;
  let cut = true;
  fs.writeSync = function (fd, data, ...rest) {
    // one short append: the archive gets W1's line and half of W2's (a crash or a full disk)
    if (cut && typeof data === 'string' && data.includes('"W2"')) { cut = false; data = data.slice(0, data.indexOf('"W2"') + 10); }
    return realWrite.call(this, fd, data, ...rest);
  };
  let moved;
  try { moved = r.hive.archivePass(NOW); } finally { fs.writeSync = realWrite; }
  assert.deepEqual(moved, ['W1']);
  assert.deepEqual(r.ids(r.hot()), ['LIVE', 'W2'], 'W2 stays hot: its line never landed whole');
  assert.deepEqual(r.ids(r.hive.allTasks().tasks), ['LIVE', 'W1', 'W2']);
  // the next pass ends the torn line first, then moves W2
  assert.deepEqual(r.hive.archivePass(NOW), ['W2']);
  assert.deepEqual(r.ids(r.hive.allTasks().tasks), ['LIVE', 'W1', 'W2']);
  assert.deepEqual(r.ids(r.hot()), ['LIVE']);
});

test('Jim NIT: a live card that depends on an archived card is no dep warning', (t) => {
  const r = rig(t, [old('D1'), card('LIVE')]);
  r.hive.archivePass(NOW);
  const hot = r.hot();
  hot.find((c) => c.id === 'LIVE').dependsOn = ['D1', 'GONE'];
  fs.writeFileSync(r.hotPath, JSON.stringify({ tasks: hot }, null, 2));
  r.hive.ledgerGuard.check();
  const deps = r.hive.ledgerGuard.issues().filter((i) => i.key.startsWith('dep:')).map((i) => i.key);
  assert.deepEqual(deps, ['dep:LIVE:GONE']);
});

test('a failed archive append leaves hot untouched (A6: append first, then rewrite hot)', (t) => {
  const r = rig(t, [old('F1'), card('LIVE')]);
  fs.writeFileSync(path.join(r.root, 'tasks-archive'), 'not a directory'); // the append cannot open its file
  assert.throws(() => r.hive.archivePass(NOW));
  assert.deepEqual(r.ids(r.hot()), ['F1', 'LIVE'], 'no card left hot before the archive held it');
});

test('a failed tombstone append still leaves the revived card hot (A10: hot first, then the tombstone)', (t) => {
  const r = rig(t, [card('LIVE')]);
  const dir = path.join(r.root, 'tasks-archive');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '2026-09.jsonl'), JSON.stringify({ v: 1, at: 'x', card: old('T1') }) + '\n');
  fs.mkdirSync(path.join(dir, `${new Date().toISOString().slice(0, 7)}.jsonl`)); // this month's file cannot be opened
  assert.throws(() => r.hive.patchTask('T1', { notes: 'n' }));
  assert.equal(r.hot().find((c) => c.id === 'T1')?.notes, 'n');
  assert.equal(r.hive.allTasks().tasks.filter((c) => c.id === 'T1').length, 1);
});

test('a torn last archive line (crash mid-append) is skipped; a new month file invalidates the cache', (t) => {
  const r = rig(t, [old('M1'), card('LIVE')]);
  r.hive.archivePass(NOW);
  assert.equal(r.hive.allTasks().tasks.length, 2);
  fs.appendFileSync(path.join(r.root, 'tasks-archive', '2026-10.jsonl'), '{"v":1,"at":"x","card":{"id":"TOR');
  assert.equal(r.hive.allTasks().tasks.length, 2);
  fs.writeFileSync(path.join(r.root, 'tasks-archive', '2026-11.jsonl'), JSON.stringify({ v: 1, at: 'x', card: old('M2') }) + '\n');
  assert.deepEqual(r.ids(r.hive.allTasks().tasks), ['LIVE', 'M1', 'M2']);
});

test('god 4eb6eb: a direct python edit of hot (indent=2, ensure_ascii=False) round-trips through the pass with no card lost', (t) => {
  const py = ['python', 'python3', 'py'].find((p) => spawnSync(p, ['--version']).status === 0);
  if (!py) { t.skip('no python on this machine'); return; }
  const tasks = [old('G1'), card('G2', { title: 'café ünïcode — dash' }), old('G3'), card('G4', { status: 'doing' })];
  const r = rig(t, tasks);
  r.hive.archivePass(NOW);
  const script = [
    'import json, sys',
    'p = sys.argv[1]',
    'd = json.load(open(p, encoding="utf-8"))',
    'for c in d["tasks"]:',
    '    if c["id"] == "G2": c["notes"] = "god édit"',
    'd["tasks"].append({"id": "G5", "title": "new by god ✓", "status": "todo", "assignee": "creed"})',
    'json.dump(d, open(p, "w", encoding="utf-8"), indent=2, ensure_ascii=False)'
  ].join('\n');
  const run = spawnSync(py, ['-c', script, r.hotPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  // god finishes G4 long ago in the same file; the next pass moves it
  const hot = r.hot();
  hot.find((c) => c.id === 'G4').status = 'done';
  hot.find((c) => c.id === 'G4').doneAt = iso(NOW - 99 * H);
  fs.writeFileSync(r.hotPath, JSON.stringify({ tasks: hot }, null, 2));
  assert.deepEqual(r.hive.archivePass(NOW), ['G4']);
  const all = r.hive.allTasks().tasks;
  assert.deepEqual(r.ids(all), ['G1', 'G2', 'G3', 'G4', 'G5']);
  assert.equal(all.find((c) => c.id === 'G2').notes, 'god édit');
  assert.equal(all.find((c) => c.id === 'G2').title, 'café ünïcode — dash');
  assert.equal(all.find((c) => c.id === 'G5').title, 'new by god ✓');
});

test('tasks-all prints hot + archive; tasks-unsplit --yes restores one tasks.json with every card and field', async (t) => {
  const tasks = [old('U1'), card('U2'), old('U3', { humanQA: [{ q: 'a', a: 'b' }], deps: ['U1'] }), card('U4', { status: 'blocked' })];
  const r = rig(t, tasks);
  r.hive.archivePass(NOW);
  r.hive.patchTask('U2', { notes: 'hot edit' });
  let out = '';
  const io = { out: (s) => { out += s; }, err: (s) => { out += s; } };
  assert.equal(await cli.main(['all', '--root', r.root], {}, io), 0);
  assert.deepEqual(JSON.parse(out).tasks, r.hive.allTasks().tasks);
  out = '';
  assert.equal(await cli.main(['unsplit', '--root', r.root], {}, io), 2, 'refused without --yes');
  // Jim SHOULD 2: never while Guppy is live (an agent shell, or a fresh fleet.json)
  assert.equal(await cli.main(['unsplit', '--yes', '--root', r.root], { HIVE_LEDGER_URL: 'http://127.0.0.1:1/x' }, io), 1);
  assert.match(out, /unsplit refused: HIVE_LEDGER_URL/);
  const fleet = path.join(r.root, 'fleet.json');
  fs.writeFileSync(fleet, '{}');
  assert.equal(await cli.main(['unsplit', '--yes', '--root', r.root], {}, io), 1);
  assert.match(out, /unsplit refused: fleet\.json was written/);
  const stale = (Date.now() - 2 * cli.LIVE_FLEET_MS) / 1000;
  fs.utimesSync(fleet, stale, stale);
  assert.ok(fs.existsSync(path.join(r.root, 'tasks-archive')), 'nothing changed while refused');
  assert.equal(await cli.main(['unsplit', '--yes', '--root', r.root], {}, io), 0, out);
  const back = r.hot();
  const byId = (list) => Object.fromEntries(list.map((c) => [c.id, c]));
  const want = byId(tasks);
  want.U2 = { ...want.U2, notes: 'hot edit' };
  assert.deepEqual(byId(back), want);
  assert.equal(back.length, tasks.length);
  assert.equal(fs.existsSync(path.join(r.root, 'tasks-archive')), false);
  assert.equal(fs.readdirSync(r.root).filter((f) => f.startsWith('tasks-archive.unsplit-')).length, 1);
});

test('tasks-revive: refuses an id not archived, says so for a hot id, and goes through the ledger route', async (t) => {
  const r = rig(t, [old('R1'), card('R2')]);
  r.hive.archivePass(NOW);
  let out = '';
  const io = { out: (s) => { out += s; }, err: (s) => { out += s; } };
  assert.equal(await cli.main(['revive', 'NOPE', '--root', r.root], {}, io), 1);
  assert.equal(await cli.main(['revive', 'R2', '--root', r.root], {}, io), 0);
  assert.match(out, /already in tasks\.json/);
  out = '';
  // no HIVE_LEDGER_URL here: the ledger route is the only writer it would use
  assert.equal(await cli.main(['revive', 'R1', '--root', r.root], {}, io), 3);
  assert.match(out, /ledger: unavailable/);
  assert.equal(A.readArchive(r.root).has('R1'), true, 'the CLI never edits the files itself');
});

test('readers that need any card ever made read allTasks (source pins)', () => {
  const ix = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const hv = fs.readFileSync(path.join(__dirname, '..', 'src/main/hive.ts'), 'utf8');
  // A13: the ledger route (a patch or message.card may name an archived card)
  assert.match(ix, /readTasks: \(\) => \{\s*const t = hive\.allTasks\(\)\.tasks;/);
  assert.equal(ix.split('taskStatus: (id) => ((hive.allTasks()').length - 1, 2, 'both claim world views');
  assert.match(ix, /tasks: \(\) => \(hive\.allTasks\(\) as \{ tasks\?: TaskRow\[\] \}\)\.tasks \?\? \[\],/);
  assert.match(ix, /const wanted = Buffer\.from\(hash\);[\s\S]{0,200}hive\.allTasks\(\) as \{ tasks\?: HiveTask\[\] \}/);
  assert.match(ix, /ipcMain\.handle\('hive:allTasks', \(\) => hive\.allTasks\(\)\);/);
  assert.match(ix, /source: `tasks-archive\/\$\{f\}`/);
  assert.match(hv, /const list = this\.allTasks\(\)\.tasks;\s+let meta: Record<string, CardMeta> = \{\};/);
  // the Slack/webhook done-pollers stay on hot: their reply patch must never revive old cards
  assert.match(ix, /function pollWebhookDoneTasks\(\): void \{\s+let tasks: HiveTask\[\];\s+try \{\s+const ledger = hive\.tasks\(\)/);
});

test('the pass runs at guard start and hourly, and stops with the guard', (t) => {
  const r = rig(t, [old('S1'), card('S2')]);
  r.hive.startLedgerGuard();
  t.after(() => r.hive.stopLedgerGuard());
  assert.deepEqual(r.ids(r.hot()), ['S2'], 'moved at start (doneAt three days ago, real clock)');
  r.hive.stopLedgerGuard();
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/hive.ts'), 'utf8');
  assert.match(src, /this\.archiveTimer = setInterval\(\(\) => \{[\s\S]{0,200}\}, ARCHIVE_PASS_MS\);\s+this\.archiveTimer\.unref\?\.\(\);/);
  assert.equal(A.ARCHIVE_PASS_MS, 60 * 60_000);
  assert.equal(A.ARCHIVE_KEEP_MS, 48 * 60 * 60_000);
});
